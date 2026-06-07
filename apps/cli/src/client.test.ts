import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GinConfigSchema } from "@gin/config";
import { buildStack, createGateway, type Gateway, type GatewayStack } from "@gin/gateway";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import { GatewayClient, gatewayWsUrl } from "./client.js";

class EchoProvider implements ModelProvider {
  readonly name = "fake";
  async chat(req: ChatRequest): Promise<ChatResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const block = lastUser?.content.find((b) => b.type === "text");
    return {
      model: "echo",
      content: [{ type: "text", text: `echo: ${block && "text" in block ? block.text : ""}` }],
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
  workspace = mkdtempSync(join(tmpdir(), "gin-cli-"));
  stack = await buildStack({
    config: GinConfigSchema.parse({ agent: { model: "fake/echo", workspace } }),
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

describe("GatewayClient", () => {
  it("derives ws urls from http bases", () => {
    expect(gatewayWsUrl("http://127.0.0.1:18789")).toBe("ws://127.0.0.1:18789/ws");
    expect(gatewayWsUrl("http://127.0.0.1:18789/")).toBe("ws://127.0.0.1:18789/ws");
  });

  it("sends a chat message and receives the pushed reply (gin message send path)", async () => {
    const client = await GatewayClient.connect(
      gatewayWsUrl(`http://127.0.0.1:${gateway.address.port}`),
    );
    try {
      const reply = client.waitForEvent<{ peerRef: string; text: string }>(
        "webchat.message",
        (p) => p.peerRef === "cli",
        10_000,
      );
      await client.call("gin.chat.send", { text: "habari", peerRef: "cli" });
      const payload = await reply;
      expect(payload.text).toBe("echo: habari");
    } finally {
      client.close();
    }
  });

  it("lists agents (gin agent list path)", async () => {
    const client = await GatewayClient.connect(
      gatewayWsUrl(`http://127.0.0.1:${gateway.address.port}`),
    );
    try {
      const agents = await client.call<{ name: string }[]>("gin.agent.list");
      expect(agents.map((a) => a.name)).toEqual(["gin"]);
    } finally {
      client.close();
    }
  });

  it("surfaces RPC errors as rejections", async () => {
    const client = await GatewayClient.connect(
      gatewayWsUrl(`http://127.0.0.1:${gateway.address.port}`),
    );
    try {
      await expect(client.call("gin.chat.send", { wrong: true })).rejects.toThrow(
        /validation_failed/,
      );
    } finally {
      client.close();
    }
  });

  it("fails fast when the gateway is down", async () => {
    await expect(GatewayClient.connect("ws://127.0.0.1:1/ws", 500)).rejects.toThrow(/reachable/);
  });
});
