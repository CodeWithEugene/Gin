import { GinError } from "@gin/core";
import { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "@gin/tools";

/** Skill tools — the model's surface for progressive disclosure + authoring. */

export const skillsRead: ToolDefinition<z.ZodObject<{ slug: z.ZodString }>> = {
  name: "skills.read",
  description:
    "Load the full instructions of an available skill by slug. Always read a skill before applying it.",
  toolset: "skills",
  riskLevel: "low",
  paramsSchema: z.object({ slug: z.string().min(1) }),
  async execute(args, ctx) {
    if (!ctx.skills) throw new GinError("tool_error", "No skill store attached to this agent.");
    const doc = ctx.skills.read(args.slug);
    return { name: doc.meta.name, version: doc.meta.version, instructions: doc.body };
  },
};

export const skillsSave: ToolDefinition<
  z.ZodObject<{
    slug: z.ZodString;
    description: z.ZodString;
    body: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "skills.save",
  description:
    "Save (or update) a reusable skill: a SKILL.md the agent can rediscover in future sessions. " +
    "Use after learning a multi-step procedure worth repeating.",
  toolset: "skills",
  riskLevel: "medium",
  paramsSchema: z.object({
    slug: z.string().min(1).describe("lowercase-dashed identifier, e.g. deploy-to-fly"),
    description: z.string().min(1).describe("One sentence: when should this skill be used?"),
    body: z.string().min(1).describe("The full markdown instructions"),
    name: z.string().optional(),
  }),
  async execute(args, ctx) {
    if (!ctx.skills) throw new GinError("tool_error", "No skill store attached to this agent.");
    const meta = ctx.skills.save(args);
    return { slug: meta.slug, version: meta.version };
  },
};

export function registerSkillTools(registry: ToolRegistry): ToolRegistry {
  return registry.register(skillsRead as ToolDefinition).register(skillsSave as ToolDefinition);
}
