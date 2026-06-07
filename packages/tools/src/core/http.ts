import { GinError } from "@gin/core";
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * Outbound HTTP for the agent. Only http(s) URLs; responses are returned as
 * text and capped. SSRF guard: requests to loopback, private, link-local
 * (cloud metadata!), and .local/.internal hosts are refused by default —
 * a prompt-injected agent must not be able to probe the operator's LAN.
 * Set GIN_ALLOW_PRIVATE_HTTP=1 to opt out (e.g. homelab automation).
 * Note: hostname-literal checks don't stop DNS rebinding; keep the gateway
 * on a trusted network for anything stronger until the proxy lands.
 */

const MAX_BODY = 128 * 1024;

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  // IPv6 literals: loopback, unique-local fc00::/7, link-local fe80::/10,
  // and v4-mapped forms fall through to the v4 check.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host) || host.startsWith("fe8") || host.startsWith("fe9")) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateHost(mapped[1]!);
    return false;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export const httpFetch: ToolDefinition<
  z.ZodObject<{
    url: z.ZodString;
    method: z.ZodDefault<z.ZodEnum<["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]>>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    body: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "http.fetch",
  description:
    "Make an HTTP request and return the response status, headers, and body text (truncated past 128KB).",
  toolset: "http",
  riskLevel: "medium",
  paramsSchema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  async execute(args, ctx) {
    const url = new URL(args.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GinError("tool_error", `Unsupported protocol: ${url.protocol}`);
    }
    if (process.env.GIN_ALLOW_PRIVATE_HTTP !== "1" && isPrivateHost(url.hostname)) {
      throw new GinError(
        "sandbox_violation",
        `Refusing to fetch private/internal host "${url.hostname}". ` +
          "Set GIN_ALLOW_PRIVATE_HTTP=1 on the gateway to allow LAN access.",
      );
    }
    const fetchImpl = ctx.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
    const res = await fetchImpl(args.url, {
      method: args.method,
      ...(args.headers !== undefined ? { headers: args.headers } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n…[truncated]` : text,
    };
  },
};
