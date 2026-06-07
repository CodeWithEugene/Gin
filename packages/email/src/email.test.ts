import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolContext } from "@gin/tools";
import {
  EmailService,
  type EmailFull,
  type EmailSummary,
  type ImapPort,
  type SmtpPort,
} from "./service.js";
import { registerEmailTools } from "./tools.js";

const SUMMARY: EmailSummary = {
  uid: 7,
  from: "boss@corp.example",
  subject: "Q3 numbers",
  date: "2026-06-07T08:00:00.000Z",
  seen: false,
};
const FULL: EmailFull = { ...SUMMARY, to: "me@corp.example", text: "Please review by Friday." };

let imap: { list: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
let smtp: { send: ReturnType<typeof vi.fn> };
let service: EmailService;

beforeEach(() => {
  imap = { list: vi.fn().mockResolvedValue([SUMMARY]), read: vi.fn().mockResolvedValue(FULL) };
  smtp = { send: vi.fn().mockResolvedValue(undefined) };
  service = new EmailService({
    imap: imap as unknown as ImapPort,
    smtp: smtp as unknown as SmtpPort,
    from: "gin@corp.example",
  });
});

describe("EmailService", () => {
  it("lists and reads through the imap port", async () => {
    await expect(service.list("INBOX", 5, true)).resolves.toEqual([SUMMARY]);
    expect(imap.list).toHaveBeenCalledWith("INBOX", { limit: 5, unseenOnly: true });
    await expect(service.read(7)).resolves.toEqual(FULL);
  });

  it("sends with the configured from address", async () => {
    await service.send("a@b.example", "hi", "body");
    expect(smtp.send).toHaveBeenCalledWith({
      from: "gin@corp.example",
      to: "a@b.example",
      subject: "hi",
      text: "body",
    });
  });

  it("enforces the outbound allowlist (exact and domain rules)", async () => {
    const guarded = new EmailService({
      imap: imap as unknown as ImapPort,
      smtp: smtp as unknown as SmtpPort,
      from: "gin@corp.example",
      allowSendTo: ["boss@corp.example", "@corp.example"],
    });
    await guarded.send("boss@corp.example", "ok", "x");
    await guarded.send("anyone@corp.example", "ok", "x");
    await expect(guarded.send("stranger@evil.example", "no", "x")).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(smtp.send).toHaveBeenCalledTimes(2);
  });
});

describe("email tools", () => {
  const ctx: ToolContext = { agentId: "a", sessionId: "s", workspacePath: "/tmp" };

  it("registers email.list/read/send and round-trips through the registry", async () => {
    const registry = registerEmailTools(new ToolRegistry(), service);
    expect(registry.list().map((t) => t.name)).toEqual(["email.list", "email.read", "email.send"]);

    const list = (await registry.execute("email.list", { unseenOnly: true }, ctx)) as {
      messages: EmailSummary[];
    };
    expect(list.messages[0]!.subject).toBe("Q3 numbers");

    const read = (await registry.execute("email.read", { uid: 7 }, ctx)) as EmailFull;
    expect(read.text).toContain("Friday");

    const sent = (await registry.execute(
      "email.send",
      { to: "a@b.example", subject: "re: Q3", body: "On it." },
      ctx,
    )) as { sent: boolean };
    expect(sent.sent).toBe(true);
  });

  it("marks email.send as high risk (approval-gate eligible)", () => {
    const registry = registerEmailTools(new ToolRegistry(), service);
    expect(registry.get("email.send")!.riskLevel).toBe("high");
    expect(registry.get("email.list")!.riskLevel).toBe("low");
  });

  it("validates recipients at the schema layer", async () => {
    const registry = registerEmailTools(new ToolRegistry(), service);
    await expect(
      registry.execute("email.send", { to: "not-an-email", subject: "x", body: "y" }, ctx),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
