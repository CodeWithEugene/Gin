import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "@gin/tools";
import { SkillStore } from "./store.js";
import { registerSkillTools } from "./tools.js";

let dir: string;
let store: SkillStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gin-skills-"));
  store = new SkillStore(dir);
});

describe("SkillStore", () => {
  it("saves and reads a skill with frontmatter", () => {
    const meta = store.save({
      slug: "deploy-to-fly",
      description: "Deploy the app to Fly.io safely",
      body: "## Steps\n1. fly deploy --strategy canary",
    });
    expect(meta.version).toBe("0.0.1");

    const doc = store.read("deploy-to-fly");
    expect(doc.meta.name).toBe("deploy-to-fly");
    expect(doc.meta.description).toBe("Deploy the app to Fly.io safely");
    expect(doc.body).toContain("fly deploy");
  });

  it("bumps the patch version on update", () => {
    store.save({ slug: "s", description: "v1", body: "one" });
    const updated = store.save({ slug: "s", description: "v2", body: "two" });
    expect(updated.version).toBe("0.0.2");
    expect(store.read("s").body).toBe("two");
  });

  it("parses hand-written SKILL.md files", () => {
    mkdirSync(join(dir, "handmade"));
    writeFileSync(
      join(dir, "handmade", "SKILL.md"),
      "---\nname: Handmade\ndescription: Written by a human\nversion: 1.2.3\n---\n\nBody here.\n",
    );
    const doc = store.read("handmade");
    expect(doc.meta).toMatchObject({ name: "Handmade", version: "1.2.3" });
    expect(doc.body).toBe("Body here.");
  });

  it("rejects bad slugs and missing skills", () => {
    expect(() => store.save({ slug: "Bad Slug!", description: "x", body: "y" })).toThrow(/slug/);
    expect(() => store.read("nope")).toThrow(/No skill/);
  });

  it("renders the progressive-disclosure prompt section", () => {
    expect(store.promptSection()).toBe("");
    store.save({ slug: "a-skill", description: "Does A", body: "..." });
    const section = store.promptSection();
    expect(section).toContain("<available_skills>");
    expect(section).toContain("- a-skill: Does A");
    expect(section).not.toContain("..."); // bodies stay out of context
  });
});

describe("skill tools", () => {
  it("skills.read and skills.save round-trip through the registry", async () => {
    const registry = registerSkillTools(new ToolRegistry());
    const ctx: ToolContext = { agentId: "a", sessionId: "s", workspacePath: dir, skills: store };

    await registry.execute(
      "skills.save",
      { slug: "greet", description: "How to greet", body: "Say hi warmly." },
      ctx,
    );
    const result = (await registry.execute("skills.read", { slug: "greet" }, ctx)) as {
      instructions: string;
    };
    expect(result.instructions).toBe("Say hi warmly.");
  });

  it("fails cleanly without a skill store", async () => {
    const registry = registerSkillTools(new ToolRegistry());
    const ctx: ToolContext = { agentId: "a", sessionId: "s", workspacePath: dir };
    await expect(registry.execute("skills.read", { slug: "x" }, ctx)).rejects.toMatchObject({
      code: "tool_error",
    });
  });
});
