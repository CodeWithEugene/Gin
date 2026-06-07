import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "@gin/core";
import { openDatabase } from "@gin/storage";
import { Scheduler } from "./scheduler.js";

let bus: EventBus;
let events: string[];
let onMessage: ReturnType<typeof vi.fn>;
let onWorkflow: ReturnType<typeof vi.fn>;
let scheduler: Scheduler;

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.on("*", (e) => events.push(e.type));
  onMessage = vi.fn().mockResolvedValue("did it");
  onWorkflow = vi.fn().mockResolvedValue({ ok: true });
  scheduler = new Scheduler(openDatabase({ path: ":memory:" }), {
    bus,
    onMessage: onMessage as unknown as (t: string, j: string) => Promise<string>,
    onWorkflow: onWorkflow as unknown as (w: string, i: unknown, j: string) => Promise<unknown>,
  });
});

describe("job management", () => {
  it("creates, upserts, lists, and deletes jobs", () => {
    const job = scheduler.setJob({
      name: "morning-brief",
      cron: "0 7 * * *",
      action: { kind: "message", text: "Summarize my inbox" },
    });
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBeGreaterThan(Date.now());

    scheduler.setJob({
      name: "morning-brief",
      cron: "30 7 * * *",
      action: { kind: "message", text: "Summarize my inbox briefly" },
    });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.getByName("morning-brief")!.cron).toBe("30 7 * * *");

    expect(scheduler.delete("morning-brief")).toBe(true);
    expect(scheduler.delete("morning-brief")).toBe(false);
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      scheduler.setJob({ name: "bad", cron: "not a cron", action: { kind: "message", text: "x" } }),
    ).toThrow(/Invalid cron/);
  });
});

describe("tick", () => {
  it("runs due message jobs and reschedules", async () => {
    scheduler.setJob({
      name: "due-now",
      cron: "* * * * *",
      action: { kind: "message", text: "ping the agent" },
    });
    // Force the job due by backdating next_run_at:
    const future = Date.now() + 120_000;
    const result = await scheduler.tick(future);
    expect(result).toEqual({ ran: 1, failed: 0 });
    expect(onMessage).toHaveBeenCalledWith("ping the agent", "due-now");

    const job = scheduler.getByName("due-now")!;
    expect(job.lastStatus).toBe("succeeded");
    expect(job.nextRunAt).toBeGreaterThan(future);
    expect(events).toEqual(
      expect.arrayContaining([
        "scheduler.heartbeat",
        "scheduler.job_started",
        "scheduler.job_completed",
      ]),
    );
  });

  it("runs workflow jobs through the workflow port", async () => {
    scheduler.setJob({
      name: "nightly-triage",
      cron: "0 2 * * *",
      action: { kind: "workflow", workflow: "triage_inbox", input: { folder: "inbox" } },
    });
    await scheduler.tick(Date.now() + 25 * 3_600_000);
    expect(onWorkflow).toHaveBeenCalledWith("triage_inbox", { folder: "inbox" }, "nightly-triage");
  });

  it("records failures without stalling the schedule", async () => {
    onMessage.mockRejectedValueOnce(new Error("agent exploded"));
    scheduler.setJob({ name: "flaky", cron: "* * * * *", action: { kind: "message", text: "x" } });
    const result = await scheduler.tick(Date.now() + 61_000);
    expect(result.failed).toBe(1);
    const job = scheduler.getByName("flaky")!;
    expect(job.lastStatus).toContain("failed: agent exploded");
    expect(job.nextRunAt).toBeDefined(); // rescheduled despite the failure
    expect(events).toContain("scheduler.job_failed");
  });

  it("skips disabled jobs and jobs not yet due", async () => {
    scheduler.setJob({
      name: "later",
      cron: "0 0 1 1 *",
      action: { kind: "message", text: "happy new year" },
    });
    scheduler.setJob({
      name: "off",
      cron: "* * * * *",
      action: { kind: "message", text: "never" },
      enabled: false,
    });
    const result = await scheduler.tick(Date.now() + 61_000);
    expect(result.ran).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("emits a heartbeat on every tick", async () => {
    await scheduler.tick();
    await scheduler.tick();
    expect(events.filter((t) => t === "scheduler.heartbeat")).toHaveLength(2);
  });
});
