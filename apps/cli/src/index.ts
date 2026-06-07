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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
