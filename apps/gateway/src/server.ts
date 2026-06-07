import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { EventBus, GinError, newId } from "@gin/core";
import { OPERATOR, type Principal } from "@gin/governance";
import { z } from "zod";
import { RequestFrameSchema, ok, fail, type ServerFrame } from "./protocol.js";
import type { GatewayStack } from "./stack.js";

export interface GatewayOptions {
  port?: number;
  host?: string;
  bus?: EventBus;
  /** Full runtime stack; chat/agent/session methods register when present. */
  stack?: GatewayStack;
  /**
   * Principal for connections (default: local operator with full access).
   * The Phase 5 auth portal resolves this per-connection from credentials.
   */
  principal?: Principal;
  /** Serve the Command Center SPA from this directory at "/". */
  uiDir?: string;
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
  /** Authenticated principal for RBAC checks. */
  principal: Principal;
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

const TraceListSchema = z
  .object({ limit: z.number().int().positive().max(500).optional() })
  .optional();

const TraceGetSchema = z.object({ traceId: z.string().min(1) });

const BudgetStatusSchema = z
  .object({
    agentId: z.string().optional(),
    sessionId: z.string().optional(),
    tenantId: z.string().optional(),
  })
  .optional();

const BudgetSetSchema = z.object({
  scope: z.enum(["agent", "tenant", "session", "pipeline", "apiKey"]),
  scopeRef: z.string().min(1).optional(),
  limitUsd: z.number().nonnegative(),
  window: z.enum(["session", "hour", "day", "week", "month"]).optional(),
  action: z.enum(["block", "degrade", "alert"]).optional(),
});

const ApprovalListSchema = z.object({ all: z.boolean().optional() }).optional();

const ApprovalDecideSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  reason: z.string().optional(),
});

const AuditListSchema = z
  .object({
    actor: z.string().optional(),
    action: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .optional();

const ScheduleSetSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  action: z.union([
    z.object({ kind: z.literal("message"), text: z.string().min(1) }),
    z.object({
      kind: z.literal("workflow"),
      workflow: z.string().min(1),
      input: z.unknown().optional(),
    }),
  ]),
  enabled: z.boolean().optional(),
});

const ScheduleDeleteSchema = z.object({ name: z.string().min(1) });

const WorkflowRunSchema = z.object({ name: z.string().min(1), input: z.unknown().optional() });

const KeyCreateSchema = z.object({
  name: z.string().min(1),
  roles: z.array(z.string().min(1)).optional(),
  tenantId: z.string().optional(),
});

const KeyRevokeSchema = z.object({ keyId: z.string().min(1) });

/** RBAC scope required per RPC method; unlisted methods are open. */
const METHOD_SCOPES: Record<string, string> = {
  "gin.schedule.list": "schedule:read",
  "gin.schedule.set": "schedule:write",
  "gin.schedule.delete": "schedule:write",
  "gin.workflow.list": "workflows:read",
  "gin.workflow.run": "workflows:run",
  "gin.skill.list": "skills:read",
  "gin.agent.list": "agents:read",
  "gin.session.list": "sessions:read",
  "gin.chat.send": "chat:send",
  "gin.trace.list": "traces:read",
  "gin.trace.get": "traces:read",
  "gin.budget.status": "budget:read",
  "gin.budget.set": "budget:write",
  "gin.approval.list": "approvals:read",
  "gin.approval.decide": "approvals:decide",
  "gin.audit.list": "audit:read",
  "gin.key.create": "keys:admin",
  "gin.key.list": "keys:admin",
  "gin.key.revoke": "keys:admin",
};

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
    // ── Phase 4: schedule, workflows, skills ─────────────────────────────────
    methods.set("gin.schedule.list", () => stack.scheduler.list());
    methods.set("gin.schedule.set", (params, ctx) => {
      const parsed = ScheduleSetSchema.safeParse(params);
      if (!parsed.success) {
        throw new GinError("validation_failed", "gin.schedule.set needs { name, cron, action }");
      }
      const job = stack.scheduler.setJob(parsed.data);
      stack.audit.append({
        actor: ctx.principal.name,
        action: "schedule.set",
        target: `job/${job.name}`,
        after: { cron: job.cron, action: job.action, enabled: job.enabled },
      });
      return job;
    });
    methods.set("gin.schedule.delete", (params, ctx) => {
      const parsed = ScheduleDeleteSchema.safeParse(params);
      if (!parsed.success)
        throw new GinError("validation_failed", "gin.schedule.delete needs { name }");
      const deleted = stack.scheduler.delete(parsed.data.name);
      if (deleted) {
        stack.audit.append({
          actor: ctx.principal.name,
          action: "schedule.delete",
          target: `job/${parsed.data.name}`,
        });
      }
      return { deleted };
    });
    methods.set("gin.workflow.list", () => stack.workflows.list());
    methods.set("gin.workflow.run", async (params) => {
      const parsed = WorkflowRunSchema.safeParse(params);
      if (!parsed.success)
        throw new GinError("validation_failed", "gin.workflow.run needs { name, input? }");
      return stack.workflows.start(parsed.data.name, parsed.data.input ?? {});
    });
    methods.set("gin.skill.list", () => stack.skills.list());

    // ── Phase 3: approvals & audit ───────────────────────────────────────────
    methods.set("gin.approval.list", (params) => {
      const parsed = ApprovalListSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid approval.list params");
      return parsed.data?.all ? stack.approvals.list() : stack.approvals.listPending();
    });
    methods.set("gin.approval.decide", (params, ctx) => {
      const parsed = ApprovalDecideSchema.safeParse(params);
      if (!parsed.success) {
        throw new GinError(
          "validation_failed",
          "gin.approval.decide needs { approvalId, decision: approved|denied, reason? }",
        );
      }
      const before = stack.approvals.get(parsed.data.approvalId);
      if (!before) throw new GinError("not_found", `Unknown approval: ${parsed.data.approvalId}`);
      const record = stack.approvals.decide(
        parsed.data.approvalId,
        parsed.data.decision,
        ctx.principal.name,
        parsed.data.reason,
      );
      stack.audit.append({
        actor: ctx.principal.name,
        action: "approval.decided",
        target: `approval/${record.id}`,
        before: { status: before.status, action: before.action },
        after: { status: record.status, reason: record.reason },
      });
      return record;
    });
    methods.set("gin.audit.list", (params) => {
      const parsed = AuditListSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid audit.list params");
      return stack.audit.list(parsed.data ?? {});
    });

    // ── Phase 2: traces & budgets ────────────────────────────────────────────
    methods.set("gin.trace.list", (params) => {
      const parsed = TraceListSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid trace.list params");
      return stack.traces.listTraces(parsed.data?.limit ?? 50);
    });
    methods.set("gin.trace.get", (params) => {
      const parsed = TraceGetSchema.safeParse(params);
      if (!parsed.success)
        throw new GinError("validation_failed", "gin.trace.get needs { traceId }");
      return stack.traces.getTrace(parsed.data.traceId);
    });
    methods.set("gin.budget.status", (params) => {
      const parsed = BudgetStatusSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid budget.status params");
      const scopes = {
        agentId: parsed.data?.agentId ?? stack.defaultAgent.id,
        tenantId: parsed.data?.tenantId ?? stack.defaultAgent.tenantId,
        ...(parsed.data?.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
      };
      // Session budgets matter per session; include every session-scoped row too.
      const scoped = stack.budget.status(scopes);
      const all = stack.budget
        .listBudgets()
        .filter((b) => !scoped.some((s) => s.id === b.id))
        .map((b) => ({
          ...b,
          spentUsd: stack.budget.spent(b.scope, b.scopeRef, b.window),
          remainingUsd: Math.max(0, b.limitUsd - stack.budget.spent(b.scope, b.scopeRef, b.window)),
        }));
      return [...scoped, ...all];
    });
    methods.set("gin.budget.set", (params, ctx) => {
      const parsed = BudgetSetSchema.safeParse(params);
      if (!parsed.success) {
        throw new GinError(
          "validation_failed",
          "gin.budget.set needs { scope, limitUsd, scopeRef?, window?, action? }",
        );
      }
      const scopeRef =
        parsed.data.scopeRef ??
        (parsed.data.scope === "agent"
          ? stack.defaultAgent.id
          : parsed.data.scope === "tenant"
            ? stack.defaultAgent.tenantId
            : undefined);
      if (scopeRef === undefined) {
        throw new GinError(
          "validation_failed",
          `scopeRef is required for scope "${parsed.data.scope}"`,
        );
      }
      const row = stack.budget.setBudget({
        scope: parsed.data.scope,
        scopeRef,
        limitUsd: parsed.data.limitUsd,
        ...(parsed.data.window !== undefined ? { window: parsed.data.window } : {}),
        ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      });
      stack.audit.append({
        actor: ctx.principal.name,
        action: "budget.set",
        target: `${row.scope}/${row.scopeRef}`,
        after: { limitUsd: row.limitUsd, window: row.window, action: row.action },
      });
      return row;
    });

    // Tenant scoping (Phase 5): a tenant-bound key sees only its own world.
    const tenantAgents = (ctx: RpcContext) => {
      const agents = stack.store.listAgents();
      return ctx.principal.tenantId
        ? agents.filter((a) => a.tenantId === ctx.principal.tenantId)
        : agents;
    };
    methods.set("gin.agent.list", (_params, ctx) => tenantAgents(ctx));
    methods.set("gin.session.list", (params, ctx) => {
      const parsed = SessionListSchema.safeParse(params ?? undefined);
      if (!parsed.success) throw new GinError("validation_failed", "Invalid session.list params");
      let sessions = stack.store.listSessions(parsed.data?.agentId);
      if (ctx.principal.tenantId) {
        const allowed = new Set(tenantAgents(ctx).map((a) => a.id));
        sessions = sessions.filter((s) => allowed.has(s.agentId));
      }
      return sessions;
    });

    // ── Phase 5: API keys ────────────────────────────────────────────────────
    methods.set("gin.key.create", (params, ctx) => {
      const parsed = KeyCreateSchema.safeParse(params);
      if (!parsed.success) {
        throw new GinError("validation_failed", "gin.key.create needs { name, roles?, tenantId? }");
      }
      const created = stack.keys.create(parsed.data);
      stack.audit.append({
        actor: ctx.principal.name,
        action: "key.created",
        target: `key/${created.id}`,
        after: { name: created.name, roles: created.roles, tenantId: created.tenantId },
      });
      return created; // includes the raw key — shown exactly once
    });
    methods.set("gin.key.list", () => stack.keys.list());
    methods.set("gin.key.revoke", (params, ctx) => {
      const parsed = KeyRevokeSchema.safeParse(params);
      if (!parsed.success)
        throw new GinError("validation_failed", "gin.key.revoke needs { keyId }");
      const revoked = stack.keys.revoke(parsed.data.keyId);
      if (revoked) {
        stack.audit.append({
          actor: ctx.principal.name,
          action: "key.revoked",
          target: `key/${parsed.data.keyId}`,
        });
      }
      return { revoked };
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

  // Command Center: static SPA with an index.html fallback for client routes.
  if (opts.uiDir) {
    const uiDir = opts.uiDir;
    void app.register(fastifyStatic, { root: uiDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html", uiDir);
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  /**
   * Per-connection auth (Phase 5): a Bearer/?token key resolves to its
   * Principal; loopback without a key stays the local operator; anything
   * else is refused. opts.principal overrides (tests / embedding).
   */
  const resolvePrincipal = (req: {
    headers: Record<string, string | string[] | undefined>;
    query?: unknown;
    ip?: string;
  }): Principal | undefined => {
    if (opts.principal) return opts.principal;
    const header = req.headers.authorization;
    const bearer =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : undefined;
    const queryToken = (req.query as { token?: string } | undefined)?.token;
    const token = bearer ?? queryToken;
    if (token) return stack?.keys.verify(token); // bad key → undefined → refuse
    const ip = req.ip ?? "";
    const loopback = ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
    return loopback ? OPERATOR : undefined;
  };

  // ── WebSocket ──────────────────────────────────────────────────────────────
  void app.register(websocket);
  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket, req) => {
      const connectionPrincipal = resolvePrincipal(req);
      if (!connectionPrincipal) {
        socket.close(1008, "unauthorized");
        return;
      }
      const closers: Array<() => void> = [];
      const boundPeers = new Set<string>();
      const ctx: RpcContext = {
        bus,
        connectionId: newId(),
        principal: connectionPrincipal,
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
          // RBAC (Phase 3): every scoped method checks the principal first.
          const requiredScope = METHOD_SCOPES[frame.data.method];
          if (requiredScope && stack && !stack.rbac.can(ctx.principal, requiredScope)) {
            ctx.push(
              fail(
                frameId,
                "permission_denied",
                `${frame.data.method} requires scope "${requiredScope}".`,
              ),
            );
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
      stack?.scheduler.start();
      bus.emit("gateway.started", { port: gateway.address.port, host });
    },
    async stop() {
      bus.emit("gateway.stopping", {});
      await app.close();
    },
  };

  return gateway;
}
