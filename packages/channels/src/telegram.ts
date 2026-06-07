import { GinError } from "@gin/core";
import type { ChannelAdapter, InboundHandler } from "./manager.js";

/**
 * Telegram over the plain Bot API with long polling — no SDK dependency.
 * peerRef is the chat id; update_id doubles as the inbound dedup key.
 */

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { first_name?: string; username?: string };
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramAdapterOptions {
  token: string;
  id?: string;
  baseUrl?: string;
  /** Long-poll wait in seconds. */
  pollTimeoutSec?: number;
  fetchImpl?: FetchLike;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  readonly id: string;
  private readonly apiBase: string;
  private readonly pollTimeoutSec: number;
  private readonly fetchImpl: FetchLike;
  private handler: InboundHandler | undefined;
  private running = false;
  private offset = 0;

  constructor(opts: TelegramAdapterOptions) {
    this.id = opts.id ?? "telegram";
    this.apiBase = `${(opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${opts.token}`;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    void this.pollLoop();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
    return Promise.resolve();
  }

  async send(peerRef: string, text: string): Promise<void> {
    const res = await this.call("sendMessage", { chat_id: Number(peerRef), text });
    if (!res.ok) {
      throw new GinError("delivery_failed", `Telegram sendMessage failed: ${res.description}`, {
        retryable: res.transient,
      });
    }
  }

  /** One getUpdates round; exposed for tests, driven by pollLoop in prod. */
  async pollOnce(): Promise<number> {
    const res = await this.call<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: this.pollTimeoutSec,
      allowed_updates: ["message"],
    });
    if (!res.ok || !res.result) return 0;
    let handled = 0;
    for (const update of res.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const message = update.message;
      if (!message?.text || !this.handler) continue;
      await this.handler({
        channelId: this.id,
        peerRef: String(message.chat.id),
        text: message.text,
        channelMessageId: String(update.update_id),
        ...(message.from?.username !== undefined || message.from?.first_name !== undefined
          ? { displayName: message.from.username ?? message.from.first_name ?? "" }
          : {}),
      });
      handled++;
    }
    return handled;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch {
        // Transient network failure — back off briefly, keep polling.
        await sleep(3_000);
      }
    }
  }

  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: T; description?: string; transient: boolean }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new GinError("channel_error", `Telegram unreachable (${method})`, {
        cause: err,
        retryable: true,
      });
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    return {
      ok: data.ok === true,
      ...(data.result !== undefined ? { result: data.result } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      transient: res.status === 429 || res.status >= 500,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
