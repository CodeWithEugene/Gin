import { z } from "zod";

/**
 * Core entity schemas (spec Section 3). These are the single source of truth
 * for entity shapes; Drizzle tables (added with the persistence layer) must
 * mirror them. All IDs are ULIDs.
 */

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

// ── Tenant / User ────────────────────────────────────────────────────────────

export const TenantSchema = z.object({
  id: UlidSchema,
  name: z.string().min(1),
  createdAt: z.number().int(),
  plan: z.enum(["local", "free", "pro", "team"]).default("local"),
  settings: z.record(z.unknown()).default({}),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const UserSchema = z.object({
  id: UlidSchema,
  tenantId: UlidSchema,
  displayName: z.string().min(1),
  roles: z.array(z.string()).default([]),
  createdAt: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

// ── Agent ────────────────────────────────────────────────────────────────────

export const ModelConfigSchema = z.object({
  /** "<provider>/<model-id>", e.g. "anthropic/claude-opus-4-8" or "ollama/llama3.3". */
  primary: z.string().min(1),
  fallbacks: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const SandboxModeSchema = z.enum(["host", "docker", "ssh", "policy"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const ToolPolicySchema = z.object({
  /** Toolset slugs enabled for this agent; "*" enables all built-ins. */
  enabledToolsets: z.array(z.string()).default(["*"]),
  deniedTools: z.array(z.string()).default([]),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const BudgetActionSchema = z.enum(["block", "degrade", "alert"]);

export const BudgetPolicySchema = z.object({
  perSessionUsd: z.number().nonnegative().optional(),
  perDayUsd: z.number().nonnegative().optional(),
  action: BudgetActionSchema.default("block"),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const AgentSchema = z.object({
  id: UlidSchema,
  tenantId: UlidSchema,
  name: z.string().min(1),
  /** SOUL.md persona text injected as the system prompt. */
  persona: z.string().default(""),
  workspacePath: z.string().min(1),
  modelConfig: ModelConfigSchema,
  toolPolicy: ToolPolicySchema.default({}),
  sandboxMode: SandboxModeSchema.default("docker"),
  budgetPolicy: BudgetPolicySchema.default({}),
  createdAt: z.number().int(),
});
export type Agent = z.infer<typeof AgentSchema>;

// ── Channel ──────────────────────────────────────────────────────────────────

export const ChannelKindSchema = z.enum([
  "webchat",
  "cli",
  "telegram",
  "whatsapp",
  "slack",
  "discord",
  "signal",
  "imessage",
  "irc",
  "msteams",
  "matrix",
  "googlechat",
  "feishu",
  "line",
  "mattermost",
  "nextcloud",
  "nostr",
  "synology",
  "twitch",
  "zalo",
  "wechat",
  "qq",
  "email",
]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open"]);

export const ChannelSchema = z.object({
  id: UlidSchema,
  tenantId: UlidSchema,
  kind: ChannelKindSchema,
  /** Opaque reference to the account/bot credential backing this channel. */
  accountRef: z.string().default("default"),
  status: z.enum(["disconnected", "connecting", "connected", "error"]).default("disconnected"),
  dmPolicy: DmPolicySchema.default("pairing"),
  allowFrom: z.array(z.string()).default([]),
  routingRules: z.array(z.object({ match: z.string(), agentId: UlidSchema })).default([]),
});
export type Channel = z.infer<typeof ChannelSchema>;

// ── Session / Message ────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum(["active", "idle", "compacting", "closed"]);

export const SessionSchema = z.object({
  id: UlidSchema,
  agentId: UlidSchema,
  channelId: UlidSchema.optional(),
  /** Stable identifier of the remote peer (e.g. telegram user id). */
  peerRef: z.string().default(""),
  status: SessionStatusSchema.default("active"),
  parentSessionId: UlidSchema.optional(),
  createdAt: z.number().int(),
  lastActiveAt: z.number().int(),
});
export type Session = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const DeliveryStatusSchema = z.enum([
  "queued",
  "sending",
  "delivered",
  "failed",
  "dead_letter",
]);

export const AttachmentSchema = z.object({
  kind: z.enum(["image", "audio", "video", "file"]),
  /** Path under the workspace blob dir, or a URL. */
  ref: z.string(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageSchema = z.object({
  id: UlidSchema,
  sessionId: UlidSchema,
  role: MessageRoleSchema,
  content: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  /** The channel-native message id (used for inbound dedup + outbound idempotency). */
  channelMessageId: z.string().optional(),
  deliveryStatus: DeliveryStatusSchema.default("queued"),
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof MessageSchema>;

// ── Turn / Step ──────────────────────────────────────────────────────────────

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const StepTypeSchema = z.enum(["tool_call", "model_call", "approval", "verify", "subagent"]);

export const StepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "compensated",
  "dead_letter",
]);

export const StepSchema = z.object({
  id: UlidSchema,
  turnId: UlidSchema,
  type: StepTypeSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  status: StepStatusSchema.default("pending"),
  latencyMs: z.number().nonnegative().optional(),
  tokens: TokenUsageSchema.optional(),
  costUsd: z.number().nonnegative().default(0),
  checkpointId: UlidSchema.optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const TurnStatusSchema = z.enum([
  "planning",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "budget_terminated",
]);

export const TurnSchema = z.object({
  id: UlidSchema,
  sessionId: UlidSchema,
  plan: z.string().default(""),
  steps: z.array(StepSchema).default([]),
  status: TurnStatusSchema.default("planning"),
  tokenUsage: TokenUsageSchema.default({}),
  costUsd: z.number().nonnegative().default(0),
  traceId: z.string().default(""),
});
export type Turn = z.infer<typeof TurnSchema>;

// ── Memory / Skills ──────────────────────────────────────────────────────────

export const MemoryKindSchema = z.enum(["fact", "skill", "episodic"]);

export const MemoryRecordSchema = z.object({
  id: UlidSchema,
  agentId: UlidSchema,
  kind: MemoryKindSchema,
  text: z.string().min(1),
  embedding: z.array(z.number()).optional(),
  source: z.string().default(""),
  createdAt: z.number().int(),
  editedBy: z.string().optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const SkillSchema = z.object({
  id: UlidSchema,
  slug: z.string().min(1),
  version: z.string().default("0.0.1"),
  /** Parsed SKILL.md frontmatter. */
  manifest: z.record(z.unknown()).default({}),
  body: z.string().default(""),
  source: z.enum(["bundled", "workspace", "hub"]).default("workspace"),
  enabled: z.boolean().default(true),
});
export type Skill = z.infer<typeof SkillSchema>;

// ── Tools / MCP ──────────────────────────────────────────────────────────────

export const ToolCallSchema = z.object({
  id: UlidSchema,
  stepId: UlidSchema,
  toolName: z.string().min(1),
  args: z.unknown(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MCPServerSchema = z.object({
  id: UlidSchema,
  transport: z.enum(["stdio", "http"]),
  url: z.string().optional(),
  cmd: z.string().optional(),
  allowedTools: z.array(z.string()).default(["*"]),
  status: z.enum(["disconnected", "connected", "error"]).default("disconnected"),
});
export type MCPServer = z.infer<typeof MCPServerSchema>;

// ── Budget / Governance / Audit ──────────────────────────────────────────────

export const BudgetScopeSchema = z.enum(["agent", "tenant", "session", "pipeline", "apiKey"]);

export const BudgetSchema = z.object({
  id: UlidSchema,
  scope: BudgetScopeSchema,
  scopeRef: z.string().min(1),
  limitUsd: z.number().nonnegative(),
  window: z.enum(["session", "hour", "day", "week", "month"]).default("session"),
  spentUsd: z.number().nonnegative().default(0),
  action: BudgetActionSchema.default("block"),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalRequestSchema = z.object({
  id: UlidSchema,
  stepId: UlidSchema,
  action: z.string().min(1),
  riskLevel: RiskLevelSchema,
  status: z.enum(["pending", "approved", "denied", "expired"]).default("pending"),
  decidedBy: z.string().optional(),
  decidedAt: z.number().int().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const AuditEventSchema = z.object({
  id: UlidSchema,
  tenantId: UlidSchema,
  actor: z.string().min(1),
  action: z.string().min(1),
  target: z.string().default(""),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  traceId: z.string().default(""),
  createdAt: z.number().int(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
