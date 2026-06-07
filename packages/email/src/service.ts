import { GinError } from "@gin/core";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

/**
 * Email behind two small ports (spec Phase 4: IMAP/SMTP). The agent-facing
 * tools speak EmailService; the real ImapFlow/Nodemailer adapters live here
 * and the tests speak to fakes — protocol plumbing stays at the edge.
 */

export interface EmailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
}

export interface EmailFull extends EmailSummary {
  to: string;
  text: string;
}

export interface ImapPort {
  list(folder: string, opts: { limit: number; unseenOnly: boolean }): Promise<EmailSummary[]>;
  read(folder: string, uid: number): Promise<EmailFull>;
}

export interface SmtpPort {
  send(mail: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export interface EmailServiceOptions {
  imap: ImapPort;
  smtp: SmtpPort;
  /** From address for outbound mail. */
  from: string;
  /** Outbound allowlist; empty means any recipient. */
  allowSendTo?: string[];
}

export class EmailService {
  constructor(private readonly opts: EmailServiceOptions) {}

  list(folder = "INBOX", limit = 10, unseenOnly = false): Promise<EmailSummary[]> {
    return this.opts.imap.list(folder, { limit, unseenOnly });
  }

  read(uid: number, folder = "INBOX"): Promise<EmailFull> {
    return this.opts.imap.read(folder, uid);
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const allow = this.opts.allowSendTo ?? [];
    if (allow.length > 0) {
      const recipient = to.toLowerCase();
      const permitted = allow.some((entry) => {
        const rule = entry.toLowerCase();
        return rule.startsWith("@") ? recipient.endsWith(rule) : recipient === rule;
      });
      if (!permitted) {
        throw new GinError("permission_denied", `Recipient ${to} is not on the send allowlist.`);
      }
    }
    await this.opts.smtp.send({ from: this.opts.from, to, subject, text });
  }
}

// ── Real adapters ─────────────────────────────────────────────────────────────

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** One connection per call: simple, robust, fine at personal-mailbox rates. */
export class ImapFlowPort implements ImapPort {
  constructor(private readonly config: ImapConfig) {}

  private client(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });
  }

  async list(
    folder: string,
    opts: { limit: number; unseenOnly: boolean },
  ): Promise<EmailSummary[]> {
    const client = this.client();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const messages: EmailSummary[] = [];
        const range = opts.unseenOnly ? { seen: false } : "1:*";
        for await (const msg of client.fetch(range, { envelope: true, flags: true, uid: true })) {
          messages.push({
            uid: msg.uid,
            from: msg.envelope?.from?.[0]?.address ?? "",
            subject: msg.envelope?.subject ?? "",
            date: msg.envelope?.date?.toISOString() ?? "",
            seen: msg.flags?.has("\\Seen") ?? false,
          });
        }
        return messages.slice(-opts.limit).reverse(); // newest first
      } finally {
        lock.release();
      }
    } catch (err) {
      throw new GinError("tool_error", `IMAP list failed: ${(err as Error).message}`, {
        cause: err,
        retryable: true,
      });
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async read(folder: string, uid: number): Promise<EmailFull> {
    const client = this.client();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(
          String(uid),
          { envelope: true, source: true, flags: true },
          { uid: true },
        );
        if (!message || !message.source) {
          throw new GinError("not_found", `No message with uid ${uid} in ${folder}`);
        }
        const parsed = await simpleParser(message.source);
        return {
          uid,
          from: message.envelope?.from?.[0]?.address ?? "",
          to: message.envelope?.to?.map((a) => a.address).join(", ") ?? "",
          subject: message.envelope?.subject ?? "",
          date: message.envelope?.date?.toISOString() ?? "",
          seen: message.flags?.has("\\Seen") ?? false,
          text: (parsed.text ?? "").slice(0, 64 * 1024),
        };
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err instanceof GinError) throw err;
      throw new GinError("tool_error", `IMAP read failed: ${(err as Error).message}`, {
        cause: err,
        retryable: true,
      });
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export class NodemailerPort implements SmtpPort {
  constructor(private readonly config: SmtpConfig) {}

  async send(mail: { from: string; to: string; subject: string; text: string }): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
    });
    try {
      await transport.sendMail(mail);
    } catch (err) {
      throw new GinError("tool_error", `SMTP send failed: ${(err as Error).message}`, {
        cause: err,
        retryable: true,
      });
    }
  }
}
