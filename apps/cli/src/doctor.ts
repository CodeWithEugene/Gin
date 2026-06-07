import { accessSync, constants, existsSync } from "node:fs";
import { auditConfig, configPath, ginHome, loadConfig } from "@gin/config";
import { GinError } from "@gin/core";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  healthy: boolean;
}

/**
 * `gin doctor` — health + risky-config report (spec 5.1, Section 6).
 * Pure function over the environment so it is unit-testable; the CLI
 * command formats the result.
 */
export async function runDoctor(opts: { gatewayUrl?: string } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 24
      ? { name: "node", status: "ok", message: `Node ${process.versions.node}` }
      : { name: "node", status: "fail", message: `Node ${process.versions.node} < 24 (required)` },
  );

  // Gin home
  const home = ginHome();
  if (existsSync(home)) {
    try {
      accessSync(home, constants.W_OK);
      checks.push({ name: "gin_home", status: "ok", message: `${home} exists and is writable` });
    } catch {
      checks.push({ name: "gin_home", status: "fail", message: `${home} is not writable` });
    }
  } else {
    checks.push({
      name: "gin_home",
      status: "warn",
      message: `${home} does not exist yet — run \`gin onboard\``,
    });
  }

  // Config + risky-config audit
  try {
    const { config } = loadConfig();
    checks.push({ name: "config", status: "ok", message: `${configPath()} is valid` });
    for (const warning of auditConfig(config)) {
      checks.push({ name: `config:${warning.code}`, status: "warn", message: warning.message });
    }
  } catch (err) {
    if (err instanceof GinError && err.details.missing === true) {
      checks.push({
        name: "config",
        status: "warn",
        message: "No config yet — run `gin onboard`",
      });
    } else {
      checks.push({
        name: "config",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Gateway reachability
  const gatewayUrl = opts.gatewayUrl ?? "http://127.0.0.1:18789";
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { status?: string; version?: string };
    checks.push(
      body.status === "ok"
        ? {
            name: "gateway",
            status: "ok",
            message: `Gateway healthy at ${gatewayUrl} (v${body.version})`,
          }
        : {
            name: "gateway",
            status: "warn",
            message: `Gateway responded abnormally at ${gatewayUrl}`,
          },
    );
  } catch {
    checks.push({
      name: "gateway",
      status: "warn",
      message: `Gateway not reachable at ${gatewayUrl} — start it with \`gin gateway\``,
    });
  }

  return { checks, healthy: checks.every((c) => c.status !== "fail") };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = report.checks.map((c) => ` ${icon[c.status]} ${c.name.padEnd(24)} ${c.message}`);
  lines.push("");
  lines.push(report.healthy ? "Gin is healthy." : "Gin has problems — fix the ✗ items above.");
  return lines.join("\n");
}
