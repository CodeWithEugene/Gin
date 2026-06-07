import type { TokenUsage } from "@gin/core";

/**
 * Provider-neutral chat shape. The runtime speaks this; adapters translate to
 * each provider's wire format. Content blocks mirror the Anthropic Messages
 * API closely (it is the richest surface we target) but stay independent so
 * Ollama/OpenAI-style providers can map cleanly.
 */

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatContentBlock[];
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface ChatRequest {
  /** Bare model id (no provider prefix) — the router strips the prefix. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingLevel;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ChatResult {
  /** Bare model id that actually served the request. */
  model: string;
  content: ChatContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  costUsd: number;
}

export interface ModelProvider {
  /** Provider slug used as the "<provider>/" prefix in model refs. */
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Split "anthropic/claude-opus-4-8" into provider + bare model id. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Model ref must be "<provider>/<model>", got "${ref}"`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/** Concatenated text of all text blocks in a result. */
export function resultText(result: ChatResult): string {
  return result.content
    .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolUses(result: ChatResult): Extract<ChatContentBlock, { type: "tool_use" }>[] {
  return result.content.filter(
    (b): b is Extract<ChatContentBlock, { type: "tool_use" }> => b.type === "tool_use",
  );
}
