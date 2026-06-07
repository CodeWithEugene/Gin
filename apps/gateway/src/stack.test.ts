import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GinConfigSchema } from "@gin/config";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { createGateway, type Gateway } from "./server.js";
import { buildStack, resolveSecret, type GatewayStack } from "./stack.js";

/** Echoes the last user text back; trips the tool path never. */
class EchoProvider implements ModelProvider {
  readonly name = "fake";
  async chat(req: ChatRequest): Promise<ChatResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.find((b) => b.type === "text");
    return {
      model: "echo",
      content: [{ type: "text", text: `echo: ${text && "text" in text ? text.text : ""}` }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
    };
  }
}

let workspace: string;
let stack: GatewayStack;
let gateway: Gateway;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "gin-gw-"));
  const config = GinConfigSchema.parse({
    agent: { model: "fake/echo", workspace },
  });
  stack = await buildStack({
    config,
    dbPath: ":memory:",
    homeDir: workspace,
    router: new ModelRouter().register(new EchoProvider()),
  });
  gateway = createGateway({ port: 0, stack });
  await gateway.start();
});

afterEach(async () => {
  await gateway.stop();
  await stack.close();
  rmSync(workspace, { recursive: true, force: true });
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.address.port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function rpc(ws: WebSocket, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "res" && frame.id === id) {
        ws.off("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function nextEvent(
  ws: WebSocket,
  type: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const onMessage = (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "event" && frame.event.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(frame.event);
      }
    };
    ws.on("message", onMessage);
  });
}

describe("stack-backed gateway", () => {
  it("creates the default agent from config", () => {
    expect(stack.defaultAgent.name).toBe("gin");
    expect(stack.defaultAgent.modelConfig.primary).toBe("fake/echo");
  });

  it("lists agents and sessions over RPC", async () => {
    const ws = await connect();
    const agents = await rpc(ws, "gin.agent.list");
    expect(agents.ok).toBe(true);
    expect((agents.payload as { name: string }[])[0]!.name).toBe("gin");

    const sessions = await rpc(ws, "gin.session.list");
    expect(sessions.ok).toBe(true);
    expect(sessions.payload).toEqual([]);
    ws.close();
  });

  it("round-trips a chat turn over WebChat (Phase 1 acceptance)", async () => {
    const ws = await connect();
    const reply = nextEvent(ws, "webchat.message");
    const ack = await rpc(ws, "gin.chat.send", { text: "hello gin" });
    expect(ack.ok).toBe(true);
    expect((ack.payload as { accepted: boolean }).accepted).toBe(true);

    const event = await reply;
    expect((event.payload as { text: string }).text).toBe("echo: hello gin");

    // Turn + messages persisted:
    const sessions = await rpc(ws, "gin.session.list");
    expect(sessions.payload as unknown[]).toHaveLength(1);
    ws.close();
  });

  it("keeps per-connection peers separate and supports follow-ups", async () => {
    const ws = await connect();
    const first = nextEvent(ws, "webchat.message");
    await rpc(ws, "gin.chat.send", { text: "one", peerRef: "alice" });
    await first;

    const second = nextEvent(ws, "webchat.message");
    await rpc(ws, "gin.chat.send", { text: "two", peerRef: "alice" });
    const ev = await second;
    expect((ev.payload as { text: string }).text).toBe("echo: two");

    const sessions = (await rpc(ws, "gin.session.list")).payload as { peerRef: string }[];
    expect(sessions).toHaveLength(1); // same peer → same session
    expect(sessions[0]!.peerRef).toBe("alice");
    ws.close();
  });

  it("validates gin.chat.send params", async () => {
    const ws = await connect();
    const res = await rpc(ws, "gin.chat.send", { nope: true });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe("validation_failed");
    ws.close();
  });
});

describe("Phase 2 RPC surface", () => {
  it("exposes traces of chat turns over gin.trace.*", async () => {
    const ws = await connect();
    const reply = nextEvent(ws, "webchat.message");
    await rpc(ws, "gin.chat.send", { text: "trace me" });
    await reply;

    const list = await rpc(ws, "gin.trace.list");
    expect(list.ok).toBe(true);
    const traces = list.payload as { traceId: string; status: string; modelCalls: number }[];
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: "succeeded", modelCalls: 1 });

    const detail = await rpc(ws, "gin.trace.get", { traceId: traces[0]!.traceId });
    const types = (detail.payload as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["turn.started", "model.called", "turn.completed"]),
    );
    ws.close();
  });

  it("sets and reports budgets over gin.budget.*", async () => {
    const ws = await connect();
    const set = await rpc(ws, "gin.budget.set", { limitUsd: 2.5, scope: "agent", window: "day" });
    expect(set.ok).toBe(true);
    expect((set.payload as { scopeRef: string }).scopeRef).toBe(stack.defaultAgent.id);

    const status = await rpc(ws, "gin.budget.status");
    const rows = status.payload as { scope: string; limitUsd: number; remainingUsd: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "agent", limitUsd: 2.5, remainingUsd: 2.5 });
    ws.close();
  });

  it("validates Phase 2 params", async () => {
    const ws = await connect();
    const bad = await rpc(ws, "gin.budget.set", { scope: "session", limitUsd: 1 }); // ref required
    expect(bad.ok).toBe(false);
    const badTrace = await rpc(ws, "gin.trace.get", {});
    expect(badTrace.ok).toBe(false);
    ws.close();
  });
});

describe("Phase 3 RPC surface", () => {
  it("lists and decides approvals, writing the audit log", async () => {
    const ws = await connect();
    // Create a pending approval directly on the broker (a high-risk tool would).
    void stack.approvals.request({ action: "shell.exec", riskLevel: "high" }, 60_000);

    const pending = await rpc(ws, "gin.approval.list");
    expect(pending.ok).toBe(true);
    const [request] = pending.payload as { id: string; action: string }[];
    expect(request).toMatchObject({ action: "shell.exec" });

    const decided = await rpc(ws, "gin.approval.decide", {
      approvalId: request!.id,
      decision: "denied",
      reason: "too spicy",
    });
    expect((decided.payload as { status: string }).status).toBe("denied");

    const audit = await rpc(ws, "gin.audit.list", { action: "approval.decided" });
    const entries = audit.payload as { actor: string; target: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "operator", target: `approval/${request!.id}` });
    ws.close();
  });

  it("audits budget changes", async () => {
    const ws = await connect();
    await rpc(ws, "gin.budget.set", { scope: "agent", limitUsd: 1 });
    const audit = await rpc(ws, "gin.audit.list", { action: "budget.set" });
    expect(audit.payload as unknown[]).toHaveLength(1);
    ws.close();
  });
});

describe("Phase 4 RPC surface", () => {
  it("manages scheduled jobs over gin.schedule.*", async () => {
    const ws = await connect();
    const set = await rpc(ws, "gin.schedule.set", {
      name: "brief",
      cron: "0 7 * * *",
      action: { kind: "message", text: "Summarize my inbox" },
    });
    expect(set.ok).toBe(true);
    expect((set.payload as { nextRunAt?: number }).nextRunAt).toBeGreaterThan(Date.now());

    const list = await rpc(ws, "gin.schedule.list");
    expect((list.payload as { name: string }[]).map((j) => j.name)).toEqual(["brief"]);

    const audit = await rpc(ws, "gin.audit.list", { action: "schedule.set" });
    expect(audit.payload as unknown[]).toHaveLength(1);

    const del = await rpc(ws, "gin.schedule.delete", { name: "brief" });
    expect((del.payload as { deleted: boolean }).deleted).toBe(true);
    ws.close();
  });

  it("registers and runs workflows over gin.workflow.*", async () => {
    const ws = await connect();
    stack.workflows.register({
      name: "echo_time",
      steps: [{ id: "now", kind: "tool", tool: "time.now", args: {} }],
      output: "{{steps.now.output.iso}}",
    });
    const list = await rpc(ws, "gin.workflow.list");
    expect((list.payload as { name: string }[]).map((w) => w.name)).toContain("echo_time");

    const run = await rpc(ws, "gin.workflow.run", { name: "echo_time" });
    expect(run.ok).toBe(true);
    expect((run.payload as { output: string }).output).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    ws.close();
  });

  it("lists skills over gin.skill.list", async () => {
    const ws = await connect();
    stack.skills.save({ slug: "test-skill", description: "Testing", body: "..." });
    const list = await rpc(ws, "gin.skill.list");
    expect((list.payload as { slug: string }[]).map((s) => s.slug)).toContain("test-skill");
    ws.close();
  });
});

describe("RBAC enforcement", () => {
  it("a viewer principal can read but not write", async () => {
    const viewerGateway = createGateway({
      port: 0,
      stack,
      principal: { id: "v1", name: "viewer", roles: ["viewer"] },
    });
    await viewerGateway.start();
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${viewerGateway.address.port}/ws`);
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
      });

      const read = await rpc(ws, "gin.trace.list");
      expect(read.ok).toBe(true);

      const write = await rpc(ws, "gin.budget.set", { scope: "agent", limitUsd: 9 });
      expect(write.ok).toBe(false);
      expect((write.error as { code: string }).code).toBe("permission_denied");

      const chat = await rpc(ws, "gin.chat.send", { text: "hi" });
      expect(chat.ok).toBe(false);

      const decide = await rpc(ws, "gin.approval.decide", {
        approvalId: "x",
        decision: "approved",
      });
      expect((decide.error as { code: string }).code).toBe("permission_denied");
      ws.close();
    } finally {
      await viewerGateway.stop();
    }
  });
});

describe("resolveSecret", () => {
  it("resolves env refs and rejects raw values", () => {
    process.env.GIN_TEST_SECRET = "tok123";
    expect(resolveSecret("env:GIN_TEST_SECRET")).toBe("tok123");
    expect(resolveSecret("env:GIN_TEST_MISSING")).toBeUndefined();
    expect(resolveSecret("raw-token")).toBeUndefined();
    expect(resolveSecret(undefined)).toBeUndefined();
  });
});
