import { GinError, toGinError, type RiskLevel, type ToolPolicy } from "@gin/core";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The tool registry. Every tool call is Zod-validated before execution and
 * every failure is wrapped in a GinError so the runtime can record it on the
 * step without string-matching. Tools declare a riskLevel so the governance
 * plane (Phase 3) can attach approval gates without changing tool code.
 */

export interface ToolMemoryPort {
  store(text: string, kind: "fact" | "skill" | "episodic"): Promise<string>;
  search(query: string, limit: number): Promise<{ id: string; text: string; score: number }[]>;
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  /** Absolute path; fs.* and shell.* are rooted here. */
  workspacePath: string;
  /** Wired by the runtime when a memory store is attached to the agent. */
  memory?: ToolMemoryPort;
  /** Wired by the runtime to deliver a message to the session's channel. */
  sendMessage?: (text: string) => Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Dotted "<toolset>.<verb>" name, e.g. "fs.read". */
  name: string;
  description: string;
  /** Toolset slug used by ToolPolicy.enabledToolsets. */
  toolset: string;
  riskLevel: RiskLevel;
  paramsSchema: Schema;
  /**
   * Raw JSON Schema override for the model layer. Bridged tools (MCP) carry
   * the server's schema verbatim; built-ins derive theirs from paramsSchema.
   */
  inputJsonSchema?: Record<string, unknown>;
  /** Optional output contract — malformed results become verification_failed. */
  resultSchema?: z.ZodTypeAny;
  execute(args: z.infer<Schema>, ctx: ToolContext): Promise<unknown>;
}

export interface ChatToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new GinError("config_invalid", `Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Tools visible to an agent under its ToolPolicy. */
  list(policy?: ToolPolicy): ToolDefinition[] {
    const all = [...this.tools.values()];
    if (!policy) return all;
    return all.filter((t) => {
      if (policy.deniedTools.includes(t.name)) return false;
      if (policy.enabledToolsets.includes("*")) return true;
      return policy.enabledToolsets.includes(t.toolset);
    });
  }

  /** Provider-neutral tool specs (JSON Schema) for the model layer. */
  toChatTools(policy?: ToolPolicy): ChatToolSpec[] {
    return this.list(policy).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema:
        t.inputJsonSchema ??
        (zodToJsonSchema(t.paramsSchema, { $refStrategy: "none" }) as Record<string, unknown>),
    }));
  }

  async execute(
    name: string,
    args: unknown,
    ctx: ToolContext,
    policy?: ToolPolicy,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new GinError("not_found", `Unknown tool: ${name}`);
    if (policy && !this.list(policy).some((t) => t.name === name)) {
      throw new GinError("permission_denied", `Tool "${name}" is not enabled for this agent.`);
    }

    const parsed = tool.paramsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      throw new GinError("validation_failed", `Invalid arguments for ${name}`, {
        details: { issues: parsed.error.issues },
      });
    }

    let output: unknown;
    try {
      output = await tool.execute(parsed.data, ctx);
    } catch (err) {
      throw toGinError(err, "tool_error");
    }

    // Output validation (spec Phase 3): a tool that declares a result shape
    // must honor it — malformed output is a verification failure, not data
    // the model silently builds on.
    if (tool.resultSchema) {
      const result = tool.resultSchema.safeParse(output);
      if (!result.success) {
        throw new GinError("verification_failed", `Tool ${name} returned malformed output`, {
          details: { issues: result.error.issues },
        });
      }
      return result.data;
    }
    return output;
  }
}
