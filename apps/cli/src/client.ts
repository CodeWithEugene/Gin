/**
 * Minimal WS RPC client for the Gateway, on Node's built-in WebSocket.
 * One connection per CLI invocation — connect, call, (optionally) wait for a
 * pushed event, close.
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
  event: { id: string; ts: number; type: string; payload: unknown };
}

export class GatewayClient {
  private constructor(
    private readonly ws: WebSocket,
    private readonly eventHandlers: Set<(event: EventFrame["event"]) => void>,
  ) {}

  static connect(url: string, timeoutMs = 3000): Promise<GatewayClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(
        () => reject(new Error(`Gateway not reachable at ${url}`)),
        timeoutMs,
      );
      const eventHandlers = new Set<(event: EventFrame["event"]) => void>();
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new GatewayClient(ws, eventHandlers));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Gateway not reachable at ${url}. Is \`gin gateway\` running?`));
      });
      ws.addEventListener("message", (msg) => {
        const frame = JSON.parse(String(msg.data)) as ResponseFrame | EventFrame;
        if (frame.type === "event") {
          for (const handler of eventHandlers) handler(frame.event);
        }
      });
    });
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      const onMessage = (msg: MessageEvent) => {
        const frame = JSON.parse(String(msg.data)) as ResponseFrame | EventFrame;
        if (frame.type !== "res" || frame.id !== id) return;
        clearTimeout(timer);
        this.ws.removeEventListener("message", onMessage);
        if (frame.ok) resolve(frame.payload as T);
        else reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
      };
      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Resolve with the first pushed event matching `type` (and predicate). */
  waitForEvent<T = unknown>(
    type: string,
    predicate: (payload: T) => boolean = () => true,
    timeoutMs = 120_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventHandlers.delete(handler);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      const handler = (event: EventFrame["event"]) => {
        if (event.type !== type) return;
        const payload = event.payload as T;
        if (!predicate(payload)) return;
        clearTimeout(timer);
        this.eventHandlers.delete(handler);
        resolve(payload);
      };
      this.eventHandlers.add(handler);
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function gatewayWsUrl(base: string): string {
  return `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
}
