import { GinError } from "@gin/core";
import type { BudgetEngine } from "@gin/cost";
import type { DurableEngine, WorkflowContext } from "@gin/durable";
import type { ApprovalBroker } from "@gin/governance";
import { resultText, type ModelRouter } from "@gin/models";
import type { ToolContext, ToolRegistry } from "@gin/tools";
import {
  WorkflowSpecSchema,
  resolveTemplates,
  type TemplateState,
  type WorkflowSpec,
} from "./spec.js";

/**
 * Compiles declarative specs onto the durable engine: each DSL step becomes
 * a ctx.step() checkpoint, so a crash mid-pipeline resumes exactly where it
 * stopped — completed tool calls, model calls, and approvals replay from the
 * log instead of re-running.
 */

export interface WorkflowRunnerOptions {
  durable: DurableEngine;
  registry: ToolRegistry;
  router: ModelRouter;
  /** Default "<provider>/<model>" for model steps without modelRef. */
  defaultModelRef: string;
  /** Tool context for tool steps (workspace, memory, skills, exec…). */
  toolContext: ToolContext;
  budget?: BudgetEngine;
  approvals?: ApprovalBroker;
}

export class WorkflowRunner {
  private readonly specs = new Map<string, WorkflowSpec>();

  constructor(private readonly opts: WorkflowRunnerOptions) {}

  /** Validate, register with the durable engine, and remember the spec. */
  register(input: unknown): WorkflowSpec {
    const parsed = WorkflowSpecSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new GinError(
        "validation_failed",
        `Invalid workflow spec: ${first ? `${first.path.join(".")} ${first.message}` : "unknown"}`,
        { details: { issues: parsed.error.issues } },
      );
    }
    const spec = parsed.data;
    if (this.specs.has(spec.name)) {
      throw new GinError("config_invalid", `Workflow "${spec.name}" already registered.`);
    }
    this.specs.set(spec.name, spec);
    this.opts.durable.register(spec.name, (ctx, input) => this.execute(spec, ctx, input));
    return spec;
  }

  list(): WorkflowSpec[] {
    return [...this.specs.values()];
  }

  async start(name: string, input: unknown): Promise<{ workflowId: string; output: unknown }> {
    if (!this.specs.has(name)) {
      throw new GinError("not_found", `No workflow registered as "${name}".`);
    }
    const record = await this.opts.durable.start(name, input);
    return { workflowId: record.id, output: record.output };
  }

  private async execute(
    spec: WorkflowSpec,
    ctx: WorkflowContext,
    input: unknown,
  ): Promise<unknown> {
    const state: TemplateState = { input, steps: {} };
    let lastOutput: unknown;

    for (const step of spec.steps) {
      let output: unknown;
      switch (step.kind) {
        case "tool": {
          const args = resolveTemplates(step.args, state);
          output = await ctx.step(
            step.id,
            () => this.opts.registry.execute(step.tool, args, this.opts.toolContext),
            step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {},
          );
          break;
        }
        case "model": {
          const prompt = String(resolveTemplates(step.prompt, state));
          const system =
            step.system !== undefined ? String(resolveTemplates(step.system, state)) : undefined;
          output = await ctx.step(step.id, async () => {
            const scopes = { pipelineId: `${spec.name}:${ctx.workflowId}` };
            if (step.budgetUsd !== undefined && this.opts.budget) {
              this.opts.budget.ensureBudget({
                scope: "pipeline",
                scopeRef: scopes.pipelineId,
                limitUsd: step.budgetUsd,
                window: "session",
                action: "block",
              });
              this.opts.budget.checkAndReserve(scopes);
            }
            const result = await this.opts.router.chat({
              modelRef: step.modelRef ?? this.opts.defaultModelRef,
              messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
              ...(system !== undefined ? { system } : {}),
              ...(step.maxTokens !== undefined ? { maxTokens: step.maxTokens } : {}),
              thinking: "off",
            });
            this.opts.budget?.record(scopes, result.costUsd, {
              description: `workflow:${spec.name}:${step.id}`,
            });
            if (
              step.budgetUsd !== undefined &&
              this.opts.budget &&
              result.costUsd > step.budgetUsd
            ) {
              throw new GinError(
                "budget_exceeded",
                `Step "${step.id}" cost $${result.costUsd.toFixed(4)} > cap $${step.budgetUsd}.`,
                { retryable: false },
              );
            }
            return resultText(result);
          });
          break;
        }
        case "approval": {
          if (!this.opts.approvals) {
            throw new GinError("config_invalid", "Workflow has approval steps but no broker.");
          }
          const broker = this.opts.approvals;
          output = await ctx.step(step.id, async () => {
            const status = await broker.request(
              {
                action: `workflow:${spec.name}:${step.action}`,
                params: { workflowId: ctx.workflowId, step: step.id },
                riskLevel: step.riskLevel,
              },
              step.timeoutMs,
            );
            if (status !== "approved") {
              throw new GinError("approval_required", `Approval "${step.action}" ${status}.`, {
                retryable: false,
              });
            }
            return { status };
          });
          break;
        }
      }
      state.steps[step.id] = { output };
      lastOutput = output;
    }

    return spec.output !== undefined ? resolveTemplates(spec.output, state) : lastOutput;
  }
}
