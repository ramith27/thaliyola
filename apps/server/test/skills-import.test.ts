import { readFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { enc, FIXTURES, fixtureFiles, startApp, zipOfFiles, type TestApp } from "./skills-helpers.js";

let db: Db;
let app: TestApp;
const settings = { ...TEST_SETTINGS };

beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, settings);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const upload = (who: string, zip: Buffer, q = "") => app.raw(who, "POST", `/api/skills/import/upload?filename=fixture.zip${q}`, zip);
const skillId = async (name: string) => (await db.query<{ id: string }>("SELECT id FROM skills WHERE name = $1", [name])).rows[0]!.id;
const EXCLUDE = "&exclude=plugins/im-knowledge-base/**&no_deliver=evals/**,tasks/**";

const ADDED = [
  "admin-tools",
  "already-stamped",
  "crlf-redshift",
  "dev-files",
  "hidden",
  "long-paths",
  "no-mention",
  "own-datasources",
  "placeholder-url",
  "plain-alpha",
  "scripts-skill",
  "tool-ids",
  "uses-tableau",
  "word-boundary",
];

describe("importing the fixture marketplace", () => {
  it("previews without writing: layout, rejections with reasons, suggested excludes", async () => {
    const r = await upload("manager", zipOfFiles(fixtureFiles()), "&dry_run=true");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("done");
    const rep = r.body.report;
    expect(rep.layout).toBe("marketplace");
    expect(rep.dry_run).toBe(true);
    expect(rep.suggested_excludes).toEqual(["plugins/im-knowledge-base/**"]);
    expect(rep.added.map((a: { name: string }) => a.name).sort()).toEqual([...ADDED, "admin-loader", "thaliyola"].sort());
    expect((await db.query("SELECT count(*)::int AS n FROM skills")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM skill_collections")).rows[0].n).toBe(0);
  });

  it("imports every valid skill as pending v1 with all its files, and reports what it refused and why", async () => {
    const r = await upload("manager", zipOfFiles(fixtureFiles()), EXCLUDE);
    expect(r.status).toBe(200);
    const rep = r.body.report;
    expect(rep.added.map((a: { name: string }) => a.name).sort()).toEqual(ADDED);
    expect(rep.added.every((a: { state: string; version: number }) => a.state === "pending" && a.version === 1)).toBe(true);
    expect(rep.excluded.map((e: { path: string }) => e.path).sort()).toEqual(["plugins/im-knowledge-base/skills/admin-loader", "plugins/im-knowledge-base/skills/thaliyola"]);
    const reasons = Object.fromEntries(rep.rejected.map((x: { name: string; reasons: string[] }) => [x.name, x.reasons.join(" | ")]));
    expect(reasons["bad-name"]).toMatch(/name 'other-name' must equal the directory name 'bad-name'/);
    expect(reasons["no-description"]).toMatch(/'description' is required/);
    expect(reasons["unknown-key"]).toMatch(/unknown frontmatter key 'owner'/);
    expect(reasons["xml-desc"]).toMatch(/must not contain XML\/HTML tags/);
    expect(reasons["has-secret"]).toMatch(/GitHub token/);
    expect(reasons["validate-ghp"]).toMatch(/looks like a GitHub token/);
    expect(reasons["validate-glpat"]).toMatch(/looks like a GitLab token/);
    expect(reasons["validate-skant"]).toMatch(/Anthropic API key/);
    expect(reasons["validate-pg"]).toMatch(/database URL with password/);
    expect(reasons["placeholder-postgres"]).toMatch(/database URL with password/);
    expect(reasons.smuggled).toMatch(/Unicode tag characters/);
    expect(reasons.collision).toMatch(/exists and is not a managed copy/);
    expect(reasons["bad-markers"]).toMatch(/duplicated or unbalanced/);
    expect(reasons.external).toMatch(/external plugin sources aren't imported/);
    expect(rep.warnings.some((w: { path: string; message: string }) => w.path === "plugins/stray" && /no entry in marketplace.json/.test(w.message))).toBe(true);
    expect(rep.warnings.some((w: { path: string; message: string }) => w.path === "plugins/gamma/.mcp.json" && /headers/.test(w.message))).toBe(true);
    // Collections keep the plugin's display name, description and connectors.
    const cols = Object.fromEntries(rep.collections.map((c: { slug: string }) => [c.slug, c]));
    expect(cols.alpha).toMatchObject({ name: "Alpha Analytics", created: true, connectors: [{ name: "tableau" }, { name: "warehouse" }] });
    expect(cols.gamma.connectors).toEqual([]);
    expect(rep.stamped.find((s: { name: string }) => s.name === "uses-tableau").files).toEqual(["connectors.md", "datasources.md", "table-knowledge.md"]);
    const row = (await db.query("SELECT name, description, connectors FROM skill_collections WHERE slug = 'alpha'")).rows[0];
    expect(row).toMatchObject({ name: "Alpha Analytics", description: "Alpha: data skills with connectors." });
    expect(row.connectors).toHaveLength(2);
    // The import is recorded, with an audit row.
    const imp = (await db.query("SELECT kind, status, layout, started_by FROM skill_imports WHERE id = $1", [r.body.import_id])).rows[0];
    expect(imp).toMatchObject({ kind: "upload", status: "done", layout: "marketplace", started_by: app.ids.manager });
    const a = (await db.query("SELECT details FROM audit_log WHERE tool = 'import_skills' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(a.details).toMatchObject({ added: ADDED.length, layout: "marketplace" });
  });

  it("stores every file of a skill byte for byte, stamps included, and marks reviewer-only files", async () => {
    const files = (await db.query("SELECT f.path, f.managed, f.deliver, f.kind, f.is_script FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = $1 ORDER BY f.path COLLATE \"C\"", ["uses-tableau"])).rows;
    expect(files.map((f) => [f.path, f.managed])).toEqual([
      ["SKILL.md", false],
      ["connectors.md", true],
      ["datasources.md", true],
      ["references/tables.md", false],
      ["table-knowledge.md", true],
    ]);
    const golden = readFileSync(path.join(FIXTURES, "marketplace.stamped/plugins/alpha/skills/uses-tableau/SKILL.md"));
    const stored = (await db.query("SELECT b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'uses-tableau' AND f.path = 'SKILL.md'")).rows[0].data;
    expect(Buffer.compare(stored, golden)).toBe(0);
    const dev = (await db.query("SELECT f.path, f.deliver FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'dev-files' ORDER BY f.path COLLATE \"C\"")).rows;
    expect(dev).toEqual([
      { path: "SKILL.md", deliver: true },
      { path: "connectors.md", deliver: true },
      { path: "evals/evals.json", deliver: false },
      { path: "tasks/lessons.md", deliver: false },
    ]);
    const long = (await db.query("SELECT f.path FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'long-paths' ORDER BY f.path")).rows.map((r) => r.path);
    expect(long.some((p: string) => p.endsWith("another-long-folder/notes.md"))).toBe(true);
    const meta = (await db.query("SELECT v.upstream_version, v.source_commit FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.name = 'uses-tableau'")).rows[0];
    expect(meta.upstream_version).toBe("2.1.0");
  });

  it("flags what a reviewer must look at", async () => {
    const flags = async (name: string) => (await db.query("SELECT v.flags, v.has_scripts, v.allowed_tools FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.name = $1", [name])).rows[0];
    const s = await flags("scripts-skill");
    expect(s.has_scripts).toBe(true);
    expect(s.allowed_tools).toBe("Bash(python3:*)");
    expect(s.flags.filter((f: { high_risk: boolean }) => f.high_risk).map((f: { kind: string }) => f.kind).sort()).toEqual(["allowed_tools", "scripts"]);
    expect((await flags("admin-tools")).flags).toContainEqual(expect.objectContaining({ kind: "admin_tools", high_risk: true, line: expect.any(Number) }));
    const hidden = (await flags("hidden")).flags.filter((f: { kind: string }) => f.kind === "hidden_text");
    expect(hidden.map((f: { message: string }) => f.message)).toEqual([expect.stringMatching(/zero-width.*U\+200B/), expect.stringMatching(/bidirectional.*U\+202E/), expect.stringMatching(/bidirectional.*U\+202C/), expect.stringMatching(/HTML comment/)]);
    const tools = (await flags("tool-ids")).flags.filter((f: { kind: string }) => f.kind === "tool_id");
    expect(tools.map((f: { path: string }) => f.path)).toEqual(["SKILL.md"]); // never the stamped connectors.md
    expect((await flags("placeholder-url")).flags).toContainEqual(expect.objectContaining({ kind: "possible_secret", high_risk: false }));
  });

  it("needs a second person to approve, and ticks for pre-approved tools and high-risk flags", async () => {
    const id = await skillId("scripts-skill");
    const own = await app.call("manager", "POST", `/api/skills/${id}/versions/1/approve`, { checked_tools: true, checked_flags: true });
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/someone else must approve/);
    const detail = await app.call("manager", "GET", `/api/skills/${id}`);
    expect(detail.body.can).toMatchObject({ review: true, approve: false, approve_hint: "Someone else must approve this (you proposed it)" });
    expect((await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, {})).body.error).toMatch(/pre-approves tools/);
    expect((await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, { checked_tools: true })).body.error).toMatch(/high-risk flags/);
    const ok = await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, { checked_tools: true, checked_flags: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ version: 1, state: "published" });
    // An Administrator who proposed something can't approve it either.
    const created = await app.call("admin", "POST", "/api/skills", { skill_md: "---\nname: admin-made\ndescription: Use when the administrator wants a hand-made skill for the fixture tests to check approval.\n---\n\n# Admin made\n", collection: "hand-made", summary: "New" });
    expect(created.status).toBe(200);
    expect((await app.call("admin", "POST", `/api/skills/${created.body.id}/versions/1/approve`, {})).status).toBe(403);
    // With "Let people approve their own skill versions" on, they can, and it's recorded.
    await db.query("INSERT INTO system_settings (key, value, updated_by) VALUES ('skills_self_approval', 'true', $1) ON CONFLICT (key) DO UPDATE SET value = 'true'", [app.ids.admin]);
    const self = await app.call("admin", "POST", `/api/skills/${created.body.id}/versions/1/approve`, {});
    expect(self.status).toBe(200);
    expect((await db.query("SELECT self_approved FROM skill_versions WHERE skill_id = $1", [created.body.id])).rows[0].self_approved).toBe(true);
    await db.query("DELETE FROM system_settings WHERE key = 'skills_self_approval'");
    expect((await db.query("SELECT details FROM audit_log WHERE tool = 'publish_skill_version' ORDER BY id DESC LIMIT 1")).rows[0].details).toMatchObject({ name: "admin-made", self_approved: true });
  });

  it("reports unchanged skills on a re-import, and proposes v2 only for what changed", async () => {
    // Publish plain-alpha first (a second person).
    const id = await skillId("plain-alpha");
    expect((await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, { checked_flags: true })).status).toBe(200);
    const again = await upload("manager", zipOfFiles(fixtureFiles()), EXCLUDE);
    expect(again.body.report.added).toEqual([]);
    expect(again.body.report.changed).toEqual([]);
    expect(again.body.report.unchanged).toHaveLength(ADDED.length);
    const edited = fixtureFiles((f) => f.set("plugins/alpha/skills/plain-alpha/SKILL.md", enc.encode(new TextDecoder().decode(f.get("plugins/alpha/skills/plain-alpha/SKILL.md")).replace("No data source", "Still no data source"))));
    const third = await upload("manager", zipOfFiles(edited), EXCLUDE);
    expect(third.body.report.changed).toEqual([expect.objectContaining({ name: "plain-alpha", from: 1, to: 2, state: "pending", guidance_only: false, files_changed: 1 })]);
    expect(third.body.report.unchanged).toHaveLength(ADDED.length - 1);
  });

  it("doesn't propose content a reviewer rejected, unless forced", async () => {
    const id = await skillId("plain-alpha");
    expect((await app.call("reviewer", "POST", `/api/skills/${id}/versions/2/reject`, { reason: "Wrong wording" })).status).toBe(200);
    const edited = fixtureFiles((f) => f.set("plugins/alpha/skills/plain-alpha/SKILL.md", enc.encode(new TextDecoder().decode(f.get("plugins/alpha/skills/plain-alpha/SKILL.md")).replace("No data source", "Still no data source"))));
    const again = await upload("manager", zipOfFiles(edited), EXCLUDE);
    expect(again.body.report.rejected_before).toEqual([{ name: "plain-alpha", version: 2, reason: "Wrong wording" }]);
    expect(again.body.report.changed).toEqual([]);
  });

  it("groups a shared-guidance change across skills", async () => {
    // Publish the skills that carry connectors.md, then change only the core guidance.
    for (const name of ["no-mention", "own-datasources"]) {
      const id = await skillId(name);
      await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, { checked_flags: true });
    }
    for (const name of ["uses-tableau", "crlf-redshift", "dev-files", "admin-tools", "tool-ids"]) {
      const id = await skillId(name);
      const r = await app.call("reviewer", "POST", `/api/skills/${id}/versions/1/approve`, { checked_flags: true, checked_tools: true });
      expect(r.status, name).toBe(200);
    }
    const edited = fixtureFiles((f) => {
      f.set("core/files/connectors.md", enc.encode("<!-- managed by ci/sync_core.py; edit core/files/connectors.md in the claude-skills repo -->\n# Connectors, revised\n"));
    });
    const r = await upload("manager", zipOfFiles(edited), EXCLUDE);
    const changed = r.body.report.changed.filter((c: { guidance_only: boolean }) => c.guidance_only).map((c: { name: string }) => c.name).sort();
    // Every published skill that carries connectors.md (plain-alpha's v1 and scripts-skill's included).
    expect(changed).toEqual(["admin-tools", "crlf-redshift", "dev-files", "plain-alpha", "scripts-skill", "tool-ids", "uses-tableau"]);
    const review = await app.call("reviewer", "GET", "/api/skills/review");
    const group = review.body.guidance_groups.find((g: { skills: unknown[] }) => g.skills.length === 7);
    expect(group).toBeTruthy();
    const counts = await app.call("reviewer", "GET", "/api/skills/review/counts");
    expect(counts.body.to_review).toBeGreaterThanOrEqual(7);
    const mine = await app.call("manager", "GET", "/api/skills/review/counts");
    expect(mine.body.to_review).toBeLessThan(counts.body.to_review); // the author's own versions don't count for them
    // The manager started the import, so they're its author: approving the group skips every one of theirs.
    const own = await app.call("manager", "POST", `/api/skills/review/guidance/${group.guidance_hash}/approve`, { checked_flags: true, checked_tools: true });
    expect(own.body.approved).toEqual([]);
    expect(own.body.skipped).toHaveLength(7);
    const approve = await app.call("reviewer", "POST", `/api/skills/review/guidance/${group.guidance_hash}/approve`, { checked_flags: true, checked_tools: true });
    expect(approve.body.approved.sort()).toEqual(changed);
    expect(approve.body.skipped).toEqual([]);
  });

  it("checks the base: approving a version proposed on an older published version is a conflict; rollback holds", async () => {
    const id = await skillId("no-mention");
    // v2 proposed by hand on v1 (detached, since it came from an upload it is hand-made: no source).
    const v2 = await app.call("manager", "POST", `/api/skills/${id}/versions`, { skill_md: "---\nname: no-mention\ndescription: Use when someone asks about the fixture's quiet behaviour; covers the steps, the checks and what to report.\n---\n\n# Quiet v2\n", summary: "v2" });
    expect(v2.body).toMatchObject({ version: 2, state: "pending" });
    // A manual proposal while another is pending supersedes it (no unique violation), and its author hears about it.
    const v3 = await app.call("reviewer", "POST", `/api/skills/${id}/versions`, { skill_md: "---\nname: no-mention\ndescription: Use when someone asks about the fixture's quiet behaviour; covers the steps, the checks and what to report.\n---\n\n# Quiet v3\n", summary: "v3" });
    expect(v3.body).toMatchObject({ version: 3, superseded: 2 });
    expect((await db.query("SELECT title FROM notifications WHERE user_id = $1 AND kind = 'skill' AND title LIKE '%replaced%'", [app.ids.manager])).rows.map((r) => r.title)).toEqual(["Skill no-mention: your version 2 was replaced by version 3"]);
    // v3 is published by someone else; rolling back to v1 publishes v4 (a copy of v1) and holds the skill.
    expect((await app.call("manager", "POST", `/api/skills/${id}/versions/3/approve`, { checked_flags: true })).status).toBe(200);
    const rb = await app.call("reviewer", "POST", `/api/skills/${id}/rollback`, { version: 1 });
    expect(rb.body).toMatchObject({ version: 4, restored_from: 1, held_at_version: 4 });
    const v1 = (await db.query("SELECT content_hash FROM skill_versions WHERE skill_id = $1 AND version = 1", [id])).rows[0].content_hash;
    expect((await db.query("SELECT content_hash, state FROM skill_versions WHERE skill_id = $1 AND version = 4", [id])).rows[0]).toEqual({ content_hash: v1, state: "published" });
    // A version proposed on v1 can't be approved now that v4 is published.
    const v5 = await app.call("reviewer", "POST", `/api/skills/${id}/versions`, { skill_md: "---\nname: no-mention\ndescription: Use when someone asks about the fixture's quiet behaviour; covers the steps, the checks and what to report.\n---\n\n# Quiet v5\n", summary: "v5" });
    expect(v5.body.version).toBe(5);
    await db.query("UPDATE skill_versions SET base_version_id = (SELECT id FROM skill_versions WHERE skill_id = $1 AND version = 1) WHERE skill_id = $1 AND version = 5", [id]);
    const stale = await app.call("manager", "POST", `/api/skills/${id}/versions/5/approve`, {});
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/published version changed since this was proposed \(v1 → v4\)/);
    // Released: the hold is gone.
    expect((await app.call("reviewer", "POST", `/api/skills/${id}/release-hold`)).body.held_at_version).toBeNull();
  });

  it("refuses edits and approvals from people without the rights, and hides the catalogue from members", async () => {
    expect((await app.call("alice", "GET", "/api/skills")).status).toBe(403);
    const id = await skillId("hidden");
    expect((await app.call("alice", "GET", `/api/skills/${id}`)).status).toBe(404);
    expect((await app.call("alice", "POST", `/api/skills/${id}/versions/1/approve`, {})).status).toBe(404);
    expect((await app.call("alice", "GET", "/api/skills/not-a-uuid")).status).toBe(404);
    // Auditors read, but don't change.
    expect((await app.call("auditor", "GET", `/api/skills/${id}`)).body.can).toMatchObject({ manage: false, review: false, usage: true });
    expect((await app.call("auditor", "POST", `/api/skills/${id}/versions/1/approve`, {})).status).toBe(403);
    const list = await app.call("auditor", "GET", "/api/skills?pending=true");
    expect(list.body.skills.map((s: { name: string }) => s.name)).toContain("hidden");
  });

  it("enforces size and file-count limits per skill", async () => {
    const big = fixtureFiles((f) => {
      for (const k of [...f.keys()]) if (!k.startsWith("plugins/alpha/") && !k.startsWith(".claude-plugin") && !k.startsWith("core/")) f.delete(k);
      f.set("plugins/alpha/skills/plain-alpha/assets/huge.bin", new Uint8Array(2 * 1024 * 1024 + 1));
      for (let i = 0; i < 301; i++) f.set(`plugins/alpha/skills/uses-tableau/references/r${i}.md`, enc.encode(`# ${i}\n`));
    });
    const r = await upload("manager", zipOfFiles(big), "&dry_run=true");
    const reasons = Object.fromEntries(r.body.report.rejected.map((x: { name: string; reasons: string[] }) => [x.name, x.reasons.join(" | ")]));
    expect(reasons["plain-alpha"]).toMatch(/a skill file can be at most 2.0 MB/);
    expect(reasons["uses-tableau"]).toMatch(/at most 300/);
  });

  it("refuses a traversal archive outright and records the failed run", async () => {
    const evil = Buffer.from(zipSync({ "repo/SKILL.md": strToU8("x"), "repo/../../etc/evil": strToU8("x") }));
    const r = await upload("manager", evil);
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toMatch(/unsafe path/);
    expect((await db.query("SELECT status FROM skill_imports WHERE id = $1", [r.body.import_id])).rows[0].status).toBe("failed");
    expect((await upload("alice", evil)).status).toBe(403);
  });

  it("imports a single skill from a zipped folder, named after the folder", async () => {
    const z = Buffer.from(zipSync({ "solo-skill/SKILL.md": strToU8("---\nname: solo-skill\ndescription: Use when testing that a single zipped skill folder imports under its folder name.\n---\n\n# Solo\n"), "solo-skill/scripts/x.sh": strToU8("echo hi\n") }));
    const r = await app.raw("manager", "POST", "/api/skills/import/upload?filename=solo-skill.zip&collection=singles", z);
    expect(r.body.report).toMatchObject({ layout: "single", added: [{ name: "solo-skill", collection: "singles" }] });
  });
});
