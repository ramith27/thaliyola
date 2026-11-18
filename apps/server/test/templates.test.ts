import { describe, expect, it } from "vitest";
import { ARTICLE_TEMPLATES, FINDING_GUIDES, SECTION_HINTS, stripHints, templateFor, writingGuide } from "../src/core/templates.js";

describe("template hints", () => {
  it("has a writing hint for every template section", () => {
    const missing = Object.values(ARTICLE_TEMPLATES).flat().filter((h) => !SECTION_HINTS[h]);
    expect(missing).toEqual([]);
  });

  it("adds hints only when asked, and strips them back to the plain skeleton", () => {
    const plain = templateFor("runbook");
    const hinted = templateFor("runbook", { hints: true });
    expect(plain).not.toContain("<!--");
    expect(hinted).toContain("<!-- Hint: Numbered checks");
    expect(stripHints(hinted)).toBe(plain);
    // Other HTML comments are the author's and stay.
    expect(stripHints("## Fix\n\n<!-- keep me -->\nRestart.")).toContain("<!-- keep me -->");
  });
});

describe("writing guide", () => {
  it("covers every article type's sections and every finding type's fields, with a checklist", () => {
    for (const type of Object.keys(ARTICLE_TEMPLATES)) {
      const g = writingGuide("article", type)!;
      expect(g.sections.map((s) => s.heading)).toEqual(ARTICLE_TEMPLATES[type]);
      expect(g.sections.every((s) => s.hint.length > 0)).toBe(true);
      expect(g.checklist.length).toBeGreaterThanOrEqual(3);
    }
    for (const type of ["incident", "rca", "known_issue", "data_gotcha", "query_recipe"]) {
      const g = writingGuide("finding", type)!;
      expect(g.sections.map((s) => s.heading)).toEqual(["Symptoms", "Root cause", "Fix or workaround"]);
      expect(g.checklist).toContain("The root cause is confirmed, not a guess");
    }
    expect(Object.keys(FINDING_GUIDES).sort()).toEqual(["data_gotcha", "incident", "known_issue", "query_recipe", "rca"]);
    // Free-form notes have no sections to fill, so no "every section" item.
    expect(writingGuide("article", "note")!.checklist.some((c) => /section/.test(c))).toBe(false);
    expect(writingGuide("article", "nope")).toBeNull();
    expect(writingGuide("finding", "runbook")).toBeNull();
  });
});
