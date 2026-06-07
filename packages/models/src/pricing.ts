import type { TokenUsage } from "@gin/core";

/**
 * Per-model $/1M-token pricing. Cache reads bill at ~0.1× input, cache writes
 * at ~1.25× input (5-minute TTL). Local providers (ollama, llamacpp, vllm)
 * cost $0 — the budget engine still meters tokens for them.
 *
 * Prices cached from platform.claude.com (2026-05). Update alongside model
 * launches; unknown models fall back to $0 with a "pricing_unknown" flag so
 * the budget engine can choose to block or alert.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

const ANTHROPIC: Record<string, ModelPricing> = {
  "claude-opus-4-8": p(5, 25),
  "claude-opus-4-7": p(5, 25),
  "claude-opus-4-6": p(5, 25),
  "claude-opus-4-5": p(5, 25),
  "claude-sonnet-4-6": p(3, 15),
  "claude-sonnet-4-5": p(3, 15),
  "claude-haiku-4-5": p(1, 5),
};

function p(input: number, output: number): ModelPricing {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: input * 0.1,
    cacheWritePerMTok: input * 1.25,
  };
}

const FREE: ModelPricing = p(0, 0);

export function pricingFor(provider: string, model: string): ModelPricing | undefined {
  if (provider === "ollama" || provider === "llamacpp" || provider === "vllm") return FREE;
  if (provider === "anthropic") {
    // Match date-suffixed full ids (claude-haiku-4-5-20251001) to their alias.
    const exact = ANTHROPIC[model];
    if (exact) return exact;
    const alias = Object.keys(ANTHROPIC).find((k) => model.startsWith(k));
    return alias ? ANTHROPIC[alias] : undefined;
  }
  return undefined;
}

export function estimateCostUsd(provider: string, model: string, usage: TokenUsage): number {
  const pricing = pricingFor(provider, model);
  if (!pricing) return 0;
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok) /
    1_000_000
  );
}
