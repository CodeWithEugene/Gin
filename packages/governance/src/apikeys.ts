import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";
import type { Principal } from "./rbac.js";

/**
 * API keys (Phase 5 auth foundation). A key is shown ONCE at creation;
 * only its sha256 lands on disk. verify() resolves a raw key to a Principal
 * carrying roles + tenant — the same Principal the RBAC layer already
 * checks, so remote callers get exactly the scopes their key grants.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "api-keys",
    up: (db) => {
      db.exec(`
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          tenant_id TEXT,
          roles TEXT NOT NULL DEFAULT '["viewer"]',
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
      `);
    },
  },
];

export interface ApiKeyRecord {
  id: string;
  name: string;
  tenantId?: string;
  roles: string[];
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** The raw secret — returned exactly once, never stored. */
  key: string;
}

const KEY_PREFIX = "gin_";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class ApiKeyStore {
  constructor(private readonly db: GinDatabase) {
    migrate(db, "governance-apikeys", MIGRATIONS);
  }

  create(input: { name: string; roles?: string[]; tenantId?: string }): CreatedApiKey {
    const raw = KEY_PREFIX + randomBytes(24).toString("base64url");
    const record: ApiKeyRecord = {
      id: newId(),
      name: input.name,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      roles: input.roles?.length ? input.roles : ["viewer"],
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, tenant_id, roles, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        hashKey(raw),
        record.tenantId ?? null,
        JSON.stringify(record.roles),
        record.createdAt,
      );
    return { ...record, key: raw };
  }

  /** Resolve a raw key to a Principal, or undefined when unknown/revoked. */
  verify(rawKey: string): (Principal & { tenantId?: string }) | undefined {
    if (!rawKey.startsWith(KEY_PREFIX)) return undefined;
    const hash = hashKey(rawKey);
    const row = this.db
      .prepare("SELECT * FROM api_keys WHERE revoked_at IS NULL")
      .all()
      .map((r) => r as Record<string, unknown>)
      // Constant-time compare against every candidate hash: lookups by hash
      // are fine for speed, but never let string equality leak timing.
      .find((r) => {
        const candidate = Buffer.from(r.key_hash as string, "hex");
        const provided = Buffer.from(hash, "hex");
        return candidate.length === provided.length && timingSafeEqual(candidate, provided);
      });
    if (!row) return undefined;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
    return {
      id: row.id as string,
      name: row.name as string,
      roles: JSON.parse(row.roles as string) as string[],
      ...(row.tenant_id !== null ? { tenantId: row.tenant_id as string } : {}),
    };
  }

  revoke(id: string): boolean {
    const result = this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(Date.now(), id);
    return result.changes > 0;
  }

  get(id: string): ApiKeyRecord | undefined {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): ApiKeyRecord[] {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY id").all() as Record<
      string,
      unknown
    >[];
    return rows.map(toRecord);
  }
}

function toRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id as string } : {}),
    roles: JSON.parse(row.roles as string) as string[],
    createdAt: row.created_at as number,
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at as number } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at as number } : {}),
  };
}
