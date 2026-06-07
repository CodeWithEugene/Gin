import { z } from "zod";

/**
 * The workflow DSL (spec Phase 4). Declarative specs — JSON on disk or over
 * RPC — compile onto the durable engine, so every step is checkpointed and
 * the whole pipeline survives crashes. The spec's canonical example:
 *
 * {
 *   "name": "triage_inbox",
 *   "steps": [
 *     { "id": "list",     "kind": "tool",     "tool": "email.list", "args": { "folder": "inbox" } },
 *     { "id": "classify", "kind": "model",    "prompt": "Classify: {{steps.list.output}}",
 *                          "budgetUsd": 0.05 },
 *     { "id": "confirm",  "kind": "approval", "action": "send-replies", "riskLevel": "high" },
 *     { "id": "send",     "kind": "tool",     "tool": "email.send", "args": { "drafts": "{{steps.classify.output}}" } }
 *   ],
 *   "output": "{{steps.classify.output}}"
 * }
 */

export const ToolStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("tool"),
  tool: z.string().min(1),
  /** Values may be templates: {{input.x}}, {{steps.<id>.output.y}}. */
  args: z.record(z.unknown()).default({}),
  maxAttempts: z.number().int().positive().max(10).optional(),
});

export const ModelStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("model"),
  prompt: z.string().min(1),
  system: z.string().optional(),
  /** "<provider>/<model>"; defaults to the workflow runner's model. */
  modelRef: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  /** Hard cap for this step (enforced via the budget engine, pipeline scope). */
  budgetUsd: z.number().positive().optional(),
});

export const ApprovalStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("approval"),
  action: z.string().min(1),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("high"),
  timeoutMs: z.number().int().positive().optional(),
});

export const WorkflowStepSchema = z.discriminatedUnion("kind", [
  ToolStepSchema,
  ModelStepSchema,
  ApprovalStepSchema,
]);

export const WorkflowSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
    description: z.string().default(""),
    steps: z.array(WorkflowStepSchema).min(1),
    /** Template for the workflow result; defaults to the last step's output. */
    output: z.string().optional(),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const step of spec.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate step id "${step.id}"` });
      }
      seen.add(step.id);
    }
  });

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/**
 * Template resolution. A string that is exactly one "{{path}}" resolves to
 * the raw value (objects stay objects); embedded templates interpolate as
 * strings. Paths: input.* and steps.<id>.output.*
 */
export interface TemplateState {
  input: unknown;
  steps: Record<string, { output: unknown }>;
}

const FULL_TEMPLATE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const EMBEDDED = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveTemplates(value: unknown, state: TemplateState): unknown {
  if (typeof value === "string") {
    const full = FULL_TEMPLATE.exec(value);
    if (full) return lookupPath(full[1]!, state);
    return value.replace(EMBEDDED, (_m, path: string) => stringify(lookupPath(path, state)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, state));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveTemplates(v, state),
      ]),
    );
  }
  return value;
}

function lookupPath(path: string, state: TemplateState): unknown {
  const parts = path.trim().split(".");
  let cursor: unknown = state;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
