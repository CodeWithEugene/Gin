import { describe, expect, it } from "vitest";
import { EventBus } from "./events.js";

describe("EventBus", () => {
  it("delivers events to exact-type subscribers", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on<{ n: number }>("test.event", (e) => seen.push(e.payload.n));
    bus.emit("test.event", { n: 1 });
    bus.emit("other.event", { n: 2 });
    expect(seen).toEqual([1]);
  });

  it("delivers all events to wildcard subscribers", () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.on("*", (e) => types.push(e.type));
    bus.emit("a", {});
    bus.emit("b", {});
    expect(types).toEqual(["a", "b"]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("x", () => count++);
    bus.emit("x", {});
    off();
    bus.emit("x", {});
    expect(count).toBe(1);
  });

  it("once fires exactly once", () => {
    const bus = new EventBus();
    let count = 0;
    bus.once("x", () => count++);
    bus.emit("x", {});
    bus.emit("x", {});
    expect(count).toBe(1);
  });

  it("a throwing subscriber does not break the publisher or other subscribers", () => {
    const bus = new EventBus();
    let delivered = false;
    bus.on("x", () => {
      throw new Error("bad subscriber");
    });
    bus.on("x", () => {
      delivered = true;
    });
    expect(() => bus.emit("x", {})).not.toThrow();
    expect(delivered).toBe(true);
  });

  it("ring buffer retains recent events with cursor support", () => {
    const bus = new EventBus({ ringBufferSize: 3 });
    bus.emit("e1", {});
    const e2 = bus.emit("e2", {});
    bus.emit("e3", {});
    bus.emit("e4", {});
    const recent = bus.recent();
    expect(recent.map((e) => e.type)).toEqual(["e2", "e3", "e4"]);
    const after = bus.recent({ afterId: e2.id });
    expect(after.map((e) => e.type)).toEqual(["e3", "e4"]);
  });
});
