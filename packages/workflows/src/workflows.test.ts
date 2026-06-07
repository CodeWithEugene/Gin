import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@gin/core";
import { BudgetEngine } from "@gin/cost";
import { CrashSignal, DurableEngine } from "@gin/durable";
import { ApprovalBroker } from "@gin/governance";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { openDatabase, type GinDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools, type ToolContext } from "@gin/tools";
import { WorkflowRunner } from "./compiler.js";
import { resolveTemplates } from "./spec.js";

class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  requests: ChatRequest[] = [];
  replies: { text: string; costUsd?: number }[] = [];
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.replies.shift() ?? { text: "default" };
    return {
      model: "test",
      content: [{ type: "text", text: next.text }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: next.costUsd ?? 0.001,
    };
  }
}

let db: GinDatabase;
let bus: EventBus;
let provider: ScriptedProvider;
let broker: ApprovalBroker;
let budget: BudgetEngine;
let toolContext: ToolContext;

function newRunner(): WorkflowRunner {
  return new WorkflowRunner({
    durable: new DurableEngine(db, { bus, sleepFn: async () => {} }),
    registry: registerCoreTools(new ToolRegistry()),
    router: new ModelRouter().register(provider),
    defaultModelRef: "fake/test",
    toolContext,
    budget,
    approvals: broker,
  });
}

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  bus = new EventBus();
  provider = new ScriptedProvider();
  broker = new ApprovalBroker(db, { bus });
  budget = new BudgetEngine(db, { bus });
  toolContext = {
    agentId: "wf-agent",
    sessionId: "wf-session",
    workspacePath: mkdtempSync(join(tmpdir(), "gin-wf-")),
  };
});

describe("template resolution", () => {
  const state = {
    input: { folder: "inbox", n: 2 },
    steps: { list: { output: { emails: ["a", "b"] } } },
  };

  it("resolves full templates to raw values and embedded ones to strings", () => {
    expect(resolveTemplates("{{input.folder}}", state)).toBe("inbox");
    expect(resolveTemplates("{{steps.list.output}}", state)).toEqual({ emails: ["a", "b"] });
    expect(resolveTemplates("Found: {{steps.list.output.emails}}!", state)).toBe(
      'Found: ["a","b"]!',
    );
    expect(resolveTemplates({ x: "{{input.n}}", y: ["{{input.folder}}"] }, state)).toEqual({
      x: 2,
      y: ["inbox"],
    });
  });

  it("missing paths resolve to undefined / empty string", () => {
    expect(resolveTemplates("{{steps.nope.output}}", state)).toBeUndefined();
    expect(resolveTemplates("x={{steps.nope.output}}", state)).toBe("x=");
  });
});

describe("WorkflowRunner", () => {
  it("runs tool → model → tool with state threading (triage shape)", async () => {
    const runner = newRunner();
    provider.replies = [{ text: "URGENT" }];
    runner.register({
      name: "triage",
      steps: [
        { id: "now", kind: "tool", tool: "time.now", args: {} },
        {
          id: "classify",
          kind: "model",
          prompt: "Classify this message received at {{steps.now.output.iso}}: {{input.text}}",
        },
        {
          id: "save",
          kind: "tool",
          tool: "fs.write",
          args: { path: "triage.txt", content: "verdict: {{steps.classify.output}}" },
        },
      ],
      output: "{{steps.classify.output}}",
    });

    const { output } = await runner.start("triage", { text: "server down!!" });
    expect(output).toBe("URGENT");
    expect(provider.requests[0]!.messages[0]!.content[0]).toMatchObject({
      type: "text",
    });
    const prompt = (provider.requests[0]!.messages[0]!.content[0] as { text: string }).text;
    expect(prompt).toContain("server down!!");
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}T/); // resolved ISO timestamp
  });

  it("rejects invalid specs and duplicate step ids", () => {
    const runner = newRunner();
    expect(() => runner.register({ name: "bad" })).toThrow(/Invalid workflow spec/);
    expect(() =>
      runner.register({
        name: "dups",
        steps: [
          { id: "a", kind: "tool", tool: "time.now", args: {} },
          { id: "a", kind: "tool", tool: "time.now", args: {} },
        ],
      }),
    ).toThrow(/Duplicate step id/);
  });

  it("blocks at approval steps until approved", async () => {
    const runner = newRunner();
    bus.on("approval.requested", (e) => {
      const { approvalId } = e.payload as { approvalId: string };
      queueMicrotask(() => broker.decide(approvalId, "approved", "op"));
    });
    runner.register({
      name: "gated",
      steps: [
        { id: "gate", kind: "approval", action: "ship-it", riskLevel: "high" },
        { id: "after", kind: "tool", tool: "time.now", args: {} },
      ],
    });
    const { output } = await runner.start("gated", {});
    expect(output).toHaveProperty("iso");
    expect(broker.list()[0]).toMatchObject({ status: "approved" });
  });

  it("denied approvals fail the workflow with approval_required", async () => {
    const runner = newRunner();
    bus.on("approval.requested", (e) => {
      const { approvalId } = e.payload as { approvalId: string };
      queueMicrotask(() => broker.decide(approvalId, "denied", "op"));
    });
    runner.register({
      name: "denied",
      steps: [{ id: "gate", kind: "approval", action: "ship-it" }],
    });
    await expect(runner.start("denied", {})).rejects.toMatchObject({ code: "approval_required" });
  });

  it("enforces per-step model budget caps", async () => {
    const runner = newRunner();
    provider.replies = [{ text: "expensive!", costUsd: 0.5 }];
    runner.register({
      name: "capped",
      steps: [{ id: "classify", kind: "model", prompt: "go", budgetUsd: 0.05 }],
    });
    await expect(runner.start("capped", {})).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("crash mid-pipeline resumes without re-running completed steps (durable)", async () => {
    let toolRuns = 0;
    let crash = true;
    const registry = new ToolRegistry().register({
      name: "counter.bump",
      description: "test counter",
      toolset: "test",
      riskLevel: "low",
      paramsSchema: (await import("zod")).z.object({}),
      async execute() {
        toolRuns++;
        if (toolRuns === 1 && crash) throw new CrashSignal();
        return { runs: toolRuns };
      },
    });
    const durable = new DurableEngine(db, { bus, sleepFn: async () => {} });
    const buildRunner = (engine: DurableEngine) => {
      const runner = new WorkflowRunner({
        durable: engine,
        registry,
        router: new ModelRouter().register(provider),
        defaultModelRef: "fake/test",
        toolContext,
      });
      runner.register({
        name: "crashy",
        steps: [
          { id: "first", kind: "tool", tool: "counter.bump", args: {} },
          { id: "second", kind: "tool", tool: "counter.bump", args: {} },
        ],
      });
      return runner;
    };

    buildRunner(durable);
    await expect(durable.start("crashy", {})).rejects.toBeInstanceOf(CrashSignal);
    const workflowId = durable.list("running")[0]!.id;

    crash = false;
    const durable2 = new DurableEngine(db, { bus, sleepFn: async () => {} });
    buildRunner(durable2);
    const record = await durable2.resume(workflowId);
    expect(record.status).toBe("succeeded");
    // First step crashed before recording → re-ran (attempt 2), second ran once.
    expect(toolRuns).toBe(3);
    expect(record.output).toEqual({ runs: 3 });
  });
});
