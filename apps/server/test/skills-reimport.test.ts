import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "../src/core/context.js";
import { runImport, type SourceRow } from "../src/core/skills/importer.js";
import { sha256 } from "../src/core/skills/types.js";
import { actorById } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { enc, fixtureFiles, startApp, zipOfFiles, type TestApp } from "./skills-helpers.js";

/**
 * Re-importing from a source: renamed and removed plugins, skills that disappear and come back, the guards against
 * wiping a source, narrowed filters, moves between plugins that would widen the audience, local overrides
 * (detach), adopting hand-made skills, publishing directly, dry runs, and one transaction per run.
 */

let db: Db;
let app: TestApp;
let ctx: RequestContext;
let sourceId: string;
const EXCLUDE = ["plugins/im-knowledge-base/**"];
const dec = new TextDecoder();

const source = async () => (await db.query<SourceRow>("SELECT * FROM skill_sources WHERE id = $1", [sourceId])).rows[0]!;
const run = async (files: Map<string, Uint8Array>, opts: { force?: boolean; dryRun?: boolean; path?: string; asCtx?: RequestContext } = {}) =>
  runImport(opts.asCtx ?? ctx, { kind: "git", data: zipOfFiles(files, "repo-abc"), source: await source(), exclude: EXCLUDE, force: opts.force, dryRun: opts.dryRun, path: opts.path, repoName: "repo" });
const skill = async (name: string) => (await db.query("SELECT id, status, status_reason, collection_id, pending_collection_id, declined_collection_id, current_version_id FROM skills WHERE name = $1", [name])).rows[0];
const approve = async (name: string) => {
  const s = await skill(name);
  const v = (await db.query("SELECT version FROM skill_versions WHERE skill_id = $1 AND state = 'pending'", [s.id])).rows[0];
  const r = await app.call("reviewer", "POST", `/api/skills/${s.id}/versions/${v.version}/approve`, { checked_flags: true, checked_tools: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

/** The first state of the repository: alpha is still called old-alpha, and a plugin that's later removed exists. */
function v0() {
  return fixtureFiles((f) => {
    const m = JSON.parse(dec.decode(f.get(".claude-plugin/marketplace.json")));
    m.plugins = m.plugins.map((p: { name: string }) => (p.name === "alpha" ? { ...p, name: "old-alpha" } : p));
    m.plugins.push({ name: "gone-plugin", description: "Goes away.", source: "./plugins/gone" });
    delete m.renames;
    f.set(".claude-plugin/marketplace.json", enc.encode(JSON.stringify(m)));
    f.set("plugins/gone/skills/gone-skill/SKILL.md", enc.encode("---\nname: gone-skill\ndescription: Use when testing that a removed plugin retires its skills and keeps their assignments.\n---\n\n# Gone\n"));
  });
}
const v1 = (edit?: (f: Map<string, Uint8Array>) => void) => fixtureFiles(edit);

beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
  ctx = { db, settings: TEST_SETTINGS, actor: (await actorById(db, app.ids.manager))! };
  sourceId = (await db.query<{ id: string }>("INSERT INTO skill_sources (name, kind, provider, repository, owner_id, created_by) VALUES ('Repo', 'git', 'gitlab', 'g/repo', $1, $1) RETURNING id", [app.ids.manager])).rows[0]!.id;
});
afterAll(async () => {
  await app.close();
  await db.end();
});

// Each test runs whole imports of the fixture marketplace: under a loaded full run they take longer than the 20 s default.
describe("re-importing a source", { timeout: 90_000 }, () => {
  it("imports the first state", async () => {
    const r = await run(v0());
    expect(r.status, r.error).toBe("done");
    expect(r.report.added.map((a) => a.name)).toContain("gone-skill");
    for (const n of ["plain-alpha", "no-mention", "gone-skill", "own-datasources", "crlf-redshift", "uses-tableau"]) await approve(n);
    expect((await app.call("manager", "POST", "/api/skill-collections/old-alpha/assignments", { audience: "everyone" })).status).toBe(200);
    expect((await app.call("manager", "POST", `/api/skills/${(await skill("gone-skill")).id}/assignments`, { audience: "everyone" })).status).toBe(200);
  });

  it("renames a collection (keeping its assignments) and retires the skills of a removed plugin", async () => {
    const r = await run(v1());
    expect(r.status, r.error).toBe("done");
    expect(r.report.collections.find((c) => c.slug === "alpha")).toMatchObject({ renamed_from: "old-alpha", created: false });
    expect(r.report.collections.find((c) => c.slug === "gone-plugin")).toMatchObject({ removed: true });
    expect(r.report.removed).toEqual([{ name: "gone-skill" }]);
    expect(await skill("gone-skill")).toMatchObject({ status: "retired", status_reason: "removed from Repo at upload" });
    expect((await db.query("SELECT count(*)::int AS n FROM skill_assignments WHERE skill_id = $1", [(await skill("gone-skill")).id])).rows[0].n).toBe(1);
    expect((await db.query("SELECT removed_at IS NOT NULL AS gone FROM skill_collections WHERE slug = 'gone-plugin'")).rows[0].gone).toBe(true);
    // The collection's assignment still reaches its skills.
    expect(((await app.call("alice", "GET", "/api/skills/mine")).body.skills as { name: string }[]).map((s) => s.name).sort()).toEqual(["plain-alpha", "uses-tableau"]);
  });

  it("retires a skill that disappears and brings it back when it returns", async () => {
    const without = v1((f) => f.delete("plugins/beta/skills/no-mention/SKILL.md"));
    expect((await run(without)).report.removed).toEqual([{ name: "no-mention" }]);
    expect((await skill("no-mention")).status).toBe("retired");
    const back = await run(v1());
    expect(back.report.reactivated).toEqual([{ name: "no-mention" }]);
    expect(back.report.unchanged.map((u) => u.name)).toContain("no-mention");
    expect((await skill("no-mention")).status).toBe("active");
    // A skill a manager retired by hand stays retired.
    await app.call("manager", "PATCH", `/api/skills/${(await skill("own-datasources")).id}`, { status: "retired" });
    expect((await run(v1())).report.reactivated).toEqual([]);
    await app.call("manager", "PATCH", `/api/skills/${(await skill("own-datasources")).id}`, { status: "active" });
  });

  it("refuses to wipe a source: no skills, or more than half removed, changes nothing", async () => {
    const before = (await db.query("SELECT name, status FROM skills ORDER BY name")).rows;
    const tiny = v1((f) => {
      for (const k of [...f.keys()]) if (k.startsWith("plugins/") && !k.startsWith("plugins/alpha/")) f.delete(k);
    });
    const r = await run(tiny);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^the source would remove \d+ of \d+ skills; nothing was changed/);
    const none = await run(v1(), { path: "plugins/nope" });
    expect(none).toMatchObject({ status: "failed", error: expect.stringMatching(/returned no skills/) });
    expect((await db.query("SELECT name, status FROM skills ORDER BY name")).rows).toEqual(before);
  });

  it("lists skills a narrowed path filter no longer covers, and retires none of them", async () => {
    const r = await run(v1(), { path: "plugins/alpha" });
    expect(r.status, r.error).toBe("done");
    expect(r.report.not_covered.map((n) => n.name)).toContain("no-mention");
    expect(r.report.removed).toEqual([]);
    expect((await skill("no-mention")).status).toBe("active");
  });

  it("holds a move that would give a skill to more people until a second person confirms it", async () => {
    const move = (f: Map<string, Uint8Array>, name: string) => {
      for (const k of [...f.keys()]) if (k.startsWith(`plugins/beta/skills/${name}/`)) {
        f.set(k.replace("plugins/beta/", "plugins/alpha/"), f.get(k)!);
        f.delete(k);
      }
    };
    const r = await run(v1((f) => (move(f, "own-datasources"), move(f, "crlf-redshift"))));
    expect(r.status, r.error).toBe("done");
    const moved = Object.fromEntries(r.report.moved.map((m) => [m.name, m]));
    expect(moved["own-datasources"]).toMatchObject({ from: "beta", to: "alpha", pending: true, gains: { audiences: ["Everyone"] } });
    expect(moved["own-datasources"]!.gains.people).toBeGreaterThan(5);
    const own = await skill("own-datasources");
    expect(own.pending_collection_id).not.toBeNull();
    // Not delivered to the wider audience while it waits.
    expect(((await app.call("alice", "GET", "/api/skills/mine")).body.skills as { name: string }[]).map((s) => s.name)).not.toContain("own-datasources");
    expect((await app.call("manager", "POST", `/api/skills/${own.id}/audience-change`, { decision: "confirm" })).status).toBe(403);
    expect((await app.call("reviewer", "GET", "/api/skills/review")).body.audience_changes.map((a: { name: string }) => a.name).sort()).toEqual(["crlf-redshift", "own-datasources"]);
    expect((await app.call("reviewer", "POST", `/api/skills/${own.id}/audience-change`, { decision: "confirm" })).body).toMatchObject({ decision: "confirm", collection: "alpha" });
    const crlf = await skill("crlf-redshift");
    expect((await app.call("reviewer", "POST", `/api/skills/${crlf.id}/audience-change`, { decision: "decline" })).body).toMatchObject({ decision: "decline", collection: "beta" });
    // A declined move isn't asked again.
    const again = await run(v1((f) => (move(f, "own-datasources"), move(f, "crlf-redshift"))));
    expect(again.report.moved.find((m) => m.name === "crlf-redshift")).toMatchObject({ declined: true, pending: false });
    expect((await skill("crlf-redshift")).pending_collection_id).toBeNull();
    expect((await skill("own-datasources")).pending_collection_id).toBeNull();
  });

  it("is edited at its source: detach to change it here, imports then leave it alone", async () => {
    const s = await skill("no-mention");
    const md = "---\nname: no-mention\ndescription: Use when someone asks about the fixture's quiet behaviour; covers the steps, the checks and what to report.\n---\n\n# Local\n";
    const refused = await app.call("manager", "POST", `/api/skills/${s.id}/versions`, { skill_md: md, summary: "local" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/This skill comes from g\/repo@plugins\/beta\/skills\/no-mention; edit it there, or detach it/);
    expect((await app.call("manager", "POST", `/api/skills/${s.id}/detach`)).body.detached).toBe(true);
    expect((await app.call("manager", "POST", `/api/skills/${s.id}/versions`, { skill_md: md, summary: "local" })).status).toBe(200);
    const r = await run(v1());
    expect(r.report.detached).toEqual([{ name: "no-mention", upstream_changed: false }]);
    expect((await db.query("SELECT count(*)::int AS n FROM skill_versions WHERE skill_id = $1 AND import_id = $2", [s.id, r.import_id])).rows[0].n).toBe(0);
    expect((await app.call("manager", "POST", `/api/skills/${s.id}/reattach`)).body.detached).toBe(false);
  });

  it("offers a hand-made skill of the same name for adoption, then proposes the upstream content", async () => {
    const md = (body: string) => `---\nname: hand-adopt\ndescription: Use when testing that a hand-made skill can be adopted into a repository source.\n---\n\n${body}`;
    const made = await app.call("manager", "POST", "/api/skills", { skill_md: md("# By hand\n"), summary: "New" });
    expect(made.status).toBe(200);
    const files = v1((f) => f.set("plugins/alpha/skills/hand-adopt/SKILL.md", enc.encode(md("# Upstream\n"))));
    let r = await run(files);
    expect(r.report.adoptable).toEqual([{ name: "hand-adopt", skill_id: made.body.id, path: "plugins/alpha/skills/hand-adopt" }]);
    const adopt = await app.call("manager", "POST", `/api/skills/${made.body.id}/adopt`, { source: "Repo", path: "plugins/alpha/skills/hand-adopt" });
    expect(adopt.status, JSON.stringify(adopt.body)).toBe(200);
    r = await run(files);
    expect(r.report.changed).toEqual([expect.objectContaining({ name: "hand-adopt", to: 2, state: "pending", superseded: 1 })]);
  });

  it("publishes changed versions directly only for an Administrator-granted source whose owner reviews, and never high-risk ones", async () => {
    await db.query("UPDATE skill_sources SET publish_directly = true, publish_directly_by = $2 WHERE id = $1", [sourceId, app.ids.admin]);
    const edit = (f: Map<string, Uint8Array>) => {
      const p = "plugins/alpha/skills/plain-alpha/SKILL.md";
      f.set(p, enc.encode(dec.decode(f.get(p)!).replace("No data source", "Directly published")));
      f.set("plugins/alpha/skills/uses-tableau/scripts/run.sh", enc.encode("#!/bin/sh\necho hi\n"));
      f.set("plugins/alpha/skills/brand-new/SKILL.md", enc.encode("---\nname: brand-new\ndescription: Use when testing that new skills are never published directly by a source.\n---\n\n# New\n"));
    };
    const r = await run(v1(edit));
    const changed = Object.fromEntries(r.report.changed.map((c) => [c.name, c.state]));
    expect(changed["plain-alpha"]).toBe("published");
    expect(changed["uses-tableau"]).toBe("pending"); // a new script is high-risk
    expect(r.report.added).toEqual([expect.objectContaining({ name: "brand-new", state: "pending" })]);
    const a = (await db.query("SELECT actor_id, details FROM audit_log WHERE tool = 'publish_skill_version' AND details->>'direct' = 'true'")).rows[0];
    expect(a).toMatchObject({ actor_id: null, details: { name: "plain-alpha", direct: true, via_import: r.import_id } });
    // An owner without Review skills: back to review.
    await db.query("UPDATE skill_sources SET owner_id = $2 WHERE id = $1", [sourceId, app.ids.alice]);
    const r2 = await run(v1((f) => (edit(f), f.set("plugins/alpha/skills/plain-alpha/SKILL.md", enc.encode(dec.decode(f.get("plugins/alpha/skills/plain-alpha/SKILL.md")!).replace("Directly published", "Reviewed again"))))));
    expect(r2.report.changed.find((c) => c.name === "plain-alpha")!.state).toBe("pending");
    await db.query("UPDATE skill_sources SET owner_id = $2, publish_directly = false, publish_directly_by = NULL WHERE id = $1", [sourceId, app.ids.manager]);
  });

  it("writes nothing on a dry run, and nothing at all when a run fails half-way", async () => {
    const count = async () => (await db.query("SELECT (SELECT count(*) FROM skill_versions)::int AS v, (SELECT count(*) FROM skills)::int AS s, (SELECT count(*) FROM skill_collections)::int AS c")).rows[0];
    const before = await count();
    const changed = v1((f) => {
      f.set("plugins/beta/skills/newcomer/SKILL.md", enc.encode("---\nname: newcomer\ndescription: Use when testing that a dry run or a failed run writes nothing at all.\n---\n\n# N\n"));
      f.set("plugins/beta/skills/newcomer/references/boom.md", enc.encode("boom\n"));
      f.set("plugins/delta/skills/delta-one/SKILL.md", enc.encode("x"));
    });
    const dry = await run(changed, { dryRun: true });
    expect(dry.report.added.map((a) => a.name)).toEqual(["newcomer"]);
    expect(await count()).toEqual(before);
    await db.query(`CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.path = 'references/boom.md' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER boom BEFORE INSERT ON skill_files FOR EACH ROW EXECUTE FUNCTION boom()");
    try {
      const failed = await run(changed);
      expect(failed).toMatchObject({ status: "failed", error: "the import failed unexpectedly" });
      expect(await count()).toEqual(before);
      expect((await db.query("SELECT status FROM skill_imports WHERE id = $1", [failed.import_id])).rows[0].status).toBe("failed");
    } finally {
      await db.query("DROP TRIGGER boom ON skill_files; DROP FUNCTION boom()");
    }
  });

  it("refreshes a reused old blob so the janitor can't delete it under a running import", async () => {
    const data = enc.encode("# Reused content\n");
    const sha = sha256(data);
    await db.query("INSERT INTO skill_blobs (sha256, size, data, created_at) VALUES ($1, $2, $3, now() - interval '3 days')", [sha, data.length, Buffer.from(data)]);
    await run(v1((f) => f.set("plugins/alpha/skills/plain-alpha/references/reused.md", data)));
    expect((await db.query("SELECT created_at > now() - interval '1 minute' AS fresh FROM skill_blobs WHERE sha256 = $1", [sha])).rows[0].fresh).toBe(true);
    await db.query("DELETE FROM skill_blobs b WHERE b.created_at < now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM skill_files f WHERE f.sha256 = b.sha256)");
    expect((await db.query("SELECT 1 FROM skill_blobs WHERE sha256 = $1", [sha])).rowCount).toBe(1);
  });
});
