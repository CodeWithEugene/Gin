import { GinError } from "@gin/core";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills (spec Phase 4): one folder per skill under the skills dir, with a
 * SKILL.md whose frontmatter carries name/description/version. Progressive
 * disclosure keeps context lean — only metas ride in the system prompt; the
 * model pulls a full body with skills.read when the task calls for it, and
 * writes new ones with skills.save (self-improvement, audited as tool calls
 * like everything else).
 */

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  version: string;
  path: string;
}

export interface SkillDocument {
  meta: SkillMeta;
  body: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SkillStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  list(): SkillMeta[] {
    const entries = readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const metas: SkillMeta[] = [];
    for (const slug of entries) {
      const doc = this.tryRead(slug);
      if (doc) metas.push(doc.meta);
    }
    return metas;
  }

  read(slug: string): SkillDocument {
    const doc = this.tryRead(slug);
    if (!doc) throw new GinError("not_found", `No skill "${slug}" in ${this.dir}`);
    return doc;
  }

  save(input: { slug: string; name?: string; description: string; body: string }): SkillMeta {
    if (!SLUG_RE.test(input.slug)) {
      throw new GinError(
        "validation_failed",
        `Skill slug must match ${SLUG_RE} (lowercase, digits, dashes).`,
      );
    }
    const skillDir = join(this.dir, input.slug);
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    const existing = this.tryRead(input.slug);
    const version = existing ? bumpPatch(existing.meta.version) : "0.0.1";
    const name = input.name ?? existing?.meta.name ?? input.slug;
    const file = [
      "---",
      `name: ${name}`,
      `description: ${input.description.replace(/\n/g, " ")}`,
      `version: ${version}`,
      "---",
      "",
      input.body.trim(),
      "",
    ].join("\n");
    writeFileSync(path, file, "utf8");
    return { slug: input.slug, name, description: input.description, version, path };
  }

  /** Compact system-prompt section; full bodies stay out of context. */
  promptSection(): string {
    const metas = this.list();
    if (metas.length === 0) return "";
    return [
      "<available_skills>",
      "Call skills.read with a slug to load the full instructions before using one.",
      ...metas.map((m) => `- ${m.slug}: ${m.description}`),
      "</available_skills>",
    ].join("\n");
  }

  private tryRead(slug: string): SkillDocument | undefined {
    const path = join(this.dir, slug, "SKILL.md");
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(raw);
    return {
      meta: {
        slug,
        name: parsed.fields.name ?? slug,
        description: parsed.fields.description ?? "",
        version: parsed.fields.version ?? "0.0.1",
        path,
      },
      body: parsed.body,
    };
  }
}

/** Minimal "key: value" frontmatter between --- fences. No YAML dependency. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { fields: {}, body: raw.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: match[2]!.trim() };
}

function bumpPatch(version: string): string {
  const parts = version.split(".").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p))) return "0.0.1";
  return `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
}
