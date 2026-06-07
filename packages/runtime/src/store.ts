import {
  AgentSchema,
  newId,
  type Agent,
  type Message,
  type Step,
  type TokenUsage,
  type Turn,
} from "@gin/core";
import { migrate, type GinDatabase, type Migration } from "@gin/storage";
import type { z } from "zod";

/**
 * Runtime persistence: agents, sessions, messages, turns, steps. Zod schemas
 * in @gin/core are the source of truth; rows mirror them with JSON columns
 * for nested config. Every write is synchronous (better-sqlite3) — the
 * runtime loop is the only writer per session.
 */

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "runtime-core",
    up: (db) => {
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL UNIQUE,
          persona TEXT NOT NULL DEFAULT '',
          workspace_path TEXT NOT NULL,
          model_config TEXT NOT NULL,
          tool_policy TEXT NOT NULL,
          sandbox_mode TEXT NOT NULL,
          budget_policy TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          channel_id TEXT,
          peer_ref TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          parent_session_id TEXT,
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX sessions_peer ON sessions (agent_id, channel_id, peer_ref)
          WHERE status = 'active';
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]',
          channel_message_id TEXT,
          delivery_status TEXT NOT NULL DEFAULT 'queued',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX messages_session ON messages (session_id, id);
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          plan TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planning',
          token_usage TEXT NOT NULL DEFAULT '{}',
          cost_usd REAL NOT NULL DEFAULT 0,
          trace_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX turns_session ON turns (session_id, id);
        CREATE TABLE steps (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES turns(id),
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          input TEXT,
          output TEXT,
          latency_ms REAL,
          tokens TEXT,
          cost_usd REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX steps_turn ON steps (turn_id, id);
      `);
    },
  },
  {
    version: 2,
    name: "session-compaction",
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN summary TEXT;
        ALTER TABLE sessions ADD COLUMN summary_until TEXT;
      `);
    },
  },
  {
    version: 3,
    name: "tenants",
    up: (db) => {
      db.exec(`
        CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          plan TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
];

export interface TenantRecord {
  id: string;
  name: string;
  plan: string;
  createdAt: number;
}

function toTenant(row: Record<string, unknown>): TenantRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    plan: row.plan as string,
    createdAt: row.created_at as number,
  };
}

export interface SessionRecord {
  id: string;
  agentId: string;
  channelId?: string;
  peerRef: string;
  status: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: Message["role"];
  content: string;
  createdAt: number;
}

export class SessionStore {
  constructor(private readonly db: GinDatabase) {
    migrate(db, "runtime", MIGRATIONS);
  }

  // ── Tenants ────────────────────────────────────────────────────────────────

  /** Idempotent: create the tenant row if its name (or id) isn't present. */
  ensureTenant(input: { id?: string; name: string; plan?: string }): TenantRecord {
    const existing = this.db
      .prepare("SELECT * FROM tenants WHERE name = ? OR id = ?")
      .get(input.name, input.id ?? "") as Record<string, unknown> | undefined;
    if (existing) return toTenant(existing);
    const tenant: TenantRecord = {
      id: input.id ?? newId(),
      name: input.name,
      plan: input.plan ?? "local",
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO tenants (id, name, plan, created_at) VALUES (?, ?, ?, ?)")
      .run(tenant.id, tenant.name, tenant.plan, tenant.createdAt);
    return tenant;
  }

  getTenant(id: string): TenantRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTenant(row) : undefined;
  }

  listTenants(): TenantRecord[] {
    const rows = this.db.prepare("SELECT * FROM tenants ORDER BY created_at").all() as Record<
      string,
      unknown
    >[];
    return rows.map(toTenant);
  }

  // ── Agents ─────────────────────────────────────────────────────────────────

  createAgent(
    input: Omit<z.input<typeof AgentSchema>, "id" | "createdAt"> & { id?: string },
  ): Agent {
    const agent = AgentSchema.parse({
      ...input,
      id: input.id ?? newId(),
      createdAt: Date.now(),
    });
    this.db
      .prepare(
        `INSERT INTO agents (id, tenant_id, name, persona, workspace_path, model_config,
           tool_policy, sandbox_mode, budget_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.tenantId,
        agent.name,
        agent.persona,
        agent.workspacePath,
        JSON.stringify(agent.modelConfig),
        JSON.stringify(agent.toolPolicy),
        agent.sandboxMode,
        JSON.stringify(agent.budgetPolicy),
        agent.createdAt,
      );
    return agent;
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? rowToAgent(row as Record<string, unknown>) : undefined;
  }

  getAgentByName(name: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
    return row ? rowToAgent(row as Record<string, unknown>) : undefined;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at").all();
    return rows.map((r) => rowToAgent(r as Record<string, unknown>));
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  getOrCreateSession(
    agentId: string,
    opts: { channelId?: string; peerRef?: string } = {},
  ): SessionRecord {
    const peerRef = opts.peerRef ?? "";
    const existing = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE agent_id = ? AND peer_ref = ? AND status = 'active'
           AND ((channel_id IS NULL AND ? IS NULL) OR channel_id = ?)`,
      )
      .get(agentId, peerRef, opts.channelId ?? null, opts.channelId ?? null);
    if (existing) return rowToSession(existing as Record<string, unknown>);

    const now = Date.now();
    const session: SessionRecord = {
      id: newId(),
      agentId,
      ...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
      peerRef,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, channel_id, peer_ref, status, created_at, last_active_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(session.id, agentId, opts.channelId ?? null, peerRef, now, now);
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? rowToSession(row as Record<string, unknown>) : undefined;
  }

  listSessions(agentId?: string): SessionRecord[] {
    const rows = agentId
      ? this.db
          .prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY last_active_at DESC")
          .all(agentId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC").all();
    return rows.map((r) => rowToSession(r as Record<string, unknown>));
  }

  touchSession(id: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  appendMessage(input: {
    sessionId: string;
    role: Message["role"];
    content: string;
    channelMessageId?: string;
  }): StoredMessage {
    const message: StoredMessage = {
      id: newId(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, channel_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        input.channelMessageId ?? null,
        message.createdAt,
      );
    this.touchSession(input.sessionId);
    return message;
  }

  /** Chronological history (ULID PK sorts by creation), after an optional cursor. */
  history(sessionId: string, limit = 40, afterId?: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE session_id = ? AND id > ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, afterId ?? "", limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      role: r.role as Message["role"],
      content: r.content as string,
      createdAt: r.created_at as number,
    }));
  }

  /** Live (uncompacted) message count — the compaction trigger. */
  messageCountAfter(sessionId: string, afterId?: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND id > ?")
      .get(sessionId, afterId ?? "") as { n: number };
    return row.n;
  }

  // ── Compaction state ───────────────────────────────────────────────────────

  getCompaction(sessionId: string): { summary?: string; summaryUntil?: string } {
    const row = this.db
      .prepare("SELECT summary, summary_until FROM sessions WHERE id = ?")
      .get(sessionId) as { summary: string | null; summary_until: string | null } | undefined;
    if (!row) return {};
    return {
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.summary_until !== null ? { summaryUntil: row.summary_until } : {}),
    };
  }

  setCompaction(sessionId: string, summary: string, summaryUntil: string): void {
    this.db
      .prepare("UPDATE sessions SET summary = ?, summary_until = ? WHERE id = ?")
      .run(summary, summaryUntil, sessionId);
  }

  // ── Turns & steps ──────────────────────────────────────────────────────────

  createTurn(sessionId: string, traceId = ""): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, status, trace_id, created_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(id, sessionId, traceId, Date.now());
    return id;
  }

  finishTurn(
    turnId: string,
    outcome: { status: Turn["status"]; usage: TokenUsage; costUsd: number },
  ): void {
    this.db
      .prepare("UPDATE turns SET status = ?, token_usage = ?, cost_usd = ? WHERE id = ?")
      .run(outcome.status, JSON.stringify(outcome.usage), outcome.costUsd, turnId);
  }

  getTurn(turnId: string):
    | (Pick<Turn, "id" | "sessionId" | "status" | "costUsd"> & {
        tokenUsage: TokenUsage;
      })
    | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      status: row.status as Turn["status"],
      costUsd: row.cost_usd as number,
      tokenUsage: JSON.parse((row.token_usage as string) || "{}") as TokenUsage,
    };
  }

  recordStep(input: {
    turnId: string;
    type: Step["type"];
    status: Step["status"];
    input?: unknown;
    output?: unknown;
    latencyMs?: number;
    tokens?: TokenUsage;
    costUsd?: number;
  }): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO steps (id, turn_id, type, status, input, output, latency_ms, tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.turnId,
        input.type,
        input.status,
        input.input !== undefined ? JSON.stringify(input.input) : null,
        input.output !== undefined ? JSON.stringify(input.output) : null,
        input.latencyMs ?? null,
        input.tokens !== undefined ? JSON.stringify(input.tokens) : null,
        input.costUsd ?? 0,
      );
    return id;
  }

  steps(turnId: string): {
    id: string;
    type: Step["type"];
    status: Step["status"];
    input: unknown;
    output: unknown;
    costUsd: number;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE turn_id = ? ORDER BY id")
      .all(turnId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      type: r.type as Step["type"],
      status: r.status as Step["status"],
      input: r.input !== null ? JSON.parse(r.input as string) : undefined,
      output: r.output !== null ? JSON.parse(r.output as string) : undefined,
      costUsd: r.cost_usd as number,
    }));
  }
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return AgentSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    persona: row.persona,
    workspacePath: row.workspace_path,
    modelConfig: JSON.parse(row.model_config as string),
    toolPolicy: JSON.parse(row.tool_policy as string),
    sandboxMode: row.sandbox_mode,
    budgetPolicy: JSON.parse(row.budget_policy as string),
    createdAt: row.created_at,
  });
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    ...(row.channel_id !== null ? { channelId: row.channel_id as string } : {}),
    peerRef: row.peer_ref as string,
    status: row.status as string,
    createdAt: row.created_at as number,
    lastActiveAt: row.last_active_at as number,
  };
}
