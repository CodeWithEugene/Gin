import { GinError } from "@gin/core";
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/** Clock, memory, and messaging tools — thin ports into runtime services. */

export const timeNow: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "time.now",
  description: "Get the current date and time (ISO 8601, UTC) and the epoch milliseconds.",
  toolset: "time",
  riskLevel: "low",
  paramsSchema: z.object({}),
  async execute() {
    const now = new Date();
    return { iso: now.toISOString(), epochMs: now.getTime() };
  },
};

export const memoryStore: ToolDefinition<
  z.ZodObject<{
    text: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<["fact", "skill", "episodic"]>>;
  }>
> = {
  name: "memory.store",
  description:
    "Save a durable memory about the user, the project, or a learned skill for future sessions.",
  toolset: "memory",
  riskLevel: "low",
  paramsSchema: z.object({
    text: z.string().min(1).describe("The memory to store, phrased as a standalone statement"),
    kind: z.enum(["fact", "skill", "episodic"]).default("fact"),
  }),
  async execute(args, ctx) {
    if (!ctx.memory) throw new GinError("tool_error", "No memory store attached to this agent.");
    const id = await ctx.memory.store(args.text, args.kind);
    return { id };
  },
};

export const memorySearch: ToolDefinition<
  z.ZodObject<{ query: z.ZodString; limit: z.ZodDefault<z.ZodNumber> }>
> = {
  name: "memory.search",
  description: "Search the agent's long-term memory for relevant facts, skills, or past events.",
  toolset: "memory",
  riskLevel: "low",
  paramsSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(20).default(5),
  }),
  async execute(args, ctx) {
    if (!ctx.memory) throw new GinError("tool_error", "No memory store attached to this agent.");
    return { results: await ctx.memory.search(args.query, args.limit) };
  },
};

export const sessionsSend: ToolDefinition<z.ZodObject<{ text: z.ZodString }>> = {
  name: "sessions.send",
  description:
    "Send an interim message to the user on the current channel before the turn finishes (e.g. progress on long work).",
  toolset: "messaging",
  riskLevel: "low",
  paramsSchema: z.object({ text: z.string().min(1) }),
  async execute(args, ctx) {
    if (!ctx.sendMessage) {
      throw new GinError("tool_error", "This session has no outbound channel.");
    }
    await ctx.sendMessage(args.text);
    return { sent: true };
  },
};
