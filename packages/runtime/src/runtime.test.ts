import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, GinError, type GinEvent } from "@gin/core";
import { HashEmbedder, MemoryStore } from "@gin/memory";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { openDatabase } from "@gin/storage";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

/** Scripted provider: pops one canned result per call, records requests. */
class FakeProvider implements ModelProvider {
  readonly name = "fake";
  requests: ChatRequest[] = [];
  private script: (ChatResult | GinError)[] = [];

  enqueue(...results: (Partial<ChatResult> | GinError)[]): void {
    for (const r of results) {
      this.script.push(
        r instanceof GinError
          ? r
          : {
              model: "test-model",
              content: [{ type: "text", text: "ok" }],
              stopReason: "end_turn",
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
              costUsd: 0.001,
              ...r,
            },
      );
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("FakeProvider script exhausted");
    if (next instanceof GinError) throw next;
    return next;
  }
}

let store: SessionStore;
let bus: EventBus;
let provider: FakeProvider;
let runtime: AgentRuntime;
let memory: MemoryStore;
let agentId: string;
let events: GinEvent[];

beforeEach(() => {
  const db = openDatabase({ path: ":memory:" });
  store = new SessionStore(db);
  bus = new EventBus();
  events = [];
  bus.on("*", (e) => events.push(e));
  provider = new FakeProvider();
  memory = new MemoryStore(db, { embedder: new HashEmbedder() });
  runtime = new AgentRuntime({
    store,
    bus,
    router: new ModelRouter().register(provider),
    registry: registerCoreTools(new ToolRegistry()),
    memory,
    maxIterations: 4,
  });
  const agent = store.createAgent({
    tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    name: "test-agent",
    persona: "You are Gin, concise and direct.",
    workspacePath: mkdtempSync(join(tmpdir(), "gin-rt-")),
    modelConfig: { primary: "fake/test-model", fallbacks: [] },
    toolPolicy: { enabledToolsets: ["*"], deniedTools: [] },
    sandboxMode: "host",
    budgetPolicy: {},
  });
  agentId = agent.id;
});

describe("plain text turn", () => {
  it("persists messages, finishes the turn, and emits events", async () => {
    provider.enqueue({ content: [{ type: "text", text: "Hello Eugene!" }] });
    const result = await runtime.runTurn({ agentId, userText: "Hi", peerRef: "u1" });

    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("Hello Eugene!");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.costUsd).toBeCloseTo(0.001);

    const history = store.history(result.sessionId);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);

    const turn = store.getTurn(result.turnId)!;
    expect(turn.status).toBe("succeeded");

    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["turn.started", "model.called", "turn.completed"]),
    );
  });

  it("sends persona and tool specs to the model", async () => {
    provider.enqueue({});
    await runtime.runTurn({ agentId, userText: "Hi", peerRef: "u1" });
    const req = provider.requests[0]!;
    expect(req.system).toContain("You are Gin");
    expect(req.tools!.map((t) => t.name)).toContain("fs.read");
  });

  it("reuses the session per peer and includes prior history", async () => {
    provider.enqueue({ content: [{ type: "text", text: "first" }] });
    provider.enqueue({ content: [{ type: "text", text: "second" }] });
    const a = await runtime.runTurn({ agentId, userText: "one", peerRef: "u1" });
    const b = await runtime.runTurn({ agentId, userText: "two", peerRef: "u1" });
    expect(b.sessionId).toBe(a.sessionId);
    const secondRequest = provider.requests[1]!;
    expect(secondRequest.messages).toHaveLength(3); // one, first, two
  });
});

describe("tool loop", () => {
  it("executes requested tools and feeds results back", async () => {
    provider.enqueue({
      content: [{ type: "tool_use", id: "t1", name: "time.now", input: {} }],
      stopReason: "tool_use",
    });
    provider.enqueue({ content: [{ type: "text", text: "It is now." }] });

    const result = await runtime.runTurn({ agentId, userText: "time?", peerRef: "u1" });
    expect(result.text).toBe("It is now.");
    expect(result.stepCount).toBe(3); // model, tool, model

    const steps = store.steps(result.turnId);
    expect(steps.map((s) => s.type)).toEqual(["model_call", "tool_call", "model_call"]);
    expect(steps[1]!.status).toBe("succeeded");

    // Second request must carry the assistant tool_use + our tool_result.
    const followup = provider.requests[1]!;
    const last = followup.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", toolUseId: "t1" });
    expect((last.content[0] as { content: string }).content).toContain("iso");
  });

  it("returns tool failures to the model as error results without failing the turn", async () => {
    provider.enqueue({
      content: [{ type: "tool_use", id: "t1", name: "fs.read", input: { path: "missing.txt" } }],
      stopReason: "tool_use",
    });
    provider.enqueue({ content: [{ type: "text", text: "The file does not exist." }] });

    const result = await runtime.runTurn({ agentId, userText: "read it", peerRef: "u1" });
    expect(result.status).toBe("succeeded");

    const steps = store.steps(result.turnId);
    expect(steps[1]).toMatchObject({ type: "tool_call", status: "failed" });
    const followup = provider.requests[1]!;
    expect(followup.messages.at(-1)!.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
  });

  it("fails the turn when iterations exceed the cap", async () => {
    for (let i = 0; i < 4; i++) {
      provider.enqueue({
        content: [{ type: "tool_use", id: `t${i}`, name: "time.now", input: {} }],
        stopReason: "tool_use",
      });
    }
    await expect(
      runtime.runTurn({ agentId, userText: "loop", peerRef: "u1" }),
    ).rejects.toMatchObject({ code: "workflow_failed" });
    expect(events.map((e) => e.type)).toContain("turn.failed");
  });
});

describe("memory integration", () => {
  it("injects relevant memories into the system prompt", async () => {
    await memory.store({ agentId, text: "User's deploy target is Fly.io" });
    provider.enqueue({});
    await runtime.runTurn({ agentId, userText: "Where do we deploy? Fly.io?", peerRef: "u1" });
    expect(provider.requests[0]!.system).toContain("Fly.io");
    expect(provider.requests[0]!.system).toContain("<relevant_memories>");
  });

  it("lets the model store memories through the memory.store tool", async () => {
    provider.enqueue({
      content: [
        { type: "tool_use", id: "t1", name: "memory.store", input: { text: "User likes chai" } },
      ],
      stopReason: "tool_use",
    });
    provider.enqueue({ content: [{ type: "text", text: "Noted." }] });
    await runtime.runTurn({ agentId, userText: "remember I like chai", peerRef: "u1" });
    expect(memory.list(agentId).map((m) => m.text)).toContain("User likes chai");
  });
});

describe("failure handling", () => {
  it("marks the turn failed and rethrows on provider errors", async () => {
    provider.enqueue(new GinError("provider_error", "all backends down", { retryable: false }));
    await expect(runtime.runTurn({ agentId, userText: "hi", peerRef: "u1" })).rejects.toMatchObject(
      { code: "provider_error" },
    );
    const turnFailed = events.find((e) => e.type === "turn.failed");
    expect(turnFailed).toBeDefined();
  });

  it("rejects unknown agents", async () => {
    await expect(
      runtime.runTurn({ agentId: "01BX5ZZKBKACTAV9WEVGEMMVRZ", userText: "hi" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
