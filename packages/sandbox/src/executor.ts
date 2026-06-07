import { GinError, type SandboxMode } from "@gin/core";
import { execFile } from "node:child_process";

/**
 * Sandboxed execution (spec Phase 4). One executor interface; backends:
 *  - host:   /bin/sh on the gateway machine (dev convenience, doctor warns)
 *  - docker: one ephemeral container per command, workspace bind-mounted,
 *            network disabled by default — tool output is identical either
 *            way, so swapping modes never changes tool contracts.
 * SSH and Firecracker backends land later behind the same interface.
 */

export interface ExecRequest {
  command: string;
  /** Absolute workspace path; cwd on host, bind-mounted in docker. */
  workspacePath: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxExecutor {
  readonly kind: string;
  exec(req: ExecRequest): Promise<ExecResult>;
}

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 60_000;

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

/** Low-level process runner — injectable so Docker paths are testable. */
export type ProcessRunner = (
  file: string,
  args: string[],
  opts: { cwd?: string; timeout: number },
) => Promise<ExecResult>;

export const defaultRunner: ProcessRunner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        timeout: opts.timeout,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const killed = Boolean(error && (error as { killed?: boolean }).killed);
        let exitCode = 0;
        if (error) {
          const code = (error as { code?: unknown }).code;
          exitCode = typeof code === "number" ? code : 1;
        }
        resolve({
          exitCode,
          timedOut: killed,
          stdout: cap(stdout),
          stderr: cap(stderr),
        });
      },
    );
  });

export class HostExecutor implements SandboxExecutor {
  readonly kind = "host";
  constructor(private readonly runner: ProcessRunner = defaultRunner) {}

  exec(req: ExecRequest): Promise<ExecResult> {
    return this.runner("/bin/sh", ["-c", req.command], {
      cwd: req.workspacePath,
      timeout: req.timeoutMs ?? DEFAULT_TIMEOUT,
    });
  }
}

export interface DockerExecutorOptions {
  image?: string;
  /** Allow outbound network from the container (off by default). */
  network?: boolean;
  /** Extra `docker run` flags (e.g. --memory=512m). */
  extraArgs?: string[];
  runner?: ProcessRunner;
}

export class DockerExecutor implements SandboxExecutor {
  readonly kind = "docker";
  private readonly image: string;
  private readonly network: boolean;
  private readonly extraArgs: string[];
  private readonly runner: ProcessRunner;

  constructor(opts: DockerExecutorOptions = {}) {
    this.image = opts.image ?? "debian:stable-slim";
    this.network = opts.network ?? false;
    this.extraArgs = opts.extraArgs ?? [];
    this.runner = opts.runner ?? defaultRunner;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const args = [
      "run",
      "--rm",
      "--init",
      ...(this.network ? [] : ["--network=none"]),
      "-v",
      `${req.workspacePath}:/workspace`,
      "-w",
      "/workspace",
      ...this.extraArgs,
      this.image,
      "/bin/sh",
      "-c",
      req.command,
    ];
    const result = await this.runner("docker", args, {
      timeout: req.timeoutMs ?? DEFAULT_TIMEOUT,
    });
    // Exit 125/126/127 from docker itself (daemon down, image missing) is an
    // infrastructure failure, not the command failing — surface it loudly.
    if (result.exitCode === 125 && /docker|daemon|Cannot connect/i.test(result.stderr)) {
      throw new GinError(
        "sandbox_violation",
        `Docker backend unavailable: ${result.stderr.slice(0, 300)}`,
        {
          retryable: true,
        },
      );
    }
    return result;
  }
}

export function executorFor(mode: SandboxMode, opts: DockerExecutorOptions = {}): SandboxExecutor {
  switch (mode) {
    case "docker":
      return new DockerExecutor(opts);
    case "host":
    case "policy": // policy engine lands later; host semantics until then
      return new HostExecutor();
    case "ssh":
      throw new GinError("config_invalid", "The ssh sandbox backend ships in a later phase.");
  }
}
