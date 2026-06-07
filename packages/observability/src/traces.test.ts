import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@gin/core";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { AgentRuntime, SessionStore } from "@gin/runtime";
import { openDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { TraceStore } from "./traces.js";

class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  private script: ChatResult[] = [];
  enqueue(...results: Partial<ChatResult>[]): void {
    for (const r of results) {
      this.script.push({
        model: "test",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ...r,
      });
    }
  }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

let bus: EventBus;
let traces: TraceStore;
let store: SessionStore;
let provider: ScriptedProvider;
let runtime: AgentRuntime;
let agentId: string;

beforeEach(() => {
  const db = openDatabase({ path: ":memory:" });
  bus = new EventBus();
  traces = new TraceStore(db).attach(bus);
  store = new SessionStore(db);
  provider = new ScriptedProvider();
  runtime = new AgentRuntime({
    store,
    bus,
    router: new ModelRouter().register(provider),
    registry: registerCoreTools(new ToolRegistry()),
  });
  agentId = store.createAgent({
    tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    name: "traced-agent",
    workspacePath: mkdtempSync(join(tmpdir(), "gin-obs-")),
    modelConfig: { primary: "fake/test", fallbacks: [] },
  }).id;
});

describe("trace-every-step (flagship)", () => {
  it("records every model call and tool call of a turn in the trace", async () => {
    provider.enqueue(
      {
        content: [
          { type: "tool_use", id: "t1", name: "time.now", input: {} },
          { type: "tool_use", id: "t2", name: "fs.list", input: { path: "." } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "t3", name: "time.now", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }] },
    );

    const result = await runtime.runTurn({ agentId, userText: "do things", peerRef: "u1" });

    const summaries = traces.listTraces();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.turnId).toBe(result.turnId);
    expect(summary.status).toBe("succeeded");

    const timeline = traces.getTrace(summary.traceId);
    const types = timeline.map((e) => e.type);

    // Every persisted step has a trace counterpart — nothing is silent.
    const persistedSteps = store.steps(result.turnId);
    const persistedModelCalls = persistedSteps.filter((s) => s.type === "model_call").length;
    const persistedToolCalls = persistedSteps.filter((s) => s.type === "tool_call").length;
    expect(types.filter((t) => t === "model.called")).toHaveLength(persistedModelCalls);
    expect(types.filter((t) => t === "step.finished")).toHaveLength(persistedToolCalls);
    expect(persistedModelCalls).toBe(3);
    expect(persistedToolCalls).toBe(3);

    // Lifecycle markers frame the timeline in order.
    expect(types[0]).toBe("turn.started");
    expect(types.at(-1)).toBe("turn.completed");

    // Cost rollup matches the turn's recorded spend.
    expect(summary.modelCalls).toBe(3);
    expect(summary.toolCalls).toBe(3);
    expect(summary.costUsd).toBeCloseTo(result.costUsd);
  });

  it("marks failed turns in the summary", async () => {
    // Empty script → provider throws → turn fails.
    await expect(runtime.runTurn({ agentId, userText: "boom", peerRef: "u1" })).rejects.toThrow();
    const summary = traces.listTraces()[0]!;
    expect(summary.status).toBe("failed");
  });
});

describe("trace store mechanics", () => {
  it("ignores untraced event types", () => {
    bus.emit("gateway.rpc", { method: "gin.ping" });
    bus.emit("turn.started", { turnId: "t", traceId: "tr" });
    expect(traces.listTraces()).toHaveLength(1);
  });

  it("totals model spend since a timestamp", () => {
    bus.emit("model.called", { traceId: "a", costUsd: 0.01 });
    bus.emit("model.called", { traceId: "a", costUsd: 0.02 });
    expect(traces.totalCostUsd()).toBeCloseTo(0.03);
    expect(traces.totalCostUsd(Date.now() + 1000)).toBe(0);
  });

  it("detach stops ingestion", () => {
    traces.detach();
    bus.emit("turn.started", { traceId: "x" });
    expect(traces.listTraces()).toHaveLength(0);
  });
});
