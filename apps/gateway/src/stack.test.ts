import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GinConfigSchema } from "@gin/config";
import {
  ModelRouter,
  resultText as _rt,
  type ChatRequest,
  type ChatResult,
  type ModelProvider,
} from "@gin/models";
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

describe("resolveSecret", () => {
  it("resolves env refs and rejects raw values", () => {
    process.env.GIN_TEST_SECRET = "tok123";
    expect(resolveSecret("env:GIN_TEST_SECRET")).toBe("tok123");
    expect(resolveSecret("env:GIN_TEST_MISSING")).toBeUndefined();
    expect(resolveSecret("raw-token")).toBeUndefined();
    expect(resolveSecret(undefined)).toBeUndefined();
  });
});
