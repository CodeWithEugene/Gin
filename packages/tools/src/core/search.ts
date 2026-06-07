import { GinError } from "@gin/core";
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * Web search without an API key: DuckDuckGo's HTML endpoint, parsed into
 * {title, url, snippet}. Local-first default — operators can swap in a keyed
 * provider later behind the same tool name. Pairs with http.fetch for the
 * deep-research skill: search wide, fetch the best sources, cite them.
 */

const ANCHOR_RE = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_RE = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const anchors = [...html.matchAll(ANCHOR_RE)];
  const results: SearchResult[] = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const match = anchors[i]!;
    const url = decodeRedirect(match[1]!);
    if (!url.startsWith("http")) continue;
    // The snippet lives between this result anchor and the next one.
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1]!.index : html.length;
    const block = html.slice(match.index + match[0].length, blockEnd);
    const snippet = SNIPPET_RE.exec(block)?.[1] ?? "";
    results.push({ title: stripTags(match[2]!), url, snippet: stripTags(snippet) });
  }
  return results;
}

/** DDG wraps result hrefs as //duckduckgo.com/l/?uddg=<encoded>&rut=… */
function decodeRedirect(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return "";
    }
  }
  return href;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webSearch: ToolDefinition<
  z.ZodObject<{ query: z.ZodString; limit: z.ZodDefault<z.ZodNumber> }>
> = {
  name: "web.search",
  description:
    "Search the web and get result titles, URLs, and snippets. Follow up with http.fetch on the most promising URLs.",
  toolset: "http",
  riskLevel: "low",
  paramsSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).default(5),
  }),
  async execute(args, ctx) {
    const fetchImpl = ctx.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
    let res: Response;
    try {
      res = await fetchImpl(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
        {
          method: "GET",
          headers: { "user-agent": "Mozilla/5.0 (gin-agent)" },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      throw new GinError("tool_error", "Web search unreachable", { cause: err, retryable: true });
    }
    if (!res.ok) {
      throw new GinError("tool_error", `Web search returned HTTP ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const results = parseDuckDuckGoHtml(await res.text(), args.limit);
    return { results };
  },
};
