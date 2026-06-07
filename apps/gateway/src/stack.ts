import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelManager,
  DiscordAdapter,
  Outbox,
  SlackAdapter,
  TelegramAdapter,
  WebChatAdapter,
  type DmPolicy,
} from "@gin/channels";
import { EmailService, ImapFlowPort, NodemailerPort, registerEmailTools } from "@gin/email";
import { ginHome, workspacePath, type GinConfig } from "@gin/config";
import { EventBus, newId, type Agent } from "@gin/core";
import { BudgetEngine } from "@gin/cost";
import { DurableEngine } from "@gin/durable";
import { ApiKeyStore, ApprovalBroker, AuditLog, Rbac } from "@gin/governance";
import { HashEmbedder, MemoryStore } from "@gin/memory";
import { AnthropicProvider, ModelRouter, OllamaProvider } from "@gin/models";
import { TraceStore } from "@gin/observability";
import { AgentRuntime, SessionStore } from "@gin/runtime";
import { Scheduler } from "@gin/scheduler";
import { SkillStore, installBundledSkills, registerSkillTools } from "@gin/skills";
import { openDatabase, type GinDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { Verifier } from "@gin/verifier";
import { WorkflowRunner } from "@gin/workflows";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The full runtime stack behind the Gateway: storage, models, tools, memory,
 * the agent runtime, channels with the guaranteed-delivery outbox, and the
 * Phase 2 wedge — durable engine, trace store, and budget engine. The
 * Gateway's RPC layer is a thin shell over this.
 */

export interface GatewayStack {
  bus: EventBus;
  db: GinDatabase;
  store: SessionStore;
  runtime: AgentRuntime;
  registry: ToolRegistry;
  router: ModelRouter;
  memory: MemoryStore;
  manager: ChannelManager;
  webchat: WebChatAdapter;
  budget: BudgetEngine;
  traces: TraceStore;
  durable: DurableEngine;
  approvals: ApprovalBroker;
  audit: AuditLog;
  rbac: Rbac;
  keys: ApiKeyStore;
  skills: SkillStore;
  workflows: WorkflowRunner;
  scheduler: Scheduler;
  config: GinConfig;
  defaultAgent: Agent;
  close(): Promise<void>;
}

export interface BuildStackOptions {
  config: GinConfig;
  /** Defaults to ~/.gin/gin.db; use ":memory:" in tests. */
  dbPath?: string;
  /** Gin home for skills/workflows dirs; defaults to ~/.gin ($GIN_HOME). */
  homeDir?: string;
  bus?: EventBus;
  /** Test override — defaults to Anthropic (if keyed) + Ollama. */
  router?: ModelRouter;
}

export async function buildStack(opts: BuildStackOptions): Promise<GatewayStack> {
  const config = opts.config;
  const bus = opts.bus ?? new EventBus();
  const home = opts.homeDir ?? ginHome();
  const db = openDatabase({ path: opts.dbPath ?? join(home, "gin.db") });

  const store = new SessionStore(db);
  // HashEmbedder keeps the vector path alive with zero dependencies; FTS5
  // carries recall. Swapping in OllamaEmbedder is a config change later.
  const memory = new MemoryStore(db, { embedder: new HashEmbedder() });
  const skills = new SkillStore(join(home, "skills"));
  installBundledSkills(skills);
  const registry = registerSkillTools(registerCoreTools(new ToolRegistry()));
  registerEmail(registry, config, bus);

  const router = opts.router ?? defaultRouter();

  // Phase 2 wedge: glass-box traces, hard budgets, durable workflows.
  const traces = new TraceStore(db).attach(bus);
  const budget = new BudgetEngine(db, { bus });
  const durable = new DurableEngine(db, { bus });

  // Phase 3 governance: approval gates, audit log, RBAC, verifier.
  const approvalsConfig = config.governance.approvals;
  const approvals = new ApprovalBroker(db, { bus, timeoutMs: approvalsConfig.timeoutMs });
  const audit = new AuditLog(db);
  const rbac = new Rbac();
  const keys = new ApiKeyStore(db);

  const runtime = new AgentRuntime({
    store,
    bus,
    router,
    registry,
    memory,
    budget,
    ...(approvalsConfig.enabled
      ? {
          approvals: {
            broker: approvals,
            threshold: approvalsConfig.threshold,
            timeoutMs: approvalsConfig.timeoutMs,
          },
        }
      : {}),
    ...(config.governance.verifier.enabled ? { verifier: new Verifier() } : {}),
    skills,
  });
  const defaultAgent = ensureDefaultAgent(store, config);
  // The default agent's tenant becomes the named "local" tenant (Phase 5).
  store.ensureTenant({ id: defaultAgent.tenantId, name: "local" });

  // Phase 4: declarative workflows (specs from ~/.gin/workflows/*.json) and
  // the scheduler that drives turns/workflows on cron.
  const workflows = new WorkflowRunner({
    durable,
    registry,
    router,
    defaultModelRef: defaultAgent.modelConfig.primary,
    toolContext: {
      agentId: defaultAgent.id,
      sessionId: "workflow",
      workspacePath: defaultAgent.workspacePath,
      skills,
    },
    budget,
    approvals,
  });
  loadWorkflowSpecs(workflows, join(home, "workflows"), bus);

  const scheduler = new Scheduler(db, {
    bus,
    onMessage: async (text, jobName) => {
      const result = await runtime.runTurn({
        agentId: defaultAgent.id,
        userText: text,
        channelId: "scheduler",
        peerRef: `job:${jobName}`,
      });
      return result.text;
    },
    onWorkflow: async (workflow, input) => (await workflows.start(workflow, input)).output,
  });

  const outbox = new Outbox(db);
  const webchat = new WebChatAdapter();

  const manager: ChannelManager = new ChannelManager({
    outbox,
    bus,
    dmPolicies: dmPolicies(config),
    onInbound: async (msg) => {
      const result = await runtime.runTurn({
        agentId: defaultAgent.id,
        userText: msg.text,
        channelId: msg.channelId,
        peerRef: msg.peerRef,
        sendMessage: async (text) => {
          manager.send(msg.channelId, msg.peerRef, text);
        },
      });
      // Reply is committed to the outbox keyed by turn id: a crash after this
      // point re-delivers instead of losing the message.
      manager.send(msg.channelId, msg.peerRef, result.text, `turn:${result.turnId}`);
    },
  });

  await manager.register(webchat);
  await registerTelegram(manager, config, bus);
  await registerSlack(manager, config, bus);
  await registerDiscord(manager, config, bus);

  return {
    bus,
    db,
    store,
    runtime,
    registry,
    router,
    memory,
    manager,
    webchat,
    budget,
    traces,
    durable,
    approvals,
    audit,
    rbac,
    keys,
    skills,
    workflows,
    scheduler,
    config,
    defaultAgent,
    async close() {
      scheduler.stop();
      await manager.stop();
      traces.detach();
      db.close();
    },
  };
}

/** Load *.json workflow specs; a malformed spec is reported, never fatal. */
function loadWorkflowSpecs(runner: WorkflowRunner, dir: string, bus: EventBus): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return; // no workflows dir yet
  }
  for (const file of files) {
    try {
      runner.register(JSON.parse(readFileSync(join(dir, file), "utf8")));
    } catch (err) {
      bus.emit("workflow.spec_invalid", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function registerSlack(
  manager: ChannelManager,
  config: GinConfig,
  bus: EventBus,
): Promise<void> {
  const slack = config.channels.slack;
  if (!slack?.enabled) return;
  const botToken = resolveSecret(slack.tokenRef);
  const appToken = resolveSecret(slack.appTokenRef);
  if (!botToken || !appToken) {
    bus.emit("channel.error", {
      channelId: "slack",
      message:
        'Slack enabled but tokens not resolvable. Set tokenRef ("env:SLACK_BOT_TOKEN") and appTokenRef ("env:SLACK_APP_TOKEN").',
    });
    return;
  }
  await manager.register(new SlackAdapter({ botToken, appToken }));
}

function defaultRouter(): ModelRouter {
  const router = new ModelRouter();
  if (process.env.ANTHROPIC_API_KEY) router.register(new AnthropicProvider());
  router.register(new OllamaProvider());
  return router;
}

/** The single default agent until multi-agent routing lands (Phase 4). */
export function ensureDefaultAgent(store: SessionStore, config: GinConfig): Agent {
  const existing = store.getAgentByName("gin");
  if (existing) return existing;
  const workspace = workspacePath(config);
  mkdirSync(workspace, { recursive: true });
  return store.createAgent({
    tenantId: newId(),
    name: "gin",
    persona: "",
    workspacePath: workspace,
    modelConfig: { primary: config.agent.model, fallbacks: config.agent.fallbacks },
    sandboxMode: config.agent.sandboxMode,
    budgetPolicy: {
      ...(config.budgets.perSessionUsd !== undefined
        ? { perSessionUsd: config.budgets.perSessionUsd }
        : {}),
      ...(config.budgets.perDayUsd !== undefined ? { perDayUsd: config.budgets.perDayUsd } : {}),
      action: config.budgets.action,
    },
  });
}

function dmPolicies(config: GinConfig): Record<string, DmPolicy> {
  const policies: Record<string, DmPolicy> = {
    // WebChat rides the loopback-bound gateway socket — local and trusted.
    webchat: { policy: "open", allowFrom: [] },
  };
  for (const [name, channel] of Object.entries(config.channels)) {
    policies[name] = { policy: channel.dmPolicy, allowFrom: channel.allowFrom };
  }
  return policies;
}

async function registerTelegram(
  manager: ChannelManager,
  config: GinConfig,
  bus: EventBus,
): Promise<void> {
  const telegram = config.channels.telegram;
  if (!telegram?.enabled) return;
  const token = resolveSecret(telegram.tokenRef);
  if (!token) {
    bus.emit("channel.error", {
      channelId: "telegram",
      message: `Telegram enabled but token not resolvable from ref "${telegram.tokenRef ?? ""}". Set tokenRef to "env:TELEGRAM_BOT_TOKEN".`,
    });
    return;
  }
  await manager.register(new TelegramAdapter({ token }));
}

async function registerDiscord(
  manager: ChannelManager,
  config: GinConfig,
  bus: EventBus,
): Promise<void> {
  const discord = config.channels.discord;
  if (!discord?.enabled) return;
  const token = resolveSecret(discord.tokenRef);
  if (!token) {
    bus.emit("channel.error", {
      channelId: "discord",
      message: `Discord enabled but token not resolvable. Set tokenRef to "env:DISCORD_BOT_TOKEN".`,
    });
    return;
  }
  await manager.register(new DiscordAdapter({ token }));
}

/** Wire email tools when the operator configured a mailbox. */
function registerEmail(registry: ToolRegistry, config: GinConfig, bus: EventBus): void {
  const email = config.email;
  if (!email.enabled) return;
  const imapPass = resolveSecret(email.imap?.passRef);
  const smtpPass = resolveSecret(email.smtp?.passRef);
  if (!email.imap || !email.smtp || !email.from || !imapPass || !smtpPass) {
    bus.emit("channel.error", {
      channelId: "email",
      message:
        "Email enabled but incomplete: needs from, imap{host,port,user,passRef}, smtp{...} with resolvable env refs.",
    });
    return;
  }
  const service = new EmailService({
    imap: new ImapFlowPort({ ...email.imap, pass: imapPass }),
    smtp: new NodemailerPort({ ...email.smtp, pass: smtpPass }),
    from: email.from,
    allowSendTo: email.allowSendTo,
  });
  registerEmailTools(registry, service);
}

/**
 * Secret references, never raw secrets, live in config (spec 5.1).
 * Phase 1 supports "env:VAR_NAME"; the keychain backend lands in Phase 3.
 */
export function resolveSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] || undefined;
  return undefined;
}
