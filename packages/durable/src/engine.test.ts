import { beforeEach, describe, expect, it } from "vitest";
import { EventBus, GinError } from "@gin/core";
import { openDatabase, type GinDatabase } from "@gin/storage";
import { CrashSignal, DurableEngine, type WorkflowContext } from "./engine.js";

const noSleep = async () => {};

let db: GinDatabase;
beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
});

function newEngine(bus?: EventBus): DurableEngine {
  return new DurableEngine(db, { sleepFn: noSleep, ...(bus ? { bus } : {}) });
}

describe("kill at step 6 → resume (flagship)", () => {
  it("resumes from the checkpoint: steps 1-6 replay, 7-10 execute, each exactly once", async () => {
    const executions = new Map<number, number>();
    let crashAfterStep6 = true;

    const defineWorkflow = (engine: DurableEngine) =>
      engine.register("ten-steps", async (ctx: WorkflowContext) => {
        const results: number[] = [];
        for (let i = 1; i <= 10; i++) {
          const value = await ctx.step(`step-${i}`, async () => {
            executions.set(i, (executions.get(i) ?? 0) + 1);
            return i * 10;
          });
          results.push(value);
          if (i === 6 && crashAfterStep6) throw new CrashSignal();
        }
        return { results };
      });

    // First run: the process dies right after step 6 commits.
    const engine1 = defineWorkflow(newEngine());
    await expect(engine1.start("ten-steps", {})).rejects.toBeInstanceOf(CrashSignal);

    const running = engine1.list("running");
    expect(running).toHaveLength(1);
    const workflowId = running[0]!.id;
    for (let i = 1; i <= 6; i++) expect(executions.get(i)).toBe(1);
    expect(executions.get(7)).toBeUndefined();

    // "Reboot": a fresh engine instance over the same database resumes.
    crashAfterStep6 = false;
    const engine2 = defineWorkflow(newEngine());
    const record = await engine2.resume(workflowId);

    expect(record.status).toBe("succeeded");
    expect(record.output).toEqual({ results: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] });
    // Exactly once, every step — 1-6 were replayed, never re-executed.
    for (let i = 1; i <= 10; i++) expect(executions.get(i)).toBe(1);
  });

  it("returns recorded results on replay instead of recomputing", async () => {
    let counter = 0;
    let crash = true;
    const define = (engine: DurableEngine) =>
      engine.register("counting", async (ctx: WorkflowContext) => {
        const first = await ctx.step("first", async () => ++counter);
        if (crash) throw new CrashSignal();
        const second = await ctx.step("second", async () => ++counter);
        return { first, second };
      });

    await expect(define(newEngine()).start("counting", {})).rejects.toBeInstanceOf(CrashSignal);
    crash = false;
    const record = await define(newEngine()).resume(newEngine().list("running")[0]!.id);
    // "first" replays its recorded value 1; only "second" increments anew.
    expect(record.output).toEqual({ first: 1, second: 2 });
  });
});

describe("retries", () => {
  it("retries retryable failures up to maxAttempts", async () => {
    let attempts = 0;
    const engine = newEngine().register("flaky", async (ctx: WorkflowContext) =>
      ctx.step(
        "flaky-step",
        async () => {
          attempts++;
          if (attempts < 3) throw new GinError("provider_error", "transient", { retryable: true });
          return "ok";
        },
        { maxAttempts: 5 },
      ),
    );
    const record = await engine.start("flaky", {});
    expect(record.status).toBe("succeeded");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable failures", async () => {
    let attempts = 0;
    const engine = newEngine().register("hard-fail", async (ctx: WorkflowContext) =>
      ctx.step("bad", async () => {
        attempts++;
        throw new GinError("validation_failed", "no", { retryable: false });
      }),
    );
    await expect(engine.start("hard-fail", {})).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(attempts).toBe(1);
    expect(engine.list("failed")).toHaveLength(1);
  });
});

describe("compensation", () => {
  it("runs compensations in reverse order on terminal failure", async () => {
    const undone: string[] = [];
    const engine = newEngine().register("booking", async (ctx: WorkflowContext) => {
      await ctx.step("book-flight", async () => "F1", {
        compensate: async () => {
          undone.push("flight");
        },
      });
      await ctx.step("book-hotel", async () => "H1", {
        compensate: async () => {
          undone.push("hotel");
        },
      });
      await ctx.step("charge-card", async () => {
        throw new GinError("tool_error", "card declined", { retryable: false });
      });
    });

    await expect(engine.start("booking", {})).rejects.toMatchObject({ code: "tool_error" });
    expect(undone).toEqual(["hotel", "flight"]); // newest first
    const record = engine.list()[0]!;
    expect(record.status).toBe("compensated");
    const types = engine.events(record.id).map((e) => e.type);
    expect(types.filter((t) => t === "compensation_completed")).toHaveLength(2);
  });
});

describe("recovery & bookkeeping", () => {
  it("resume on a finished workflow returns the terminal record untouched", async () => {
    let runs = 0;
    const engine = newEngine().register("once", async (ctx: WorkflowContext) =>
      ctx.step("only", async () => ++runs),
    );
    const done = await engine.start("once", {});
    const again = await engine.resume(done.id);
    expect(again.status).toBe("succeeded");
    expect(runs).toBe(1);
  });

  it("resumeAll recovers every running workflow on boot", async () => {
    let crash = true;
    const define = (engine: DurableEngine) =>
      engine.register("pair", async (ctx: WorkflowContext) => {
        await ctx.step("a", async () => "a");
        if (crash) throw new CrashSignal();
        await ctx.step("b", async () => "b");
        return "done";
      });

    const engine1 = define(newEngine());
    await expect(engine1.start("pair", { n: 1 })).rejects.toBeInstanceOf(CrashSignal);
    await expect(engine1.start("pair", { n: 2 })).rejects.toBeInstanceOf(CrashSignal);
    expect(engine1.list("running")).toHaveLength(2);

    crash = false;
    const recovered = await define(newEngine()).resumeAll();
    expect(recovered.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("detects non-deterministic replay as checkpoint_corrupt", async () => {
    let crash = true;
    const engine1 = newEngine().register("drift", async (ctx: WorkflowContext) => {
      await ctx.step("original-name", async () => 1);
      if (crash) throw new CrashSignal();
      return "done";
    });
    await expect(engine1.start("drift", {})).rejects.toBeInstanceOf(CrashSignal);
    const id = engine1.list("running")[0]!.id;

    crash = false;
    const engine2 = newEngine().register("drift", async (ctx: WorkflowContext) => {
      await ctx.step("renamed", async () => 1); // code changed under a live run
      return "done";
    });
    await expect(engine2.resume(id)).rejects.toMatchObject({ code: "checkpoint_corrupt" });
  });

  it("emits workflow.* events on the bus", async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.on("*", (e) => types.push(e.type));
    const engine = newEngine(bus).register("evented", async (ctx: WorkflowContext) =>
      ctx.step("s", async () => 1),
    );
    await engine.start("evented", {});
    expect(types).toEqual(
      expect.arrayContaining(["workflow.started", "workflow.step_completed", "workflow.completed"]),
    );
  });
});
