import { describe, expect, it } from "vitest";
import { replaceSection, splitSections } from "../src/core/chunking.js";

describe("splitSections", () => {
  it("splits at # and ## headings and keeps deeper headings inside", () => {
    const md = "intro text\n\n## Purpose\nWhy.\n### Detail\nmore\n## Fix\nDo it.";
    expect(splitSections(md)).toEqual([
      { heading: "", text: "intro text" },
      { heading: "Purpose", text: "Why.\n### Detail\nmore" },
      { heading: "Fix", text: "Do it." },
    ]);
  });

  it("ignores headings inside fenced code", () => {
    const md = "## Example\n```sh\n# not a heading\n```\n## Next\nx";
    const sections = splitSections(md);
    expect(sections.map((s) => s.heading)).toEqual(["Example", "Next"]);
    expect(sections[0]!.text).toContain("# not a heading");
  });

  it("returns nothing for empty input", () => {
    expect(splitSections("   \n")).toEqual([]);
  });
});

describe("replaceSection", () => {
  const md = "## Purpose\nWhy.\n\n## Fix\nOld fix.\n\n## Verify\nCheck.";

  it("replaces one section and keeps the others", () => {
    expect(replaceSection(md, "fix", "New fix.")).toBe("## Purpose\nWhy.\n\n## Fix\n\nNew fix.\n\n## Verify\nCheck.");
  });

  it("appends to a section", () => {
    expect(replaceSection(md, "Fix", "- also this")).toContain("## Fix\n\n- also this");
    expect(replaceSection(md, "Fix", "- also this", "append")).toContain("## Fix\n\nOld fix.\n- also this\n");
  });

  it("adds a missing section at the end", () => {
    expect(replaceSection(md, "Known issues", "- one")).toBe(`${md}\n\n## Known issues\n\n- one\n`);
  });

  it("replaces the last section", () => {
    expect(replaceSection(md, "Verify", "Done.")).toBe("## Purpose\nWhy.\n\n## Fix\nOld fix.\n\n## Verify\n\nDone.\n");
  });
});
