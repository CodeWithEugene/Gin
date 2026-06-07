import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ToolRegistry } from "@gin/tools";
import { MCPConnection, type MCPServerConfig } from "./client.js";
import { registerMCPTools } from "./bridge.js";

/** In-process MCP server with two tools, linked to the client over memory. */
async function connect(configOverrides: Partial<MCPServerConfig> = {}): Promise<MCPConnection> {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message back",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
  );
  server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "boom" }],
    isError: true,
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const config: MCPServerConfig = {
    id: "test",
    transport: "stdio",
    cmd: "unused",
    ...configOverrides,
  };
  return MCPConnection.connect(config, clientTransport);
}

describe("MCPConnection", () => {
  it("lists tools with their JSON Schemas", async () => {
    const conn = await connect();
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema).toMatchObject({ type: "object" });
    await conn.close();
  });

  it("filters tools by the per-server allowlist", async () => {
    const conn = await connect({ allowedTools: ["echo"] });
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    await expect(conn.callTool("fail", {})).rejects.toMatchObject({ code: "permission_denied" });
    await conn.close();
  });

  it("calls tools and flattens text content", async () => {
    const conn = await connect();
    const result = await conn.callTool("echo", { message: "hi" });
    expect(result).toEqual({ text: "echo: hi", isError: false });
    await conn.close();
  });

  it("surfaces tool errors via isError", async () => {
    const conn = await connect();
    const result = await conn.callTool("fail", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("boom");
    await conn.close();
  });
});

describe("registry bridge", () => {
  it("registers MCP tools under namespaced names with server schemas", async () => {
    const conn = await connect();
    const registry = new ToolRegistry();
    const names = await registerMCPTools(registry, conn);
    expect(names.sort()).toEqual(["mcp__test__echo", "mcp__test__fail"]);

    const specs = registry.toChatTools();
    const echoSpec = specs.find((s) => s.name === "mcp__test__echo")!;
    // The server's own JSON Schema flows through, not a Zod-derived one.
    expect(echoSpec.inputSchema).toMatchObject({ type: "object" });
    expect((echoSpec.inputSchema.properties as Record<string, unknown>).message).toBeDefined();

    const ctx = { agentId: "a", sessionId: "s", workspacePath: "/tmp" };
    const result = await registry.execute("mcp__test__echo", { message: "yo" }, ctx);
    expect(result).toEqual({ content: "echo: yo" });
    await conn.close();
  });

  it("returns tool errors as data rather than throwing", async () => {
    const conn = await connect();
    const registry = new ToolRegistry();
    await registerMCPTools(registry, conn);
    const ctx = { agentId: "a", sessionId: "s", workspacePath: "/tmp" };
    const result = await registry.execute("mcp__test__fail", {}, ctx);
    expect(result).toEqual({ error: "boom" });
    await conn.close();
  });
});
