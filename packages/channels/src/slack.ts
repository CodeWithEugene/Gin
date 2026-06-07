import { GinError } from "@gin/core";
import type { ChannelAdapter, InboundHandler } from "./manager.js";

/**
 * Slack over Socket Mode — local-first (no public URL needed). The adapter
 * opens a socket via apps.connections.open (app-level token), acks every
 * envelope, and forwards message events into the channel pipeline. Outbound
 * goes through chat.postMessage with the bot token. peerRef is the Slack
 * channel id; envelope event ids drive inbound dedup upstream.
 */

export interface SlackWsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    handler: (event: never) => void,
  ): void;
}

export type SlackWsFactory = (url: string) => SlackWsLike;
export type SlackFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SlackAdapterOptions {
  /** xoxb- bot token (chat.postMessage). */
  botToken: string;
  /** xapp- app-level token with connections:write (Socket Mode). */
  appToken: string;
  id?: string;
  baseUrl?: string;
  fetchImpl?: SlackFetchLike;
  wsFactory?: SlackWsFactory;
  /** Backoff before reconnecting after a drop. */
  reconnectDelayMs?: number;
}

interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
      event_ts?: string;
    };
  };
}

export class SlackAdapter implements ChannelAdapter {
  readonly kind = "slack";
  readonly id: string;
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: SlackFetchLike;
  private readonly wsFactory: SlackWsFactory;
  private readonly reconnectDelayMs: number;
  private handler: InboundHandler | undefined;
  private socket: SlackWsLike | undefined;
  private running = false;

  constructor(opts: SlackAdapterOptions) {
    this.id = opts.id ?? "slack";
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.baseUrl = (opts.baseUrl ?? "https://slack.com/api").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as SlackWsLike);
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3_000;
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    await this.connect();
  }

  stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
    this.socket?.close();
    this.socket = undefined;
    return Promise.resolve();
  }

  async send(peerRef: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: peerRef, text }),
    });
    const transient = res.status === 429 || res.status >= 500;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      throw new GinError(
        "delivery_failed",
        `Slack postMessage failed: ${data.error ?? res.status}`,
        {
          retryable: transient || data.error === "ratelimited",
        },
      );
    }
  }

  /** One socket lifecycle; exposed for tests via the injected factory. */
  async connect(): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.appToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      url?: string;
      error?: string;
    };
    if (data.ok !== true || !data.url) {
      throw new GinError(
        "channel_error",
        `Slack connections.open failed: ${data.error ?? res.status}`,
        {
          retryable: true,
        },
      );
    }

    const socket = this.wsFactory(data.url);
    this.socket = socket;
    socket.addEventListener("message", ((event: { data: unknown }) => {
      void this.handleFrame(String(event.data), socket);
    }) as never);
    socket.addEventListener("close", (() => {
      if (!this.running) return;
      setTimeout(() => {
        if (this.running) void this.connect().catch(() => undefined);
      }, this.reconnectDelayMs).unref?.();
    }) as never);
  }

  private async handleFrame(raw: string, socket: SlackWsLike): Promise<void> {
    let envelope: SocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketEnvelope;
    } catch {
      return; // not JSON — ignore
    }
    // Ack first: Slack redelivers unacked envelopes; our outbox/inbound-dedup
    // layer makes redelivery safe, but prompt acks keep the stream healthy.
    if (envelope.envelope_id) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === "disconnect") {
      socket.close();
      return;
    }
    if (envelope.type !== "events_api") return;

    const event = envelope.payload?.event;
    if (!event || event.type !== "message" || !event.text || !event.channel) return;
    if (event.bot_id || event.subtype) return; // ignore bots and edits/joins
    if (!this.handler) return;

    await this.handler({
      channelId: this.id,
      peerRef: event.channel,
      text: event.text,
      channelMessageId: event.event_ts ?? event.ts ?? `${event.channel}:${event.text}`,
      ...(event.user !== undefined ? { displayName: event.user } : {}),
    });
  }
}
