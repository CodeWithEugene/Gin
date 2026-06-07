import { GinError } from "@gin/core";
import type { ChannelAdapter, InboundHandler } from "./manager.js";

/**
 * Discord over the v10 gateway: hello → identify (message intents) →
 * heartbeat on the server's interval, MESSAGE_CREATE dispatches into the
 * channel pipeline. Outbound goes through the REST API. peerRef is the
 * Discord channel id; message ids drive inbound dedup upstream.
 */

export interface DiscordWsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    handler: (event: never) => void,
  ): void;
}

export type DiscordWsFactory = (url: string) => DiscordWsLike;
export type DiscordFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** GUILDS isn't needed; messages + content + DMs are. */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordAdapterOptions {
  /** Bot token (no "Bot " prefix — added where needed). */
  token: string;
  id?: string;
  apiBase?: string;
  gatewayUrl?: string;
  fetchImpl?: DiscordFetchLike;
  wsFactory?: DiscordWsFactory;
  reconnectDelayMs?: number;
  /** Heartbeat scheduler — injectable for tests. */
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly kind = "discord";
  readonly id: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: DiscordFetchLike;
  private readonly wsFactory: DiscordWsFactory;
  private readonly reconnectDelayMs: number;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => NodeJS.Timeout;
  private handler: InboundHandler | undefined;
  private socket: DiscordWsLike | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastSeq: number | null = null;
  private running = false;

  constructor(opts: DiscordAdapterOptions) {
    this.id = opts.id ?? "discord";
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? "https://discord.com/api/v10").replace(/\/$/, "");
    this.gatewayUrl = opts.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as DiscordWsLike);
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3_000;
    this.setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  }

  start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    this.connect();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = undefined;
    return Promise.resolve();
  }

  async send(peerRef: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/channels/${peerRef}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GinError(
        "delivery_failed",
        `Discord send failed (${res.status}): ${body.slice(0, 200)}`,
        {
          retryable: res.status === 429 || res.status >= 500,
        },
      );
    }
  }

  private connect(): void {
    const socket = this.wsFactory(this.gatewayUrl);
    this.socket = socket;
    socket.addEventListener("message", ((event: { data: unknown }) => {
      void this.handleFrame(String(event.data), socket);
    }) as never);
    socket.addEventListener("close", (() => {
      this.clearHeartbeat();
      if (!this.running) return;
      setTimeout(() => {
        if (this.running) this.connect();
      }, this.reconnectDelayMs).unref?.();
    }) as never);
  }

  private async handleFrame(raw: string, socket: DiscordWsLike): Promise<void> {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") this.lastSeq = frame.s;

    switch (frame.op) {
      case 10: {
        // Hello → heartbeat cadence + identify.
        const interval = (frame.d as { heartbeat_interval?: number }).heartbeat_interval ?? 41_250;
        this.clearHeartbeat();
        this.heartbeat = this.setIntervalImpl(() => {
          socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
        }, interval);
        this.heartbeat.unref?.();
        socket.send(
          JSON.stringify({
            op: 2,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "gin", device: "gin" },
            },
          }),
        );
        return;
      }
      case 1: // server asks for an immediate heartbeat
        socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
        return;
      case 7: // reconnect request
      case 9: // invalid session → re-identify via fresh connect
        socket.close();
        return;
      case 0:
        break; // dispatch — handled below
      default:
        return;
    }

    if (frame.t !== "MESSAGE_CREATE" || !this.handler) return;
    const message = frame.d as {
      id?: string;
      channel_id?: string;
      content?: string;
      author?: { id?: string; bot?: boolean; username?: string };
    };
    if (!message.content || !message.channel_id || !message.id) return;
    if (message.author?.bot) return; // never loop on our own replies

    await this.handler({
      channelId: this.id,
      peerRef: message.channel_id,
      text: message.content,
      channelMessageId: message.id,
      ...(message.author?.username !== undefined ? { displayName: message.author.username } : {}),
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}
