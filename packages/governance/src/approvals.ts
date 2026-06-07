import { EventBus, newId, type RiskLevel } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * Durable approval gates (spec Phase 3). A high-risk action pauses until a
 * human decides. Requests are persisted BEFORE the requester starts waiting,
 * so a restart never loses the question: pending rows survive and can still
 * be decided (the decision is recorded and audited even if the original
 * waiter died with the process). Undecided requests expire to "expired",
 * which callers treat as denial — the safe default.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "approvals",
    up: (db) => {
      db.exec(`
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL DEFAULT '',
          turn_id TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          params TEXT NOT NULL DEFAULT '{}',
          risk_level TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
          requested_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT,
          reason TEXT
        );
        CREATE INDEX approvals_status ON approvals (status, id);
      `);
    },
  },
];

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalDecision = "approved" | "denied";

export interface ApprovalRequestInput {
  action: string;
  params?: unknown;
  riskLevel: RiskLevel;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
}

export interface ApprovalRecord {
  id: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  action: string;
  params: unknown;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalBrokerOptions {
  bus?: EventBus;
  /** How long request() waits before expiring (default 5 minutes). */
  timeoutMs?: number;
}

export class ApprovalBroker {
  private readonly bus: EventBus;
  private readonly timeoutMs: number;
  private readonly waiters = new Map<string, (status: ApprovalStatus) => void>();

  constructor(
    private readonly db: GinDatabase,
    opts: ApprovalBrokerOptions = {},
  ) {
    this.bus = opts.bus ?? new EventBus();
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    migrate(db, "governance-approvals", MIGRATIONS);
  }

  /**
   * Persist the request, announce it, and wait for a decision. Resolves with
   * the terminal status; "expired" (timeout) must be treated as denial.
   */
  request(input: ApprovalRequestInput, timeoutMs = this.timeoutMs): Promise<ApprovalStatus> {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, session_id, turn_id, action, params, risk_level, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId ?? "",
        input.sessionId ?? "",
        input.turnId ?? "",
        input.action,
        JSON.stringify(input.params ?? {}),
        input.riskLevel,
        Date.now(),
      );
    this.bus.emit("approval.requested", {
      approvalId: id,
      action: input.action,
      riskLevel: input.riskLevel,
      agentId: input.agentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      params: input.params ?? {},
    });

    return new Promise<ApprovalStatus>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        this.expire(id);
        resolve("expired");
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, (status) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(status);
      });
    });
  }

  /** Decide a pending request (operator action — audit at the call site). */
  decide(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): ApprovalRecord {
    const existing = this.get(id);
    if (!existing) throw new Error(`Unknown approval: ${id}`);
    if (existing.status !== "pending") return existing; // idempotent: first decision wins
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?",
      )
      .run(decision, Date.now(), decidedBy, reason ?? null, id);
    this.bus.emit("approval.decided", {
      approvalId: id,
      decision,
      decidedBy,
      action: existing.action,
    });
    this.waiters.get(id)?.(decision);
    return this.get(id)!;
  }

  get(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  listPending(limit = 100): ApprovalRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  list(limit = 100): ApprovalRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  private expire(id: string): void {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(Date.now(), id);
    if (result.changes > 0) this.bus.emit("approval.expired", { approvalId: id });
  }
}

function toRecord(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionId: row.session_id as string,
    turnId: row.turn_id as string,
    action: row.action as string,
    params: JSON.parse(row.params as string),
    riskLevel: row.risk_level as RiskLevel,
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at as number,
    ...(row.decided_at !== null ? { decidedAt: row.decided_at as number } : {}),
    ...(row.decided_by !== null ? { decidedBy: row.decided_by as string } : {}),
    ...(row.reason !== null ? { reason: row.reason as string } : {}),
  };
}
