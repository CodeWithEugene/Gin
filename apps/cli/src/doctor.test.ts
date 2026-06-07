import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGateway, type Gateway } from "@gin/gateway";
import { formatDoctorReport, runDoctor } from "./doctor.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "gin-doctor-"));
  process.env.GIN_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.GIN_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("gin doctor", () => {
  it("warns (not fails) when config is missing and gateway is down", async () => {
    const report = await runDoctor({ gatewayUrl: "http://127.0.0.1:1" });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.node!.status).toBe("ok");
    expect(byName.config!.status).toBe("warn");
    expect(byName.gateway!.status).toBe("warn");
    expect(report.healthy).toBe(true); // warns don't fail the doctor
  });

  it("fails on invalid config", async () => {
    writeFileSync(join(tmpHome, "gin.json"), JSON.stringify({ agent: { model: "" } }));
    const report = await runDoctor({ gatewayUrl: "http://127.0.0.1:1" });
    const config = report.checks.find((c) => c.name === "config");
    expect(config!.status).toBe("fail");
    expect(report.healthy).toBe(false);
  });

  it("flags risky config as warnings", async () => {
    writeFileSync(
      join(tmpHome, "gin.json"),
      JSON.stringify({
        agent: { model: "x/y", sandboxMode: "host" },
        channels: { telegram: { enabled: true, dmPolicy: "open", allowFrom: ["*"] } },
      }),
    );
    const report = await runDoctor({ gatewayUrl: "http://127.0.0.1:1" });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("config:open_dm");
    expect(names).toContain("config:host_sandbox");
  });

  it("reports a live gateway as healthy", async () => {
    writeFileSync(
      join(tmpHome, "gin.json"),
      JSON.stringify({ agent: { model: "x/y" }, budgets: { perSessionUsd: 1 } }),
    );
    const gw: Gateway = createGateway({ port: 0 });
    await gw.start();
    try {
      const report = await runDoctor({ gatewayUrl: `http://127.0.0.1:${gw.address.port}` });
      const gatewayCheck = report.checks.find((c) => c.name === "gateway");
      expect(gatewayCheck!.status).toBe("ok");
      expect(report.healthy).toBe(true);
      expect(formatDoctorReport(report)).toContain("Gin is healthy.");
    } finally {
      await gw.stop();
    }
  });
});
