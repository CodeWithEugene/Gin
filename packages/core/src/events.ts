import { newId } from "./ids.js";

/**
 * The internal event bus. Every subsystem publishes here; the observability
 * layer is a pure consumer (convention enforced in Section 11 of the spec:
 * no subsystem imports observability directly — they meet at this bus).
 *
 * Events are deliberately open-typed (`type: string`) so packages can define
 * their own event vocabularies without core knowing about every subsystem.
 * Well-known prefixes: gateway.*, channel.*, session.*, turn.*, step.*,
 * workflow.*, budget.*, approval.*, audit.*, memory.*, model.*.
 */

export interface GinEvent<T = unknown> {
  /** ULID — also serves as a stable cursor for the ring buffer. */
  id: string;
  /** Epoch millis. */
  ts: number;
  type: string;
  payload: T;
}

export type EventHandler<T = unknown> = (event: GinEvent<T>) => void;

export interface EventBusOptions {
  /** How many recent events to retain for live streaming / late subscribers. */
  ringBufferSize?: number;
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private ring: GinEvent[] = [];
  private readonly ringSize: number;

  constructor(opts: EventBusOptions = {}) {
    this.ringSize = opts.ringBufferSize ?? 1000;
  }

  emit<T>(type: string, payload: T): GinEvent<T> {
    const event: GinEvent<T> = { id: newId(), ts: Date.now(), type, payload };
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);

    for (const pattern of [type, "*"]) {
      const set = this.handlers.get(pattern);
      if (!set) continue;
      for (const handler of set) {
        try {
          handler(event);
        } catch {
          // A misbehaving subscriber must never break the publisher.
        }
      }
    }
    return event;
  }

  /** Subscribe to an exact event type, or "*" for everything. Returns an unsubscribe fn. */
  on<T = unknown>(type: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler);
    return () => {
      set.delete(handler as EventHandler);
      if (set.size === 0) this.handlers.delete(type);
    };
  }

  once<T = unknown>(type: string, handler: EventHandler<T>): () => void {
    const off = this.on<T>(type, (event) => {
      off();
      handler(event);
    });
    return off;
  }

  /** Recent events, optionally after a cursor (event id) — for late WS subscribers. */
  recent(opts: { afterId?: string; limit?: number } = {}): GinEvent[] {
    let events = this.ring;
    if (opts.afterId !== undefined) {
      const afterId = opts.afterId;
      events = events.filter((e) => e.id > afterId);
    }
    const limit = opts.limit ?? events.length;
    return events.slice(-limit);
  }
}
