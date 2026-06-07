import { GinError, toGinError, type EventBus } from "@gin/core";
import type { Outbox } from "./outbox.js";

/**
 * Channel plumbing: adapters bring messages in and take them out; the
 * manager owns dm-policy enforcement, inbound dedup, and pumping the outbox
 * through adapters with retry. The gateway wires `onInbound` to the runtime.
 */

export interface InboundMessage {
  channelId: string;
  /** Stable remote peer id (e.g. Telegram chat id). */
  peerRef: string;
  text: string;
  /** Channel-native message id, used for inbound dedup. */
  channelMessageId: string;
  displayName?: string;
}

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  /** Channel id this adapter serves (matches config key). */
  readonly id: string;
  readonly kind: string;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  /** Deliver one message; throw (retryable GinError) on transient failure. */
  send(peerRef: string, text: string): Promise<void>;
}

export interface DmPolicy {
  policy: "pairing" | "allowlist" | "open";
  allowFrom: string[];
}

export interface ChannelManagerOptions {
  outbox: Outbox;
  bus: EventBus;
  /** Called for accepted inbound messages — wired to the agent runtime. */
  onInbound: InboundHandler;
  dmPolicies?: Record<string, DmPolicy>;
}

export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly outbox: Outbox;
  private readonly bus: EventBus;
  private readonly onInbound: InboundHandler;
  private readonly dmPolicies: Record<string, DmPolicy>;
  private pumpTimer: NodeJS.Timeout | undefined;

  constructor(opts: ChannelManagerOptions) {
    this.outbox = opts.outbox;
    this.bus = opts.bus;
    this.onInbound = opts.onInbound;
    this.dmPolicies = opts.dmPolicies ?? {};
  }

  async register(adapter: ChannelAdapter): Promise<void> {
    if (this.adapters.has(adapter.id)) {
      throw new GinError("config_invalid", `Channel "${adapter.id}" already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
    await adapter.start((msg) => this.handleInbound(msg));
    this.bus.emit("channel.connected", { channelId: adapter.id, kind: adapter.kind });
  }

  async stop(): Promise<void> {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
      this.bus.emit("channel.disconnected", { channelId: adapter.id });
    }
    this.adapters.clear();
  }

  /** Queue an outbound message; delivery happens on the next tick. */
  send(channelId: string, peerRef: string, text: string, idempotencyKey?: string): string {
    const id = this.outbox.enqueue({
      channelId,
      peerRef,
      body: text,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    this.bus.emit("message.queued", { outboxId: id, channelId, peerRef });
    return id;
  }

  /** Drive queued deliveries; call on an interval (startPump) or in tests. */
  async tick(now = Date.now()): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const entry of this.outbox.claimDue(now)) {
      const adapter = this.adapters.get(entry.channelId);
      if (!adapter) {
        const status = this.outbox.markFailed(entry.id, "channel not connected", now);
        failed++;
        if (status === "dead_letter") this.emitDeadLetter(entry.id, entry.channelId);
        continue;
      }
      try {
        await adapter.send(entry.peerRef, entry.body);
        this.outbox.markDelivered(entry.id, now);
        delivered++;
        this.bus.emit("message.delivered", {
          outboxId: entry.id,
          channelId: entry.channelId,
          peerRef: entry.peerRef,
          attempts: entry.attempts + 1,
        });
      } catch (err) {
        const ginError = toGinError(err, "delivery_failed");
        const status = this.outbox.markFailed(entry.id, ginError.message, now);
        failed++;
        if (status === "dead_letter") this.emitDeadLetter(entry.id, entry.channelId);
      }
    }
    return { delivered, failed };
  }

  startPump(intervalMs = 500): void {
    this.pumpTimer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.pumpTimer.unref?.();
  }

  private async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.outbox.markInboundSeen(msg.channelId, msg.channelMessageId)) return; // duplicate
    if (!this.permitted(msg)) {
      this.bus.emit("channel.rejected", { channelId: msg.channelId, peerRef: msg.peerRef });
      this.send(
        msg.channelId,
        msg.peerRef,
        "This agent only talks to paired contacts. Ask the operator to add you.",
        `pairing-reject:${msg.channelId}:${msg.peerRef}`,
      );
      return;
    }
    this.bus.emit("message.received", {
      channelId: msg.channelId,
      peerRef: msg.peerRef,
      channelMessageId: msg.channelMessageId,
    });
    await this.onInbound(msg);
  }

  private permitted(msg: InboundMessage): boolean {
    const dm = this.dmPolicies[msg.channelId] ?? { policy: "pairing", allowFrom: [] };
    switch (dm.policy) {
      case "open":
        return true;
      case "allowlist":
      case "pairing":
        // Pairing-code exchange lands in Phase 3 governance; until then a
        // pairing channel behaves as an operator-managed allowlist.
        return dm.allowFrom.includes(msg.peerRef);
    }
  }

  private emitDeadLetter(outboxId: string, channelId: string): void {
    this.bus.emit("message.dead_letter", { outboxId, channelId });
  }
}
