import type { BusEvent } from "./types.js";

/**
 * Browser gateway client: one WS, request/response RPC frames plus the
 * subscribed event stream fanned out to listeners. Reconnects with backoff;
 * pending calls reject on disconnect (the views retry on reconnect).
 */

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

interface EventFrame {
  type: "event";
  event: BusEvent;
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (event: never) => void): void;
}

export interface GatewayClientOptions {
  url?: string;
  wsFactory?: (url: string) => WsLike;
  reconnectDelayMs?: number;
}

export function defaultWsUrl(): string {
  const { protocol, host } = window.location;
  const scheme = protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}/ws`;
}

export class GatewayClient {
  readonly url: string;
  private readonly wsFactory: (url: string) => WsLike;
  private readonly reconnectDelayMs: number;
  private socket: WsLike | undefined;
  private state: ConnectionState = "closed";
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventListeners = new Set<(event: BusEvent) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private stopped = false;

  constructor(opts: GatewayClientOptions = {}) {
    this.url = opts.url ?? defaultWsUrl();
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1500;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  getState(): ConnectionState {
    return this.state;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.state !== "open") {
      return Promise.reject(new Error("Gateway disconnected"));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private open(): void {
    this.setState("connecting");
    const socket = this.wsFactory(this.url);
    this.socket = socket;

    socket.addEventListener("open", (() => {
      this.setState("open");
      // Resubscribe to the bus on every (re)connect.
      void this.call("gin.events.subscribe").catch(() => undefined);
    }) as never);

    socket.addEventListener("message", ((event: { data: unknown }) => {
      let frame: ResponseFrame | EventFrame;
      try {
        frame = JSON.parse(String(event.data)) as ResponseFrame | EventFrame;
      } catch {
        return;
      }
      if (frame.type === "event") {
        for (const listener of this.eventListeners) listener(frame.event);
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.payload);
      else waiter.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
    }) as never);

    socket.addEventListener("close", (() => {
      this.setState("closed");
      for (const waiter of this.pending.values()) waiter.reject(new Error("Gateway disconnected"));
      this.pending.clear();
      if (!this.stopped) {
        setTimeout(() => {
          if (!this.stopped) this.open();
        }, this.reconnectDelayMs);
      }
    }) as never);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
