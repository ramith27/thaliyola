import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * Skills owned by a members-only project: they exist only for people who can read that project (members,
 * Administrators, Auditors), its Project admins manage them, they go only to that project and the projects under it,
 * and they reach only recipients who can read the project.
 */

let db: Db;
let app: TestApp;
let vault: string;
let sub: string;
let skillId: string;

const md = (name: string, body = "# Vault work\n") => `---\nname: ${name}\ndescription: Use when someone works on the vault's private procedures; it lists the steps and the checks.\n---\n\n${body}`;

beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
  vault = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility) VALUES ('project', 'vault', 'Vault', 'members') RETURNING id")).rows[0]!.id;
  sub = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility, parent_id) VALUES ('project', 'vault-sub', 'Vault sub', 'members', $1) RETURNING id", [vault])).rows[0]!.id;
  // carol runs the vault (Project admin, no organisation permissions); the reviewer and alice are members; bob only
  // holds a role in the sub-project.
  await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'reader'), ($1, $4, 'reader'), ($5, $6, 'reader')", [vault, app.ids.carol, app.ids.reviewer, app.ids.alice, sub, app.ids.bob]);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("a skill owned by a members-only project", () => {
  it("is created by the project's admin and reviewed by a member with Review skills; non-members never hear of it", async () => {
    // request_review: carol is the vault's Project admin, whose own skills otherwise publish at once.
    const c = await app.call("carol", "POST", "/api/skills", { skill_md: md("vault-steps"), project: "vault", collection: "vault-skills", summary: "New", request_review: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    skillId = c.body.id;
    // Notified: the reviewer (reads the vault), not the Skills manager who can't.
    const notified = (await db.query<{ user_id: string }>("SELECT user_id FROM notifications WHERE kind = 'skill' AND target_id = $1", [skillId])).rows.map((r) => r.user_id);
    expect(notified).toContain(app.ids.reviewer);
    expect(notified).not.toContain(app.ids.manager);
    expect(notified).not.toContain(app.ids.carol);
    // carol can't approve her own; the reviewer can.
    expect((await app.call("carol", "POST", `/api/skills/${skillId}/versions/1/approve`, {})).status).toBe(403);
    expect((await app.call("reviewer", "POST", `/api/skills/${skillId}/versions/1/approve`, {})).status).toBe(200);
  });

  it("doesn't exist for a Skills manager who can't read the project", async () => {
    expect((await app.call("manager", "GET", `/api/skills/${skillId}`)).status).toBe(404);
    expect((await app.call("manager", "GET", `/api/skills/${skillId}/versions/1`)).status).toBe(404);
    expect((await app.call("manager", "GET", `/api/skills/${skillId}/usage`)).status).toBe(404);
    expect((await app.call("manager", "GET", `/api/skills/${skillId}/assignments`)).status).toBe(404);
    const list = await app.call("manager", "GET", "/api/skills");
    expect(list.body.skills.map((s: { name: string }) => s.name)).not.toContain("vault-steps");
    expect((await app.call("manager", "GET", "/api/skill-collections")).body.collections.map((c: { slug: string }) => c.slug)).not.toContain("vault-skills");
    expect(JSON.stringify((await app.call("manager", "GET", "/api/skills/usage")).body)).not.toContain("vault-steps");
    // A colliding name says only that it isn't available.
    const clash = await app.call("manager", "POST", "/api/skills", { skill_md: md("vault-steps"), summary: "New" });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toBe("that name isn't available");
    // The members see it; an Administrator and an Auditor too.
    expect((await app.call("reviewer", "GET", `/api/skills/${skillId}`)).body).toMatchObject({ view: "manager", owner_project: { slug: "vault", name: "Vault" } });
    expect((await app.call("admin", "GET", "/api/skills")).body.skills.map((s: { name: string }) => s.name)).toContain("vault-steps");
    expect((await app.call("auditor", "GET", `/api/skills/${skillId}`)).status).toBe(200);
  });

  it("goes only to the project and the projects under it (app and database both refuse anything else)", async () => {
    const add = (body: Record<string, unknown>) => app.call("carol", "POST", `/api/skills/${skillId}/assignments`, body);
    expect((await add({ audience: "everyone" })).body.error).toMatch(/only to that project and the projects under it/);
    expect((await add({ audience: "project", project: "merchant-portal" })).body.error).toMatch(/only to that project and the projects under it/);
    expect((await add({ audience: "team", team: "anything" })).status).toBe(400);
    const own = await add({ audience: "project", project: "vault" });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.assignment.label).toBe("Vault (and the projects under it)");
    // project_role without a project means the owner project.
    expect((await add({ audience: "project_role", role: "reader" })).body.assignment.label).toBe("Viewer in Vault");
    await expect(db.query("INSERT INTO skill_assignments (skill_id, audience) VALUES ($1, 'everyone')", [skillId])).rejects.toThrow(/only to that project/);
    const portal = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = 'merchant-portal'")).rows[0]!.id;
    await expect(db.query("INSERT INTO skill_assignments (skill_id, audience, scope_id) VALUES ($1, 'project', $2)", [skillId, portal])).rejects.toThrow(/only to that project/);
    await db.query("INSERT INTO skill_assignments (skill_id, audience, scope_id) VALUES ($1, 'project', $2)", [skillId, sub]);
  });

  it("reaches only recipients who can read the project", async () => {
    const mine = async (who: string) => ((await app.call(who, "GET", "/api/skills/mine")).body.skills as { name: string }[]).map((s) => s.name);
    expect(await mine("alice")).toEqual(["vault-steps"]);
    // bob holds a role in vault-sub only and can't read the members-only vault: the project's own skill isn't his.
    expect(await mine("bob")).toEqual([]);
    expect((await app.call("bob", "GET", "/api/skills/sync")).body.skills).toEqual([]);
    expect((await app.call("bob", "GET", `/api/skills/${skillId}`)).status).toBe(404);
    expect((await app.call("manager", "GET", "/api/skills/mine")).body.skills).toEqual([]);
  });

  it("keeps problem reports and the review queue inside the project", async () => {
    expect((await app.call("alice", "POST", `/api/skills/${skillId}/feedback`, { body: "Step 1 is wrong" })).status).toBe(200);
    expect((await app.call("manager", "GET", "/api/skills/feedback")).body.feedback).toEqual([]);
    expect((await app.call("carol", "GET", "/api/skills/feedback")).body.feedback.map((f: { name: string }) => f.name)).toEqual(["vault-steps"]);
    await app.call("carol", "POST", `/api/skills/${skillId}/versions`, { skill_md: md("vault-steps", "# Vault work, v2\n"), summary: "v2", request_review: true });
    const q = await app.call("manager", "GET", "/api/skills/review");
    expect(q.body.versions).toEqual([]);
    expect((await app.call("manager", "GET", "/api/skills/review/counts")).body).toEqual({ to_review: 0, pending: 0, feedback: 0 });
    expect((await app.call("reviewer", "GET", "/api/skills/review/counts")).body).toMatchObject({ to_review: 1, pending: 1, feedback: 1 });
    expect((await app.call("carol", "GET", "/api/skills/review/counts")).body).toMatchObject({ to_review: 0, pending: 1 });
  });

  it("keeps an owned upload's import report inside the project", async () => {
    const z = Buffer.from(zipSync({ "vault-upload/SKILL.md": strToU8(md("vault-upload")) }));
    const r = await app.raw("carol", "POST", "/api/skills/import/upload?filename=vault-upload.zip&project=vault&collection=vault-skills", z);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.report.added).toEqual([expect.objectContaining({ name: "vault-upload" })]);
    expect((await app.call("manager", "GET", `/api/skill-imports/${r.body.import_id}`)).status).toBe(404);
    expect((await app.call("manager", "GET", "/api/skill-imports")).body.imports.map((i: { id: string }) => i.id)).not.toContain(r.body.import_id);
    expect((await app.call("reviewer", "GET", `/api/skill-imports/${r.body.import_id}`)).status).toBe(200);
    // Only a project's own collection takes a project's own skills.
    const bad = await app.raw("carol", "POST", "/api/skills/import/upload?filename=x.zip&project=vault&collection=hand-made", Buffer.from(zipSync({ "x-skill/SKILL.md": strToU8(md("x-skill")) })));
    expect(bad.status).toBe(200);
    await app.call("manager", "POST", "/api/skills", { skill_md: md("org-skill"), collection: "org-col", summary: "New" });
    const blocked = await app.raw("carol", "POST", "/api/skills/import/upload?filename=y.zip&project=vault&collection=org-col", Buffer.from(zipSync({ "y-skill/SKILL.md": strToU8(md("y-skill")) })));
    expect(blocked.body.report.rejected).toEqual([expect.objectContaining({ name: "y-skill", reasons: [expect.stringMatching(/belongs to the organisation/)] })]);
  });

  it("converts the project's skill articles into its own pending skills", async () => {
    const insert = async (title: string, body: string, tags = ["claude-skill"], path = "Skills") =>
      (await db.query<{ id: string }>("INSERT INTO articles (scope_id, type, title, path, body_md, tags, status) VALUES ($1, 'runbook', $2, $3, $4, $5, 'published') RETURNING id", [vault, title, path, body, tags])).rows[0]!.id;
    const main = await insert("vault-rotate", "## Trigger\nUse when the vault's keys must be rotated; covers the order and the checks.\n\n## Steps\n1. Rotate.\n");
    const helper = await insert("Key inventory", "Where every key lives.", []);
    await db.query("INSERT INTO relations (from_kind, from_id, to_kind, to_id, kind) VALUES ('article', $1, 'article', $2, 'related')", [main, helper]);
    await insert("Bad Title", "## Trigger\nSomething.\n");
    await insert("no-trigger", "## Steps\nNothing to trigger on.\n");
    const dry = await app.call("carol", "POST", "/api/projects/vault/skills/convert-articles", { dry_run: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.added.map((a: { name: string }) => a.name)).toEqual(["vault-rotate"]);
    expect(dry.body.rejected.map((r: { title: string }) => r.title).sort()).toEqual(["Bad Title", "no-trigger"]);
    expect((await db.query("SELECT 1 FROM skills WHERE name = 'vault-rotate'")).rowCount).toBe(0);
    const done = await app.call("carol", "POST", "/api/projects/vault/skills/convert-articles", {});
    expect(done.body.added).toEqual([expect.objectContaining({ name: "vault-rotate", version: 1 })]);
    const row = (await db.query("SELECT s.owner_scope_id, v.state, v.description FROM skills s JOIN skill_versions v ON v.skill_id = s.id WHERE s.name = 'vault-rotate'")).rows[0];
    expect(row).toEqual({ owner_scope_id: vault, state: "pending", description: "Use when the vault's keys must be rotated; covers the order and the checks." });
    const files = (await db.query("SELECT f.path FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'vault-rotate' ORDER BY f.path COLLATE \"C\"")).rows.map((r) => r.path);
    expect(files).toEqual(["SKILL.md", "references/key-inventory.md"]);
    expect((await app.call("manager", "POST", "/api/projects/vault/skills/convert-articles", {})).status).toBe(404);
  });
});
