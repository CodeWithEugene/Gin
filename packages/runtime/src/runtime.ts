import { GinError, newId, toGinError, type Agent, type EventBus, type TokenUsage } from "@gin/core";
import type { MemoryStore } from "@gin/memory";
import {
  resultText,
  toolUses,
  type ChatContentBlock,
  type ChatMessage,
  type ModelRouter,
} from "@gin/models";
import type { ToolContext, ToolRegistry } from "@gin/tools";
import type { SessionStore } from "./store.js";

/**
 * The agent loop (spec Section 4): assemble context → call model → execute
 * requested tools → feed results back → repeat until the model ends the
 * turn. Every model call and tool call becomes a recorded step and a bus
 * event, so the observability cockpit and (Phase 2) the durable engine see
 * the same trace the runtime acted on.
 */

export interface AgentRuntimeOptions {
  store: SessionStore;
  bus: EventBus;
  router: ModelRouter;
  registry: ToolRegistry;
  memory?: MemoryStore;
  /** Hard cap on model-call iterations per turn (runaway-loop backstop). */
  maxIterations?: number;
  /** History window assembled into each model call. */
  historyLimit?: number;
}

export interface RunTurnInput {
  agentId: string;
  userText: string;
  /** Resume an existing session; otherwise resolved via channel/peer. */
  sessionId?: string;
  channelId?: string;
  peerRef?: string;
  /** Outbound port for interim messages (sessions.send tool). */
  sendMessage?: (text: string) => Promise<void>;
}

export interface TurnResult {
  turnId: string;
  sessionId: string;
  text: string;
  usage: TokenUsage;
  costUsd: number;
  stepCount: number;
  status: "succeeded" | "failed";
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export class AgentRuntime {
  private readonly store: SessionStore;
  private readonly bus: EventBus;
  private readonly router: ModelRouter;
  private readonly registry: ToolRegistry;
  private readonly memory: MemoryStore | undefined;
  private readonly maxIterations: number;
  private readonly historyLimit: number;

  constructor(opts: AgentRuntimeOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.router = opts.router;
    this.registry = opts.registry;
    this.memory = opts.memory;
    this.maxIterations = opts.maxIterations ?? 16;
    this.historyLimit = opts.historyLimit ?? 40;
  }

  async runTurn(input: RunTurnInput): Promise<TurnResult> {
    const agent = this.store.getAgent(input.agentId);
    if (!agent) throw new GinError("not_found", `Unknown agent: ${input.agentId}`);

    const session = input.sessionId
      ? this.store.getSession(input.sessionId)
      : this.store.getOrCreateSession(agent.id, {
          ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
          ...(input.peerRef !== undefined ? { peerRef: input.peerRef } : {}),
        });
    if (!session) throw new GinError("not_found", `Unknown session: ${input.sessionId}`);

    this.store.appendMessage({ sessionId: session.id, role: "user", content: input.userText });

    const traceId = newId();
    const turnId = this.store.createTurn(session.id, traceId);
    this.bus.emit("turn.started", { turnId, sessionId: session.id, agentId: agent.id, traceId });

    const total: TokenUsage = { ...ZERO_USAGE };
    let totalCost = 0;
    let stepCount = 0;

    const ctx: ToolContext = {
      agentId: agent.id,
      sessionId: session.id,
      workspacePath: agent.workspacePath,
      ...(this.memory ? { memory: this.memoryPort(agent.id) } : {}),
      ...(input.sendMessage !== undefined ? { sendMessage: input.sendMessage } : {}),
    };

    try {
      const system = await this.buildSystemPrompt(agent, input.userText);
      const working: ChatMessage[] = this.assembleHistory(session.id);
      const tools = this.registry.toChatTools(agent.toolPolicy);

      let finalText = "";
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        const started = Date.now();
        const result = await this.router.chat({
          modelRef: agent.modelConfig.primary,
          fallbacks: agent.modelConfig.fallbacks,
          system,
          messages: working,
          tools,
          ...(agent.modelConfig.maxTokens !== undefined
            ? { maxTokens: agent.modelConfig.maxTokens }
            : {}),
          ...(agent.modelConfig.temperature !== undefined
            ? { temperature: agent.modelConfig.temperature }
            : {}),
        });
        accumulate(total, result.usage);
        totalCost += result.costUsd;
        stepCount++;
        this.store.recordStep({
          turnId,
          type: "model_call",
          status: "succeeded",
          input: { modelRef: result.modelRef, iteration },
          output: { stopReason: result.stopReason },
          latencyMs: Date.now() - started,
          tokens: result.usage,
          costUsd: result.costUsd,
        });
        this.bus.emit("model.called", {
          turnId,
          traceId,
          modelRef: result.modelRef,
          stopReason: result.stopReason,
          usage: result.usage,
          costUsd: result.costUsd,
        });

        const calls = toolUses(result);
        if (result.stopReason !== "tool_use" || calls.length === 0) {
          finalText = resultText(result);
          break;
        }

        working.push({ role: "assistant", content: result.content });
        const resultBlocks: ChatContentBlock[] = [];
        for (const call of calls) {
          resultBlocks.push(await this.executeTool(call, ctx, agent, turnId, traceId));
          stepCount++;
        }
        working.push({ role: "user", content: resultBlocks });

        if (iteration === this.maxIterations - 1) {
          throw new GinError("workflow_failed", `Turn exceeded ${this.maxIterations} iterations.`);
        }
      }

      this.store.appendMessage({ sessionId: session.id, role: "assistant", content: finalText });
      this.store.finishTurn(turnId, { status: "succeeded", usage: total, costUsd: totalCost });
      this.bus.emit("turn.completed", {
        turnId,
        sessionId: session.id,
        traceId,
        usage: total,
        costUsd: totalCost,
        stepCount,
      });
      return {
        turnId,
        sessionId: session.id,
        text: finalText,
        usage: total,
        costUsd: totalCost,
        stepCount,
        status: "succeeded",
      };
    } catch (err) {
      const ginError = toGinError(err);
      this.store.finishTurn(turnId, { status: "failed", usage: total, costUsd: totalCost });
      this.bus.emit("turn.failed", {
        turnId,
        sessionId: session.id,
        traceId,
        error: ginError.toJSON(),
      });
      throw ginError;
    }
  }

  private async executeTool(
    call: { id: string; name: string; input: unknown },
    ctx: ToolContext,
    agent: Agent,
    turnId: string,
    traceId: string,
  ): Promise<ChatContentBlock> {
    const started = Date.now();
    this.bus.emit("step.started", { turnId, traceId, tool: call.name });
    try {
      const output = await this.registry.execute(call.name, call.input, ctx, agent.toolPolicy);
      this.store.recordStep({
        turnId,
        type: "tool_call",
        status: "succeeded",
        input: { tool: call.name, args: call.input },
        output,
        latencyMs: Date.now() - started,
      });
      this.bus.emit("step.finished", { turnId, traceId, tool: call.name, ok: true });
      return { type: "tool_result", toolUseId: call.id, content: JSON.stringify(output) };
    } catch (err) {
      const ginError = toGinError(err, "tool_error");
      this.store.recordStep({
        turnId,
        type: "tool_call",
        status: "failed",
        input: { tool: call.name, args: call.input },
        output: ginError.toJSON(),
        latencyMs: Date.now() - started,
      });
      this.bus.emit("step.finished", { turnId, traceId, tool: call.name, ok: false });
      // The model sees the failure and can adapt — a failed tool call is not
      // a failed turn (anti-silent-failure: the error is recorded either way).
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: `Error (${ginError.code}): ${ginError.message}`,
        isError: true,
      };
    }
  }

  private async buildSystemPrompt(agent: Agent, userText: string): Promise<string> {
    const parts: string[] = [];
    parts.push(agent.persona.trim() || `You are ${agent.name}, a helpful autonomous agent.`);
    if (this.memory) {
      const hits = await this.memory.search(agent.id, userText, { limit: 5 });
      if (hits.length > 0) {
        parts.push(
          [
            "<relevant_memories>",
            ...hits.map((h) => `- ${h.record.text}`),
            "</relevant_memories>",
          ].join("\n"),
        );
      }
    }
    parts.push(
      "Use the available tools when they help you answer accurately. " +
        "Store durable facts about the user or project with memory.store.",
    );
    return parts.join("\n\n");
  }

  private assembleHistory(sessionId: string): ChatMessage[] {
    const history = this.store.history(sessionId, this.historyLimit);
    const messages: ChatMessage[] = [];
    for (const msg of history) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      if (!msg.content) continue;
      messages.push({ role: msg.role, content: [{ type: "text", text: msg.content }] });
    }
    return messages;
  }

  private memoryPort(agentId: string): NonNullable<ToolContext["memory"]> {
    const memory = this.memory!;
    return {
      store: async (text, kind) => (await memory.store({ agentId, text, kind })).id,
      search: async (query, limit) =>
        (await memory.search(agentId, query, { limit })).map((h) => ({
          id: h.record.id,
          text: h.record.text,
          score: h.score,
        })),
    };
  }
}

function accumulate(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}
