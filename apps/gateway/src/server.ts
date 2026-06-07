import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { EventBus, GinError, newId } from "@gin/core";
import { z } from "zod";
import { RequestFrameSchema, ok, fail, type ServerFrame } from "./protocol.js";
import type { GatewayStack } from "./stack.js";

export interface GatewayOptions {
  port?: number;
  host?: string;
  bus?: EventBus;
  /** Full runtime stack; chat/agent/session methods register when present. */
  stack?: GatewayStack;
}

export interface Gateway {
  app: FastifyInstance;
  bus: EventBus;
  /** Resolved listen address, available after start(). */
  address: { port: number; host: string };
  start(): Promise<void>;
  stop(): Promise<void>;
}

type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown;

interface RpcContext {
  bus: EventBus;
  /** Stable id for this client connection. */
  connectionId: string;
  /** Send an extra frame to this client (used by subscriptions). */
  push(frame: ServerFrame): void;
  /** Register cleanup to run when the socket closes. */
  onClose(fn: () => void): void;
  /** Bind a WebChat peer to this connection (stack-backed gateways only). */
  bindWebChatPeer?: (peerRef: string) => void;
}

const ChatSendSchema = z.object({
  text: z.string().min(1),
  peerRef: z.string().min(1).optional(),
});

const SessionListSchema = z.object({ agentId: z.string().optional() }).optional();

const startedAt = Symbol("startedAt");

export function createGateway(opts: GatewayOptions = {}): Gateway {
  const bus = opts.bus ?? opts.stack?.bus ?? new EventBus();
  const stack = opts.stack;
  const app = Fastify({ logger: false });
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 18789;

  // ── RPC method registry ────────────────────────────────────────────────────
  const methods = new Map<string, RpcHandler>();

  methods.set("gin.ping", () => "pong");
  // WS echo: the Phase 0 round-trip primitive WebChat is built on.
  methods.set("gin.echo", (params) => params);
  methods.set("gin.status", (_params, ctx) => ({
    name: "gin-gateway",
    version: "0.1.0",
    uptimeMs: Date.now() - ((app as never as Record<symbol, number>)[startedAt] ?? Date.now()),
    eventsBuffered: ctx.bus.recent().length,
    ...(stack
      ? { agents: stack.store.listAgents().length, defaultAgent: stack.defaultAgent.name }
      : {}),
  }));
  methods.set("gin.events.subscribe", (_params, ctx) => {
    const off = ctx.bus.on("*", (event) => ctx.push({ type: "event", event }));
    ctx.onClose(off);
    return { subscribed: true };
  });

  if (stack) {
    methods.set("gin.agent.list", () => stack.store.listAgents());
    methods.set("gin.session.list", (params) => {
      const parsed = SessionListSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid session.list params");
      return stack.store.listSessions(parsed.data?.agentId);
    });
    /**
     * WebChat send: feed the message into the channel pipeline and return
     * immediately. The reply arrives as a pushed "webchat.message" event once
     * the turn completes and the outbox delivers (at-least-once, in order).
     */
    methods.set("gin.chat.send", (params, ctx) => {
      const parsed = ChatSendSchema.safeParse(params);
      if (!parsed.success) {
        throw new GinError("validation_failed", "gin.chat.send needs { text, peerRef? }");
      }
      const peerRef = parsed.data.peerRef ?? `ws:${ctx.connectionId}`;
      ctx.bindWebChatPeer?.(peerRef);
      stack.webchat
        .receive({ peerRef, text: parsed.data.text, channelMessageId: newId() })
        .catch((err: unknown) => {
          const ginError = err instanceof GinError ? err : undefined;
          ctx.push({
            type: "event",
            event: {
              id: newId(),
              ts: Date.now(),
              type: "webchat.error",
              payload: {
                peerRef,
                code: ginError?.code ?? "internal",
                message: err instanceof Error ? err.message : String(err),
              },
            },
          });
        });
      return { accepted: true, peerRef };
    });
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  app.get("/health", async () => ({ status: "ok", name: "gin-gateway", version: "0.1.0" }));

  // ── WebSocket ──────────────────────────────────────────────────────────────
  void app.register(websocket);
  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      const closers: Array<() => void> = [];
      const boundPeers = new Set<string>();
      const ctx: RpcContext = {
        bus,
        connectionId: newId(),
        push: (frame) => socket.send(JSON.stringify(frame)),
        onClose: (fn) => closers.push(fn),
        ...(stack
          ? {
              bindWebChatPeer: (peerRef: string) => {
                if (boundPeers.has(peerRef)) return;
                boundPeers.add(peerRef);
                const off = stack.webchat.connect(peerRef, (text) => {
                  ctx.push({
                    type: "event",
                    event: {
                      id: newId(),
                      ts: Date.now(),
                      type: "webchat.message",
                      payload: { peerRef, text },
                    },
                  });
                });
                closers.push(off);
              },
            }
          : {}),
      };
      socket.on("close", () => {
        for (const fn of closers) fn();
      });

      socket.on("message", (raw: Buffer) => {
        // All inbound channel/client input is untrusted (spec 5.1): parse + validate
        // before touching anything, and never crash the socket on garbage.
        let frameId = "?";
        try {
          const parsed: unknown = JSON.parse(raw.toString());
          const frame = RequestFrameSchema.safeParse(parsed);
          if (!frame.success) {
            const maybeId =
              typeof parsed === "object" && parsed !== null && "id" in parsed
                ? String((parsed as { id: unknown }).id)
                : "?";
            ctx.push(fail(maybeId, "validation_failed", "Malformed request frame."));
            return;
          }
          frameId = frame.data.id;
          const handler = methods.get(frame.data.method);
          if (!handler) {
            ctx.push(fail(frameId, "not_found", `Unknown method: ${frame.data.method}`));
            return;
          }
          bus.emit("gateway.rpc", { method: frame.data.method });
          Promise.resolve()
            .then(() => handler(frame.data.params, ctx))
            .then(
              (payload) => ctx.push(ok(frameId, payload)),
              (err: unknown) => {
                const code = err instanceof GinError ? err.code : "internal";
                const message = err instanceof Error ? err.message : String(err);
                ctx.push(fail(frameId, code, message));
              },
            );
        } catch {
          ctx.push(fail(frameId, "validation_failed", "Frame is not valid JSON."));
        }
      });
    });
  });

  const gateway: Gateway = {
    app,
    bus,
    address: { port: requestedPort, host },
    async start() {
      (app as never as Record<symbol, number>)[startedAt] = Date.now();
      await app.listen({ port: requestedPort, host });
      const addr = app.server.address();
      if (addr && typeof addr === "object") gateway.address = { port: addr.port, host };
      stack?.manager.startPump(200);
      bus.emit("gateway.started", { port: gateway.address.port, host });
    },
    async stop() {
      bus.emit("gateway.stopping", {});
      await app.close();
    },
  };

  return gateway;
}
