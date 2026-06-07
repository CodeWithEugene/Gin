import { newId, type AuditEvent } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * Append-only audit log (spec Phase 3). Every governance-relevant mutation —
 * budget changes, approval decisions, agent/config edits — lands here with
 * actor, action, target, and before/after snapshots. There is no update or
 * delete surface by design.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "audit-log",
    up: (db) => {
      db.exec(`
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '',
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL DEFAULT '',
          before TEXT,
          after TEXT,
          trace_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX audit_actor ON audit_events (actor, id);
        CREATE INDEX audit_action ON audit_events (action, id);
      `);
    },
  },
];

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  tenantId?: string;
  traceId?: string;
}

export class AuditLog {
  constructor(private readonly db: GinDatabase) {
    migrate(db, "governance-audit", MIGRATIONS);
  }

  append(input: AuditInput): AuditEvent {
    const event = {
      id: newId(),
      tenantId: input.tenantId ?? "",
      actor: input.actor,
      action: input.action,
      target: input.target ?? "",
      before: input.before,
      after: input.after,
      traceId: input.traceId ?? "",
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, tenant_id, actor, action, target, before, after, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tenantId,
        event.actor,
        event.action,
        event.target,
        event.before !== undefined ? JSON.stringify(event.before) : null,
        event.after !== undefined ? JSON.stringify(event.after) : null,
        event.traceId,
        event.createdAt,
      );
    return event as AuditEvent;
  }

  list(filter: { actor?: string; action?: string; limit?: number } = {}): AuditEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.actor !== undefined) {
      where.push("actor = ?");
      params.push(filter.actor);
    }
    if (filter.action !== undefined) {
      where.push("action = ?");
      params.push(filter.action);
    }
    const sql =
      "SELECT * FROM audit_events" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ?";
    params.push(filter.limit ?? 100);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      tenantId: row.tenant_id as string,
      actor: row.actor as string,
      action: row.action as string,
      target: row.target as string,
      ...(row.before !== null ? { before: JSON.parse(row.before as string) } : {}),
      ...(row.after !== null ? { after: JSON.parse(row.after as string) } : {}),
      traceId: row.trace_id as string,
      createdAt: row.created_at as number,
    })) as AuditEvent[];
  }
}
