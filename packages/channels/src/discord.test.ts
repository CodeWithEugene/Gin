import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter, type DiscordWsLike } from "./discord.js";
import type { InboundMessage } from "./manager.js";

class FakeWs implements DiscordWsLike {
  sent: string[] = [];
  private listeners = new Map<string, ((event: never) => void)[]>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.fire("close", {});
  }
  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event as never);
  }
  frame(payload: unknown): void {
    this.fire("message", { data: JSON.stringify(payload) });
  }
}

function newAdapter() {
  const ws = new FakeWs();
  const fetchImpl = vi.fn();
  const heartbeats: { fn: () => void; ms: number }[] = [];
  const adapter = new DiscordAdapter({
    token: "bot-token",
    fetchImpl,
    wsFactory: () => ws,
    reconnectDelayMs: 1,
    setIntervalImpl: (fn, ms) => {
      heartbeats.push({ fn, ms });
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
  });
  return { adapter, ws, fetchImpl, heartbeats };
}

describe("DiscordAdapter gateway", () => {
  it("identifies after hello and heartbeats with the last sequence", async () => {
    const { adapter, ws, heartbeats } = newAdapter();
    await adapter.start(async () => {});

    ws.frame({ op: 10, d: { heartbeat_interval: 1000 } });
    const identify = JSON.parse(ws.sent[0]!);
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("bot-token");
    expect(identify.d.intents).toBe((1 << 9) | (1 << 12) | (1 << 15));
    expect(heartbeats[0]!.ms).toBe(1000);

    // Dispatch advances seq; the next heartbeat carries it.
    ws.frame({ op: 0, s: 42, t: "READY", d: {} });
    heartbeats[0]!.fn();
    const beat = JSON.parse(ws.sent.at(-1)!);
    expect(beat).toEqual({ op: 1, d: 42 });
    await adapter.stop();
  });

  it("forwards user messages and ignores bot echoes", async () => {
    const { adapter, ws } = newAdapter();
    const inbound: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      inbound.push(msg);
    });
    ws.frame({ op: 10, d: { heartbeat_interval: 1000 } });

    ws.frame({
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
      d: { id: "m1", channel_id: "C9", content: "habari", author: { id: "u1", username: "eu" } },
    });
    ws.frame({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "m2", channel_id: "C9", content: "echo", author: { id: "bot", bot: true } },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      channelId: "discord",
      peerRef: "C9",
      text: "habari",
      channelMessageId: "m1",
      displayName: "eu",
    });
    await adapter.stop();
  });

  it("responds to server heartbeat requests immediately", async () => {
    const { adapter, ws } = newAdapter();
    await adapter.start(async () => {});
    ws.frame({ op: 10, d: { heartbeat_interval: 1000 } });
    const before = ws.sent.length;
    ws.frame({ op: 1 });
    expect(JSON.parse(ws.sent[before]!)).toMatchObject({ op: 1 });
    await adapter.stop();
  });
});

describe("DiscordAdapter REST", () => {
  it("posts messages with the Bot authorization header", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await adapter.send("C9", "jambo");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/v10/channels/C9/messages");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bot bot-token" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ content: "jambo" });
  });

  it("classifies 429 as retryable and 403 as permanent", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    await expect(adapter.send("C9", "x")).rejects.toMatchObject({ retryable: true });
    fetchImpl.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(adapter.send("C9", "x")).rejects.toMatchObject({ retryable: false });
  });
});
