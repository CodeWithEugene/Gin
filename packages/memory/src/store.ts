import { newId, type MemoryRecord } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";
import { cosine, normalize, type Embedder } from "./embedder.js";

/**
 * Persistent agent memory on SQLite: FTS5 for keyword recall, an embedded
 * vector table for semantic recall, and hybrid search via reciprocal-rank
 * fusion. Vector scan is in-process cosine over float32 blobs — plenty for
 * single-tenant local memory sizes; sqlite-vec is the planned swap-in once
 * collections grow past that.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "memories",
    up: (db) => {
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'skill', 'episodic')),
          text TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          edited_by TEXT
        );
        CREATE INDEX memories_agent ON memories (agent_id, created_at);
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          text,
          content='memories',
          content_rowid='rowid'
        );
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TABLE memory_vectors (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          embedder TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vector BLOB NOT NULL
        );
      `);
    },
  },
];

interface MemoryRow {
  id: string;
  agent_id: string;
  kind: MemoryRecord["kind"];
  text: string;
  source: string;
  created_at: number;
  edited_by: string | null;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
    ...(row.edited_by !== null ? { editedBy: row.edited_by } : {}),
  };
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
}

export type SearchMode = "keyword" | "vector" | "hybrid";

export interface MemorySearchOptions {
  limit?: number;
  mode?: SearchMode;
}

export interface MemoryStoreOptions {
  embedder?: Embedder;
}

export class MemoryStore {
  private readonly embedder: Embedder | undefined;

  constructor(
    private readonly db: GinDatabase,
    opts: MemoryStoreOptions = {},
  ) {
    this.embedder = opts.embedder;
    migrate(db, "memory", MIGRATIONS);
  }

  async store(input: {
    agentId: string;
    text: string;
    kind?: MemoryRecord["kind"];
    source?: string;
  }): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: newId(),
      agentId: input.agentId,
      kind: input.kind ?? "fact",
      text: input.text,
      source: input.source ?? "",
      createdAt: Date.now(),
    };
    // Embed before the write transaction so a failed embedder leaves no row.
    let vector: Float32Array | undefined;
    if (this.embedder) {
      const [embedding] = await this.embedder.embed([input.text]);
      if (embedding) vector = new Float32Array(normalize(embedding));
    }

    this.db
      .prepare(
        `INSERT INTO memories (id, agent_id, kind, text, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.agentId, record.kind, record.text, record.source, record.createdAt);
    if (vector && this.embedder) {
      this.db
        .prepare(
          `INSERT INTO memory_vectors (memory_id, embedder, dim, vector) VALUES (?, ?, ?, ?)`,
        )
        .run(record.id, this.embedder.id, vector.length, Buffer.from(vector.buffer));
    }
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(agentId: string, limit = 100): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  async search(
    agentId: string,
    query: string,
    opts: MemorySearchOptions = {},
  ): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 5;
    const mode = opts.mode ?? (this.embedder ? "hybrid" : "keyword");
    switch (mode) {
      case "keyword":
        return this.searchKeyword(agentId, query, limit);
      case "vector":
        return this.searchVector(agentId, query, limit);
      case "hybrid": {
        const [keyword, vector] = await Promise.all([
          this.searchKeyword(agentId, query, limit * 2),
          this.searchVector(agentId, query, limit * 2),
        ]);
        return fuse([keyword, vector], limit);
      }
    }
  }

  private searchKeyword(agentId: string, query: string, limit: number): MemoryHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, memories_fts.rank AS fts_rank
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.agent_id = ?
         ORDER BY memories_fts.rank
         LIMIT ?`,
      )
      .all(match, agentId, limit) as (MemoryRow & { fts_rank: number })[];
    // FTS5 rank is negative bm25 — more negative is better. Map to (0, 1].
    return rows.map((row) => ({
      record: toRecord(row),
      score: 1 / (1 + Math.max(0, -row.fts_rank)),
    }));
  }

  private async searchVector(agentId: string, query: string, limit: number): Promise<MemoryHit[]> {
    if (!this.embedder) return [];
    const [embedding] = await this.embedder.embed([query]);
    if (!embedding) return [];
    const q = new Float32Array(normalize(embedding));
    const rows = this.db
      .prepare(
        `SELECT m.*, v.vector AS vec
         FROM memory_vectors v
         JOIN memories m ON m.id = v.memory_id
         WHERE m.agent_id = ? AND v.embedder = ?`,
      )
      .all(agentId, this.embedder.id) as (MemoryRow & { vec: Buffer })[];
    return rows
      .map((row) => ({
        record: toRecord(row),
        score: cosine(
          q,
          new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4),
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Each whitespace token becomes a quoted FTS5 term; ANDed implicitly. */
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Reciprocal-rank fusion across result lists (k=60, the standard constant). */
function fuse(lists: MemoryHit[][], limit: number): MemoryHit[] {
  const K = 60;
  const byId = new Map<string, MemoryHit & { fused: number }>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const existing = byId.get(hit.record.id);
      const contribution = 1 / (K + index + 1);
      if (existing) {
        existing.fused += contribution;
      } else {
        byId.set(hit.record.id, { ...hit, fused: contribution });
      }
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map(({ record, fused }) => ({ record, score: fused }));
}
