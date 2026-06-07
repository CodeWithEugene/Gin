import { EventBus, GinError, newId, type BudgetScope } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * The budget engine (spec Phase 2): dollar-denominated limits per scope,
 * checked BEFORE each model call — the bill is prevented, not reported.
 * Every charge lands in an append-only ledger; window spend is computed
 * from the ledger, so budgets and spend survive restarts together.
 *
 * Window semantics: "session" sums the scope's entire ledger (a session is
 * its own lifetime); time windows are rolling (now - duration).
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "budgets",
    up: (db) => {
      db.exec(`
        CREATE TABLE budgets (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          scope_ref TEXT NOT NULL,
          limit_usd REAL NOT NULL,
          window TEXT NOT NULL DEFAULT 'session',
          action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'degrade', 'alert')),
          created_at INTEGER NOT NULL,
          UNIQUE (scope, scope_ref, window)
        );
        CREATE TABLE spend_ledger (
          id TEXT PRIMARY KEY,
          tenant_id TEXT,
          agent_id TEXT,
          session_id TEXT,
          pipeline_id TEXT,
          api_key_ref TEXT,
          amount_usd REAL NOT NULL,
          trace_id TEXT,
          description TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX ledger_agent ON spend_ledger (agent_id, created_at);
        CREATE INDEX ledger_session ON spend_ledger (session_id, created_at);
        CREATE INDEX ledger_tenant ON spend_ledger (tenant_id, created_at);
      `);
    },
  },
];

export type BudgetWindow = "session" | "hour" | "day" | "week" | "month";
export type BudgetAction = "block" | "degrade" | "alert";

const WINDOW_MS: Record<Exclude<BudgetWindow, "session">, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

const SCOPE_COLUMN: Record<BudgetScope, string> = {
  tenant: "tenant_id",
  agent: "agent_id",
  session: "session_id",
  pipeline: "pipeline_id",
  apiKey: "api_key_ref",
};

export interface BudgetScopes {
  tenantId?: string;
  agentId?: string;
  sessionId?: string;
  pipelineId?: string;
  apiKeyRef?: string;
}

export interface BudgetRow {
  id: string;
  scope: BudgetScope;
  scopeRef: string;
  limitUsd: number;
  window: BudgetWindow;
  action: BudgetAction;
}

export interface BudgetStatus extends BudgetRow {
  spentUsd: number;
  remainingUsd: number;
}

export class BudgetEngine {
  private readonly bus: EventBus;

  constructor(
    private readonly db: GinDatabase,
    opts: { bus?: EventBus } = {},
  ) {
    this.bus = opts.bus ?? new EventBus();
    migrate(db, "cost", MIGRATIONS);
  }

  setBudget(input: {
    scope: BudgetScope;
    scopeRef: string;
    limitUsd: number;
    window?: BudgetWindow;
    action?: BudgetAction;
  }): BudgetRow {
    const row: BudgetRow = {
      id: newId(),
      scope: input.scope,
      scopeRef: input.scopeRef,
      limitUsd: input.limitUsd,
      window: input.window ?? "session",
      action: input.action ?? "block",
    };
    this.db
      .prepare(
        `INSERT INTO budgets (id, scope, scope_ref, limit_usd, window, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_ref, window)
         DO UPDATE SET limit_usd = excluded.limit_usd, action = excluded.action`,
      )
      .run(row.id, row.scope, row.scopeRef, row.limitUsd, row.window, row.action, Date.now());
    this.bus.emit("budget.set", { ...row });
    return row;
  }

  /** Create only if absent — config defaults must not clobber operator edits. */
  ensureBudget(input: Parameters<BudgetEngine["setBudget"]>[0]): void {
    const existing = this.db
      .prepare("SELECT id FROM budgets WHERE scope = ? AND scope_ref = ? AND window = ?")
      .get(input.scope, input.scopeRef, input.window ?? "session");
    if (!existing) this.setBudget(input);
  }

  listBudgets(scope?: BudgetScope, scopeRef?: string): BudgetRow[] {
    let rows: Record<string, unknown>[];
    if (scope && scopeRef !== undefined) {
      rows = this.db
        .prepare("SELECT * FROM budgets WHERE scope = ? AND scope_ref = ? ORDER BY id")
        .all(scope, scopeRef) as Record<string, unknown>[];
    } else if (scope) {
      rows = this.db
        .prepare("SELECT * FROM budgets WHERE scope = ? ORDER BY id")
        .all(scope) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare("SELECT * FROM budgets ORDER BY id").all() as Record<
        string,
        unknown
      >[];
    }
    return rows.map(toBudgetRow);
  }

  /**
   * The hard gate: called BEFORE each model call. Throws budget_exceeded when
   * a blocking budget would be breached by estimateUsd more spend. "alert"
   * and "degrade" budgets emit events instead of blocking (degrade routing
   * lands with the model-tier policy in a later phase).
   */
  checkAndReserve(scopes: BudgetScopes, estimateUsd = 0, now = Date.now()): void {
    for (const status of this.status(scopes, now)) {
      if (status.spentUsd + estimateUsd < status.limitUsd) continue;
      const payload = {
        scope: status.scope,
        scopeRef: status.scopeRef,
        window: status.window,
        limitUsd: status.limitUsd,
        spentUsd: status.spentUsd,
        action: status.action,
      };
      if (status.action === "block") {
        this.bus.emit("budget.exceeded", payload);
        throw new GinError(
          "budget_exceeded",
          `Budget exhausted: ${status.scope}/${status.window} limit $${status.limitUsd.toFixed(2)}, ` +
            `spent $${status.spentUsd.toFixed(4)}.`,
          { retryable: false, details: payload },
        );
      }
      this.bus.emit(status.action === "degrade" ? "budget.degrade" : "budget.warning", payload);
    }
  }

  /** Append actual spend to the ledger after the call completes. */
  record(
    scopes: BudgetScopes,
    amountUsd: number,
    meta: { traceId?: string; description?: string } = {},
  ): void {
    if (amountUsd <= 0) return;
    this.db
      .prepare(
        `INSERT INTO spend_ledger
           (id, tenant_id, agent_id, session_id, pipeline_id, api_key_ref, amount_usd, trace_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        scopes.tenantId ?? null,
        scopes.agentId ?? null,
        scopes.sessionId ?? null,
        scopes.pipelineId ?? null,
        scopes.apiKeyRef ?? null,
        amountUsd,
        meta.traceId ?? null,
        meta.description ?? "",
        Date.now(),
      );
    this.bus.emit("budget.spend", { ...scopes, amountUsd, traceId: meta.traceId });
  }

  spent(scope: BudgetScope, scopeRef: string, window: BudgetWindow, now = Date.now()): number {
    const column = SCOPE_COLUMN[scope];
    const since = window === "session" ? 0 : now - WINDOW_MS[window];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend_ledger
         WHERE ${column} = ? AND created_at >= ?`,
      )
      .get(scopeRef, since) as { total: number };
    return row.total;
  }

  /** Every configured budget that applies to the given scopes, with spend. */
  status(scopes: BudgetScopes, now = Date.now()): BudgetStatus[] {
    const refs: [BudgetScope, string | undefined][] = [
      ["tenant", scopes.tenantId],
      ["agent", scopes.agentId],
      ["session", scopes.sessionId],
      ["pipeline", scopes.pipelineId],
      ["apiKey", scopes.apiKeyRef],
    ];
    const result: BudgetStatus[] = [];
    for (const [scope, ref] of refs) {
      if (ref === undefined) continue;
      for (const budget of this.listBudgets(scope, ref)) {
        const spentUsd = this.spent(scope, ref, budget.window, now);
        result.push({ ...budget, spentUsd, remainingUsd: Math.max(0, budget.limitUsd - spentUsd) });
      }
    }
    return result;
  }
}

function toBudgetRow(row: Record<string, unknown>): BudgetRow {
  return {
    id: row.id as string,
    scope: row.scope as BudgetScope,
    scopeRef: row.scope_ref as string,
    limitUsd: row.limit_usd as number,
    window: row.window as BudgetWindow,
    action: row.action as BudgetAction,
  };
}
