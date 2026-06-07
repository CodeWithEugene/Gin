import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerExecutor,
  HostExecutor,
  executorFor,
  type ExecResult,
  type ProcessRunner,
} from "./executor.js";

describe("HostExecutor", () => {
  it("runs commands in the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gin-sbx-"));
    writeFileSync(join(workspace, "hello.txt"), "");
    const result = await new HostExecutor().exec({ command: "ls", workspacePath: workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
  });

  it("reports non-zero exits without throwing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gin-sbx-"));
    const result = await new HostExecutor().exec({ command: "exit 7", workspacePath: workspace });
    expect(result.exitCode).toBe(7);
  });

  it("kills on timeout", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gin-sbx-"));
    const result = await new HostExecutor().exec({
      command: "sleep 5",
      workspacePath: workspace,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
  });
});

describe("DockerExecutor", () => {
  const okResult: ExecResult = { exitCode: 0, stdout: "out", stderr: "", timedOut: false };

  it("builds an isolated docker run with the workspace mounted", async () => {
    const runner = vi.fn().mockResolvedValue(okResult) as unknown as ProcessRunner;
    const executor = new DockerExecutor({ runner });
    await executor.exec({ command: "echo hi", workspacePath: "/ws/agent" });

    const [file, args] = (runner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(file).toBe("docker");
    expect(args).toEqual([
      "run",
      "--rm",
      "--init",
      "--network=none",
      "-v",
      "/ws/agent:/workspace",
      "-w",
      "/workspace",
      "debian:stable-slim",
      "/bin/sh",
      "-c",
      "echo hi",
    ]);
  });

  it("honors image, network, and extra args", async () => {
    const runner = vi.fn().mockResolvedValue(okResult) as unknown as ProcessRunner;
    const executor = new DockerExecutor({
      runner,
      image: "node:24-slim",
      network: true,
      extraArgs: ["--memory=512m"],
    });
    await executor.exec({ command: "true", workspacePath: "/ws" });
    const [, args] = (runner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args).not.toContain("--network=none");
    expect(args).toContain("--memory=512m");
    expect(args).toContain("node:24-slim");
  });

  it("passes command failures through as results", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue({ exitCode: 3, stdout: "", stderr: "boom", timedOut: false });
    const executor = new DockerExecutor({ runner: runner as unknown as ProcessRunner });
    const result = await executor.exec({ command: "false", workspacePath: "/ws" });
    expect(result.exitCode).toBe(3);
  });

  it("classifies a missing docker daemon as a retryable sandbox failure", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 125,
      stdout: "",
      stderr: "docker: Cannot connect to the Docker daemon",
      timedOut: false,
    });
    const executor = new DockerExecutor({ runner: runner as unknown as ProcessRunner });
    await expect(executor.exec({ command: "true", workspacePath: "/ws" })).rejects.toMatchObject({
      code: "sandbox_violation",
      retryable: true,
    });
  });
});

describe("executorFor", () => {
  it("maps sandbox modes to backends", () => {
    expect(executorFor("host").kind).toBe("host");
    expect(executorFor("docker").kind).toBe("docker");
    expect(executorFor("policy").kind).toBe("host");
    expect(() => executorFor("ssh")).toThrow(/later phase/);
  });
});
