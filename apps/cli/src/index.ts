#!/usr/bin/env node
import { Command } from "commander";
import { GinConfigSchema, configPath, loadConfig, saveConfig, workspacePath } from "@gin/config";
import { createGateway } from "@gin/gateway";
import { mkdirSync } from "node:fs";
import { GatewayClient, gatewayWsUrl } from "./client.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";

export { runDoctor, formatDoctorReport, type DoctorReport, type DoctorCheck } from "./doctor.js";
export { GatewayClient, gatewayWsUrl } from "./client.js";

const program = new Command();

program.name("gin").description("Gin — self-hosted autonomous AI agent").version("0.1.0");

program
  .command("onboard")
  .description("Initialize ~/.gin: write a starter config and create the workspace")
  .option("--model <model>", "default model as <provider>/<model-id>", "anthropic/claude-opus-4-8")
  .option("--install-daemon", "install a launchd/systemd user service (not yet implemented)")
  .action((opts: { model: string; installDaemon?: boolean }) => {
    const config = GinConfigSchema.parse({ agent: { model: opts.model } });
    const path = saveConfig(config);
    mkdirSync(workspacePath(config), { recursive: true });
    console.log(`Wrote ${path}`);
    console.log(`Workspace at ${workspacePath(config)}`);
    if (opts.installDaemon) {
      console.log("(--install-daemon ships in a later phase; start manually with `gin gateway`)");
    }
    console.log("Next: `gin doctor`, then `gin gateway`.");
  });

program
  .command("doctor")
  .description("Check health and flag risky configuration")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { gatewayUrl: string }) => {
    const report = await runDoctor({ gatewayUrl: opts.gatewayUrl });
    console.log(formatDoctorReport(report));
    process.exitCode = report.healthy ? 0 : 1;
  });

const gateway = program.command("gateway").description("Run or inspect the Gateway daemon");

gateway
  .command("start", { isDefault: true })
  .description("Start the Gateway in the foreground")
  .option("--port <port>", "listen port")
  .option("--verbose", "log every bus event")
  .action(async (opts: { port?: string; verbose?: boolean }) => {
    let port = 18789;
    let host = "127.0.0.1";
    try {
      const { config } = loadConfig();
      port = config.gateway.port;
      host = config.gateway.host;
    } catch {
      console.error(`No valid config at ${configPath()} — using defaults. Run \`gin onboard\`.`);
    }
    if (opts.port) port = Number(opts.port);

    const gw = createGateway({ port, host });
    if (opts.verbose) {
      gw.bus.on("*", (e) => console.log(`[event] ${e.type}`, JSON.stringify(e.payload)));
    }
    await gw.start();
    console.log(`gin-gateway listening on ws://${host}:${gw.address.port}/ws`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void gw.stop().then(() => process.exit(0));
      });
    }
  });

gateway
  .command("status")
  .description("Check whether the Gateway is running")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { gatewayUrl: string }) => {
    try {
      const res = await fetch(`${opts.gatewayUrl}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { status?: string; version?: string };
      console.log(`Gateway is ${body.status} (v${body.version}) at ${opts.gatewayUrl}`);
    } catch {
      console.log(`Gateway is not reachable at ${opts.gatewayUrl}`);
      process.exitCode = 1;
    }
  });

const message = program.command("message").description("Exchange messages with the agent");

message
  .command("send <text>")
  .description("Send a message to the default agent and print the reply")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .option("--peer <peerRef>", "stable peer id (keeps one conversation per peer)", "cli")
  .option("--timeout <seconds>", "seconds to wait for the reply", "120")
  .action(async (text: string, opts: { gatewayUrl: string; peer: string; timeout: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const reply = client.waitForEvent<{ peerRef: string; text: string }>(
        "webchat.message",
        (p) => p.peerRef === opts.peer,
        Number(opts.timeout) * 1000,
      );
      const failure = client.waitForEvent<{ peerRef: string; code: string; message: string }>(
        "webchat.error",
        (p) => p.peerRef === opts.peer,
        Number(opts.timeout) * 1000,
      );
      await client.call("gin.chat.send", { text, peerRef: opts.peer });
      const outcome = await Promise.race([
        reply.then((p) => ({ kind: "reply" as const, ...p })),
        failure.then((p) => ({ kind: "error" as const, ...p })),
      ]);
      if (outcome.kind === "error") {
        console.error(`Turn failed (${outcome.code}): ${outcome.message}`);
        process.exitCode = 1;
      } else {
        console.log(outcome.text);
      }
    } finally {
      client.close();
    }
  });

const agent = program.command("agent").description("Inspect configured agents");

agent
  .command("list")
  .description("List agents registered on the gateway")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { gatewayUrl: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const agents =
        await client.call<
          { id: string; name: string; modelConfig: { primary: string }; workspacePath: string }[]
        >("gin.agent.list");
      if (agents.length === 0) {
        console.log("No agents yet — send a message to create the default agent.");
        return;
      }
      for (const a of agents) {
        console.log(`${a.name}  ${a.modelConfig.primary}  ${a.workspacePath}  (${a.id})`);
      }
    } finally {
      client.close();
    }
  });

const trace = program.command("trace").description("Inspect step-level traces");

trace
  .command("list")
  .description("List recent traces with cost and step rollups")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .option("--limit <n>", "max traces", "20")
  .action(async (opts: { gatewayUrl: string; limit: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const traces = await client.call<
        {
          traceId: string;
          status: string;
          modelCalls: number;
          toolCalls: number;
          costUsd: number;
          startTs: number;
          endTs: number;
        }[]
      >("gin.trace.list", { limit: Number(opts.limit) });
      if (traces.length === 0) {
        console.log("No traces yet.");
        return;
      }
      for (const t of traces) {
        const duration = ((t.endTs - t.startTs) / 1000).toFixed(1);
        console.log(
          `${t.traceId}  ${t.status.padEnd(18)}  ${t.modelCalls} model / ${t.toolCalls} tool  ` +
            `$${t.costUsd.toFixed(4)}  ${duration}s`,
        );
      }
    } finally {
      client.close();
    }
  });

trace
  .command("show <traceId>")
  .description("Print the full ordered timeline of one trace")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (traceId: string, opts: { gatewayUrl: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const events = await client.call<{ type: string; ts: number; payload: unknown }[]>(
        "gin.trace.get",
        { traceId },
      );
      if (events.length === 0) {
        console.log(`No events for trace ${traceId}.`);
        process.exitCode = 1;
        return;
      }
      const start = events[0]!.ts;
      for (const e of events) {
        const offset = `+${((e.ts - start) / 1000).toFixed(3)}s`.padStart(10);
        console.log(`${offset}  ${e.type.padEnd(24)}  ${JSON.stringify(e.payload)}`);
      }
    } finally {
      client.close();
    }
  });

const budget = program.command("budget").description("Inspect and set spend budgets");

budget
  .command("status")
  .description("Show configured budgets with spend and remaining headroom")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { gatewayUrl: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const rows = await client.call<
        {
          scope: string;
          scopeRef: string;
          window: string;
          limitUsd: number;
          spentUsd: number;
          remainingUsd: number;
          action: string;
        }[]
      >("gin.budget.status");
      if (rows.length === 0) {
        console.log("No budgets configured. Set one with `gin budget set --limit <usd>`.");
        return;
      }
      for (const b of rows) {
        console.log(
          `${b.scope}/${b.window}  ${b.scopeRef}  limit $${b.limitUsd.toFixed(2)}  ` +
            `spent $${b.spentUsd.toFixed(4)}  remaining $${b.remainingUsd.toFixed(4)}  [${b.action}]`,
        );
      }
    } finally {
      client.close();
    }
  });

budget
  .command("set")
  .description("Create or update a budget (defaults to the default agent, daily window)")
  .requiredOption("--limit <usd>", "limit in USD")
  .option("--scope <scope>", "agent | tenant | session | pipeline | apiKey", "agent")
  .option("--ref <scopeRef>", "scope reference (defaults for agent/tenant)")
  .option("--window <window>", "session | hour | day | week | month", "day")
  .option("--action <action>", "block | degrade | alert", "block")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(
    async (opts: {
      limit: string;
      scope: string;
      ref?: string;
      window: string;
      action: string;
      gatewayUrl: string;
    }) => {
      const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
      try {
        const row = await client.call<{ scope: string; scopeRef: string; limitUsd: number }>(
          "gin.budget.set",
          {
            scope: opts.scope,
            ...(opts.ref !== undefined ? { scopeRef: opts.ref } : {}),
            limitUsd: Number(opts.limit),
            window: opts.window,
            action: opts.action,
          },
        );
        console.log(`Budget set: ${row.scope} ${row.scopeRef} → $${row.limitUsd.toFixed(2)}`);
      } finally {
        client.close();
      }
    },
  );

const approvals = program.command("approvals").description("Review and decide approval requests");

approvals
  .command("list")
  .description("List pending approval requests")
  .option("--all", "include decided/expired requests")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { all?: boolean; gatewayUrl: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const rows = await client.call<
        {
          id: string;
          action: string;
          riskLevel: string;
          status: string;
          params: unknown;
          requestedAt: number;
        }[]
      >("gin.approval.list", { all: opts.all === true });
      if (rows.length === 0) {
        console.log(opts.all ? "No approval requests." : "No pending approvals.");
        return;
      }
      for (const a of rows) {
        const age = ((Date.now() - a.requestedAt) / 1000).toFixed(0);
        console.log(
          `${a.id}  ${a.status.padEnd(8)}  ${a.riskLevel.padEnd(8)}  ${a.action}  ` +
            `${JSON.stringify(a.params).slice(0, 80)}  (${age}s ago)`,
        );
      }
    } finally {
      client.close();
    }
  });

function decideCommand(decision: "approved" | "denied", verb: string) {
  approvals
    .command(`${verb} <approvalId>`)
    .description(`${verb === "approve" ? "Approve" : "Deny"} a pending request`)
    .option("--reason <reason>", "recorded with the decision")
    .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
    .action(async (approvalId: string, opts: { reason?: string; gatewayUrl: string }) => {
      const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
      try {
        const record = await client.call<{ id: string; status: string; action: string }>(
          "gin.approval.decide",
          {
            approvalId,
            decision,
            ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          },
        );
        console.log(`${record.action} → ${record.status}`);
      } finally {
        client.close();
      }
    });
}
decideCommand("approved", "approve");
decideCommand("denied", "deny");

program
  .command("audit")
  .description("List the append-only audit log")
  .option("--actor <actor>", "filter by actor")
  .option("--action <action>", "filter by action")
  .option("--limit <n>", "max entries", "50")
  .option("--gateway-url <url>", "gateway base URL", "http://127.0.0.1:18789")
  .action(async (opts: { actor?: string; action?: string; limit: string; gatewayUrl: string }) => {
    const client = await GatewayClient.connect(gatewayWsUrl(opts.gatewayUrl));
    try {
      const rows = await client.call<
        { actor: string; action: string; target: string; after?: unknown; createdAt: number }[]
      >("gin.audit.list", {
        ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
        ...(opts.action !== undefined ? { action: opts.action } : {}),
        limit: Number(opts.limit),
      });
      if (rows.length === 0) {
        console.log("Audit log is empty.");
        return;
      }
      for (const e of rows) {
        const when = new Date(e.createdAt).toISOString();
        console.log(
          `${when}  ${e.actor.padEnd(10)}  ${e.action.padEnd(18)}  ${e.target}` +
            (e.after !== undefined ? `  ${JSON.stringify(e.after)}` : ""),
        );
      }
    } finally {
      client.close();
    }
  });

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
