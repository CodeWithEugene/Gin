import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type GinEvent, type RiskLevel } from "@gin/core";
import { ApprovalBroker } from "@gin/governance";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { openDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { Verifier } from "@gin/verifier";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  requests: ChatRequest[] = [];
  private script: Partial<ChatResult>[] = [];
  enqueue(...results: Partial<ChatResult>[]): void {
    this.script.push(...results);
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return {
      model: "test",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ...next,
    };
  }
}

interface Harness {
  store: SessionStore;
  bus: EventBus;
  broker: ApprovalBroker;
  provider: ScriptedProvider;
  runtime: AgentRuntime;
  agentId: string;
  events: GinEvent[];
}

function setup(
  opts: { threshold?: RiskLevel; timeoutMs?: number; verifier?: boolean } = {},
): Harness {
  const db = openDatabase({ path: ":memory:" });
  const bus = new EventBus();
  const events: GinEvent[] = [];
  bus.on("*", (e) => events.push(e));
  const store = new SessionStore(db);
  const broker = new ApprovalBroker(db, { bus });
  const provider = new ScriptedProvider();
  const runtime = new AgentRuntime({
    store,
    bus,
    router: new ModelRouter().register(provider),
    registry: registerCoreTools(new ToolRegistry()),
    approvals: {
      broker,
      threshold: opts.threshold ?? "high",
      timeoutMs: opts.timeoutMs ?? 5_000,
    },
    ...(opts.verifier !== false ? { verifier: new Verifier() } : {}),
  });
  const agentId = store.createAgent({
    tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    name: "governed-agent",
    workspacePath: mkdtempSync(join(tmpdir(), "gin-p3-")),
    modelConfig: { primary: "fake/test", fallbacks: [] },
  }).id;
  return { store, bus, broker, provider, runtime, agentId, events };
}

/** Auto-decide the next approval request the moment it is announced. */
function autoDecide(h: Harness, decision: "approved" | "denied") {
  h.bus.on("approval.requested", (e) => {
    const { approvalId } = e.payload as { approvalId: string };
    // Decide on the next tick so the requester is already waiting.
    queueMicrotask(() => h.broker.decide(approvalId, decision, "test-operator"));
  });
}

describe("approval gates", () => {
  it("runs a high-risk tool only after approval, recording the approval step", async () => {
    const h = setup({ threshold: "high" });
    autoDecide(h, "approved");
    h.provider.enqueue(
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "shell.exec",
            input: { command: "echo approved-run" },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "The command ran." }] },
    );

    const result = await h.runtime.runTurn({
      agentId: h.agentId,
      userText: "run it",
      peerRef: "u1",
    });
    expect(result.status).toBe("succeeded");

    const steps = h.store.steps(result.turnId);
    expect(steps.map((s) => s.type)).toEqual([
      "model_call",
      "approval",
      "tool_call",
      "model_call",
      "verify",
    ]);
    expect(steps[1]).toMatchObject({ type: "approval", status: "succeeded" });
    const toolOutput = steps[2]!.output as { stdout: string };
    expect(toolOutput.stdout).toContain("approved-run");
    expect(h.broker.list()[0]).toMatchObject({ status: "approved", action: "shell.exec" });
  });

  it("denied approval blocks the tool; the model gets an error result", async () => {
    const h = setup({ threshold: "high" });
    autoDecide(h, "denied");
    h.provider.enqueue(
      {
        content: [
          { type: "tool_use", id: "t1", name: "shell.exec", input: { command: "rm -rf /" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "I couldn't run that — the operator denied it." }] },
    );

    const result = await h.runtime.runTurn({
      agentId: h.agentId,
      userText: "nuke it",
      peerRef: "u1",
    });
    expect(result.status).toBe("succeeded");

    const steps = h.store.steps(result.turnId);
    expect(steps.map((s) => s.type)).toEqual(["model_call", "approval", "model_call", "verify"]);
    expect(steps[1]).toMatchObject({ type: "approval", status: "failed" });
    // No tool_call step: the command never ran.
    const followup = h.provider.requests[1]!;
    const block = followup.messages.at(-1)!.content[0] as { content: string; isError?: boolean };
    expect(block.isError).toBe(true);
    expect(block.content).toMatch(/denied/);
  });

  it("an unanswered approval expires and counts as denial", async () => {
    const h = setup({ threshold: "high", timeoutMs: 40 });
    h.provider.enqueue(
      {
        content: [{ type: "tool_use", id: "t1", name: "shell.exec", input: { command: "true" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "No one approved it in time, so I stopped." }] },
    );
    const result = await h.runtime.runTurn({ agentId: h.agentId, userText: "go", peerRef: "u1" });
    expect(result.status).toBe("succeeded");
    expect(h.broker.list()[0]!.status).toBe("expired");
    const followup = h.provider.requests[1]!;
    expect((followup.messages.at(-1)!.content[0] as { content: string }).content).toMatch(
      /timed out/,
    );
  });

  it("low-risk tools below the threshold skip approval entirely", async () => {
    const h = setup({ threshold: "high" });
    h.provider.enqueue(
      {
        content: [{ type: "tool_use", id: "t1", name: "time.now", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "It is now." }] },
    );
    await h.runtime.runTurn({ agentId: h.agentId, userText: "time?", peerRef: "u1" });
    expect(h.events.map((e) => e.type)).not.toContain("approval.requested");
    expect(h.broker.list()).toHaveLength(0);
  });
});

describe("verifier at turn end", () => {
  it("appends a verifier note when '0 rows affected' is reported as done", async () => {
    const h = setup({ threshold: "critical" });
    h.provider.enqueue(
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "shell.exec",
            input: { command: 'echo "0 rows affected"' },
          },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "Done! I deleted the old records." }] },
    );

    const result = await h.runtime.runTurn({
      agentId: h.agentId,
      userText: "clean up",
      peerRef: "u1",
    });
    expect(result.text).toContain("Done! I deleted the old records.");
    expect(result.text).toContain("⚠️ Verifier:");
    expect(result.text).toMatch(/zero effect/);

    const steps = h.store.steps(result.turnId);
    const verify = steps.find((s) => s.type === "verify")!;
    expect(verify.status).toBe("failed");
    expect(h.events.map((e) => e.type)).toContain("verifier.flagged");

    // The note is on the persisted record too — channels deliver what we store.
    expect(h.store.history(result.sessionId).at(-1)!.content).toContain("⚠️ Verifier:");
  });

  it("clean turns pass verification without altering the reply", async () => {
    const h = setup({ threshold: "critical" });
    h.provider.enqueue({ content: [{ type: "text", text: "Paris is the capital of France." }] });
    const result = await h.runtime.runTurn({
      agentId: h.agentId,
      userText: "capital?",
      peerRef: "u1",
    });
    expect(result.text).toBe("Paris is the capital of France.");
    expect(h.events.map((e) => e.type)).toContain("verifier.passed");
    expect(h.store.steps(result.turnId).find((s) => s.type === "verify")!.status).toBe("succeeded");
  });
});
