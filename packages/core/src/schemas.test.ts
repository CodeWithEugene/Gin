import { describe, expect, it } from "vitest";
import { newId, isId, idTimestamp } from "./ids.js";
import { GinError, toGinError } from "./errors.js";
import { AgentSchema, MessageSchema, BudgetSchema, ChannelSchema } from "./schemas.js";

describe("ids", () => {
  it("generates valid, monotonically usable ULIDs", () => {
    const a = newId();
    const b = newId();
    expect(isId(a)).toBe(true);
    expect(isId(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("extracts a sane timestamp", () => {
    const before = Date.now();
    const id = newId();
    const ts = idTimestamp(id);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("errors", () => {
  it("classifies retryability by code", () => {
    expect(new GinError("provider_rate_limited", "429").retryable).toBe(true);
    expect(new GinError("permission_denied", "no").retryable).toBe(false);
  });

  it("wraps unknown errors preserving cause", () => {
    const cause = new Error("boom");
    const wrapped = toGinError(cause, "tool_error");
    expect(wrapped.code).toBe("tool_error");
    expect(wrapped.cause).toBe(cause);
  });
});

describe("entity schemas", () => {
  it("parses a minimal agent with defaults applied", () => {
    const agent = AgentSchema.parse({
      id: newId(),
      tenantId: newId(),
      name: "gin",
      workspacePath: "/tmp/ws",
      modelConfig: { primary: "anthropic/claude-opus-4-8" },
      createdAt: Date.now(),
    });
    expect(agent.sandboxMode).toBe("docker");
    expect(agent.toolPolicy.enabledToolsets).toEqual(["*"]);
    expect(agent.budgetPolicy.action).toBe("block");
  });

  it("rejects a message with an invalid role", () => {
    const result = MessageSchema.safeParse({
      id: newId(),
      sessionId: newId(),
      role: "hacker",
      content: "hi",
      createdAt: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative budget limit", () => {
    const result = BudgetSchema.safeParse({
      id: newId(),
      scope: "session",
      scopeRef: "s1",
      limitUsd: -5,
    });
    expect(result.success).toBe(false);
  });

  it("defaults channels to DM pairing (secure-by-default)", () => {
    const channel = ChannelSchema.parse({
      id: newId(),
      tenantId: newId(),
      kind: "telegram",
    });
    expect(channel.dmPolicy).toBe("pairing");
    expect(channel.allowFrom).toEqual([]);
  });
});
