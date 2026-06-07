import {
  GinError,
  newId,
  toGinError,
  type Agent,
  type EventBus,
  type RiskLevel,
  type TokenUsage,
} from "@gin/core";
import type { BudgetEngine, BudgetScopes } from "@gin/cost";
import type { ApprovalBroker } from "@gin/governance";
import type { MemoryStore } from "@gin/memory";
import { executorFor, type SandboxExecutor } from "@gin/sandbox";
import type { SkillStore } from "@gin/skills";
import {
  resultText,
  toolUses,
  type ChatContentBlock,
  type ChatMessage,
  type ModelRouter,
} from "@gin/models";
import type { ToolContext, ToolRegistry } from "@gin/tools";
import type { Verifier } from "@gin/verifier";
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
  /** Budgets enforced BEFORE each model call (spec Phase 2). */
  budget?: BudgetEngine;
  /** Approval gates: tools at/above threshold pause for a human (Phase 3). */
  approvals?: {
    broker: ApprovalBroker;
    /** Minimum risk level that requires approval (default "critical"). */
    threshold?: RiskLevel;
    timeoutMs?: number;
  };
  /** Anti-silent-failure verification of the final reply (Phase 3). */
  verifier?: Verifier;
  /** Sandbox executor overrides per mode (tests / custom backends). */
  sandboxExecutors?: Partial<Record<Agent["sandboxMode"], SandboxExecutor>>;
  /** Skill store: metas disclosed in the system prompt, bodies on demand. */
  skills?: SkillStore;
  /** Hard cap on model-call iterations per turn (runaway-loop backstop). */
  maxIterations?: number;
  /** History window assembled into each model call. */
  historyLimit?: number;
  /** Compact when live (uncompacted) messages exceed this count. */
  compactAfter?: number;
  /** How many recent messages stay verbatim after compaction. */
  compactKeep?: number;
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
  status: "succeeded" | "failed" | "budget_terminated";
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
  private readonly budget: BudgetEngine | undefined;
  private readonly approvals: AgentRuntimeOptions["approvals"];
  private readonly verifier: Verifier | undefined;
  private readonly sandboxExecutors: NonNullable<AgentRuntimeOptions["sandboxExecutors"]>;
  private readonly executorCache = new Map<string, SandboxExecutor>();
  private readonly skills: SkillStore | undefined;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly compactAfter: number;
  private readonly compactKeep: number;

  constructor(opts: AgentRuntimeOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.router = opts.router;
    this.registry = opts.registry;
    this.memory = opts.memory;
    this.budget = opts.budget;
    this.approvals = opts.approvals;
    this.verifier = opts.verifier;
    this.sandboxExecutors = opts.sandboxExecutors ?? {};
    this.skills = opts.skills;
    this.maxIterations = opts.maxIterations ?? 16;
    this.historyLimit = opts.historyLimit ?? 40;
    this.compactAfter = opts.compactAfter ?? 60;
    this.compactKeep = opts.compactKeep ?? 20;
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

    const scopes: BudgetScopes = {
      tenantId: agent.tenantId,
      agentId: agent.id,
      sessionId: session.id,
    };
    this.ensureBudgets(agent, session.id);

    const total: TokenUsage = { ...ZERO_USAGE };
    let totalCost = 0;
    let stepCount = 0;

    const executor = this.executorForAgent(agent);
    const ctx: ToolContext = {
      agentId: agent.id,
      sessionId: session.id,
      workspacePath: agent.workspacePath,
      ...(executor
        ? {
            exec: (req: { command: string; timeoutMs: number }) =>
              executor.exec({ ...req, workspacePath: agent.workspacePath }),
          }
        : {}),
      ...(this.memory ? { memory: this.memoryPort(agent.id) } : {}),
      ...(this.skills ? { skills: this.skills } : {}),
      ...(input.sendMessage !== undefined ? { sendMessage: input.sendMessage } : {}),
    };

    try {
      const compaction = this.store.getCompaction(session.id);
      const system = await this.buildSystemPrompt(agent, input.userText, compaction.summary);
      const working: ChatMessage[] = this.assembleHistory(session.id, compaction.summaryUntil);
      const tools = this.registry.toChatTools(agent.toolPolicy);

      let finalText = "";
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        // The hard cost gate: the call is prevented, not billed-then-noticed.
        this.budget?.checkAndReserve(scopes);
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
        this.budget?.record(scopes, result.costUsd, { traceId, description: result.modelRef });
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

      finalText = this.runVerifier(turnId, traceId, finalText);

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
      await this.maybeCompact(agent, session.id, scopes, traceId);
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
      if (ginError.code === "budget_exceeded") {
        // Terminate gracefully: the user learns WHY the agent stopped, the
        // turn is recorded as budget_terminated, and no further calls happen.
        const notice =
          `⚠️ Budget limit reached — stopping here. ${ginError.message} ` +
          "Raise the limit with `gin budget set` to continue.";
        this.store.appendMessage({ sessionId: session.id, role: "assistant", content: notice });
        this.store.finishTurn(turnId, {
          status: "budget_terminated",
          usage: total,
          costUsd: totalCost,
        });
        this.bus.emit("turn.budget_terminated", {
          turnId,
          sessionId: session.id,
          traceId,
          usage: total,
          costUsd: totalCost,
          details: ginError.details,
        });
        return {
          turnId,
          sessionId: session.id,
          text: notice,
          usage: total,
          costUsd: totalCost,
          stepCount,
          status: "budget_terminated",
        };
      }
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

  /**
   * Anti-silent-failure check (Phase 3): cross-check the final reply against
   * the recorded step evidence. Error-level findings are appended to the
   * reply itself — the user must never read a failed action as "done".
   */
  private runVerifier(turnId: string, traceId: string, finalText: string): string {
    if (!this.verifier) return finalText;
    const verdict = this.verifier.verifyTurn({ finalText, steps: this.store.steps(turnId) });
    this.store.recordStep({
      turnId,
      type: "verify",
      status: verdict.ok ? "succeeded" : "failed",
      output: verdict,
    });
    this.bus.emit(verdict.ok ? "verifier.passed" : "verifier.flagged", {
      turnId,
      traceId,
      findings: verdict.findings,
    });
    if (verdict.ok) return finalText;
    const notes = verdict.findings
      .filter((f) => f.severity === "error")
      .map((f) => `⚠️ Verifier: ${f.message}`)
      .join("\n");
    return `${finalText}\n\n${notes}`;
  }

  /** Returns an error tool_result when approval is required and not granted. */
  private async gateApproval(
    call: { id: string; name: string; input: unknown },
    ctx: ToolContext,
    turnId: string,
    traceId: string,
  ): Promise<ChatContentBlock | undefined> {
    if (!this.approvals) return undefined;
    const risk = this.registry.get(call.name)?.riskLevel ?? "medium";
    const threshold = this.approvals.threshold ?? "critical";
    if (riskRank(risk) < riskRank(threshold)) return undefined;

    const status = await this.approvals.broker.request(
      {
        action: call.name,
        params: call.input,
        riskLevel: risk,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        turnId,
      },
      this.approvals.timeoutMs,
    );
    this.store.recordStep({
      turnId,
      type: "approval",
      status: status === "approved" ? "succeeded" : "failed",
      input: { tool: call.name, riskLevel: risk },
      output: { status },
    });
    this.bus.emit("step.approval", { turnId, traceId, tool: call.name, status });
    if (status === "approved") return undefined;

    const why = status === "expired" ? "timed out awaiting approval" : "was denied by the operator";
    return {
      type: "tool_result",
      toolUseId: call.id,
      content: `Error (approval_required): the ${call.name} call ${why}. Do not retry it; explain to the user instead.`,
      isError: true,
    };
  }

  /** Host mode keeps the tool's built-in sh; other modes get a sandbox. */
  private executorForAgent(agent: Agent): SandboxExecutor | undefined {
    const override = this.sandboxExecutors[agent.sandboxMode];
    if (override) return override;
    if (agent.sandboxMode === "host") return undefined;
    let executor = this.executorCache.get(agent.sandboxMode);
    if (!executor) {
      executor = executorFor(agent.sandboxMode);
      this.executorCache.set(agent.sandboxMode, executor);
    }
    return executor;
  }

  /** Materialize the agent's budget policy as engine rows (never overwrites). */
  private ensureBudgets(agent: Agent, sessionId: string): void {
    if (!this.budget) return;
    const action = agent.budgetPolicy.action;
    if (agent.budgetPolicy.perSessionUsd !== undefined) {
      this.budget.ensureBudget({
        scope: "session",
        scopeRef: sessionId,
        limitUsd: agent.budgetPolicy.perSessionUsd,
        window: "session",
        action,
      });
    }
    if (agent.budgetPolicy.perDayUsd !== undefined) {
      this.budget.ensureBudget({
        scope: "agent",
        scopeRef: agent.id,
        limitUsd: agent.budgetPolicy.perDayUsd,
        window: "day",
        action,
      });
    }
  }

  /**
   * Compaction: once live history outgrows compactAfter, summarize everything
   * but the most recent compactKeep messages into the session summary. The
   * raw messages stay on disk (audit); only the assembled context shrinks.
   */
  private async maybeCompact(
    agent: Agent,
    sessionId: string,
    scopes: BudgetScopes,
    traceId: string,
  ): Promise<void> {
    const compaction = this.store.getCompaction(sessionId);
    const liveCount = this.store.messageCountAfter(sessionId, compaction.summaryUntil);
    if (liveCount <= this.compactAfter) return;

    const live = this.store.history(sessionId, liveCount, compaction.summaryUntil);
    const toSummarize = live.slice(0, live.length - this.compactKeep);
    if (toSummarize.length === 0) return;

    try {
      this.budget?.checkAndReserve(scopes);
      const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n");
      const result = await this.router.chat({
        modelRef: agent.modelConfig.primary,
        fallbacks: agent.modelConfig.fallbacks,
        system:
          "You compress conversation history. Produce a dense summary that preserves: " +
          "facts about the user, decisions made, open tasks, and anything the assistant " +
          "promised. Write it as bullet points. No preamble.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  (compaction.summary ? `Existing summary:\n${compaction.summary}\n\n` : "") +
                  `Conversation to fold in:\n${transcript}`,
              },
            ],
          },
        ],
        maxTokens: 1024,
        thinking: "off",
      });
      this.budget?.record(scopes, result.costUsd, { traceId, description: "compaction" });
      const summary = resultText(result);
      const lastSummarized = toSummarize.at(-1)!.id;
      this.store.setCompaction(sessionId, summary, lastSummarized);
      this.bus.emit("session.compacted", {
        sessionId,
        traceId,
        summarizedMessages: toSummarize.length,
        costUsd: result.costUsd,
      });
    } catch (err) {
      // Compaction is best-effort: a failed summary must never fail the turn.
      this.bus.emit("session.compact_failed", {
        sessionId,
        traceId,
        error: toGinError(err).toJSON(),
      });
    }
  }

  private async executeTool(
    call: { id: string; name: string; input: unknown },
    ctx: ToolContext,
    agent: Agent,
    turnId: string,
    traceId: string,
  ): Promise<ChatContentBlock> {
    // Approval gate (Phase 3): high-risk actions pause for a human. A denial
    // or timeout becomes an error result the model must work around — the
    // action itself never runs.
    const gated = await this.gateApproval(call, ctx, turnId, traceId);
    if (gated) return gated;

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

  private async buildSystemPrompt(
    agent: Agent,
    userText: string,
    summary?: string,
  ): Promise<string> {
    const parts: string[] = [];
    parts.push(agent.persona.trim() || `You are ${agent.name}, a helpful autonomous agent.`);
    if (summary) {
      parts.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);
    }
    if (this.skills) {
      const section = this.skills.promptSection();
      if (section) parts.push(section);
    }
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

  private assembleHistory(sessionId: string, afterId?: string): ChatMessage[] {
    const history = this.store.history(sessionId, this.historyLimit, afterId);
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

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function riskRank(level: RiskLevel): number {
  return RISK_ORDER[level];
}

function accumulate(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}
