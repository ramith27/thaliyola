import { describe, expect, it } from "vitest";
import { ARTICLE_TEMPLATES, SECTION_HINTS, stripHints, templateFor } from "../src/core/templates.js";

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
