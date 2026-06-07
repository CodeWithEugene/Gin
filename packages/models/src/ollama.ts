import { GinError, newId, type TokenUsage } from "@gin/core";
import { estimateCostUsd } from "./pricing.js";
import type {
  ChatContentBlock,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelProvider,
  StopReason,
} from "./types.js";

/**
 * Ollama adapter over the local HTTP API (`POST /api/chat`, non-streaming).
 * Local inference costs $0; tokens are still metered for observability.
 */

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  /** Defaults to the standard local daemon. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class OllamaProvider implements ModelProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const messages: OllamaMessage[] = [];
    if (req.system !== undefined) messages.push({ role: "system", content: req.system });
    for (const msg of req.messages) messages.push(...toOllamaMessages(msg));

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: false,
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    if (Object.keys(options).length > 0) body.options = options;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new GinError("provider_error", `Ollama unreachable at ${this.baseUrl}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GinError("provider_error", `Ollama HTTP ${res.status}: ${text.slice(0, 300)}`, {
        retryable: res.status >= 500,
        details: { status: res.status },
      });
    }

    const data = (await res.json()) as OllamaChatResponse;
    const content: ChatContentBlock[] = [];
    if (data.message.content) content.push({ type: "text", text: data.message.content });
    for (const call of data.message.tool_calls ?? []) {
      // Ollama doesn't assign call ids; mint ULIDs so the runtime can pair
      // results to calls the same way it does for Anthropic.
      content.push({
        type: "tool_use",
        id: newId(),
        name: call.function.name,
        input: call.function.arguments,
      });
    }

    const usage: TokenUsage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const stopReason: StopReason =
      (data.message.tool_calls?.length ?? 0) > 0
        ? "tool_use"
        : data.done_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      model: req.model,
      content,
      stopReason,
      usage,
      costUsd: estimateCostUsd(this.name, req.model, usage),
    };
  }
}

function toOllamaMessages(msg: ChatMessage): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  let current: OllamaMessage | undefined;
  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        if (current === undefined) {
          current = { role: msg.role, content: block.text };
          out.push(current);
        } else {
          current.content += block.text;
        }
        break;
      case "tool_use": {
        if (current === undefined) {
          current = { role: msg.role, content: "" };
          out.push(current);
        }
        (current.tool_calls ??= []).push({
          function: {
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          },
        });
        break;
      }
      case "tool_result":
        // Tool results are their own role in Ollama's chat shape.
        out.push({ role: "tool", content: block.content });
        current = undefined;
        break;
    }
  }
  return out;
}
