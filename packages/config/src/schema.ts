import { z } from "zod";

/**
 * `~/.gin/gin.json` schema. Minimal valid form:
 *   { "agent": { "model": "anthropic/claude-opus-4-8" } }
 * Everything else has secure, local-first defaults.
 *
 * Secrets NEVER live here — they go in the OS keychain or the encrypted
 * secrets file; config may only hold secret *references* (e.g. "keychain:anthropic").
 */

export const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(18789),
  host: z.string().default("127.0.0.1"),
  /** Remote access must be an explicit opt-in (spec 5.1). */
  allowRemote: z.boolean().default(false),
});

export const AgentDefaultsSchema = z.object({
  /** "<provider>/<model-id>" */
  model: z.string().min(1),
  fallbacks: z.array(z.string()).default([]),
  workspace: z.string().optional(),
  sandboxMode: z.enum(["host", "docker", "ssh", "policy"]).default("docker"),
  thinking: z.enum(["off", "low", "medium", "high"]).default("medium"),
});

export const BudgetDefaultsSchema = z.object({
  perSessionUsd: z.number().nonnegative().optional(),
  perDayUsd: z.number().nonnegative().optional(),
  action: z.enum(["block", "degrade", "alert"]).default("block"),
});

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  dmPolicy: z.enum(["pairing", "allowlist", "open"]).default("pairing"),
  allowFrom: z.array(z.string()).default([]),
  /** Secret reference, e.g. "keychain:telegram-bot-token" — never a raw token. */
  tokenRef: z.string().optional(),
});

export const GovernanceConfigSchema = z.object({
  approvals: z
    .object({
      enabled: z.boolean().default(true),
      /** Tools at/above this risk level pause for human approval. */
      threshold: z.enum(["low", "medium", "high", "critical"]).default("critical"),
      timeoutMs: z.number().int().positive().default(300_000),
    })
    .default({}),
  /** Anti-silent-failure verification of every turn. */
  verifier: z.object({ enabled: z.boolean().default(true) }).default({}),
});

export const GinConfigSchema = z.object({
  agent: AgentDefaultsSchema,
  gateway: GatewayConfigSchema.default({}),
  budgets: BudgetDefaultsSchema.default({}),
  channels: z.record(ChannelConfigSchema).default({}),
  governance: GovernanceConfigSchema.default({}),
  /** Privacy-first: telemetry is opt-in and off by default. */
  telemetry: z.boolean().default(false),
});

export type GinConfig = z.infer<typeof GinConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
