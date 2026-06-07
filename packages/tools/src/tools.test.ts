import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolPolicySchema } from "@gin/core";
import { CORE_TOOLS, registerCoreTools } from "./index.js";
import { ToolRegistry, type ToolContext } from "./registry.js";

let workspace: string;
let ctx: ToolContext;
const registry = registerCoreTools(new ToolRegistry());

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gin-tools-"));
  ctx = { agentId: "a", sessionId: "s", workspacePath: workspace };
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("registry", () => {
  it("registers the core tools", () => {
    expect(CORE_TOOLS).toHaveLength(11);
    expect(registry.list().map((t) => t.name)).toContain("fs.read");
    expect(registry.list().map((t) => t.name)).toContain("web.search");
  });

  it("filters by toolset policy and deny-list", () => {
    const policy = ToolPolicySchema.parse({ enabledToolsets: ["fs"], deniedTools: ["fs.write"] });
    const names = registry.list(policy).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["fs.read", "fs.edit", "fs.list"]));
    expect(names).not.toContain("fs.write");
    expect(names).not.toContain("shell.exec");
  });

  it("rejects calls to policy-disabled tools", async () => {
    const policy = ToolPolicySchema.parse({ enabledToolsets: ["fs"] });
    await expect(
      registry.execute("shell.exec", { command: "true" }, ctx, policy),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("validates arguments with Zod", async () => {
    await expect(registry.execute("fs.read", { path: 42 }, ctx)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("emits JSON Schema specs for the model layer", () => {
    const specs = registry.toChatTools();
    const read = specs.find((s) => s.name === "fs.read")!;
    expect(read.inputSchema).toMatchObject({ type: "object" });
    expect((read.inputSchema.properties as Record<string, unknown>).path).toBeDefined();
  });
});

describe("fs tools", () => {
  it("round-trips write → read → list", async () => {
    await registry.execute("fs.write", { path: "notes/a.txt", content: "hello" }, ctx);
    const read = (await registry.execute("fs.read", { path: "notes/a.txt" }, ctx)) as {
      content: string;
    };
    expect(read.content).toBe("hello");
    const list = (await registry.execute("fs.list", { path: "notes" }, ctx)) as {
      entries: { name: string }[];
    };
    expect(list.entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("edits a unique snippet and rejects ambiguous ones", async () => {
    writeFileSync(join(workspace, "f.txt"), "one two one");
    await expect(
      registry.execute("fs.edit", { path: "f.txt", oldText: "one", newText: "1" }, ctx),
    ).rejects.toMatchObject({ code: "tool_error" });
    await registry.execute("fs.edit", { path: "f.txt", oldText: "two", newText: "2" }, ctx);
    const read = (await registry.execute("fs.read", { path: "f.txt" }, ctx)) as { content: string };
    expect(read.content).toBe("one 2 one");
  });

  it("blocks path escapes", async () => {
    await expect(
      registry.execute("fs.read", { path: "../outside.txt" }, ctx),
    ).rejects.toMatchObject({ code: "sandbox_violation" });
    await expect(
      registry.execute("fs.write", { path: "/etc/evil", content: "x" }, ctx),
    ).rejects.toMatchObject({ code: "sandbox_violation" });
  });
});

describe("shell.exec", () => {
  it("runs in the workspace and captures output", async () => {
    writeFileSync(join(workspace, "x.txt"), "");
    const result = (await registry.execute("shell.exec", { command: "ls" }, ctx)) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("x.txt");
  });

  it("reports non-zero exit codes instead of throwing", async () => {
    const result = (await registry.execute("shell.exec", { command: "exit 3" }, ctx)) as {
      exitCode: number;
    };
    expect(result.exitCode).toBe(3);
  });
});

describe("http.fetch", () => {
  it("returns status and body via the injected fetch", async () => {
    ctx.fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    const result = (await registry.execute(
      "http.fetch",
      { url: "https://example.com/ping" },
      ctx,
    )) as {
      status: number;
      body: string;
    };
    expect(result).toMatchObject({ status: 200, body: "pong" });
  });

  it("rejects non-http URLs at validation", async () => {
    await expect(
      registry.execute("http.fetch", { url: "file:///etc/passwd" }, ctx),
    ).rejects.toMatchObject({ code: "tool_error" });
  });

  it("refuses private, loopback, link-local, and metadata hosts (SSRF guard)", async () => {
    ctx.fetchImpl = vi.fn(); // must never be called
    for (const url of [
      "http://127.0.0.1:18789/ws",
      "http://localhost/admin",
      "http://10.0.0.5/",
      "http://192.168.1.1/router",
      "http://172.20.3.4/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://nas.local/",
      "http://[::1]:8080/",
      "http://[fd00::1]/",
    ]) {
      await expect(registry.execute("http.fetch", { url }, ctx)).rejects.toMatchObject({
        code: "sandbox_violation",
      });
    }
    expect(ctx.fetchImpl).not.toHaveBeenCalled();
  });

  it("public hosts pass the SSRF guard", async () => {
    const { isPrivateHost } = await import("./index.js");
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateHost("2606:4700::6810:84e5")).toBe(false);
  });

  it("GIN_ALLOW_PRIVATE_HTTP=1 opts out for homelab use", async () => {
    process.env.GIN_ALLOW_PRIVATE_HTTP = "1";
    try {
      ctx.fetchImpl = vi.fn().mockResolvedValue(new Response("lan", { status: 200 }));
      const result = (await registry.execute(
        "http.fetch",
        { url: "http://192.168.1.10/api" },
        ctx,
      )) as { body: string };
      expect(result.body).toBe("lan");
    } finally {
      delete process.env.GIN_ALLOW_PRIVATE_HTTP;
    }
  });
});

describe("web.search", () => {
  const DDG_HTML = `
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdurable&amp;rut=abc"><b>Durable</b> execution</a>
      <a class="result__snippet" href="#">Checkpoint and <b>resume</b> workflows.</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://plain.example.org/page">Plain link</a>
    </div>`;

  it("parses results and decodes redirect URLs", async () => {
    ctx.fetchImpl = vi.fn().mockResolvedValue(new Response(DDG_HTML, { status: 200 }));
    const result = (await registry.execute("web.search", { query: "durable execution" }, ctx)) as {
      results: { title: string; url: string; snippet: string }[];
    };
    expect(result.results).toEqual([
      {
        title: "Durable execution",
        url: "https://example.com/durable",
        snippet: "Checkpoint and resume workflows.",
      },
      { title: "Plain link", url: "https://plain.example.org/page", snippet: "" },
    ]);
    const [url] = (ctx.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("html.duckduckgo.com/html/?q=durable%20execution");
  });

  it("classifies upstream failures", async () => {
    ctx.fetchImpl = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    await expect(registry.execute("web.search", { query: "x" }, ctx)).rejects.toMatchObject({
      code: "tool_error",
      retryable: true,
    });
  });
});

describe("memory + messaging ports", () => {
  it("delegates memory.store/search to the context port", async () => {
    const store = vi.fn().mockResolvedValue("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const search = vi.fn().mockResolvedValue([{ id: "m1", text: "likes tea", score: 0.9 }]);
    ctx.memory = { store, search };

    await registry.execute("memory.store", { text: "User likes tea" }, ctx);
    expect(store).toHaveBeenCalledWith("User likes tea", "fact");

    const result = (await registry.execute("memory.search", { query: "tea" }, ctx)) as {
      results: unknown[];
    };
    expect(result.results).toHaveLength(1);
    expect(search).toHaveBeenCalledWith("tea", 5);
  });

  it("fails cleanly when ports are missing", async () => {
    await expect(registry.execute("memory.store", { text: "x" }, ctx)).rejects.toMatchObject({
      code: "tool_error",
    });
    await expect(registry.execute("sessions.send", { text: "hi" }, ctx)).rejects.toMatchObject({
      code: "tool_error",
    });
  });

  it("sends interim messages through the channel port", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    ctx.sendMessage = sendMessage;
    await registry.execute("sessions.send", { text: "working on it" }, ctx);
    expect(sendMessage).toHaveBeenCalledWith("working on it");
  });
});

describe("output validation (resultSchema)", () => {
  it("rejects malformed tool output as verification_failed", async () => {
    const { z } = await import("zod");
    const local = new ToolRegistry().register({
      name: "weather.get",
      description: "Weather with a declared output contract",
      toolset: "weather",
      riskLevel: "low",
      paramsSchema: z.object({}),
      resultSchema: z.object({ tempC: z.number(), summary: z.string() }),
      async execute() {
        return { tempC: "not-a-number" }; // violates the contract
      },
    });
    await expect(local.execute("weather.get", {}, ctx)).rejects.toMatchObject({
      code: "verification_failed",
    });
  });

  it("passes conforming output through", async () => {
    const { z } = await import("zod");
    const local = new ToolRegistry().register({
      name: "weather.get",
      description: "Weather",
      toolset: "weather",
      riskLevel: "low",
      paramsSchema: z.object({}),
      resultSchema: z.object({ tempC: z.number() }),
      async execute() {
        return { tempC: 21 };
      },
    });
    await expect(local.execute("weather.get", {}, ctx)).resolves.toEqual({ tempC: 21 });
  });
});

describe("time.now", () => {
  it("returns ISO and epoch forms", async () => {
    const result = (await registry.execute("time.now", {}, ctx)) as {
      iso: string;
      epochMs: number;
    };
    expect(new Date(result.iso).getTime()).toBe(result.epochMs);
  });
});
