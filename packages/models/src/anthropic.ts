import Anthropic from "@anthropic-ai/sdk";
import { GinError, type TokenUsage } from "@gin/core";
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
 * Anthropic adapter on the official SDK. Defaults follow current API
 * guidance: adaptive thinking when thinking is requested, top-level
 * auto prompt caching, and usage accounting that includes cache tokens.
 */

/** The slice of the SDK the adapter touches — injectable for tests. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  /** Defaults to ANTHROPIC_API_KEY from the environment. */
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicMessagesClient;
}

const DEFAULT_MAX_TOKENS = 8192;

/** Models where sampling parameters (temperature et al.) are removed. */
const NO_SAMPLING_PARAMS = /^claude-opus-4-(7|8)/;

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly client: AnthropicMessagesClient;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: req.messages.map(toAnthropicMessage),
      // Auto-cache the last cacheable block: system + tools + history prefix
      // are reused across the agent loop's successive calls.
      cache_control: { type: "ephemeral" },
    };
    if (req.system !== undefined) params.system = req.system;
    if (req.tools !== undefined && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
    }
    const thinking = req.thinking ?? "medium";
    params.thinking = thinking === "off" ? { type: "disabled" } : { type: "adaptive" };
    if (req.temperature !== undefined && !NO_SAMPLING_PARAMS.test(req.model)) {
      params.temperature = req.temperature;
    }

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params);
    } catch (err) {
      throw classifyAnthropicError(err);
    }

    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };

    return {
      model: message.model,
      content: message.content.flatMap(fromAnthropicBlock),
      stopReason: mapStopReason(message.stop_reason),
      usage,
      costUsd: estimateCostUsd(this.name, message.model, usage),
    };
  }
}

function toAnthropicMessage(msg: ChatMessage): Anthropic.MessageParam {
  return {
    role: msg.role,
    content: msg.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          };
      }
    }),
  };
}

function fromAnthropicBlock(block: Anthropic.ContentBlock): ChatContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    default:
      // thinking / server-tool blocks are not part of the neutral surface.
      return [];
  }
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function classifyAnthropicError(err: unknown): GinError {
  if (err instanceof Anthropic.RateLimitError) {
    return new GinError("provider_rate_limited", err.message, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    // 5xx/529 are transient; 4xx are caller bugs and must not be retried.
    return new GinError("provider_error", err.message, {
      cause: err,
      retryable: status >= 500,
      details: { status },
    });
  }
  return new GinError("provider_error", err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}
