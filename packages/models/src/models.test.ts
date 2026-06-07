import { describe, expect, it, vi } from "vitest";
import { GinError } from "@gin/core";
import { AnthropicProvider, type AnthropicMessagesClient } from "./anthropic.js";
import { OllamaProvider, type FetchLike } from "./ollama.js";
import { estimateCostUsd } from "./pricing.js";
import { ModelRouter } from "./router.js";
import { parseModelRef, resultText, toolUses, type ModelProvider } from "./types.js";

function fakeAnthropicMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "Hello!", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 200,
    },
    ...overrides,
  };
}

describe("parseModelRef", () => {
  it("splits provider and model", () => {
    expect(parseModelRef("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(parseModelRef("ollama/llama3.3:70b")).toEqual({
      provider: "ollama",
      model: "llama3.3:70b",
    });
  });
  it("rejects refs without a provider prefix", () => {
    expect(() => parseModelRef("claude-opus-4-8")).toThrow(/provider/);
  });
});

describe("pricing", () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  it("prices Opus at $5/$25 per MTok", () => {
    expect(estimateCostUsd("anthropic", "claude-opus-4-8", usage)).toBe(30);
  });
  it("prices cache reads at 0.1x input", () => {
    expect(
      estimateCostUsd("anthropic", "claude-sonnet-4-6", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(0.3);
  });
  it("matches date-suffixed model ids", () => {
    expect(estimateCostUsd("anthropic", "claude-haiku-4-5-20251001", usage)).toBe(6);
  });
  it("treats local providers as free", () => {
    expect(estimateCostUsd("ollama", "llama3.3", usage)).toBe(0);
  });
});

describe("AnthropicProvider", () => {
  it("maps a text response with usage and cost", async () => {
    const create = vi.fn().mockResolvedValue(fakeAnthropicMessage());
    const provider = new AnthropicProvider({
      client: { messages: { create } } as AnthropicMessagesClient,
    });

    const result = await provider.chat({
      model: "claude-opus-4-8",
      system: "Be helpful.",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });

    expect(resultText(result)).toBe("Hello!");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
    });
    // 1000*$5 + 100*$25 + 500*$0.5 + 200*$6.25 per MTok
    expect(result.costUsd).toBeCloseTo((1000 * 5 + 100 * 25 + 500 * 0.5 + 200 * 6.25) / 1e6);

    const params = create.mock.calls[0]![0];
    expect(params.system).toBe("Be helpful.");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });

  it("maps tool definitions and tool_use responses", async () => {
    const create = vi.fn().mockResolvedValue(
      fakeAnthropicMessage({
        content: [
          { type: "text", text: "Checking…", citations: null },
          { type: "tool_use", id: "toolu_1", name: "fs.read", input: { path: "a.txt" } },
        ],
        stop_reason: "tool_use",
      }),
    );
    const provider = new AnthropicProvider({
      client: { messages: { create } } as AnthropicMessagesClient,
    });

    const result = await provider.chat({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "Read a.txt" }] }],
      tools: [{ name: "fs.read", description: "Read a file", inputSchema: { type: "object" } }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(toolUses(result)).toEqual([
      { type: "tool_use", id: "toolu_1", name: "fs.read", input: { path: "a.txt" } },
    ]);
    const params = create.mock.calls[0]![0];
    expect(params.tools).toEqual([
      { name: "fs.read", description: "Read a file", input_schema: { type: "object" } },
    ]);
  });

  it("sends tool results back as tool_result blocks", async () => {
    const create = vi.fn().mockResolvedValue(fakeAnthropicMessage());
    const provider = new AnthropicProvider({
      client: { messages: { create } } as AnthropicMessagesClient,
    });

    await provider.chat({
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "fs.read", input: { path: "a.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "toolu_1", content: "file body" }],
        },
      ],
    });

    const params = create.mock.calls[0]![0];
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
    });
  });

  it("omits temperature on models without sampling params", async () => {
    const create = vi.fn().mockResolvedValue(fakeAnthropicMessage());
    const provider = new AnthropicProvider({
      client: { messages: { create } } as AnthropicMessagesClient,
    });
    await provider.chat({
      model: "claude-opus-4-8",
      temperature: 0.7,
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    expect(create.mock.calls[0]![0].temperature).toBeUndefined();
  });

  it("disables thinking when requested", async () => {
    const create = vi.fn().mockResolvedValue(fakeAnthropicMessage());
    const provider = new AnthropicProvider({
      client: { messages: { create } } as AnthropicMessagesClient,
    });
    await provider.chat({
      model: "claude-opus-4-8",
      thinking: "off",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    expect(create.mock.calls[0]![0].thinking).toEqual({ type: "disabled" });
  });
});

describe("OllamaProvider", () => {
  function fakeFetch(payload: unknown, status = 200): FetchLike {
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("maps a plain chat response", async () => {
    const fetchImpl = fakeFetch({
      message: { role: "assistant", content: "Hi there" },
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 8,
    });
    const provider = new OllamaProvider({ fetchImpl });
    const result = await provider.chat({
      model: "llama3.3",
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });
    expect(resultText(result)).toBe("Hi there");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.costUsd).toBe(0);

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(body.stream).toBe(false);
  });

  it("assigns ULIDs to tool calls", async () => {
    const fetchImpl = fakeFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "time.now", arguments: {} } }],
      },
    });
    const provider = new OllamaProvider({ fetchImpl });
    const result = await provider.chat({
      model: "llama3.3",
      messages: [{ role: "user", content: [{ type: "text", text: "time?" }] }],
      tools: [{ name: "time.now", description: "Current time", inputSchema: { type: "object" } }],
    });
    expect(result.stopReason).toBe("tool_use");
    const calls = toolUses(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("classifies unreachable daemon as retryable provider_error", async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new OllamaProvider({ fetchImpl });
    await expect(
      provider.chat({
        model: "llama3.3",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });
});

describe("ModelRouter", () => {
  function stubProvider(name: string, impl: ModelProvider["chat"]): ModelProvider {
    return { name, chat: impl };
  }
  const okResult = {
    model: "m",
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
  const baseReq = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };

  it("routes to the primary provider", async () => {
    const router = new ModelRouter().register(stubProvider("anthropic", async () => okResult));
    const result = await router.chat({ ...baseReq, modelRef: "anthropic/claude-opus-4-8" });
    expect(result.provider).toBe("anthropic");
    expect(result.modelRef).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back on retryable errors", async () => {
    const primary = vi
      .fn()
      .mockRejectedValue(new GinError("provider_rate_limited", "429", { retryable: true }));
    const fallback = vi.fn().mockResolvedValue(okResult);
    const router = new ModelRouter()
      .register(stubProvider("anthropic", primary))
      .register(stubProvider("ollama", fallback));

    const result = await router.chat({
      ...baseReq,
      modelRef: "anthropic/claude-opus-4-8",
      fallbacks: ["ollama/llama3.3"],
    });
    expect(result.provider).toBe("ollama");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not fall back on non-retryable errors", async () => {
    const primary = vi
      .fn()
      .mockRejectedValue(new GinError("validation_failed", "bad request", { retryable: false }));
    const fallback = vi.fn();
    const router = new ModelRouter()
      .register(stubProvider("anthropic", primary))
      .register(stubProvider("ollama", fallback));

    await expect(
      router.chat({
        ...baseReq,
        modelRef: "anthropic/claude-opus-4-8",
        fallbacks: ["ollama/llama3.3"],
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws the last error when the whole chain fails", async () => {
    const failing = vi
      .fn()
      .mockRejectedValue(new GinError("provider_error", "down", { retryable: true }));
    const router = new ModelRouter().register(stubProvider("anthropic", failing));
    await expect(
      router.chat({ ...baseReq, modelRef: "anthropic/claude-opus-4-8", fallbacks: ["missing/x"] }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });
});
