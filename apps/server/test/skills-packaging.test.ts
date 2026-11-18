import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArchive } from "../src/core/skills/archive.js";
import { detectLayout, skillNameOf } from "../src/core/skills/layout.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * How people actually hand over a skill: Claude's "package skill" (<name>.skill, a zip of <name>/SKILL.md),
 * that file zipped again (<name>.skill.zip), a folder zipped inside another folder, or a misspelt skill.md.
 * Production import 2cc498e6 ("advertiser-analysis.skill.zip") failed with "no skills found".
 */

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Analyse advertiser performance when asked about advertiser revenue.\n---\n\n# ${name}\n\nSteps.\n`;
const zip = (files: Record<string, string | Uint8Array>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? strToU8(v) : v])) as never));
const layoutOf = (buf: Buffer, filename?: string) => {
  const tree = readArchive(buf, { gitignore: true });
  return detectLayout(tree.entries, { topName: tree.topName, filename: filename ?? null });
};

describe("finding skills in packaged uploads", () => {
  it("drops Claude's .skill suffix from names", () => {
    expect(skillNameOf("advertiser-analysis.skill")).toBe("advertiser-analysis");
    expect(skillNameOf("advertiser-analysis.skill.zip")).toBe("advertiser-analysis");
    expect(skillNameOf("dir/advertiser-analysis.zip")).toBe("advertiser-analysis");
    expect(skillNameOf("weekly-report")).toBe("weekly-report");
  });

  it("reads a Claude package: <name>/SKILL.md, or a folder named <name>.skill", () => {
    const pkg = layoutOf(zip({ "advertiser-analysis/SKILL.md": skillMd("advertiser-analysis"), "advertiser-analysis/references/metrics.md": "EPC" }), "advertiser-analysis.skill");
    expect(pkg).toMatchObject({ layout: "single", skills: [{ dir: "", name: "advertiser-analysis" }] });
    const suffixed = layoutOf(zip({ "advertiser-analysis.skill/SKILL.md": skillMd("advertiser-analysis") }));
    expect(suffixed).toMatchObject({ layout: "single", skills: [{ dir: "", name: "advertiser-analysis" }] });
    const loose = layoutOf(zip({ "SKILL.md": skillMd("advertiser-analysis") }), "advertiser-analysis.skill.zip");
    expect(loose).toMatchObject({ layout: "single", skills: [{ name: "advertiser-analysis" }] });
  });

  it("finds a skill folder zipped inside other folders, but not in hidden folders or node_modules", () => {
    const nested = layoutOf(zip({ "Downloads/skills-export/advertiser-analysis/SKILL.md": skillMd("advertiser-analysis"), "Downloads/notes.txt": "x" }));
    expect(nested.layout).toBe("folder");
    expect(nested.skills).toEqual([{ dir: "skills-export/advertiser-analysis", name: "advertiser-analysis", collection: "uploaded" }]);
    expect(nested.warnings.some((w) => /inside another folder/.test(w.message))).toBe(true);
    const hidden = layoutOf(zip({ "r/node_modules/pkg/x/SKILL.md": skillMd("x"), "r/.cache/y/SKILL.md": skillMd("y"), "r/readme.txt": "x" }));
    expect(hidden.layout).toBeNull();
  });

  it("says to rename a skill.md instead of finding nothing", () => {
    const r = layoutOf(zip({ "advertiser-analysis/skill.md": skillMd("advertiser-analysis") }));
    expect(r.layout).toBeNull();
    expect(r.rejected).toEqual([{ path: "skill.md", name: "advertiser-analysis", reasons: [expect.stringMatching(/rename skill\.md to SKILL\.md/)] }]);
  });
});

let db: Db;
let app: TestApp;
beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const upload = (zipBuf: Buffer, filename: string, q = "") => app.raw("manager", "POST", `/api/skills/import/upload?filename=${encodeURIComponent(filename)}${q}`, zipBuf);

describe("importing packaged skills", () => {
  it("imports a .skill file that was zipped again (advertiser-analysis.skill.zip)", async () => {
    const packaged = zip({ "advertiser-analysis/SKILL.md": skillMd("advertiser-analysis"), "advertiser-analysis/references/metrics.md": "EPC and RPI" });
    const r = await upload(zip({ "advertiser-analysis.skill": packaged }), "advertiser-analysis.skill.zip", "&dry_run=true");
    expect(r.status).toBe(200);
    expect(r.body.report.added.map((a: { name: string }) => a.name)).toEqual(["advertiser-analysis"]);
    expect(r.body.report.warnings.some((w: { path: string; message: string }) => w.path === "advertiser-analysis.skill" && /opened as the folder advertiser-analysis\//.test(w.message))).toBe(true);
  });

  it("imports a .skill file uploaded as it is, and a zip of several .skill files", async () => {
    const one = await upload(zip({ "advertiser-analysis/SKILL.md": skillMd("advertiser-analysis") }), "advertiser-analysis.skill", "&dry_run=true");
    expect(one.status).toBe(200);
    expect(one.body.report.added.map((a: { name: string }) => a.name)).toEqual(["advertiser-analysis"]);
    const many = await upload(
      zip({ "a-one.skill": zip({ "a-one/SKILL.md": skillMd("a-one") }), "b-two.skill": zip({ "SKILL.md": skillMd("b-two") }) }),
      "two-skills.zip",
      "&dry_run=true",
    );
    expect(many.status).toBe(200);
    expect(many.body.report.added.map((a: { name: string }) => a.name).sort()).toEqual(["a-one", "b-two"]);
  });

  it("explains what it found when there is no skill, and refuses archives nested twice", async () => {
    const none = await upload(zip({ "notes/readme.txt": "hello", "notes/data.csv": "a,b" }), "notes.zip", "&dry_run=true");
    expect(none.body.status).toBe("failed");
    expect(none.body.error).toMatch(/A skill is a folder with a SKILL\.md file/);
    expect(none.body.error).toMatch(/The upload contains: data\.csv, readme\.txt/);
    const twice = await upload(zip({ "outer.zip": zip({ "inner.skill": zip({ "x/SKILL.md": skillMd("x") }) }) }), "twice.zip", "&dry_run=true");
    expect(twice.body.status).toBe("failed");
    expect(twice.body.error).toMatch(/no skills found/);
    const misspelt = await upload(zip({ "advertiser-analysis/Skill.md": skillMd("advertiser-analysis") }), "advertiser-analysis.zip", "&dry_run=true");
    expect(misspelt.body.status).toBe("failed");
    expect(misspelt.body.error).toMatch(/rename Skill\.md to SKILL\.md/);
  });
});
