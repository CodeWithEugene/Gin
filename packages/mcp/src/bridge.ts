import { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "@gin/tools";
import type { MCPConnection } from "./client.js";

/**
 * Bridges a connected MCP server's tools into the Gin tool registry as
 * "mcp__<serverId>__<tool>". Arguments pass through with the server's own
 * JSON Schema (the server validates); results flatten to text. Bridged tools
 * default to medium risk — operators can deny-list per agent via ToolPolicy.
 */

const PASSTHROUGH = z.record(z.unknown());

export function bridgeName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export async function registerMCPTools(
  registry: ToolRegistry,
  connection: MCPConnection,
): Promise<string[]> {
  const tools = await connection.listTools();
  const registered: string[] = [];
  for (const tool of tools) {
    const definition: ToolDefinition<typeof PASSTHROUGH> = {
      name: bridgeName(connection.config.id, tool.name),
      description: tool.description || `MCP tool ${tool.name} on ${connection.config.id}`,
      toolset: `mcp:${connection.config.id}`,
      riskLevel: "medium",
      paramsSchema: PASSTHROUGH,
      inputJsonSchema: tool.inputSchema,
      async execute(args) {
        const result = await connection.callTool(tool.name, args as Record<string, unknown>);
        if (result.isError) return { error: result.text };
        return { content: result.text };
      },
    };
    registry.register(definition as unknown as ToolDefinition);
    registered.push(definition.name);
  }
  return registered;
}
