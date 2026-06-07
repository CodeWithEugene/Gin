#!/usr/bin/env node
import { loadConfig } from "@gin/config";
import { GinError } from "@gin/core";
import { createGateway } from "./server.js";

export { createGateway, type Gateway, type GatewayOptions } from "./server.js";
export * from "./protocol.js";

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  let port = 18789;
  let host = "127.0.0.1";
  try {
    const { config } = loadConfig();
    port = config.gateway.port;
    host = config.gateway.host;
  } catch (err) {
    if (err instanceof GinError && err.details.missing === true) {
      console.error("No config found — starting with defaults (run `gin onboard` to configure).");
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const portFlag = process.argv.indexOf("--port");
  if (portFlag !== -1 && process.argv[portFlag + 1]) port = Number(process.argv[portFlag + 1]);

  const gateway = createGateway({ port, host });
  gateway
    .start()
    .then(() => {
      console.log(`gin-gateway listening on ws://${host}:${gateway.address.port}/ws`);
    })
    .catch((err: unknown) => {
      console.error("Gateway failed to start:", err instanceof Error ? err.message : err);
      process.exit(1);
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void gateway.stop().then(() => process.exit(0));
    });
  }
}
