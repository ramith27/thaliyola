import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import {
  contrast,
  designVersions,
  exportTokens,
  getDesignSystem,
  listDesignSystems,
  mergeTokens,
  recordDesignDecision,
  restoreDesignVersion,
  updateDesignSystem,
} from "../src/core/design.js";
import { getProjectContext } from "../src/core/projects.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });

const LIBRARY = {
  colors: [
    { name: "primary", value: "#2a78d6", dark: "#3987e5", role: "primary" as const, usage: "Buttons and links" },
    { name: "background", value: "#ffffff", dark: "#101418", role: "background" as const },
    { name: "text", value: "#1a2233", dark: "#e8ecf2", role: "text" as const },
    { name: "muted", value: "#c9ced6", role: "muted" as const },
  ],
  typography: { fonts: [{ role: "body" as const, family: "Inter, system-ui, sans-serif", weights: [400, 600] }], scale: [{ name: "body", size: "1rem", line_height: "1.5" }] },
  spacing: [
    { name: "2", value: "8px" },
    { name: "4", value: "16px" },
  ],
  radii: [{ name: "md", value: "8px" }],
};

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop" });
  await adminSetMember(a, "shop", "owner@example.com", "owner");
  await adminSetMember(a, "shop", "dev@example.com", "writer");
  await adminSetMember(a, "shop", "viewer@example.com", "reader");
});
afterAll(() => db.end());

describe("tokens", () => {
  it("merges by name, computes contrast, and exports CSS, Tailwind and W3C tokens", () => {
    const merged = mergeTokens(LIBRARY, { colors: [{ name: "Primary", value: "#7c3aed", role: "primary" }, { name: "brand-accent", value: "#f59e0b", role: "accent" }] });
    expect(merged.colors!.map((c) => `${c.name}:${c.value}`)).toEqual(["Primary:#7c3aed", "background:#ffffff", "text:#1a2233", "muted:#c9ced6", "brand-accent:#f59e0b"]);
    expect(merged.spacing).toHaveLength(2);
    expect(contrast("#000", "#ffffff")).toBe(21);
    expect(contrast("oklch(0.5 0.1 200)", "#fff")).toBeNull();
    const css = exportTokens(LIBRARY, "css").text;
    expect(css).toContain("--color-primary: #2a78d6;");
    expect(css).toContain("--font-body: Inter, system-ui, sans-serif;");
    expect(css).toMatch(/prefers-color-scheme: dark[\s\S]*--color-primary: #3987e5;/);
    const tw = exportTokens(LIBRARY, "tailwind").text;
    expect(tw).toContain('"primary": "var(--color-primary, #2a78d6)"');
    expect(tw).toContain('"sans": [');
    const w3c = JSON.parse(exportTokens(LIBRARY, "w3c").text);
    expect(w3c.color.primary).toMatchObject({ $value: "#2a78d6", $type: "color", $extensions: { "mode.dark": "#3987e5" } });
  });
});

describe("design systems", () => {
  it("lets library owners keep the shared system and project writers keep theirs", async () => {
    await expect(updateDesignSystem(await as("dev@example.com"), "library", { tokens: LIBRARY })).rejects.toThrow(/owners and admins/);
    const r = await updateDesignSystem(await as("admin@example.com"), "library", { tokens: LIBRARY, principles: "- Primary for one action per screen", source: "design-system@abc:tokens.css" });
    // Muted grey on white fails AA, and this blue just misses it (4.42:1).
    expect(r).toMatchObject({ version: 1, colors: 4 });
    expect(r.contrast_failures.map((c) => `${c.name}:${c.ratio}`)).toEqual(["primary:4.42", "muted:1.58"]);
    await expect(updateDesignSystem(await as("viewer@example.com"), "shop", { tokens: { colors: [] } })).rejects.toThrow(/include Propose/);
    await expect(updateDesignSystem(await as("dev@example.com"), "shop", { tokens: { colors: [{ name: "primary", value: "blue-ish" }] } })).rejects.toThrow(/colors\.0\.value/);
    await expect(updateDesignSystem(await as("dev@example.com"), "shop", { tokens: { spacing: [{ name: "x", value: "16 pixels" }] } })).rejects.toThrow(/a size is/);
  });

  it("builds a project on the library's system and overrides only what differs", async () => {
    const dev = await as("dev@example.com");
    await updateDesignSystem(dev, "shop", {
      based_on: "library",
      tokens: { colors: [{ name: "primary", value: "#7c3aed", dark: "#a78bfa", role: "primary" }], components: [{ name: "PriceTag", description: "Price with currency", path: "src/ui/PriceTag.tsx" }] },
      principles: "- Prices always show the currency",
    });
    const d = await getDesignSystem(await as("viewer@example.com"), "shop");
    expect(d).toMatchObject({ exists: true, based_on: { slug: "library" }, inherited_from: ["library"], can_edit: false });
    expect(d.tokens.colors!.find((c) => c.name === "primary")!.value).toBe("#7c3aed");
    expect(d.tokens.colors!.find((c) => c.name === "text")!.value).toBe("#1a2233");
    expect(d.tokens.typography!.fonts![0]!.family).toContain("Inter");
    expect(d.tokens.components).toHaveLength(1);
    expect(d.principles).toContain("Prices always show the currency");
    expect(d.principles).toContain("Primary for one action per screen");
    expect((await getDesignSystem(dev, "library")).used_by).toEqual([{ slug: "shop", name: "Shop" }]);
    // No loops.
    await expect(updateDesignSystem(await as("admin@example.com"), "library", { based_on: "shop" })).rejects.toThrow(/already based on/);
    expect((await listDesignSystems(dev)).systems.map((s: { slug: string }) => s.slug)).toEqual(["library", "shop"]);
  });

  it("keeps versions, restores one, and removes entries by name", async () => {
    const dev = await as("dev@example.com");
    await updateDesignSystem(dev, "shop", { remove: { components: ["PriceTag"] }, note: "PriceTag moved to library" });
    expect((await getDesignSystem(dev, "shop")).own_tokens.components).toEqual([]);
    const v = await designVersions(dev, "shop");
    expect(v.versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    await restoreDesignVersion(dev, "shop", 1);
    expect((await getDesignSystem(dev, "shop")).own_tokens.components).toHaveLength(1);
  });

  it("records design decisions, publishing for owners and proposing for writers, and shows them with the system", async () => {
    const own = await recordDesignDecision(await as("owner@example.com"), { project: "shop", title: "Violet primary to separate Shop from Admin", context: "Both apps used the same blue.", choice: "Shop uses violet #7c3aed as primary.", consequences: "Admin keeps the library blue." });
    expect(own).toMatchObject({ published: true });
    const proposed = await recordDesignDecision(await as("dev@example.com"), { project: "shop", title: "Rounded 8px cards", context: "Mixed radii.", choice: "Cards use radius md." });
    expect(proposed).toMatchObject({ status: "pending_review" });
    const d = await getDesignSystem(await as("dev@example.com"), "shop");
    expect(d.decisions.map((x: { title: string }) => x.title)).toContain("Violet primary to separate Shop from Admin");
    const ctx = (await getProjectContext(await as("viewer@example.com"), "shop")) as { design?: { colors: string[]; fonts: string[]; based_on: string; design_decisions: { title: string }[] } };
    expect(ctx.design!.colors[0]).toBe("primary (primary): #7c3aed / dark #a78bfa");
    expect(ctx.design!.based_on).toBe("library");
    expect(ctx.design!.design_decisions.map((x) => x.title)).toContain("Violet primary to separate Shop from Admin");
  });
});
