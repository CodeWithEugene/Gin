#!/usr/bin/env node
import { GinConfigSchema, loadConfig, type GinConfig } from "@gin/config";
import { GinError } from "@gin/core";
import { buildStack } from "./stack.js";
import { createGateway } from "./server.js";

export { createGateway, type Gateway, type GatewayOptions } from "./server.js";
export { buildStack, ensureDefaultAgent, resolveSecret, type GatewayStack } from "./stack.js";
export * from "./protocol.js";

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  let config: GinConfig = GinConfigSchema.parse({
    agent: { model: "anthropic/claude-opus-4-8" },
  });
  try {
    config = loadConfig().config;
  } catch (err) {
    if (err instanceof GinError && err.details.missing === true) {
      console.error("No config found — starting with defaults (run `gin onboard` to configure).");
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  let port = config.gateway.port;
  const host = config.gateway.host;
  const portFlag = process.argv.indexOf("--port");
  if (portFlag !== -1 && process.argv[portFlag + 1]) port = Number(process.argv[portFlag + 1]);

  buildStack({ config })
    .then(async (stack) => {
      // Crash recovery: any workflow left 'running' resumes from its log.
      await stack.durable.resumeAll();
      const gateway = createGateway({ port, host, stack });
      await gateway.start();
      console.log(`gin-gateway listening on ws://${host}:${gateway.address.port}/ws`);
      console.log(
        `default agent "${stack.defaultAgent.name}" → ${stack.defaultAgent.modelConfig.primary}`,
      );

      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
          void gateway
            .stop()
            .then(() => stack.close())
            .then(() => process.exit(0));
        });
      }
    })
    .catch((err: unknown) => {
      console.error("Gateway failed to start:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
