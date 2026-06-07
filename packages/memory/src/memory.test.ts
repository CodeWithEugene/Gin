import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "@gin/storage";
import { HashEmbedder, OllamaEmbedder, cosine, normalize } from "./embedder.js";
import { MemoryStore } from "./store.js";

const AGENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

function newStore(withEmbedder = true): MemoryStore {
  const db = openDatabase({ path: ":memory:" });
  return new MemoryStore(db, withEmbedder ? { embedder: new HashEmbedder() } : {});
}

describe("MemoryStore CRUD", () => {
  it("stores and retrieves records", async () => {
    const store = newStore();
    const record = await store.store({ agentId: AGENT, text: "User prefers dark roast coffee" });
    expect(store.get(record.id)?.text).toBe("User prefers dark roast coffee");
    expect(store.list(AGENT)).toHaveLength(1);
  });

  it("deletes records and their vectors", async () => {
    const store = newStore();
    const record = await store.store({ agentId: AGENT, text: "temp" });
    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeUndefined();
    expect(await store.search(AGENT, "temp")).toHaveLength(0);
  });
});

describe("keyword search (FTS5)", () => {
  it("finds records by keyword and scopes by agent", async () => {
    const store = newStore(false);
    await store.store({ agentId: AGENT, text: "The deploy pipeline uses GitHub Actions" });
    await store.store({ agentId: AGENT, text: "User speaks Swahili and English" });
    await store.store({ agentId: OTHER, text: "GitHub is the user's favorite site" });

    const hits = await store.search(AGENT, "github actions", { mode: "keyword" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.record.text).toContain("pipeline");
  });

  it("survives FTS5 metacharacters in queries", async () => {
    const store = newStore(false);
    await store.store({ agentId: AGENT, text: 'C++ and "quotes" are fine' });
    await expect(store.search(AGENT, 'C++ "quotes" AND NOT (x)')).resolves.toBeDefined();
  });
});

describe("vector search", () => {
  it("ranks token-overlapping texts higher", async () => {
    const store = newStore();
    await store.store({ agentId: AGENT, text: "favorite drink is green tea" });
    await store.store({ agentId: AGENT, text: "deploy pipeline failed on linting" });

    const hits = await store.search(AGENT, "green tea drink", { mode: "vector", limit: 2 });
    expect(hits[0]!.record.text).toContain("tea");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});

describe("hybrid search", () => {
  it("fuses keyword and vector hits", async () => {
    const store = newStore();
    await store.store({ agentId: AGENT, text: "User works at Cyber Uhuru in Nairobi" });
    await store.store({ agentId: AGENT, text: "Production database is PostgreSQL 17" });
    const hits = await store.search(AGENT, "where does the user work? Nairobi", { mode: "hybrid" });
    expect(hits[0]!.record.text).toContain("Nairobi");
  });
});

describe("embedders", () => {
  it("HashEmbedder is deterministic and normalized", async () => {
    const e = new HashEmbedder(64);
    const [a] = await e.embed(["hello world"]);
    const [b] = await e.embed(["hello world"]);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it("cosine of identical normalized vectors is 1", () => {
    const v = new Float32Array(normalize([1, 2, 3]));
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  it("OllamaEmbedder posts to /api/embed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 }),
      );
    const e = new OllamaEmbedder({ fetchImpl, dim: 2 });
    const result = await e.embed(["hi"]);
    expect(result).toEqual([[0.1, 0.2]]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/api/embed");
    expect(JSON.parse(init.body)).toEqual({ model: "nomic-embed-text", input: ["hi"] });
  });

  it("classifies unreachable embedder as retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const e = new OllamaEmbedder({ fetchImpl });
    await expect(e.embed(["hi"])).rejects.toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });
});
