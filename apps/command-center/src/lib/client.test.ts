import { describe, expect, it } from "vitest";
import { GatewayClient, type WsLike } from "./client.js";

class FakeWs implements WsLike {
  sent: string[] = [];
  private listeners = new Map<string, ((event: never) => void)[]>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.fire("close", {});
  }
  addEventListener(type: string, cb: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event as never);
  }
  reply(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }
}

function connected(): { client: GatewayClient; ws: FakeWs } {
  const ws = new FakeWs();
  const client = new GatewayClient({
    url: "ws://test/ws",
    wsFactory: () => ws,
    reconnectDelayMs: 1,
  });
  client.connect();
  ws.fire("open", {});
  return { client, ws };
}

describe("GatewayClient", () => {
  it("subscribes to events on connect and routes RPC responses by id", async () => {
    const { client, ws } = connected();
    // First frame is the auto-subscribe.
    const sub = JSON.parse(ws.sent[0]!);
    expect(sub.method).toBe("gin.events.subscribe");

    const promise = client.call<{ pong: boolean }>("gin.ping");
    const req = JSON.parse(ws.sent[1]!);
    ws.reply({ type: "res", id: req.id, ok: true, payload: { pong: true } });
    await expect(promise).resolves.toEqual({ pong: true });
  });

  it("rejects RPC errors with code and message", async () => {
    const { client, ws } = connected();
    const promise = client.call("gin.budget.set", {});
    const req = JSON.parse(ws.sent[1]!);
    ws.reply({
      type: "res",
      id: req.id,
      ok: false,
      error: { code: "permission_denied", message: "nope" },
    });
    await expect(promise).rejects.toThrow(/permission_denied: nope/);
  });

  it("fans bus events out to listeners", () => {
    const { client, ws } = connected();
    const seen: string[] = [];
    client.onEvent((e) => seen.push(e.type));
    ws.reply({ type: "event", event: { id: "1", ts: 1, type: "turn.completed", payload: {} } });
    ws.reply({ type: "event", event: { id: "2", ts: 2, type: "budget.spend", payload: {} } });
    expect(seen).toEqual(["turn.completed", "budget.spend"]);
  });

  it("rejects pending calls and reports state on disconnect", async () => {
    const { client, ws } = connected();
    const states: string[] = [];
    client.onState((s) => states.push(s));
    const promise = client.call("gin.trace.list");
    client.stop();
    ws.close();
    await expect(promise).rejects.toThrow(/disconnected/);
    expect(states).toContain("closed");
    expect(client.getState()).toBe("closed");
  });

  it("refuses calls while disconnected", async () => {
    const ws = new FakeWs();
    const client = new GatewayClient({ url: "ws://t/ws", wsFactory: () => ws });
    await expect(client.call("gin.ping")).rejects.toThrow(/disconnected/);
  });
});
