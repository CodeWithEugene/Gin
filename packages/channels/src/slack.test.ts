import { describe, expect, it, vi } from "vitest";
import { SlackAdapter, type SlackWsLike } from "./slack.js";
import type { InboundMessage } from "./manager.js";

class FakeWs implements SlackWsLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((event: never) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
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
  /** Push a socket-mode frame to the adapter. */
  frame(payload: unknown): void {
    this.fire("message", { data: JSON.stringify(payload) });
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function newAdapter() {
  const ws = new FakeWs();
  const fetchImpl = vi.fn();
  const adapter = new SlackAdapter({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    fetchImpl,
    wsFactory: () => ws,
    reconnectDelayMs: 1,
  });
  return { adapter, ws, fetchImpl };
}

describe("SlackAdapter inbound", () => {
  it("opens a socket, acks envelopes, and forwards user messages", async () => {
    const { adapter, ws, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true, url: "wss://slack.test/socket" }));

    const inbound: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      inbound.push(msg);
    });

    const [openUrl, openInit] = fetchImpl.mock.calls[0]!;
    expect(openUrl).toContain("apps.connections.open");
    expect((openInit as RequestInit).headers).toMatchObject({ authorization: "Bearer xapp-test" });

    ws.frame({
      envelope_id: "env-1",
      type: "events_api",
      payload: {
        event: {
          type: "message",
          text: "habari gin",
          channel: "C123",
          user: "U9",
          event_ts: "111.222",
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(ws.sent[0]!)).toEqual({ envelope_id: "env-1" });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      channelId: "slack",
      peerRef: "C123",
      text: "habari gin",
      channelMessageId: "111.222",
    });
    await adapter.stop();
  });

  it("ignores bot echoes, subtypes, and non-message events", async () => {
    const { adapter, ws, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true, url: "wss://x" }));
    const inbound: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      inbound.push(msg);
    });

    ws.frame({
      envelope_id: "e1",
      type: "events_api",
      payload: { event: { type: "message", text: "from bot", channel: "C1", bot_id: "B1" } },
    });
    ws.frame({
      envelope_id: "e2",
      type: "events_api",
      payload: {
        event: { type: "message", subtype: "message_changed", text: "edit", channel: "C1" },
      },
    });
    ws.frame({
      envelope_id: "e3",
      type: "events_api",
      payload: { event: { type: "reaction_added" } },
    });
    ws.frame({ type: "hello" });
    await new Promise((r) => setTimeout(r, 0));

    expect(inbound).toHaveLength(0);
    // All envelopes with ids still acked:
    expect(ws.sent).toHaveLength(3);
    await adapter.stop();
  });

  it("fails to start when connections.open is rejected", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: false, error: "invalid_auth" }));
    await expect(adapter.start(async () => {})).rejects.toMatchObject({
      code: "channel_error",
      retryable: true,
    });
  });
});

describe("SlackAdapter outbound", () => {
  it("posts messages with the bot token", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await adapter.send("C123", "jambo!");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("chat.postMessage");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer xoxb-test" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channel: "C123",
      text: "jambo!",
    });
  });

  it("classifies rate limits as retryable delivery failures", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: false, error: "ratelimited" }, 429));
    await expect(adapter.send("C123", "x")).rejects.toMatchObject({
      code: "delivery_failed",
      retryable: true,
    });
  });

  it("classifies permanent API errors as non-retryable", async () => {
    const { adapter, fetchImpl } = newAdapter();
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ok: false, error: "channel_not_found" }, 200));
    await expect(adapter.send("C404", "x")).rejects.toMatchObject({
      code: "delivery_failed",
      retryable: false,
    });
  });
});
