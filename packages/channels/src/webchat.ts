import { GinError } from "@gin/core";
import type { ChannelAdapter, InboundHandler } from "./manager.js";

/**
 * WebChat is an in-process channel: the gateway's WS handler registers a
 * delivery callback per connected peer and forwards client frames to
 * `receive()`. Messages to disconnected peers stay queued in the outbox
 * (retryable failure) and flush when the peer reconnects — guaranteed
 * delivery applies to the local channel too.
 */

export type WebChatDeliver = (text: string) => Promise<void> | void;

export class WebChatAdapter implements ChannelAdapter {
  readonly kind = "webchat";
  private handler: InboundHandler | undefined;
  private readonly connections = new Map<string, WebChatDeliver>();

  constructor(readonly id: string = "webchat") {}

  start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.handler = undefined;
    this.connections.clear();
    return Promise.resolve();
  }

  /** Gateway: register a live client connection. Returns an unsubscribe fn. */
  connect(peerRef: string, deliver: WebChatDeliver): () => void {
    this.connections.set(peerRef, deliver);
    return () => {
      if (this.connections.get(peerRef) === deliver) this.connections.delete(peerRef);
    };
  }

  isConnected(peerRef: string): boolean {
    return this.connections.has(peerRef);
  }

  /** Gateway: feed an inbound client message into the channel pipeline. */
  async receive(msg: { peerRef: string; text: string; channelMessageId: string }): Promise<void> {
    if (!this.handler) throw new GinError("channel_error", "WebChat adapter not started.");
    await this.handler({ channelId: this.id, ...msg });
  }

  async send(peerRef: string, text: string): Promise<void> {
    const deliver = this.connections.get(peerRef);
    if (!deliver) {
      throw new GinError("delivery_failed", `WebChat peer "${peerRef}" not connected`, {
        retryable: true,
      });
    }
    await deliver(text);
  }
}
