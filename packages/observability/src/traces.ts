import type { EventBus, GinEvent } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * Glass-box tracing (spec Section 11): the trace store is a pure consumer of
 * the event bus — no subsystem imports it; they meet at the bus. Every
 * turn/step/model/budget/workflow/delivery event is persisted with its
 * traceId so the cockpit (and `gin trace`) can replay exactly what the agent
 * thought, did, and spent.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "trace-events",
    up: (db) => {
      db.exec(`
        CREATE TABLE trace_events (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          turn_id TEXT,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          ts INTEGER NOT NULL
        );
        CREATE INDEX trace_events_trace ON trace_events (trace_id, id);
        CREATE INDEX trace_events_type ON trace_events (type, ts);
      `);
    },
  },
];

/** Bus event prefixes that belong in the trace store. */
const TRACED_PREFIXES = [
  "turn.",
  "step.",
  "model.",
  "budget.",
  "workflow.",
  "message.",
  "channel.",
  "session.",
];

export interface TraceEvent {
  id: string;
  traceId?: string;
  turnId?: string;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface TraceSummary {
  traceId: string;
  turnId?: string;
  sessionId?: string;
  agentId?: string;
  startTs: number;
  endTs: number;
  eventCount: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
  status: "running" | "succeeded" | "failed" | "budget_terminated";
}

export class TraceStore {
  private off: (() => void) | undefined;

  constructor(private readonly db: GinDatabase) {
    migrate(db, "obs", MIGRATIONS);
  }

  /** Subscribe to the bus; returns this for chaining. Call detach() to stop. */
  attach(bus: EventBus): this {
    this.off = bus.on("*", (event) => this.ingest(event));
    return this;
  }

  detach(): void {
    this.off?.();
    this.off = undefined;
  }

  ingest(event: GinEvent): void {
    if (!TRACED_PREFIXES.some((p) => event.type.startsWith(p))) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trace_events (id, trace_id, turn_id, type, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        typeof payload.traceId === "string" ? payload.traceId : null,
        typeof payload.turnId === "string" ? payload.turnId : null,
        event.type,
        JSON.stringify(payload),
        event.ts,
      );
  }

  /** Full ordered timeline for one trace. */
  getTrace(traceId: string): TraceEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY id")
      .all(traceId) as Record<string, unknown>[];
    return rows.map(toEvent);
  }

  /** Recent traces, newest first, with step/cost rollups. */
  listTraces(limit = 50): TraceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT trace_id, MIN(ts) AS start_ts, MAX(ts) AS end_ts, COUNT(*) AS n
         FROM trace_events
         WHERE trace_id IS NOT NULL
         GROUP BY trace_id
         ORDER BY MAX(id) DESC
         LIMIT ?`,
      )
      .all(limit) as { trace_id: string; start_ts: number; end_ts: number; n: number }[];
    return rows.map((row) => this.summarize(row.trace_id, row.start_ts, row.end_ts, row.n));
  }

  /** Total recorded model spend since a timestamp (cockpit headline number). */
  totalCostUsd(sinceTs = 0): number {
    const rows = this.db
      .prepare("SELECT payload FROM trace_events WHERE type = 'model.called' AND ts >= ?")
      .all(sinceTs) as { payload: string }[];
    return rows.reduce((acc, row) => {
      const cost = (JSON.parse(row.payload) as { costUsd?: number }).costUsd;
      return acc + (typeof cost === "number" ? cost : 0);
    }, 0);
  }

  private summarize(traceId: string, startTs: number, endTs: number, n: number): TraceSummary {
    const events = this.getTrace(traceId);
    let modelCalls = 0;
    let toolCalls = 0;
    let costUsd = 0;
    let status: TraceSummary["status"] = "running";
    let turnId: string | undefined;
    let sessionId: string | undefined;
    let agentId: string | undefined;

    for (const event of events) {
      turnId ??= event.turnId;
      if (typeof event.payload.sessionId === "string") sessionId ??= event.payload.sessionId;
      if (typeof event.payload.agentId === "string") agentId ??= event.payload.agentId;
      switch (event.type) {
        case "model.called":
          modelCalls++;
          if (typeof event.payload.costUsd === "number") costUsd += event.payload.costUsd;
          break;
        case "step.finished":
          toolCalls++;
          break;
        case "turn.completed":
          status = "succeeded";
          break;
        case "turn.failed":
          status = "failed";
          break;
        case "turn.budget_terminated":
          status = "budget_terminated";
          break;
      }
    }

    return {
      traceId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      startTs,
      endTs,
      eventCount: n,
      modelCalls,
      toolCalls,
      costUsd,
      status,
    };
  }
}

function toEvent(row: Record<string, unknown>): TraceEvent {
  return {
    id: row.id as string,
    ...(row.trace_id !== null ? { traceId: row.trace_id as string } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id as string } : {}),
    type: row.type as string,
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    ts: row.ts as number,
  };
}
