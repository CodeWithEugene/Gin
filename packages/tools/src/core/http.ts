import { GinError } from "@gin/core";
import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

/**
 * Outbound HTTP for the agent. Only http(s) URLs; responses are returned as
 * text and capped. SSRF hardening (private-range blocking) lands with the
 * governance plane; dm-pairing already keeps untrusted senders out.
 */

const MAX_BODY = 128 * 1024;

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
