import { Cron } from "croner";
import { EventBus, GinError, newId, toGinError } from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";

/**
 * The scheduler (spec Phase 4): cron jobs persisted in SQLite that either
 * message an agent ("every morning, summarize my inbox") or start a durable
 * workflow. next_run_at is stored, so missed windows are visible after a
 * restart and run on the next tick. Each tick emits a heartbeat — silence on
 * the bus means the scheduler is down, not idle (anti-silent-failure).
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "jobs",
    up: (db) => {
      db.exec(`
        CREATE TABLE schedule_jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          cron TEXT NOT NULL,
          action TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_status TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX jobs_due ON schedule_jobs (enabled, next_run_at);
      `);
    },
  },
];

export type JobAction =
  | { kind: "message"; text: string }
  | { kind: "workflow"; workflow: string; input?: unknown };

export interface ScheduleJob {
  id: string;
  name: string;
  cron: string;
  action: JobAction;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export interface SchedulerPorts {
  /** Run a scheduled message as an agent turn; resolves with the reply text. */
  onMessage?: (text: string, jobName: string) => Promise<string>;
  /** Start (and await) a durable workflow. */
  onWorkflow?: (workflow: string, input: unknown, jobName: string) => Promise<unknown>;
}

export interface SchedulerOptions extends SchedulerPorts {
  bus?: EventBus;
}

export class Scheduler {
  private readonly bus: EventBus;
  private readonly ports: SchedulerPorts;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: GinDatabase,
    opts: SchedulerOptions = {},
  ) {
    this.bus = opts.bus ?? new EventBus();
    this.ports = opts;
    migrate(db, "scheduler", MIGRATIONS);
  }

  /** Create or update a job by name. Validates the cron expression. */
  setJob(input: { name: string; cron: string; action: JobAction; enabled?: boolean }): ScheduleJob {
    const next = nextRun(input.cron, Date.now());
    if (next === undefined) {
      throw new GinError("validation_failed", `Cron "${input.cron}" never fires.`);
    }
    const enabled = input.enabled ?? true;
    const existing = this.getByName(input.name);
    if (existing) {
      this.db
        .prepare(
          "UPDATE schedule_jobs SET cron = ?, action = ?, enabled = ?, next_run_at = ? WHERE name = ?",
        )
        .run(input.cron, JSON.stringify(input.action), enabled ? 1 : 0, next, input.name);
      this.bus.emit("scheduler.job_set", { name: input.name, cron: input.cron });
      return this.getByName(input.name)!;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO schedule_jobs (id, name, cron, action, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.cron,
        JSON.stringify(input.action),
        enabled ? 1 : 0,
        next,
        Date.now(),
      );
    this.bus.emit("scheduler.job_set", { name: input.name, cron: input.cron });
    return this.getByName(input.name)!;
  }

  getByName(name: string): ScheduleJob | undefined {
    const row = this.db.prepare("SELECT * FROM schedule_jobs WHERE name = ?").get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? toJob(row) : undefined;
  }

  list(): ScheduleJob[] {
    const rows = this.db.prepare("SELECT * FROM schedule_jobs ORDER BY name").all() as Record<
      string,
      unknown
    >[];
    return rows.map(toJob);
  }

  delete(name: string): boolean {
    const changed = this.db.prepare("DELETE FROM schedule_jobs WHERE name = ?").run(name).changes;
    if (changed > 0) this.bus.emit("scheduler.job_deleted", { name });
    return changed > 0;
  }

  /** Run everything due; reschedule; heartbeat. Called on an interval. */
  async tick(now = Date.now()): Promise<{ ran: number; failed: number }> {
    this.bus.emit("scheduler.heartbeat", { now, jobs: this.list().length });
    const due = this.db
      .prepare(
        "SELECT * FROM schedule_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
      )
      .all(now) as Record<string, unknown>[];

    let ran = 0;
    let failed = 0;
    for (const row of due) {
      const job = toJob(row);
      // Reschedule BEFORE running: a hung action must not stall the cadence,
      // and a crash mid-run shows last_status='started' — visible, not silent.
      const next = nextRun(job.cron, now);
      this.db
        .prepare(
          "UPDATE schedule_jobs SET next_run_at = ?, last_run_at = ?, last_status = 'started' WHERE id = ?",
        )
        .run(next ?? null, now, job.id);
      this.bus.emit("scheduler.job_started", { name: job.name, action: job.action.kind });
      try {
        await this.run(job);
        this.db
          .prepare("UPDATE schedule_jobs SET last_status = 'succeeded' WHERE id = ?")
          .run(job.id);
        this.bus.emit("scheduler.job_completed", { name: job.name });
        ran++;
      } catch (err) {
        const ginError = toGinError(err);
        this.db
          .prepare("UPDATE schedule_jobs SET last_status = ? WHERE id = ?")
          .run(`failed: ${ginError.message.slice(0, 200)}`, job.id);
        this.bus.emit("scheduler.job_failed", { name: job.name, error: ginError.toJSON() });
        failed++;
      }
    }
    return { ran, failed };
  }

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async run(job: ScheduleJob): Promise<void> {
    switch (job.action.kind) {
      case "message": {
        if (!this.ports.onMessage) {
          throw new GinError("config_invalid", "Scheduler has no message port wired.");
        }
        await this.ports.onMessage(job.action.text, job.name);
        return;
      }
      case "workflow": {
        if (!this.ports.onWorkflow) {
          throw new GinError("config_invalid", "Scheduler has no workflow port wired.");
        }
        await this.ports.onWorkflow(job.action.workflow, job.action.input ?? {}, job.name);
        return;
      }
    }
  }
}

function nextRun(cron: string, from: number): number | undefined {
  try {
    const next = new Cron(cron).nextRun(new Date(from));
    return next ? next.getTime() : undefined;
  } catch (err) {
    throw new GinError("validation_failed", `Invalid cron expression "${cron}"`, { cause: err });
  }
}

function toJob(row: Record<string, unknown>): ScheduleJob {
  return {
    id: row.id as string,
    name: row.name as string,
    cron: row.cron as string,
    action: JSON.parse(row.action as string) as JobAction,
    enabled: row.enabled === 1,
    ...(row.next_run_at !== null ? { nextRunAt: row.next_run_at as number } : {}),
    ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at as number } : {}),
    ...(row.last_status !== null ? { lastStatus: row.last_status as string } : {}),
  };
}
