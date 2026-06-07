import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GinError } from "@gin/core";
import { auditConfig, configPath, ginHome, loadConfig, saveConfig } from "./loader.js";
import { GinConfigSchema } from "./schema.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "gin-test-"));
  process.env.GIN_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.GIN_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

const minimal = { agent: { model: "anthropic/claude-opus-4-8" } };

describe("config loader", () => {
  it("respects GIN_HOME and resolves paths under it", () => {
    expect(ginHome()).toBe(tmpHome);
    expect(configPath()).toBe(join(tmpHome, "gin.json"));
  });

  it("throws config_invalid when no config exists", () => {
    expect(() => loadConfig()).toThrowError(GinError);
    try {
      loadConfig();
    } catch (err) {
      expect((err as GinError).code).toBe("config_invalid");
      expect((err as GinError).details.missing).toBe(true);
    }
  });

  it("loads the minimal config form with secure defaults", () => {
    writeFileSync(configPath(), JSON.stringify(minimal));
    const { config } = loadConfig();
    expect(config.agent.model).toBe("anthropic/claude-opus-4-8");
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.gateway.allowRemote).toBe(false);
    expect(config.telemetry).toBe(false);
    expect(config.agent.sandboxMode).toBe("docker");
  });

  it("rejects malformed JSON and schema violations loudly", () => {
    writeFileSync(configPath(), "{ not json");
    expect(() => loadConfig()).toThrowError(/not valid JSON/);

    writeFileSync(configPath(), JSON.stringify({ agent: { model: "" } }));
    expect(() => loadConfig()).toThrowError(/failed validation/);
  });

  it("saveConfig round-trips and sets restrictive permissions", () => {
    const path = saveConfig(GinConfigSchema.parse(minimal));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.agent.model).toBe("anthropic/claude-opus-4-8");
    const { config } = loadConfig();
    expect(config.agent.model).toBe("anthropic/claude-opus-4-8");
  });
});

describe("auditConfig (gin doctor checks)", () => {
  it("flags open DMs, host sandbox, remote exposure, and missing budgets", () => {
    const config = GinConfigSchema.parse({
      agent: { model: "x/y", sandboxMode: "host" },
      gateway: { allowRemote: true, host: "0.0.0.0" },
      channels: {
        telegram: { enabled: true, dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    const codes = auditConfig(config).map((w) => w.code);
    expect(codes).toContain("open_dm");
    expect(codes).toContain("host_sandbox");
    expect(codes).toContain("remote_exposed");
    expect(codes).toContain("nonlocal_bind");
    expect(codes).toContain("no_budget");
  });

  it("is quiet on a safe config with budgets", () => {
    const config = GinConfigSchema.parse({
      agent: { model: "x/y" },
      budgets: { perSessionUsd: 1 },
    });
    expect(auditConfig(config)).toEqual([]);
  });
});
