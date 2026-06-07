import { GinError } from "@gin/core";

/**
 * Pluggable embedders. The default local-first option is Ollama
 * (nomic-embed-text); the HashEmbedder is a deterministic, dependency-free
 * fallback used in tests and when no embedding model is available — FTS5
 * keyword search still carries recall in that case.
 */

export interface Embedder {
  /** Identifies the embedding space; stored alongside vectors. */
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaEmbedderOptions {
  model?: string;
  baseUrl?: string;
  dim?: number;
  fetchImpl?: FetchLike;
}

export class OllamaEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.model = opts.model ?? "nomic-embed-text";
    this.dim = opts.dim ?? 768;
    this.id = `ollama/${this.model}`;
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err) {
      throw new GinError("provider_error", `Ollama embedder unreachable at ${this.baseUrl}`, {
        cause: err,
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new GinError("provider_error", `Ollama embed HTTP ${res.status}`, {
        retryable: res.status >= 500,
      });
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}

/**
 * Deterministic bag-of-tokens hash embedding. Not semantically meaningful,
 * but stable, fast, and good enough to exercise the vector path end-to-end:
 * texts sharing tokens land close together.
 */
export class HashEmbedder implements Embedder {
  readonly id = "hash/v1";
  readonly dim: number;

  constructor(dim = 128) {
    this.dim = dim;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const vec = Array.from({ length: this.dim }, () => 0);
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (!token) continue;
      const slot = fnv1a(token) % this.dim;
      vec[slot] = (vec[slot] ?? 0) + 1;
    }
    return normalize(vec);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/** Cosine similarity; assumes both vectors are L2-normalized. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
