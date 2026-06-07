import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@gin/core";
import { ModelRouter, type ChatRequest, type ChatResult, type ModelProvider } from "@gin/models";
import type { SandboxExecutor } from "@gin/sandbox";
import { openDatabase } from "@gin/storage";
import { ToolRegistry, registerCoreTools } from "@gin/tools";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "./store.js";

class OneShotProvider implements ModelProvider {
  readonly name = "fake";
  private script: Partial<ChatResult>[] = [];
  enqueue(...results: Partial<ChatResult>[]): void {
    this.script.push(...results);
  }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return {
      model: "test",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ...next,
    };
  }
}

describe("sandbox routing", () => {
  it("routes shell.exec through the agent's sandbox executor", async () => {
    const db = openDatabase({ path: ":memory:" });
    const store = new SessionStore(db);
    const provider = new OneShotProvider();
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "from-sandbox", stderr: "", timedOut: false });
    const fakeDocker: SandboxExecutor = { kind: "docker", exec };

    const runtime = new AgentRuntime({
      store,
      bus: new EventBus(),
      router: new ModelRouter().register(provider),
      registry: registerCoreTools(new ToolRegistry()),
      sandboxExecutors: { docker: fakeDocker },
    });
    const workspace = mkdtempSync(join(tmpdir(), "gin-p4-"));
    const agent = store.createAgent({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "dockerized",
      workspacePath: workspace,
      modelConfig: { primary: "fake/test", fallbacks: [] },
      sandboxMode: "docker",
    });

    provider.enqueue(
      {
        content: [{ type: "tool_use", id: "t1", name: "shell.exec", input: { command: "ls" } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "listed" }] },
    );
    const result = await runtime.runTurn({ agentId: agent.id, userText: "ls", peerRef: "u1" });
    expect(result.status).toBe("succeeded");
    expect(exec).toHaveBeenCalledWith({
      command: "ls",
      timeoutMs: 60_000,
      workspacePath: workspace,
    });
    const steps = store.steps(result.turnId);
    expect(steps.find((s) => s.type === "tool_call")!.output).toMatchObject({
      stdout: "from-sandbox",
    });
  });

  it("host-mode agents keep the tool's built-in shell", async () => {
    const db = openDatabase({ path: ":memory:" });
    const store = new SessionStore(db);
    const provider = new OneShotProvider();
    const runtime = new AgentRuntime({
      store,
      bus: new EventBus(),
      router: new ModelRouter().register(provider),
      registry: registerCoreTools(new ToolRegistry()),
    });
    const agent = store.createAgent({
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "hosty",
      workspacePath: mkdtempSync(join(tmpdir(), "gin-p4h-")),
      modelConfig: { primary: "fake/test", fallbacks: [] },
      sandboxMode: "host",
    });
    provider.enqueue(
      {
        content: [
          { type: "tool_use", id: "t1", name: "shell.exec", input: { command: "echo host-run" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ran" }] },
    );
    const result = await runtime.runTurn({ agentId: agent.id, userText: "go", peerRef: "u1" });
    const steps = store.steps(result.turnId);
    expect(
      (steps.find((s) => s.type === "tool_call")!.output as { stdout: string }).stdout,
    ).toContain("host-run");
  });
});
