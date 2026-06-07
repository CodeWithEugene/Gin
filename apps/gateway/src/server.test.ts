import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createGateway, type Gateway } from "./server.js";

let gateway: Gateway;

beforeEach(async () => {
  gateway = createGateway({ port: 0 }); // ephemeral port
  await gateway.start();
});

afterEach(async () => {
  await gateway.stop();
});

function wsUrl(): string {
  return `ws://127.0.0.1:${gateway.address.port}/ws`;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function rpc(ws: WebSocket, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "res" && frame.id === id) {
        ws.off("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

describe("gateway", () => {
  it("boots and reports health over HTTP", async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.address.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; name: string };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("gin-gateway");
  });

  it("round-trips a WebChat echo over WS (Phase 0 acceptance)", async () => {
    const ws = await connect();
    const res = await rpc(ws, "gin.echo", { hello: "gin" });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ hello: "gin" });
    ws.close();
  });

  it("answers gin.ping and gin.status", async () => {
    const ws = await connect();
    const ping = await rpc(ws, "gin.ping");
    expect(ping.payload).toBe("pong");
    const status = await rpc(ws, "gin.status");
    expect((status.payload as Record<string, unknown>).name).toBe("gin-gateway");
    ws.close();
  });

  it("rejects malformed frames and unknown methods without crashing", async () => {
    const ws = await connect();

    const badJson = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      ws.send("not json at all");
    });
    expect(badJson.ok).toBe(false);

    const badFrame = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: "req", id: "x" })); // missing method
    });
    expect(badFrame.ok).toBe(false);
    expect((badFrame.error as Record<string, unknown>).code).toBe("validation_failed");

    const unknown = await rpc(ws, "gin.does.not.exist");
    expect(unknown.ok).toBe(false);
    expect((unknown.error as Record<string, unknown>).code).toBe("not_found");

    // Socket still alive after all three failures:
    const echo = await rpc(ws, "gin.echo", 42);
    expect(echo.payload).toBe(42);
    ws.close();
  });

  it("streams bus events to subscribers", async () => {
    const ws = await connect();
    await rpc(ws, "gin.events.subscribe");

    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "event" && frame.event.type === "test.signal") {
          ws.off("message", onMessage);
          resolve(frame.event);
        }
      };
      ws.on("message", onMessage);
    });

    gateway.bus.emit("test.signal", { value: 7 });
    const event = await eventPromise;
    expect((event.payload as Record<string, unknown>).value).toBe(7);
    ws.close();
  });
});
