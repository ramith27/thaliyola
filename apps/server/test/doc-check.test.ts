import { describe, expect, it } from "vitest";
import { docsStatus, parsePatch, rangeOutcome, type DocsCheck } from "../src/core/doc-check.js";

// Old file lines 1..20. The diff adds two lines after line 3, changes line 12, and deletes line 18.
const patch = [
  "@@ -2,3 +2,5 @@ import x",
  " line2",
  " line3",
  "+added a",
  "+added b",
  " line4",
  "@@ -11,3 +13,3 @@ function f() {",
  " line11",
  "-line12",
  "+line12 changed",
  " line13",
  "@@ -17,3 +19,2 @@",
  " line17",
  "-line18",
  " line19",
].join("\n");

describe("reading a diff", () => {
  const h = parsePatch(patch);
  it("finds deleted lines and where lines were added, in old-file numbers", () => {
    expect(h.deleted).toEqual([12, 18]);
    expect(h.insertedAfter).toEqual([3, 3, 12]);
  });

  it("says whether a cited range changed, or only moved", () => {
    expect(rangeOutcome(h, 1, 3)).toEqual({ changed: false, shift: 0 });
    expect(rangeOutcome(h, 5, 9)).toEqual({ changed: false, shift: 2 });
    expect(rangeOutcome(h, 10, 14).changed).toBe(true);
    expect(rangeOutcome(h, 14, 16)).toEqual({ changed: false, shift: 2 });
    expect(rangeOutcome(h, 18, 18).changed).toBe(true);
    expect(rangeOutcome(h, 19, 20)).toEqual({ changed: false, shift: 1 });
    // Added lines between two cited lines change the range; added right after it don't.
    expect(rangeOutcome(h, 2, 4).changed).toBe(true);
    expect(rangeOutcome(h, 1, 3).changed).toBe(false);
  });

  it("handles a pure insertion hunk and a new file", () => {
    expect(parsePatch("@@ -5,0 +6,2 @@\n+a\n+b").insertedAfter).toEqual([5, 5]);
    expect(parsePatch("@@ -0,0 +1,2 @@\n+a\n+b").insertedAfter).toEqual([0, 0]);
  });
});

describe("the commit status", () => {
  const d = (x: Partial<DocsCheck>): DocsCheck => ({ facts: [], changed: 0, removed: 0, moved: 0, unknown: 0, ...x });
  it("passes when nothing needs a look, warns without blocking, blocks until acknowledged", () => {
    expect(docsStatus(d({ moved: 2 }), "block", null)).toMatchObject({ state: "success", description: expect.stringMatching(/follow the code/) });
    expect(docsStatus(d({ changed: 1 }), "warn", null)).toMatchObject({ state: "success", description: expect.stringMatching(/1 documented fact cite lines this changes \(1 changed\)/) });
    expect(docsStatus(d({ changed: 1, removed: 1 }), "block", null)).toMatchObject({ state: "failure", description: expect.stringMatching(/acknowledge/) });
    expect(docsStatus(d({ changed: 1 }), "block", "dana@example.com")).toMatchObject({ state: "success", description: expect.stringMatching(/acknowledged by dana@example.com/) });
  });
});
