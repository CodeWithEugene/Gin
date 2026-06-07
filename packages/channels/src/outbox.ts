import { newId } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * The guaranteed-delivery outbox (spec: at-least-once, idempotency keys,
 * inbound dedup, ordered per-peer delivery, dead-lettering). Replies are
 * committed here before any network send; a crash between commit and send
 * re-delivers rather than silently dropping — the documented failure mode
 * this design exists to beat.
 *
 * Ordering: messages to the same (channel, peer) deliver strictly in enqueue
 * order. A failing head message blocks its peer's queue through backoff —
 * later messages must not overtake — while other peers keep flowing.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "outbox",
    up: (db) => {
      db.exec(`
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          peer_ref TEXT NOT NULL,
          body TEXT NOT NULL,
          idempotency_key TEXT,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued', 'sending', 'delivered', 'dead_letter')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          delivered_at INTEGER
        );
        CREATE UNIQUE INDEX outbox_idem ON outbox (idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX outbox_peer ON outbox (channel_id, peer_ref, id);
        CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
        CREATE TABLE inbound_seen (
          channel_id TEXT NOT NULL,
          channel_message_id TEXT NOT NULL,
          seen_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, channel_message_id)
        );
      `);
    },
  },
];

export type OutboxStatus = "queued" | "sending" | "delivered" | "dead_letter";

export interface OutboxEntry {
  id: string;
  channelId: string;
  peerRef: string;
  body: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface OutboxOptions {
  maxAttempts?: number;
  /** Base backoff; doubles per attempt up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export class Outbox {
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly db: GinDatabase,
    opts: OutboxOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    migrate(db, "channels", MIGRATIONS);
  }

  /**
   * Queue a message. With an idempotencyKey, re-enqueueing the same logical
   * message returns the original entry id instead of duplicating it.
   */
  enqueue(input: {
    channelId: string;
    peerRef: string;
    body: string;
    idempotencyKey?: string;
    now?: number;
  }): string {
    const now = input.now ?? Date.now();
    if (input.idempotencyKey !== undefined) {
      const existing = this.db
        .prepare("SELECT id FROM outbox WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { id: string } | undefined;
      if (existing) return existing.id;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO outbox (id, channel_id, peer_ref, body, idempotency_key, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.channelId, input.peerRef, input.body, input.idempotencyKey ?? null, now, now);
    return id;
  }

  /**
   * Claim due messages for delivery, at most one per (channel, peer) and only
   * the head of each peer queue. Claimed rows move to 'sending'.
   */
  claimDue(now = Date.now(), limit = 50): OutboxEntry[] {
    const claim = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox o
           WHERE o.status = 'queued' AND o.next_attempt_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM outbox p
               WHERE p.channel_id = o.channel_id AND p.peer_ref = o.peer_ref
                 AND p.id < o.id AND p.status IN ('queued', 'sending')
             )
           ORDER BY o.id LIMIT ?`,
        )
        .all(now, limit) as Record<string, unknown>[];
      const mark = this.db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?");
      for (const row of rows) mark.run(row.id);
      return rows.map(toEntry);
    });
    return claim();
  }

  markDelivered(id: string, now = Date.now()): void {
    this.db
      .prepare("UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(now, id);
  }

  /** Failed attempt: backoff and requeue, or dead-letter past maxAttempts. */
  markFailed(id: string, error: string, now = Date.now()): OutboxStatus {
    const row = this.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as
      | { attempts: number }
      | undefined;
    if (!row) return "dead_letter";
    const attempts = row.attempts + 1;
    if (attempts >= this.maxAttempts) {
      this.db
        .prepare(
          "UPDATE outbox SET status = 'dead_letter', attempts = ?, last_error = ? WHERE id = ?",
        )
        .run(attempts, error, id);
      return "dead_letter";
    }
    const backoff = Math.min(this.baseBackoffMs * 2 ** (attempts - 1), this.maxBackoffMs);
    this.db
      .prepare(
        `UPDATE outbox SET status = 'queued', attempts = ?, last_error = ?, next_attempt_at = ?
         WHERE id = ?`,
      )
      .run(attempts, error, now + backoff, id);
    return "queued";
  }

  get(id: string): OutboxEntry | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toEntry(row) : undefined;
  }

  deadLetters(limit = 100): OutboxEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE status = 'dead_letter' ORDER BY id LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  /** Inbound dedup: true the first time a channel message id is seen. */
  markInboundSeen(channelId: string, channelMessageId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_seen (channel_id, channel_message_id, seen_at)
         VALUES (?, ?, ?)`,
      )
      .run(channelId, channelMessageId, now);
    return result.changes > 0;
  }
}

function toEntry(row: Record<string, unknown>): OutboxEntry {
  return {
    id: row.id as string,
    channelId: row.channel_id as string,
    peerRef: row.peer_ref as string,
    body: row.body as string,
    status: row.status as OutboxStatus,
    attempts: row.attempts as number,
    nextAttemptAt: row.next_attempt_at as number,
    ...(row.last_error !== null ? { lastError: row.last_error as string } : {}),
  };
}
