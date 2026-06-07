import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type GinEvent } from "@gin/core";
import { BudgetEngine } from "@gin/cost";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { openDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

/** Provider with a fixed per-call cost; loops tool calls until script ends. */
class CostedProvider implements ModelProvider {
  readonly name = "fake";
  requests: ChatRequest[] = [];
  costPerCall = 0.004;
  /** How many tool_use rounds before a final text answer. */
  toolRounds = 100; // effectively infinite — budget must stop it
  replyText = "all done";

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (this.requests.length <= this.toolRounds) {
      return {
        model: "costed",
        content: [
          { type: "tool_use", id: `t${this.requests.length}`, name: "time.now", input: {} },
        ],
        stopReason: "tool_use",
        usage,
        costUsd: this.costPerCall,
      };
    }
    return {
      model: "costed",
      content: [{ type: "text", text: this.replyText }],
      stopReason: "end_turn",
      usage,
      costUsd: this.costPerCall,
    };
  }
}

let store: SessionStore;
let budget: BudgetEngine;
let provider: CostedProvider;
let runtime: AgentRuntime;
let events: GinEvent[];

function setup(budgetPolicy: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const db = openDatabase({ path: ":memory:" });
  const bus = new EventBus();
  events = [];
  bus.on("*", (e) => events.push(e));
  store = new SessionStore(db);
  budget = new BudgetEngine(db, { bus });
  provider = new CostedProvider();
  runtime = new AgentRuntime({
    store,
    bus,
    router: new ModelRouter().register(provider),
    registry: registerCoreTools(new ToolRegistry()),
    budget,
    maxIterations: 50,
    ...opts,
  });
  return store.createAgent({
    tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    name: "budgeted-agent",
    workspacePath: mkdtempSync(join(tmpdir(), "gin-p2-")),
    modelConfig: { primary: "fake/costed", fallbacks: [] },
    budgetPolicy,
  }).id;
}

describe("budget-terminates-overspend (flagship)", () => {
  it("stops a runaway tool loop the moment the session budget is exhausted", async () => {
    // $0.008 budget, $0.004/call, infinite tool loop → exactly 2 calls allowed.
    const agentId = setup({ perSessionUsd: 0.008, action: "block" });

    const result = await runtime.runTurn({ agentId, userText: "go wild", peerRef: "u1" });

    expect(result.status).toBe("budget_terminated");
    expect(result.text).toMatch(/Budget limit reached/);
    expect(provider.requests).toHaveLength(2); // third call never happened
    expect(result.costUsd).toBeCloseTo(0.008);

    // Recorded as a first-class outcome, not a generic failure.
    expect(store.getTurn(result.turnId)!.status).toBe("budget_terminated");
    const types = events.map((e) => e.type);
    expect(types).toContain("budget.exceeded");
    expect(types).toContain("turn.budget_terminated");
    expect(types).not.toContain("turn.failed");

    // The user got told, on the record.
    const history = store.history(result.sessionId);
    expect(history.at(-1)!.content).toMatch(/Budget limit reached/);
  });

  it("subsequent turns in the same session are blocked before any model call", async () => {
    const agentId = setup({ perSessionUsd: 0.008, action: "block" });
    const first = await runtime.runTurn({ agentId, userText: "go", peerRef: "u1" });
    expect(first.status).toBe("budget_terminated");

    const callsAfterFirst = provider.requests.length;
    const second = await runtime.runTurn({ agentId, userText: "again", peerRef: "u1" });
    expect(second.status).toBe("budget_terminated");
    expect(provider.requests.length).toBe(callsAfterFirst); // zero new model calls
  });

  it("alert-mode budgets warn but never terminate", async () => {
    const agentId = setup({ perSessionUsd: 0.004, action: "alert" });
    provider.toolRounds = 2;
    const result = await runtime.runTurn({ agentId, userText: "go", peerRef: "u1" });
    expect(result.status).toBe("succeeded");
    expect(events.map((e) => e.type)).toContain("budget.warning");
  });

  it("runs without any budget engine exactly as before", async () => {
    const agentId = setup({}, {});
    provider.toolRounds = 1;
    const result = await runtime.runTurn({ agentId, userText: "hi", peerRef: "u1" });
    expect(result.status).toBe("succeeded");
  });
});

describe("session compaction", () => {
  it("summarizes older history once the live window exceeds compactAfter", async () => {
    const agentId = setup({}, { compactAfter: 6, compactKeep: 2 });
    provider.toolRounds = 0; // plain text replies
    provider.replyText = "reply";

    // Each turn adds 2 messages. Turn 4 → 8 live messages > 6 → compaction.
    for (let i = 1; i <= 4; i++) {
      await runtime.runTurn({ agentId, userText: `message ${i}`, peerRef: "u1" });
    }

    const compacted = events.find((e) => e.type === "session.compacted");
    expect(compacted).toBeDefined();
    const payload = compacted!.payload as { summarizedMessages: number; sessionId: string };
    expect(payload.summarizedMessages).toBe(6); // 8 live - keep 2

    const state = store.getCompaction(payload.sessionId);
    expect(state.summary).toBe("reply"); // provider's canned summary text
    expect(state.summaryUntil).toBeDefined();

    // Next turn: assembled history excludes summarized messages…
    await runtime.runTurn({ agentId, userText: "message 5", peerRef: "u1" });
    const lastRequest = provider.requests.at(-1)!;
    expect(lastRequest.messages.length).toBeLessThanOrEqual(4); // 2 kept + new pair vs 9+
    // …and the summary rides in the system prompt instead.
    expect(lastRequest.system).toContain("<conversation_summary>");
  });

  it("a failed compaction never fails the turn", async () => {
    const agentId = setup({}, { compactAfter: 2, compactKeep: 1 });
    provider.toolRounds = 0;

    // Force the compaction call (request #3) to fail by exhausting after turn replies:
    let calls = 0;
    provider.chat = async function (this: CostedProvider, req: ChatRequest): Promise<ChatResult> {
      calls++;
      this.requests.push(req);
      if (req.system?.includes("compress conversation history")) {
        throw new Error("summarizer down");
      }
      return {
        model: "costed",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
      };
    }.bind(provider) as typeof provider.chat;

    const r1 = await runtime.runTurn({ agentId, userText: "one", peerRef: "u1" });
    const r2 = await runtime.runTurn({ agentId, userText: "two", peerRef: "u1" });
    expect(r1.status).toBe("succeeded");
    expect(r2.status).toBe("succeeded");
    expect(events.map((e) => e.type)).toContain("session.compact_failed");
    expect(calls).toBeGreaterThan(2);
  });

  it("compaction spend is budgeted and recorded", async () => {
    const agentId = setup({ perSessionUsd: 1 }, { compactAfter: 2, compactKeep: 1 });
    provider.toolRounds = 0;
    await runtime.runTurn({ agentId, userText: "one", peerRef: "u1" });
    const result = await runtime.runTurn({ agentId, userText: "two", peerRef: "u1" });

    const spent = budget.spent("session", result.sessionId, "session");
    // 2 turn calls + 1 compaction call, $0.004 each.
    expect(spent).toBeCloseTo(0.012);
  });
});
