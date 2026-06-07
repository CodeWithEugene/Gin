import { GinError } from "@gin/core";
import { z } from "zod";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ToolContext, ToolDefinition } from "../registry.js";

/**
 * Filesystem toolset, rooted at the agent's workspace. Paths are resolved
 * against the workspace and must stay inside it — escaping (../, absolute
 * paths outside) is a sandbox_violation regardless of sandbox mode.
 */

export function resolveInWorkspace(ctx: ToolContext, path: string): string {
  const abs = resolve(ctx.workspacePath, path);
  const root = resolve(ctx.workspacePath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new GinError("sandbox_violation", `Path escapes the workspace: ${path}`);
  }
  return abs;
}

const MAX_READ_BYTES = 256 * 1024;

export const fsRead: ToolDefinition<z.ZodObject<{ path: z.ZodString }>> = {
  name: "fs.read",
  description: "Read a UTF-8 text file from the agent workspace.",
  toolset: "fs",
  riskLevel: "low",
  paramsSchema: z.object({ path: z.string().min(1).describe("Path relative to the workspace") }),
  async execute(args, ctx) {
    const text = await readFile(resolveInWorkspace(ctx, args.path), "utf8");
    if (text.length > MAX_READ_BYTES) {
      return { content: text.slice(0, MAX_READ_BYTES), truncated: true };
    }
    return { content: text, truncated: false };
  },
};

export const fsWrite: ToolDefinition<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>> = {
  name: "fs.write",
  description: "Write a UTF-8 text file in the agent workspace, creating parent directories.",
  toolset: "fs",
  riskLevel: "medium",
  paramsSchema: z.object({
    path: z.string().min(1).describe("Path relative to the workspace"),
    content: z.string().describe("Full file contents to write"),
  }),
  async execute(args, ctx) {
    const abs = resolveInWorkspace(ctx, args.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, "utf8");
    return { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
  },
};

export const fsEdit: ToolDefinition<
  z.ZodObject<{ path: z.ZodString; oldText: z.ZodString; newText: z.ZodString }>
> = {
  name: "fs.edit",
  description:
    "Replace an exact text snippet in a workspace file. The snippet must occur exactly once.",
  toolset: "fs",
  riskLevel: "medium",
  paramsSchema: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1).describe("Exact text to replace (must be unique in the file)"),
    newText: z.string(),
  }),
  async execute(args, ctx) {
    const abs = resolveInWorkspace(ctx, args.path);
    const text = await readFile(abs, "utf8");
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      throw new GinError("tool_error", `oldText not found in ${args.path}`);
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      throw new GinError("tool_error", `oldText occurs more than once in ${args.path}`);
    }
    await writeFile(abs, text.replace(args.oldText, args.newText), "utf8");
    return { path: args.path, replaced: true };
  },
};

export const fsList: ToolDefinition<z.ZodObject<{ path: z.ZodDefault<z.ZodString> }>> = {
  name: "fs.list",
  description: "List directory entries in the agent workspace.",
  toolset: "fs",
  riskLevel: "low",
  paramsSchema: z.object({
    path: z.string().default(".").describe("Directory path relative to the workspace"),
  }),
  async execute(args, ctx) {
    const entries = await readdir(resolveInWorkspace(ctx, args.path), { withFileTypes: true });
    return {
      entries: entries
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
};
