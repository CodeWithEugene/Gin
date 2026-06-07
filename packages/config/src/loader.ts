import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GinError } from "@gin/core";
import { GinConfigSchema, type GinConfig } from "./schema.js";

/** Resolve the Gin home dir: $GIN_HOME or ~/.gin. */
export function ginHome(): string {
  return process.env.GIN_HOME ?? join(homedir(), ".gin");
}

export function configPath(): string {
  return join(ginHome(), "gin.json");
}

export function workspacePath(config?: GinConfig): string {
  return config?.agent.workspace ?? join(ginHome(), "workspace");
}

export interface LoadResult {
  config: GinConfig;
  path: string;
  /** True if the file existed on disk (vs. not yet onboarded). */
  existed: boolean;
}

/**
 * Load and validate config. Throws GinError("config_invalid") with the full
 * Zod issue list on malformed config — never silently falls back, because a
 * typo'd budget or dmPolicy must not be ignored.
 */
export function loadConfig(): LoadResult {
  const path = configPath();
  if (!existsSync(path)) {
    throw new GinError("config_invalid", `No config at ${path}. Run \`gin onboard\` first.`, {
      details: { path, missing: true },
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new GinError("config_invalid", `Config at ${path} is not valid JSON.`, { cause: err });
  }

  const result = GinConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new GinError("config_invalid", `Config at ${path} failed validation.`, {
      details: { issues: result.error.issues },
    });
  }
  return { config: result.data, path, existed: true };
}

/** Write a config (used by `gin onboard`). Creates ~/.gin if needed. */
export function saveConfig(config: GinConfig): string {
  const home = ginHome();
  mkdirSync(home, { recursive: true });
  const path = configPath();
  const validated = GinConfigSchema.parse(config);
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export interface ConfigWarning {
  code: string;
  message: string;
}

/**
 * Risky-config checks surfaced by `gin doctor` (spec 5.1/6): open DMs,
 * host sandbox, remote exposure, missing budgets.
 */
export function auditConfig(config: GinConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const [name, ch] of Object.entries(config.channels)) {
    if (!ch.enabled) continue;
    if (ch.dmPolicy === "open" && ch.allowFrom.includes("*")) {
      warnings.push({
        code: "open_dm",
        message: `Channel "${name}" accepts DMs from anyone (dmPolicy=open, allowFrom=["*"]). Anyone can command your agent.`,
      });
    }
  }

  if (config.agent.sandboxMode === "host") {
    warnings.push({
      code: "host_sandbox",
      message:
        "Default sandboxMode is 'host': tool execution is NOT isolated for non-main sessions.",
    });
  }

  if (config.gateway.allowRemote) {
    warnings.push({
      code: "remote_exposed",
      message:
        "Gateway remote access is enabled. Review the exposure runbook (docs/security) before exposing.",
    });
  }

  if (config.gateway.host !== "127.0.0.1" && config.gateway.host !== "localhost") {
    warnings.push({
      code: "nonlocal_bind",
      message: `Gateway binds ${config.gateway.host} (not loopback). Combine with auth + TLS or a private network only.`,
    });
  }

  if (config.budgets.perSessionUsd === undefined && config.budgets.perDayUsd === undefined) {
    warnings.push({
      code: "no_budget",
      message:
        "No default budgets set. Consider `gin budget set` so a runaway loop can't overspend.",
    });
  }

  return warnings;
}
