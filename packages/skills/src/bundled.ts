import type { SkillStore } from "./store.js";

/**
 * Skills that ship with Gin. Installed once into the operator's skill dir —
 * never overwritten afterwards, so local edits (human or agent) always win.
 */

export interface BundledSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
}

export const DEEP_RESEARCH_SKILL: BundledSkill = {
  slug: "deep-research",
  name: "Deep Research",
  description:
    "Multi-source web research with citations — use when the user asks to research, investigate, or compare anything beyond a single lookup.",
  body: `## Deep research procedure

1. **Decompose** the question into 2-4 concrete sub-questions before searching.
2. **Search wide**: run web.search once per sub-question with distinct phrasings.
   Collect candidate URLs across searches; prefer primary sources (docs, papers,
   official announcements) over aggregators.
3. **Read deep**: http.fetch the 3-6 most promising URLs. Extract the specific
   claims that answer the sub-questions. If a page contradicts another source,
   fetch a third to break the tie — do not silently pick one.
4. **Synthesize** a structured answer:
   - Lead with the direct answer, then the evidence.
   - Cite every non-obvious claim inline as [n], with a numbered source list
     (title — URL) at the end.
   - Flag uncertainty explicitly ("two sources disagree on…") instead of
     averaging it away.
5. **Store** durable findings the user will care about again with memory.store.

Rules:
- Never present a claim you did not see in a fetched page.
- Quote numbers exactly; include the source's date when freshness matters.
- If search yields nothing solid, say so and list what you tried.`,
};

export const BUNDLED_SKILLS: BundledSkill[] = [DEEP_RESEARCH_SKILL];

/** Install missing bundled skills; existing ones are left untouched. */
export function installBundledSkills(store: SkillStore): string[] {
  const existing = new Set(store.list().map((s) => s.slug));
  const installed: string[] = [];
  for (const skill of BUNDLED_SKILLS) {
    if (existing.has(skill.slug)) continue;
    store.save({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      body: skill.body,
    });
    installed.push(skill.slug);
  }
  return installed;
}
