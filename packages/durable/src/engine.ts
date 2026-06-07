import { EventBus, GinError, isGinError, newId, toGinError } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * The durable execution engine (spec Phase 2 — the spine). Workflows are
 * event-sourced: every completed step is appended to a SQLite log before the
 * workflow proceeds, so a crash at step N resumes by replaying the log —
 * steps 1..N-1 return their recorded results without re-executing, and work
 * continues from N. Failures after retries run registered compensations in
 * reverse order. A crash never restarts work; it resumes it.
 *
 * Determinism contract: a workflow function must call ctx.step() in the same
 * order with the same names on every run. The engine verifies names during
 * replay and fails with checkpoint_corrupt on drift rather than silently
 * misattributing results.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "workflows",
    up: (db) => {
      db.exec(`
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running', 'succeeded', 'failed', 'compensated')),
          input TEXT,
          output TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX workflows_status ON workflows (status);
        CREATE TABLE workflow_events (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflows(id),
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (workflow_id, seq)
        );
      `);
    },
  },
];

export interface StepOptions {
  /** Attempts for retryable failures before the step fails (default 3). */
  maxAttempts?: number;
  /** Runs (reverse order) if the workflow later fails terminally. */
  compensate?: () => Promise<void>;
}

export interface WorkflowContext {
  readonly workflowId: string;
  /** Run a checkpointed step. Replayed (not re-executed) after a resume. */
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
}

export type WorkflowFn<I = unknown, O = unknown> = (ctx: WorkflowContext, input: I) => Promise<O>;

export type WorkflowStatus = "running" | "succeeded" | "failed" | "compensated";

export interface WorkflowRecord {
  id: string;
  name: string;
  status: WorkflowStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/**
 * Chaos hook: a step (or test harness) throws this to emulate a process
 * crash. The engine rethrows WITHOUT recording any event — exactly what a
 * real crash leaves behind — so resume paths can be tested honestly.
 */
export class CrashSignal extends Error {
  constructor(message = "simulated crash") {
    super(message);
    this.name = "CrashSignal";
  }
}

export interface DurableEngineOptions {
  bus?: EventBus;
  /** Injectable retry delay (tests pass a no-op). */
  sleepFn?: (ms: number) => Promise<void>;
  retryBaseMs?: number;
}

export class DurableEngine {
  private readonly definitions = new Map<string, WorkflowFn>();
  private readonly inFlight = new Set<string>();
  private readonly bus: EventBus;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly retryBaseMs: number;

  constructor(
    private readonly db: GinDatabase,
    opts: DurableEngineOptions = {},
  ) {
    this.bus = opts.bus ?? new EventBus();
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retryBaseMs = opts.retryBaseMs ?? 250;
    migrate(db, "durable", MIGRATIONS);
  }

  register<I, O>(name: string, fn: WorkflowFn<I, O>): this {
    if (this.definitions.has(name)) {
      throw new GinError("config_invalid", `Workflow "${name}" already registered.`);
    }
    this.definitions.set(name, fn as WorkflowFn);
    return this;
  }

  /** Start a new workflow run and drive it to a terminal state (or crash). */
  async start(name: string, input: unknown): Promise<WorkflowRecord> {
    if (!this.definitions.has(name)) {
      throw new GinError("not_found", `No workflow registered as "${name}".`);
    }
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, status, input, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, name, JSON.stringify(input ?? null), now, now);
    this.append(id, "workflow_started", { name, input });
    this.bus.emit("workflow.started", { workflowId: id, name });
    return this.drive(id);
  }

  /** Resume a previously started workflow (after crash or restart). */
  async resume(workflowId: string): Promise<WorkflowRecord> {
    const record = this.get(workflowId);
    if (!record) throw new GinError("not_found", `Unknown workflow: ${workflowId}`);
    if (record.status !== "running") return record;
    this.bus.emit("workflow.resumed", { workflowId, name: record.name });
    return this.drive(workflowId);
  }

  /** Crash recovery: resume every workflow left in 'running'. Call on boot. */
  async resumeAll(): Promise<WorkflowRecord[]> {
    const rows = this.db
      .prepare("SELECT id FROM workflows WHERE status = 'running' ORDER BY id")
      .all() as { id: string }[];
    const results: WorkflowRecord[] = [];
    for (const row of rows) {
      try {
        results.push(await this.resume(row.id));
      } catch (err) {
        if (err instanceof CrashSignal) throw err;
        // Terminal failure is a recorded outcome, not a recovery error.
        const record = this.get(row.id);
        if (record) results.push(record);
      }
    }
    return results;
  }

  get(workflowId: string): WorkflowRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(workflowId) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(status?: WorkflowStatus, limit = 100): WorkflowRecord[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM workflows WHERE status = ? ORDER BY id DESC LIMIT ?")
            .all(status, limit)
        : this.db.prepare("SELECT * FROM workflows ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  events(workflowId: string): WorkflowEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY seq")
      .all(workflowId) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      type: r.type as string,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
      createdAt: r.created_at as number,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async drive(workflowId: string): Promise<WorkflowRecord> {
    if (this.inFlight.has(workflowId)) {
      throw new GinError("workflow_failed", `Workflow ${workflowId} is already executing here.`);
    }
    this.inFlight.add(workflowId);
    try {
      const record = this.get(workflowId)!;
      const definition = this.definitions.get(record.name);
      if (!definition) {
        throw new GinError(
          "not_found",
          `Workflow "${record.name}" is not registered in this engine.`,
        );
      }

      // Replay table: step index → recorded completion.
      const replay = new Map<number, { name: string; result: unknown }>();
      const compensated = new Set<number>();
      for (const event of this.events(workflowId)) {
        if (event.type === "step_completed") {
          replay.set(event.payload.index as number, {
            name: event.payload.name as string,
            result: event.payload.result,
          });
        } else if (event.type === "compensation_completed") {
          compensated.add(event.payload.index as number);
        }
      }

      let stepIndex = 0;
      const compensations: { index: number; name: string; fn: () => Promise<void> }[] = [];

      const ctx: WorkflowContext = {
        workflowId,
        step: async <T>(name: string, fn: () => Promise<T>, opts: StepOptions = {}) => {
          const index = stepIndex++;
          const recorded = replay.get(index);
          if (recorded) {
            if (recorded.name !== name) {
              throw new GinError(
                "checkpoint_corrupt",
                `Replay mismatch at step ${index}: log has "${recorded.name}", code ran "${name}". ` +
                  "Workflow code must be deterministic.",
              );
            }
            if (opts.compensate) compensations.push({ index, name, fn: opts.compensate });
            return recorded.result as T;
          }

          const result = await this.runWithRetries(workflowId, name, index, fn, opts);
          this.append(workflowId, "step_completed", { index, name, result });
          this.bus.emit("workflow.step_completed", { workflowId, index, name });
          if (opts.compensate) compensations.push({ index, name, fn: opts.compensate });
          return result;
        },
      };

      try {
        const output = await definition(ctx, record.input);
        this.append(workflowId, "workflow_completed", { output });
        this.updateStatus(workflowId, "succeeded", { output });
        this.bus.emit("workflow.completed", { workflowId, name: record.name });
        return this.get(workflowId)!;
      } catch (err) {
        if (err instanceof CrashSignal) throw err; // leave 'running' — resume later
        const ginError = toGinError(err, "workflow_failed");
        this.append(workflowId, "step_failed", {
          index: stepIndex - 1,
          error: ginError.toJSON(),
        });
        const didCompensate = await this.compensate(workflowId, compensations, compensated);
        this.append(workflowId, "workflow_failed", { error: ginError.toJSON() });
        this.updateStatus(workflowId, didCompensate ? "compensated" : "failed", {
          error: ginError.message,
        });
        this.bus.emit("workflow.failed", {
          workflowId,
          name: record.name,
          error: ginError.toJSON(),
          compensated: didCompensate,
        });
        throw ginError;
      }
    } finally {
      this.inFlight.delete(workflowId);
    }
  }

  private async runWithRetries<T>(
    workflowId: string,
    name: string,
    index: number,
    fn: () => Promise<T>,
    opts: StepOptions,
  ): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof CrashSignal) throw err;
        lastError = err;
        const retryable = isGinError(err) ? err.retryable : false;
        if (!retryable || attempt === maxAttempts) break;
        this.bus.emit("workflow.step_retry", { workflowId, index, name, attempt });
        await this.sleepFn(this.retryBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  /** Run compensations newest-first, skipping any already recorded. */
  private async compensate(
    workflowId: string,
    compensations: { index: number; name: string; fn: () => Promise<void> }[],
    alreadyDone: Set<number>,
  ): Promise<boolean> {
    let ran = false;
    for (const comp of [...compensations].reverse()) {
      if (alreadyDone.has(comp.index)) continue;
      try {
        await comp.fn();
        ran = true;
        this.append(workflowId, "compensation_completed", {
          index: comp.index,
          name: comp.name,
        });
        this.bus.emit("workflow.compensated_step", { workflowId, ...comp });
      } catch {
        // A failing compensation must not mask the original failure; it is
        // recorded for the operator instead.
        this.append(workflowId, "compensation_failed", { index: comp.index, name: comp.name });
      }
    }
    return ran;
  }

  private append(workflowId: string, type: string, payload: Record<string, unknown>): void {
    const seq =
      ((
        this.db
          .prepare("SELECT MAX(seq) AS s FROM workflow_events WHERE workflow_id = ?")
          .get(workflowId) as { s: number | null }
      ).s ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO workflow_events (id, workflow_id, seq, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), workflowId, seq, type, JSON.stringify(payload), Date.now());
  }

  private updateStatus(
    workflowId: string,
    status: WorkflowStatus,
    extra: { output?: unknown; error?: string } = {},
  ): void {
    this.db
      .prepare(
        "UPDATE workflows SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        status,
        extra.output !== undefined ? JSON.stringify(extra.output) : null,
        extra.error ?? null,
        Date.now(),
        workflowId,
      );
  }
}

function toRecord(row: Record<string, unknown>): WorkflowRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as WorkflowStatus,
    input: row.input !== null ? JSON.parse(row.input as string) : null,
    ...(row.output !== null && row.output !== undefined
      ? { output: JSON.parse(row.output as string) }
      : {}),
    ...(row.error !== null && row.error !== undefined ? { error: row.error as string } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
