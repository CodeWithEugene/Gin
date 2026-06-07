import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelManager,
  Outbox,
  TelegramAdapter,
  WebChatAdapter,
  type DmPolicy,
} from "@gin/channels";
import { ginHome, workspacePath, type GinConfig } from "@gin/config";
import { EventBus, newId, type Agent } from "@gin/core";
import { HashEmbedder, MemoryStore } from "@gin/memory";
import { AnthropicProvider, ModelRouter, OllamaProvider } from "@gin/models";
import { AgentRuntime, SessionStore } from "@gin/runtime";
import { openDatabase, type GinDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";

/**
 * The full Phase 1 runtime stack behind the Gateway: storage, models, tools,
 * memory, the agent runtime, and channels with the guaranteed-delivery
 * outbox. The Gateway's RPC layer is a thin shell over this.
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
  config: GinConfig;
  defaultAgent: Agent;
  close(): Promise<void>;
}

export interface BuildStackOptions {
  config: GinConfig;
  /** Defaults to ~/.gin/gin.db; use ":memory:" in tests. */
  dbPath?: string;
  bus?: EventBus;
  /** Test override — defaults to Anthropic (if keyed) + Ollama. */
  router?: ModelRouter;
}

export async function buildStack(opts: BuildStackOptions): Promise<GatewayStack> {
  const config = opts.config;
  const bus = opts.bus ?? new EventBus();
  const db = openDatabase({ path: opts.dbPath ?? join(ginHome(), "gin.db") });

  const store = new SessionStore(db);
  // HashEmbedder keeps the vector path alive with zero dependencies; FTS5
  // carries recall. Swapping in OllamaEmbedder is a config change later.
  const memory = new MemoryStore(db, { embedder: new HashEmbedder() });
  const registry = registerCoreTools(new ToolRegistry());

  const router = opts.router ?? defaultRouter();

  const runtime = new AgentRuntime({ store, bus, router, registry, memory });
  const defaultAgent = ensureDefaultAgent(store, config);

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
    config,
    defaultAgent,
    async close() {
      await manager.stop();
      db.close();
    },
  };
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

/**
 * Secret references, never raw secrets, live in config (spec 5.1).
 * Phase 1 supports "env:VAR_NAME"; the keychain backend lands in Phase 3.
 */
export function resolveSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] || undefined;
  return undefined;
}
