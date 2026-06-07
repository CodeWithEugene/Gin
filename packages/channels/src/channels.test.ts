import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, GinError } from "@gin/core";
import { openDatabase } from "@gin/storage";
import { ChannelManager, type ChannelAdapter, type InboundHandler } from "./manager.js";
import { Outbox } from "./outbox.js";
import { TelegramAdapter } from "./telegram.js";
import { WebChatAdapter } from "./webchat.js";

const T0 = 1_000_000;

function newOutbox(opts = {}): Outbox {
  return new Outbox(openDatabase({ path: ":memory:" }), { baseBackoffMs: 1000, ...opts });
}

describe("Outbox", () => {
  let outbox: Outbox;
  beforeEach(() => {
    outbox = newOutbox();
  });

  it("deduplicates on idempotency key", () => {
    const a = outbox.enqueue({
      channelId: "c",
      peerRef: "p",
      body: "hi",
      idempotencyKey: "k1",
      now: T0,
    });
    const b = outbox.enqueue({
      channelId: "c",
      peerRef: "p",
      body: "hi",
      idempotencyKey: "k1",
      now: T0,
    });
    expect(b).toBe(a);
    expect(outbox.claimDue(T0)).toHaveLength(1);
  });

  it("delivers per-peer in order: head blocks, other peers flow", () => {
    const first = outbox.enqueue({ channelId: "c", peerRef: "alice", body: "1", now: T0 });
    outbox.enqueue({ channelId: "c", peerRef: "alice", body: "2", now: T0 });
    outbox.enqueue({ channelId: "c", peerRef: "bob", body: "x", now: T0 });

    const claimed = outbox.claimDue(T0);
    expect(claimed.map((e) => e.body).sort()).toEqual(["1", "x"]); // heads only

    // Alice's head fails → backoff. Her #2 must NOT be claimable; Bob is done.
    outbox.markFailed(first, "boom", T0);
    for (const e of claimed.filter((e) => e.peerRef === "bob")) outbox.markDelivered(e.id, T0);

    expect(outbox.claimDue(T0 + 1)).toHaveLength(0); // backoff not elapsed
    const retry = outbox.claimDue(T0 + 1001);
    expect(retry.map((e) => e.body)).toEqual(["1"]); // head retries before #2
  });

  it("delivers the next message only after the head succeeds", () => {
    outbox.enqueue({ channelId: "c", peerRef: "p", body: "1", now: T0 });
    outbox.enqueue({ channelId: "c", peerRef: "p", body: "2", now: T0 });
    const [head] = outbox.claimDue(T0);
    outbox.markDelivered(head!.id, T0);
    const next = outbox.claimDue(T0);
    expect(next.map((e) => e.body)).toEqual(["2"]);
  });

  it("dead-letters after maxAttempts", () => {
    const strict = newOutbox({ maxAttempts: 2 });
    const id = strict.enqueue({ channelId: "c", peerRef: "p", body: "x", now: T0 });
    strict.claimDue(T0);
    expect(strict.markFailed(id, "e1", T0)).toBe("queued");
    strict.claimDue(T0 + 2000);
    expect(strict.markFailed(id, "e2", T0 + 2000)).toBe("dead_letter");
    expect(strict.deadLetters().map((e) => e.id)).toEqual([id]);
  });

  it("dedups inbound channel message ids", () => {
    expect(outbox.markInboundSeen("c", "42")).toBe(true);
    expect(outbox.markInboundSeen("c", "42")).toBe(false);
    expect(outbox.markInboundSeen("other", "42")).toBe(true);
  });
});

class FakeAdapter implements ChannelAdapter {
  readonly kind = "fake";
  handler: InboundHandler | undefined;
  sent: { peerRef: string; text: string }[] = [];
  failures = 0;

  constructor(readonly id: string = "fake") {}
  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
  }
  async stop(): Promise<void> {}
  async send(peerRef: string, text: string): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new GinError("delivery_failed", "transient", { retryable: true });
    }
    this.sent.push({ peerRef, text });
  }
}

describe("ChannelManager", () => {
  it("routes accepted inbound to the handler and replies via outbox", async () => {
    const outbox = newOutbox();
    const bus = new EventBus();
    const adapter = new FakeAdapter();
    const onInbound = vi.fn(async () => {});
    const manager = new ChannelManager({
      outbox,
      bus,
      onInbound,
      dmPolicies: { fake: { policy: "open", allowFrom: [] } },
    });
    await manager.register(adapter);

    await adapter.handler!({
      channelId: "fake",
      peerRef: "p1",
      text: "hello",
      channelMessageId: "m1",
    });
    expect(onInbound).toHaveBeenCalledOnce();

    manager.send("fake", "p1", "reply!", "turn-1");
    const result = await manager.tick();
    expect(result.delivered).toBe(1);
    expect(adapter.sent).toEqual([{ peerRef: "p1", text: "reply!" }]);
  });

  it("drops duplicate inbound messages", async () => {
    const outbox = newOutbox();
    const onInbound = vi.fn(async () => {});
    const manager = new ChannelManager({
      outbox,
      bus: new EventBus(),
      onInbound,
      dmPolicies: { fake: { policy: "open", allowFrom: [] } },
    });
    const adapter = new FakeAdapter();
    await manager.register(adapter);
    const msg = { channelId: "fake", peerRef: "p", text: "x", channelMessageId: "same" };
    await adapter.handler!(msg);
    await adapter.handler!(msg);
    expect(onInbound).toHaveBeenCalledTimes(1);
  });

  it("rejects unpaired peers under the pairing policy", async () => {
    const outbox = newOutbox();
    const onInbound = vi.fn(async () => {});
    const events: string[] = [];
    const bus = new EventBus();
    bus.on("*", (e) => events.push(e.type));
    const manager = new ChannelManager({
      outbox,
      bus,
      onInbound,
      dmPolicies: { fake: { policy: "pairing", allowFrom: ["friend"] } },
    });
    const adapter = new FakeAdapter();
    await manager.register(adapter);

    await adapter.handler!({
      channelId: "fake",
      peerRef: "stranger",
      text: "hi",
      channelMessageId: "1",
    });
    expect(onInbound).not.toHaveBeenCalled();
    expect(events).toContain("channel.rejected");
    await manager.tick();
    expect(adapter.sent[0]!.text).toMatch(/paired/);

    await adapter.handler!({
      channelId: "fake",
      peerRef: "friend",
      text: "hi",
      channelMessageId: "2",
    });
    expect(onInbound).toHaveBeenCalledOnce();
  });

  it("retries transient failures and eventually delivers", async () => {
    const outbox = newOutbox();
    const manager = new ChannelManager({
      outbox,
      bus: new EventBus(),
      onInbound: async () => {},
      dmPolicies: { fake: { policy: "open", allowFrom: [] } },
    });
    const adapter = new FakeAdapter();
    adapter.failures = 1;
    await manager.register(adapter);

    manager.send("fake", "p", "msg");
    const t = Date.now();
    expect((await manager.tick(t)).failed).toBe(1);
    expect((await manager.tick(t + 1001)).delivered).toBe(1);
    expect(adapter.sent).toHaveLength(1);
  });
});

describe("WebChatAdapter", () => {
  it("delivers to connected peers and queues for absent ones", async () => {
    const adapter = new WebChatAdapter();
    await adapter.start(async () => {});
    await expect(adapter.send("p1", "hi")).rejects.toMatchObject({
      code: "delivery_failed",
      retryable: true,
    });
    const got: string[] = [];
    const off = adapter.connect("p1", (text) => {
      got.push(text);
    });
    await adapter.send("p1", "hi");
    expect(got).toEqual(["hi"]);
    off();
    expect(adapter.isConnected("p1")).toBe(false);
  });
});

describe("TelegramAdapter", () => {
  it("polls updates, advances offset, and forwards messages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 7,
                message: {
                  message_id: 1,
                  text: "hello",
                  chat: { id: 42 },
                  from: { username: "eu" },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      );

    const adapter = new TelegramAdapter({ token: "T", fetchImpl, pollTimeoutSec: 0 });
    const inbound: unknown[] = [];
    (adapter as unknown as { handler: InboundHandler }).handler = async (msg) => {
      inbound.push(msg);
    };
    expect(await adapter.pollOnce()).toBe(1);
    expect(inbound[0]).toMatchObject({ peerRef: "42", text: "hello", channelMessageId: "7" });

    await adapter.pollOnce();
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body);
    expect(secondBody.offset).toBe(8);
  });

  it("sends messages and classifies 5xx as retryable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "overloaded" }), { status: 502 }),
      );
    const adapter = new TelegramAdapter({ token: "T", fetchImpl });
    await adapter.send("42", "yo");
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body).toEqual({ chat_id: 42, text: "yo" });

    await expect(adapter.send("42", "again")).rejects.toMatchObject({
      code: "delivery_failed",
      retryable: true,
    });
  });
});
