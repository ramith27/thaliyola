import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { checkDesignDrift, compareDesign, latestDrift, tokenKey, valueKey } from "../src/core/design-drift.js";
import { designSummary, updateDesignSystem } from "../src/core/design.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });

const stored = {
  colors: [
    { name: "primary", value: "#2563eb", dark: "#4f8cff", role: "primary" as const },
    { name: "background", value: "#ffffff", dark: "#0f172a", role: "background" as const },
    { name: "danger", value: "#b91c1c", role: "danger" as const },
  ],
  spacing: [{ name: "4", value: "16px" }, { name: "2", value: "8px" }],
  typography: { fonts: [{ role: "body" as const, family: "Inter, system-ui, sans-serif" }] },
};

describe("comparing", () => {
  it("normalises names and values as code spells them", () => {
    expect(tokenKey("--color-primary")).toBe("primary");
    expect(tokenKey("$colour-brand-accent")).toBe("brand-accent");
    expect(tokenKey("theme.colors.danger")).toBe("danger");
    expect(tokenKey("--space-4")).toBe("4");
    expect(valueKey("#FFF")).toBe("#ffffff");
    expect(valueKey("0.25rem")).toBe("4px");
    expect(valueKey("rgb(1, 2, 3)")).toBe("rgb(1,2,3)");
  });

  it("finds changed values (light and dark), missing and new tokens, and only for the kinds reported", () => {
    const r = compareDesign(stored, {
      tokens: {
        colors: [
          { name: "--color-primary", value: "#2563EB", dark: "#5b8cff" },
          { name: "--color-background", value: "#fff" },
          { name: "--color-brand-pink", value: "#ec4899" },
        ],
        fonts: [{ role: "body", family: '"Inter Variable", Inter, system-ui' }],
      },
    });
    expect(r.changed).toEqual([{ kind: "colors", name: "primary", stored: "#4f8cff", code: "#5b8cff", mode: "dark" }]);
    expect(r.missing_in_code).toEqual([{ kind: "colors", name: "danger", stored: "#b91c1c" }]);
    expect(r.new_in_code).toEqual([{ kind: "colors", name: "--color-brand-pink", code: "#ec4899" }]);
    // Spacing wasn't reported, so it isn't "missing"; the font stack still starts from Inter.
    expect(r.counts).toMatchObject({ changed: 1, missing_in_code: 1, new_in_code: 1, hardcoded: 0 });
    expect(compareDesign(stored, { tokens: { spacing: [{ name: "--space-4", value: "1rem" }, { name: "--space-2", value: "8px" }] } }).differences).toBe(0);
    expect(compareDesign(stored, { tokens: { fonts: [{ role: "body", family: "Roboto, sans-serif" }] } }).changed[0]).toMatchObject({ kind: "fonts", name: "body" });
  });

  it("points each hard-coded colour at the token it should use", () => {
    const r = compareDesign(stored, {
      tokens: {},
      hardcoded: [
        { value: "#2563eb", file: "src/Button.tsx", line: 12 },
        { value: "#2664ea", file: "src/Card.tsx", line: 3, count: 4 },
        { value: "#4f8cff", file: "src/Dark.tsx" },
        { value: "#ec4899", file: "src/Promo.tsx" },
        { value: "oklch(0.7 0.1 200)", file: "src/X.tsx" },
      ],
    });
    expect(r.hardcoded.map((h) => h.suggestion)).toEqual([
      "use the primary token (var(--color-primary))",
      "probably meant primary (#2563eb); use the token",
      "use the primary token (var(--color-primary))",
      "not in the palette: add it to the design system or use an existing colour",
      "not a colour that can be compared",
    ]);
    expect(r.counts.off_palette).toBe(1);
  });
});

describe("reports", () => {
  beforeAll(async () => {
    ({ db } = await freshDb());
    const a = await as("admin@example.com");
    await adminCreateProject(a, { slug: "shop", name: "Shop" });
    await adminSetMember(a, "shop", "writer@example.com", "writer");
    await adminSetMember(a, "shop", "viewer@example.com", "reader");
    await updateDesignSystem(a, "shop", { tokens: stored });
  });
  afterAll(() => db.end());

  it("stores the report for contributors, shows it to readers and in the project's design summary", async () => {
    const w = await as("writer@example.com");
    const r = await checkDesignDrift(w, "shop", { tokens: { colors: [{ name: "--color-primary", value: "#1d4ed8" }] }, hardcoded: [{ value: "#ec4899", file: "a.tsx" }], source: "repo@abc" });
    expect(r).toMatchObject({ in_sync: false, differences: 4, counts: { changed: 1, missing_in_code: 2, hardcoded: 1, off_palette: 1 } });
    const v = await as("viewer@example.com");
    await expect(checkDesignDrift(v, "shop", { tokens: {} })).rejects.toThrow(/Propose/);
    expect(await latestDrift(v, "shop")).toMatchObject({ differences: 4, source: "repo@abc", checked_by: "writer@example.com" });
    expect((await designSummary(v, "shop"))?.drift).toMatch(/1 values differ from the code, 1 hard-coded colours \(1 off the palette\)/);
    const ok = await checkDesignDrift(w, "shop", { tokens: { colors: stored.colors.map((c) => ({ name: c.name, value: c.value, dark: c.dark })) } });
    expect(ok.in_sync).toBe(true);
    expect((await designSummary(v, "shop"))?.drift).toMatch(/matched/);
  });

  it("refuses a project with no design system, and keeps the last 20 reports", async () => {
    const a = await as("admin@example.com");
    await adminCreateProject(a, { slug: "empty", name: "Empty" });
    await expect(checkDesignDrift(a, "empty", { tokens: {} })).rejects.toThrow(/no design system yet/);
    for (let i = 0; i < 22; i++) await checkDesignDrift(a, "shop", { tokens: {} });
    const n = (await db.query("SELECT count(*)::int AS n FROM design_drift_reports d JOIN scopes s ON s.id = d.scope_id WHERE s.slug = 'shop'")).rows[0].n;
    expect(n).toBe(20);
  });
});
