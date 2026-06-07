import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GinError, toGinError } from "@gin/core";

/**
 * One connection per configured MCP server. Tools are filtered by the
 * per-server allowlist before they ever reach the model — a server cannot
 * expose more surface than the operator granted it (spec 5.x).
 */

export interface MCPServerConfig {
  /** Operator-chosen slug; namespaces bridged tool names. */
  id: string;
  transport: "stdio" | "http";
  /** stdio: command + args to spawn. */
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: streamable-HTTP endpoint URL. */
  url?: string;
  /** Tool names this server may expose; "*" (default) allows all. */
  allowedTools?: string[];
}

export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPCallResult {
  text: string;
  isError: boolean;
}

export class MCPConnection {
  private constructor(
    readonly config: MCPServerConfig,
    private readonly client: Client,
  ) {}

  static async connect(config: MCPServerConfig, transport?: Transport): Promise<MCPConnection> {
    const client = new Client({ name: "gin", version: "0.1.0" });
    const resolved = transport ?? buildTransport(config);
    try {
      await client.connect(resolved);
    } catch (err) {
      throw new GinError("channel_error", `MCP server "${config.id}" failed to connect`, {
        cause: err,
        retryable: true,
      });
    }
    return new MCPConnection(config, client);
  }

  private allowed(name: string): boolean {
    const allow = this.config.allowedTools ?? ["*"];
    return allow.includes("*") || allow.includes(name);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    try {
      const { tools } = await this.client.listTools();
      return tools
        .filter((t) => this.allowed(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        }));
    } catch (err) {
      throw toGinError(err, "tool_error");
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (!this.allowed(name)) {
      throw new GinError(
        "permission_denied",
        `Tool "${name}" is not allowed on MCP server "${this.config.id}"`,
      );
    }
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((block: { type: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : `[${block.type}]`,
        )
        .join("\n");
      return { text, isError: result.isError === true };
    } catch (err) {
      throw toGinError(err, "tool_error");
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function buildTransport(config: MCPServerConfig): Transport {
  switch (config.transport) {
    case "stdio": {
      if (!config.cmd) {
        throw new GinError("config_invalid", `MCP server "${config.id}" needs a cmd for stdio.`);
      }
      return new StdioClientTransport({
        command: config.cmd,
        args: config.args ?? [],
        // Only the explicitly configured env crosses the boundary.
        env: config.env ?? {},
      });
    }
    case "http": {
      if (!config.url) {
        throw new GinError("config_invalid", `MCP server "${config.id}" needs a url for http.`);
      }
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
  }
}
