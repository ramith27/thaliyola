import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../src/core/skills/types.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * A realistic import: a copy of the team's claude-skills repository (a Claude plugin marketplace with core/ guidance),
 * archived with `git archive` (ustar prefix entries included) and uploaded through the REST API into a database,
 * compared file by file with what the repository's own ci/sync_core.py stamps. Three broken skills are added to the
 * copy to check the rejections. Runs when SKILLS_PARITY_REPO points at a clone (and git and python3 with pyyaml are
 * there); skipped otherwise.
 */

const REPO = process.env.SKILLS_PARITY_REPO;
const missing = (() => {
  if (!REPO || !existsSync(path.join(REPO, "ci", "sync_core.py"))) return "SKILLS_PARITY_REPO isn't set to a claude-skills clone";
  if (spawnSync("git", ["--version"]).status !== 0) return "git isn't available";
  if (spawnSync("python3", ["-c", "import yaml"]).status !== 0) return "python3 with pyyaml isn't available";
  return null;
})();

let db: Db;
let app: TestApp;
let work: string;
let cleanSha: string;
let importedSha: string;
let report: any;
const expected = new Map<string, Buffer>(); // path → bytes after sync_core.py

function treeOf(root: string, rel = "", out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const n of readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(path.join(root, r));
    if (st.isDirectory()) treeOf(root, r, out);
    else if (st.isFile()) out.set(r, readFileSync(path.join(root, r)));
  }
  return out;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { maxBuffer: 256 * 1024 * 1024 });

beforeAll(async () => {
  if (missing) return;
  work = mkdtempSync(path.join(tmpdir(), "skills-real-"));
  const copy = path.join(work, "repo");
  cpSync(REPO!, copy, { recursive: true });
  cleanSha = git(copy, "rev-parse", "HEAD").toString().trim();
  // What sync_core.py makes of the committed tree (Python's own tarfile, not our reader).
  const tar = git(copy, "archive", "--format=tar", "--prefix=py/", "HEAD");
  const out = path.join(work, "out");
  mkdirSync(out);
  execFileSync("python3", ["-I", "-c", "import sys,tarfile,io; t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); t.extractall(sys.argv[1], **({'filter': 'tar'} if hasattr(tarfile, 'tar_filter') else {}))", out], { input: tar });
  execFileSync("python3", ["-I", path.join(out, "py", "ci", "sync_core.py"), "--root", path.join(out, "py")], { stdio: "ignore" });
  for (const [p, b] of treeOf(path.join(out, "py"))) expected.set(p, b);

  // Three broken skills, committed on top.
  const general = path.join(copy, "plugins", "im-general", "skills");
  const fm = (name: string) => `---\nname: ${name}\ndescription: Use when testing that the importer refuses a broken skill in a realistic repository import.\n---\n\n# Test\n`;
  mkdirSync(path.join(general, "leaky", "references"), { recursive: true });
  writeFileSync(path.join(general, "leaky", "SKILL.md"), fm("leaky"));
  writeFileSync(path.join(general, "leaky", "references", "creds.md"), `token: glpat-${"A1b2C3d4E5".repeat(3)}\n`);
  mkdirSync(path.join(general, "misnamed"));
  writeFileSync(path.join(general, "misnamed", "SKILL.md"), fm("other-name"));
  mkdirSync(path.join(general, "linky"));
  writeFileSync(path.join(general, "linky", "SKILL.md"), fm("linky"));
  symlinkSync("../hello-world/SKILL.md", path.join(general, "linky", "link.md"));
  git(copy, "add", "-A");
  git(copy, "commit", "-q", "-m", "broken skills");
  importedSha = git(copy, "rev-parse", "HEAD").toString().trim();
  const upload = gzipSync(git(copy, "archive", "--format=tar", `--prefix=claude-skills-${importedSha.slice(0, 7)}/`, "HEAD"));

  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
  const r = await app.raw("manager", "POST", "/api/skills/import/upload?filename=claude-skills.tar.gz&exclude=plugins/im-knowledge-base/**&no_deliver=evals/**,tasks/**", upload);
  expect(r.status, r.buf.toString("utf8").slice(0, 500)).toBe(200);
  expect(r.body.status, JSON.stringify(r.body.error)).toBe("done");
  report = r.body.report;
}, 180_000);
afterAll(async () => {
  if (missing) return;
  rmSync(work, { recursive: true, force: true });
  await app.close();
  await db.end();
});

describe.skipIf(!!missing)(`importing the real claude-skills repository${missing ? ` (skipped: ${missing})` : ""}`, () => {
  it("reads the marketplace: every plugin as a collection with its display name, description and connectors", async () => {
    expect(report.layout).toBe("marketplace");
    expect(report.commit).toBe(importedSha);
    const market = JSON.parse(readFileSync(path.join(REPO!, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins: { name: string; displayName?: string; description?: string }[] };
    expect(report.collections.map((c: { slug: string }) => c.slug).sort()).toEqual(market.plugins.map((p) => p.name).sort());
    expect(report.collections.filter((c: { connectors: unknown[] }) => c.connectors.length).length).toBe(8);
    const rows = (await db.query<{ slug: string; name: string; description: string; connectors: unknown[] }>("SELECT slug, name, description, connectors FROM skill_collections ORDER BY slug")).rows;
    // im-knowledge-base is excluded entirely, so no collection is created for it.
    expect(rows.map((r) => r.slug)).toEqual(market.plugins.map((p) => p.name).filter((n) => n !== "im-knowledge-base").sort());
    for (const r of rows) {
      const p = market.plugins.find((x) => x.name === r.slug)!;
      if (p.displayName) expect(r.name).toBe(p.displayName);
      if (p.description) expect(r.description).toBe(p.description);
    }
    expect(report.suggested_excludes).toEqual(["plugins/im-knowledge-base/**"]);
    expect(report.excluded.map((e: { path: string }) => e.path).sort()).toEqual(["plugins/im-knowledge-base/skills/admin-skills", "plugins/im-knowledge-base/skills/prod-ops-skills", "plugins/im-knowledge-base/skills/thaliyola"]);
  });

  it("imports every other skill as pending v1 and rejects the three broken ones with reasons", async () => {
    expect(report.added).toHaveLength(37);
    expect(report.added.every((a: { state: string; version: number }) => a.state === "pending" && a.version === 1)).toBe(true);
    const reasons = Object.fromEntries(report.rejected.map((r: { name: string; reasons: string[] }) => [r.name, r.reasons.join(" | ")]));
    expect(Object.keys(reasons).sort()).toEqual(["leaky", "linky", "misnamed"]);
    expect(reasons.leaky).toMatch(/GitLab token/);
    expect(reasons.misnamed).toMatch(/name 'other-name' must equal the directory name 'misnamed'/);
    expect(reasons.linky).toMatch(/symlinks are not allowed/);
    const versions = (await db.query("SELECT count(*)::int AS n, count(DISTINCT source_commit)::int AS commits, min(source_commit) AS commit FROM skill_versions")).rows[0];
    expect(versions).toEqual({ n: 37, commits: 1, commit: importedSha });
  });

  it("stores every file of every skill exactly as ci/sync_core.py stamps it", async () => {
    const skills = (await db.query<{ name: string; dir: string }>("SELECT s.name, c.slug AS plugin FROM skills s JOIN skill_collections c ON c.id = s.collection_id")).rows as unknown as { name: string; plugin: string }[];
    let compared = 0;
    let managed = 0;
    for (const s of skills) {
      const dir = `plugins/${s.plugin}/skills/${s.name}`;
      const want = [...expected].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, b]) => [p.slice(dir.length + 1), sha256(b)] as const).sort();
      const have = (
        await db.query<{ path: string; sha256: string; managed: boolean; deliver: boolean }>(
          "SELECT f.path, f.sha256, f.managed, f.deliver FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = $1 ORDER BY f.path COLLATE \"C\"",
          [s.name],
        )
      ).rows;
      expect(have.map((f) => [f.path, f.sha256]).sort(), dir).toEqual(want);
      for (const f of have) {
        if (/^(evals|tasks)\//.test(f.path)) expect(f.deliver, `${dir}/${f.path}`).toBe(false);
        if (f.managed) managed++;
      }
      compared += have.length;
    }
    expect(compared).toBeGreaterThan(300);
    expect(managed).toBeGreaterThan(50);
    // The report names what was stamped, matching the shared copies in the database.
    const stampedFiles = report.stamped.reduce((n: number, s: { files: string[] }) => n + s.files.length, 0);
    expect(stampedFiles).toBe(managed);
    // The committed tree has no stamps: the import added them.
    const committed = readFileSync(path.join(REPO!, "plugins", "im-analytics", "skills", "nhausa", "SKILL.md"));
    const stored = (await db.query("SELECT b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'nhausa' AND f.path = 'SKILL.md'")).rows[0].data as Buffer;
    expect(Buffer.compare(stored, expected.get("plugins/im-analytics/skills/nhausa/SKILL.md")!)).toBe(0);
    expect(Buffer.compare(stored, committed)).not.toBe(0);
    expect(cleanSha).not.toBe(importedSha);
  });

  it("flags what reviewers must see without rejecting the real repository's harmless matches", async () => {
    const flags = (await db.query<{ name: string; flags: { kind: string; path: string }[]; has_scripts: boolean }>("SELECT s.name, v.flags, v.has_scripts FROM skill_versions v JOIN skills s ON s.id = v.skill_id")).rows;
    const all = flags.flatMap((r) => r.flags.map((f) => `${r.name}:${f.kind}:${f.path}`));
    expect(all.some((f) => /:possible_secret:scripts\/offer_digest\.py$/.test(f))).toBe(true);
    expect(all.some((f) => /:personal_data:.*evals\.json$/.test(f))).toBe(true);
    expect(flags.find((r) => r.name === "ab-test-analysis")!.has_scripts).toBe(true);
    // No tool-id flag ever comes from a stamped copy.
    const managedPaths = new Set((await db.query<{ k: string }>("SELECT s.name || ':' || f.path AS k FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE f.managed")).rows.map((r) => r.k));
    for (const r of flags) for (const f of r.flags) if (f.kind === "tool_id") expect(managedPaths.has(`${r.name}:${f.path}`)).toBe(false);
  });

  it("re-imports the same archive as unchanged", async () => {
    const copy = path.join(work, "repo");
    const upload = gzipSync(git(copy, "archive", "--format=tar", `--prefix=claude-skills-${importedSha.slice(0, 7)}/`, "HEAD"));
    const r = await app.raw("manager", "POST", "/api/skills/import/upload?filename=claude-skills.tar.gz&exclude=plugins/im-knowledge-base/**&no_deliver=evals/**,tasks/**", upload);
    expect(r.body.report.unchanged).toHaveLength(37);
    expect(r.body.report.added).toEqual([]);
    expect(r.body.report.changed).toEqual([]);
  }, 60_000);
});
