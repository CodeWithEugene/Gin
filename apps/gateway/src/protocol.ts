import { z } from "zod";

/**
 * The Gateway WS protocol. Three frame kinds:
 *   req   client → gateway   { type:"req", id, method, params }
 *   res   gateway → client   { type:"res", id, ok, payload | error }
 *   event gateway → client   { type:"event", event: GinEvent }  (bus fan-out for subscribers)
 *
 * Method namespaces follow the spec: gin.session.*, gin.agent.*, gin.channel.*,
 * gin.node.*, gin.budget.*, gin.trace.*. Phase 0 implements the control-plane
 * basics: gin.ping, gin.echo, gin.status, gin.events.subscribe.
 */

export const RequestFrameSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface EventFrame {
  type: "event";
  event: { id: string; ts: number; type: string; payload: unknown };
}

export type ServerFrame = ResponseFrame | EventFrame;

export function ok(id: string, payload?: unknown): ResponseFrame {
  return { type: "res", id, ok: true, payload };
}

export function fail(id: string, code: string, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}
