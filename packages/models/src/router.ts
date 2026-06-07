import { GinError, isGinError } from "@gin/core";
import type { ChatRequest, ChatResult, ModelProvider } from "./types.js";
import { parseModelRef } from "./types.js";

/**
 * Routes "<provider>/<model>" refs to registered providers, falling back down
 * the configured chain on retryable provider failures (rate limits, 5xx,
 * unreachable local daemon). Non-retryable errors propagate immediately —
 * a schema-invalid request will fail on every provider identically.
 */

export interface RoutedChatRequest extends Omit<ChatRequest, "model"> {
  /** Primary "<provider>/<model>" ref. */
  modelRef: string;
  fallbacks?: string[];
}

export interface RoutedChatResult extends ChatResult {
  provider: string;
  /** The "<provider>/<model>" ref that actually served the call. */
  modelRef: string;
}

export class ModelRouter {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    this.providers.set(provider.name, provider);
    return this;
  }

  has(providerName: string): boolean {
    return this.providers.has(providerName);
  }

  async chat(req: RoutedChatRequest): Promise<RoutedChatResult> {
    const chain = [req.modelRef, ...(req.fallbacks ?? [])];
    let lastError: GinError | undefined;

    for (const ref of chain) {
      const { provider: providerName, model } = parseModelRef(ref);
      const provider = this.providers.get(providerName);
      if (!provider) {
        lastError = new GinError("config_invalid", `No provider registered for "${ref}"`, {
          retryable: false,
        });
        continue; // a misconfigured fallback entry shouldn't doom the chain
      }
      try {
        const { modelRef: _ref, fallbacks: _fb, ...rest } = req;
        const result = await provider.chat({ ...rest, model });
        return { ...result, provider: providerName, modelRef: ref };
      } catch (err) {
        if (isGinError(err) && err.retryable) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw (
      lastError ??
      new GinError("config_invalid", "Model fallback chain is empty", { retryable: false })
    );
  }
}
