import { z } from "zod";
import { execFile } from "node:child_process";
import type { ToolDefinition } from "../registry.js";

/**
 * Shell execution in the agent workspace. Phase 1 runs on the host with a
 * timeout and output cap; the sandbox package (Docker/SSH backends) takes
 * over execution in Phase 4 without changing this tool's contract.
 */

const MAX_OUTPUT = 64 * 1024;

export const shellExec: ToolDefinition<
  z.ZodObject<{ command: z.ZodString; timeoutMs: z.ZodDefault<z.ZodNumber> }>
> = {
  name: "shell.exec",
  description:
    "Run a shell command with the agent workspace as the working directory. Returns stdout, stderr, and the exit code.",
  toolset: "shell",
  riskLevel: "high",
  paramsSchema: z.object({
    command: z.string().min(1).describe("Shell command line to execute"),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  }),
  execute(args, ctx) {
    return new Promise((resolvePromise) => {
      execFile(
        "/bin/sh",
        ["-c", args.command],
        { cwd: ctx.workspacePath, timeout: args.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((error as unknown as { code: number }).code ?? 1)
              : error
                ? 1
                : 0;
          resolvePromise({
            exitCode,
            timedOut: Boolean(error && (error as { killed?: boolean }).killed),
            stdout: cap(stdout),
            stderr: cap(stderr),
          });
        },
      );
    });
  },
};

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}
