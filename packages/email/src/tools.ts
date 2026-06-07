import { z } from "zod";
import type { ToolDefinition, ToolRegistry } from "@gin/tools";
import type { EmailService } from "./service.js";

/**
 * Email tools, created over a configured EmailService. email.send is
 * high-risk: with the approval threshold at "high" it pauses for a human —
 * an agent never mails anyone silently unless the operator opted into that.
 */

export function createEmailTools(service: EmailService): ToolDefinition[] {
  const emailList: ToolDefinition<
    z.ZodObject<{
      folder: z.ZodDefault<z.ZodString>;
      limit: z.ZodDefault<z.ZodNumber>;
      unseenOnly: z.ZodDefault<z.ZodBoolean>;
    }>
  > = {
    name: "email.list",
    description: "List recent emails (newest first) with uid, sender, subject, and read state.",
    toolset: "email",
    riskLevel: "low",
    paramsSchema: z.object({
      folder: z.string().default("INBOX"),
      limit: z.number().int().positive().max(50).default(10),
      unseenOnly: z.boolean().default(false),
    }),
    async execute(args) {
      return { messages: await service.list(args.folder, args.limit, args.unseenOnly) };
    },
  };

  const emailRead: ToolDefinition<
    z.ZodObject<{ uid: z.ZodNumber; folder: z.ZodDefault<z.ZodString> }>
  > = {
    name: "email.read",
    description: "Read one email in full by uid (from email.list).",
    toolset: "email",
    riskLevel: "low",
    paramsSchema: z.object({
      uid: z.number().int().positive(),
      folder: z.string().default("INBOX"),
    }),
    async execute(args) {
      return await service.read(args.uid, args.folder);
    },
  };

  const emailSend: ToolDefinition<
    z.ZodObject<{ to: z.ZodString; subject: z.ZodString; body: z.ZodString }>
  > = {
    name: "email.send",
    description:
      "Send an email from the operator's account. Outward-facing and irreversible — only send what the user explicitly asked for.",
    toolset: "email",
    riskLevel: "high",
    paramsSchema: z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
    }),
    async execute(args) {
      await service.send(args.to, args.subject, args.body);
      return { sent: true, to: args.to };
    },
  };

  return [emailList as ToolDefinition, emailRead as ToolDefinition, emailSend as ToolDefinition];
}

export function registerEmailTools(registry: ToolRegistry, service: EmailService): ToolRegistry {
  for (const tool of createEmailTools(service)) registry.register(tool);
  return registry;
}
