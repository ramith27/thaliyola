import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { bulletTitle, draftFeatures, guessArea, guessKind, parseChangelog, sectionFor } from "../src/core/changelog.js";
import { autoDraftRelease, countsText, ensureReleaseCatalog, fillSeedPlaceholders, seedReleases } from "../src/core/releases.js";
import { SEED_PLACEHOLDERS, SEED_RELEASES } from "../src/core/release-seed.js";
import { createRole, ORG_PERMISSIONS, setUserRoles } from "../src/core/roles.js";
import { buildInfo, compareVersions, readBuildInfo } from "../src/core/version.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PEOPLE = ["admin", "rita", "otto", "nell"];

let db: Db;
let server: Server;
let base: string;
const clients: Client[] = [];

/** A changelog in the shapes CHANGELOG.md uses: prose, bold leads, colons, wrapped and indented lines. */
const FIXTURE = `# Changelog

## Unreleased

Release 2.1 in preparation.

- **Saved searches.** Keep a search and get told about new hits (\`/api/saved-searches\`)
- Audit log: export as JSON too
  with the same filters
- Fix: the review queue lost its filters after approving

## 2.0.0 (2026-10-01)

- Several replicas behind a load balancer
- MCP: \`list_features\` tool for agents

## 1.0.0 (2026-09-01)

First.
`;

beforeAll(async () => {
  ({ db } = await freshDb());
  const tokens = [...PEOPLE.map((p) => `${p}=${p}@example.com`), "svc=svc-bot@example.com"].join(",");
  server = createApp({ db, authenticate: devAuthenticator(tokens), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await ctxFor(db, { email: `${p}@example.com` });
  await ctxFor(db, { email: "svc-bot@example.com", service: true });
  // otto writes release notes through a custom organisation role with only Manage releases.
  const admin = await ctxFor(db, { email: "admin@example.com" });
  await createRole(admin, { kind: "org", name: "Release editor", permissions: ["manage_releases"] });
  await setUserRoles(admin, await idOf("otto"), ["Release editor"]);
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [`${p}@example.com`])).rows[0].id as string;

async function call(auth: string, method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p.startsWith("/healthz") ? "" : "/api"}${p}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

async function mcp(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

describe("version numbers", () => {
  it("keeps one version in the root, server and web package.json", () => {
    const versions = ["package.json", "apps/server/package.json", "apps/web/package.json"].map((f) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8")).version);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(buildInfo().version).toBe(versions[0]);
  });

  it("takes the commit from BUILD_SHA, then CI_COMMIT_SHA, then the build, else null", () => {
    const root = mkdtempSync(path.join(tmpdir(), "thaliyola-build-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.4.5" }));
    expect(readBuildInfo({}, root, "dist")).toEqual({ version: "3.4.5", commit: null, built_at: null });
    expect(readBuildInfo({ CI_COMMIT_SHA: "ABCDEF1234567890" }, root, "dist").commit).toBe("abcdef1234567890");
    expect(readBuildInfo({ BUILD_SHA: "1234567", CI_COMMIT_SHA: "abcdef1234567890" }, root, "dist").commit).toBe("1234567");
    // Anything that isn't a hash is ignored.
    expect(readBuildInfo({ BUILD_SHA: "$(rm -rf /)" }, root, "dist").commit).toBeNull();
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ commit: "feedface00", built_at: "2026-11-13T10:00:00Z" }));
    expect(readBuildInfo({}, root, "dist")).toEqual({ version: "3.4.5", commit: "feedface00", built_at: "2026-11-13T10:00:00.000Z" });
    expect(readBuildInfo({ BUILD_SHA: "0123abcd" }, root, "dist").commit).toBe("0123abcd");
    // Run from source, a build left behind in dist/ is ignored: the checkout's commit (git), else none.
    expect(readBuildInfo({}, root, "source")).toEqual({ version: "3.4.5", commit: null, built_at: null });
    const server = path.join(ROOT, "apps/server");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: server, encoding: "utf8" }).trim();
    expect(readBuildInfo({}, server, "source")).toMatchObject({ commit: head, built_at: null });
  });

  it("the build script writes build-info.json from BUILD_SHA", () => {
    const root = mkdtempSync(path.join(tmpdir(), "thaliyola-build-"));
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "build-info.mjs"), readFileSync(path.join(ROOT, "apps/server/scripts/build-info.mjs")));
    execFileSync(process.execPath, [path.join(root, "scripts", "build-info.mjs")], { env: { ...process.env, BUILD_SHA: "c0ffee1234" }, stdio: "pipe" });
    const info = JSON.parse(readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
    expect(info.commit).toBe("c0ffee1234");
    expect(Date.parse(info.built_at)).not.toBeNaN();
  });

  it("compares versions as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("reports {version, commit, built_at} on /healthz, /api/version and /api/me", async () => {
    const { version, commit, built_at } = buildInfo();
    const health = await fetch(`${base}/healthz`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true, version, commit, built_at });
    const v = await call("rita", "GET", "/version");
    expect(v).toEqual({ status: 200, body: { version, commit, built_at } });
    const me = await call("rita", "GET", "/me");
    expect(me.body.build).toEqual({ version, commit, built_at });
    expect(me.body.whats_new).toEqual({ latest: null, last_seen: null, unseen: false });
    // Signed out: /api/version needs a sign-in like the rest of /api.
    expect((await fetch(`${base}/api/version`)).status).toBe(401);
  });
});

describe("the version bump script", () => {
  const bump = (root: string, ...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts/version-bump.mjs"), ...args, "--root", root], { encoding: "utf8" });
  const repo = (version: string, changelog: string) => {
    const root = mkdtempSync(path.join(tmpdir(), "thaliyola-bump-"));
    mkdirSync(path.join(root, "apps/server"), { recursive: true });
    mkdirSync(path.join(root, "apps/web"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "thaliyola", private: true, scripts: {} }, null, 2) + "\n");
    writeFileSync(path.join(root, "apps/server/package.json"), JSON.stringify({ name: "@thaliyola/server", version }, null, 2) + "\n");
    writeFileSync(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "@thaliyola/web", version }, null, 2) + "\n");
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    return root;
  };
  const versions = (root: string) => ["package.json", "apps/server/package.json", "apps/web/package.json"].map((f) => JSON.parse(readFileSync(path.join(root, f), "utf8")).version);

  it("sets all three package.json files and starts the version's changelog section from Unreleased", () => {
    const root = repo("1.2.3", "# Changelog\n\n## Unreleased\n\n- New thing\n\n## 1.2.3 (2026-01-01)\n\n- Old thing\n");
    const out = bump(root, "minor");
    expect(out.status).toBe(0);
    expect(versions(root)).toEqual(["1.3.0", "1.3.0", "1.3.0"]);
    // The root's "version" goes right after "name".
    expect(Object.keys(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")))).toEqual(["name", "version", "private", "scripts"]);
    const log = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(log).toMatch(/## Unreleased\n\n## 1\.3\.0 \(\d{4}-\d{2}-\d{2}\)\n\n- New thing\n\n## 1\.2\.3/);
    // Again: nothing changes.
    expect(bump(root, "1.3.0").stdout).toMatch(/nothing to change/);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(log);
  });

  it("takes major, patch and exact versions, refuses older ones and nonsense", () => {
    const root = repo("1.2.3", "# Changelog\n");
    expect(bump(root, "patch").status).toBe(0);
    expect(versions(root)).toEqual(["1.2.4", "1.2.4", "1.2.4"]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toMatch(/## Unreleased\n\n## 1\.2\.4 \(/);
    expect(bump(root, "major", "--no-changelog").status).toBe(0);
    expect(versions(root)).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toMatch(/2\.0\.0/);
    const older = bump(root, "1.9.0");
    expect(older.status).toBe(1);
    expect(older.stderr).toMatch(/older than the current version 2\.0\.0/);
    expect(bump(root, "two").status).toBe(1);
    expect(bump(root, "3.0.0", "--dry-run").status).toBe(0);
    expect(versions(root)).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
    // Without an Unreleased section, the new section starts empty: no stray "- " bullet.
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).not.toMatch(/^- *$/m);
  });

  it("cuts the version being prepared, and won't file its Unreleased notes under the next one", () => {
    const root = repo("1.0.0", "# Changelog\n\n## Unreleased\n\n- Audit log\n\n## 0.9.0 (2026-11-12)\n\n- Old thing\n");
    const refused = bump(root, "patch");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/Unreleased notes belong to 1\.0\.0.*pnpm version:bump 1\.0\.0/);
    expect(versions(root)).toEqual([undefined, "1.0.0", "1.0.0"]);
    const cut = bump(root, "1.0.0");
    expect(cut.status).toBe(0);
    expect(cut.stdout).toMatch(/^Cut 1\.0\.0: package\.json, CHANGELOG\.md/);
    expect(versions(root)).toEqual(["1.0.0", "1.0.0", "1.0.0"]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toMatch(/## Unreleased\n\n## 1\.0\.0 \(\d{4}-\d{2}-\d{2}\)\n\n- Audit log\n\n## 0\.9\.0/);
    // Now 1.0.0 has its section, the next version starts from an empty Unreleased.
    expect(bump(root, "patch").status).toBe(0);
    expect(versions(root)).toEqual(["1.0.1", "1.0.1", "1.0.1"]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## .*/gm)).toEqual(["## Unreleased", expect.stringMatching(/^## 1\.0\.1 /), expect.stringMatching(/^## 1\.0\.0 /), "## 0.9.0 (2026-11-12)"]);
  });
});

describe("drafts from CHANGELOG.md", () => {
  it("parses sections, summaries and one feature per bullet", () => {
    const sections = parseChangelog(FIXTURE);
    expect(sections.map((s) => [s.heading, s.version, s.date])).toEqual([
      ["Unreleased", null, null],
      ["2.0.0 (2026-10-01)", "2.0.0", "2026-10-01"],
      ["1.0.0 (2026-09-01)", "1.0.0", "2026-09-01"],
    ]);
    expect(sections[0]!.summary).toBe("Release 2.1 in preparation.");
    expect(sections[0]!.bullets).toHaveLength(3);
    expect(sections[0]!.bullets[1]).toBe("Audit log: export as JSON too\nwith the same filters");
    expect(sectionFor(sections, "2.0.0")!.heading).toBe("2.0.0 (2026-10-01)");
    expect(sectionFor(sections, "2.1.0")!.heading).toBe("Unreleased");
    expect(bulletTitle("**Saved searches.** Keep a search")).toBe("Saved searches");
    expect(bulletTitle("Audit log: export as JSON too")).toBe("Audit log");
    expect(guessKind("Fix: the review queue lost its filters")).toBe("fixed");
    expect(bulletTitle("MCP: `list_features` tool for agents")).toBe("List_features tool for agents");
    expect(guessArea("Several replicas behind a load balancer")).toBe("platform");
    expect(guessArea("MCP: `list_features` tool for agents")).toBe("mcp");
    expect(guessArea("Admin › Audit log for Administrators")).toBe("admin");
  });

  it("reads Keep a Changelog subsections, second paragraphs and pre-release headings", () => {
    const kac = parseChangelog(
      "## [2.0.0] - 2026-01-01\n\nIntro.\n\n### Added\n\n- Saved searches\n\n  A second paragraph.\n- Tests: faster fixtures\n\n### Fixed\n\n- Search crashed on empty query\n\n## 2.1.0-rc.1\n\n- A candidate\n",
    );
    expect(kac[0]).toMatchObject({ version: "2.0.0", date: "2026-01-01", summary: "Intro.", bullets: ["Saved searches\n\nA second paragraph.", "Tests: faster fixtures", "Search crashed on empty query"] });
    expect(draftFeatures(kac[0]!).map((f) => [f.title, f.kind])).toEqual([
      ["Saved searches", "new"],
      ["Search crashed on empty query", "fixed"],
    ]);
    // A pre-release isn't the release's section.
    expect(kac[1]!.version).toBeNull();
    expect(sectionFor(kac, "2.1.0")).toBeNull();
  });

  it("files the real changelog's bullets under the right areas, leaving out internal ones", () => {
    const section = sectionFor(parseChangelog(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")), "1.0.0")!;
    const drafts = draftFeatures(section);
    const byTitle = (t: string) => drafts.find((f) => f.title.startsWith(t));
    expect(byTitle("Several replicas")?.area).toBe("platform");
    expect(byTitle("Display names")?.area).toBe("people");
    expect(byTitle("Sub-projects")).toMatchObject({ area: "projects", kind: "fixed" });
    expect(byTitle("Admin › Audit log")?.area).toBe("admin");
    expect(byTitle("Token hygiene")?.area).toBe("people");
    expect(byTitle("Security feed")?.area).toBe("security");
    expect(byTitle("MCP for jobs")?.area).toBe("mcp");
    expect(drafts.some((f) => /^(Tests|Kit)\b/i.test(f.description))).toBe(false);
    expect(guessArea("UX extras: a split view in Review and the Inbox, saved views on Security")).toBe("review");
    // 1.0.1: skill authoring, all of it under Skills; Keep a Changelog's subsections set the kinds.
    const next = draftFeatures(sectionFor(parseChangelog(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")), "1.0.1")!);
    expect(next.map((f) => [f.title, f.area, f.kind])).toEqual([
      ["Push skills from Claude", "skills", "new"],
      ["Give skills out from Claude", "skills", "new"],
      ["New skill on every Skills tab, and in the Create menu", "skills", "improved"],
      ["A clearer New skill editor", "skills", "improved"],
      ["Skill reviews stay with people", "skills", "improved"],
    ]);
    // A tool name or "agents" alone doesn't make a bullet Claude/MCP.
    expect(guessArea("Faster pages for agents that call `get_article`")).toBe("knowledge");
  });

  it("drafts the running version once, from its own section or Unreleased", async () => {
    const first = await autoDraftRelease(db, "2.1.0", FIXTURE);
    expect(first).toEqual({ created: true, version: "2.1.0", features: 3, from: "Unreleased" });
    const again = await autoDraftRelease(db, "2.1.0", FIXTURE);
    expect(again.created).toBe(false);
    const own = await autoDraftRelease(db, "2.0.0", FIXTURE);
    expect(own).toMatchObject({ created: true, features: 2, from: "2.0.0 (2026-10-01)" });

    const draft = await call("admin", "GET", "/releases/2.1.0");
    expect(draft.body).toMatchObject({ version: "2.1.0", status: "draft", source: "changelog", title: "Thaliyola 2.1.0", summary: "Release 2.1 in preparation.", counts: { total: 3, new: 2, fixed: 1 } });
    expect(draft.body.features.map((f: { title: string; area: string; kind: string; position: number }) => [f.title, f.area, f.kind, f.position])).toEqual([
      ["Saved searches", "knowledge", "new", 0],
      ["Audit log", "admin", "new", 1],
      ["The review queue lost its filters after approving", "review", "fixed", 2],
    ]);
    expect((await call("admin", "GET", "/releases/2.0.0")).body.released_on).toBe("2026-10-01");
    // Without a changelog: an empty draft, still only once.
    expect(await autoDraftRelease(db, "2.2.0", null)).toMatchObject({ created: true, features: 0 });
    expect(await autoDraftRelease(db, "2.2.0", FIXTURE)).toMatchObject({ created: false });
    const audited = await db.query("SELECT details FROM audit_log WHERE tool = 'draft_release' AND actor_id IS NULL ORDER BY id");
    expect(audited.rows.map((r) => r.details.version)).toEqual(["2.1.0", "2.0.0", "2.2.0"]);
    for (const v of ["2.1.0", "2.0.0", "2.2.0"]) expect((await call("admin", "DELETE", `/releases/${v}`)).status).toBe(200);
    // A draft an admin deleted isn't made again on the next start.
    expect(await autoDraftRelease(db, "2.1.0", FIXTURE)).toMatchObject({ created: false });
    expect((await db.query("SELECT 1 FROM releases WHERE version = '2.1.0'")).rowCount).toBe(0);
    await db.query("DELETE FROM release_autodrafts");
  });

  it("seeds the catalog into empty tables only, then drafts the running version", async () => {
    const first = await ensureReleaseCatalog(db, { version: "1.0.0", changelog: FIXTURE });
    expect(first.seeded).toBe(SEED_RELEASES.length);
    // 1.0.0 is in the starting catalog, so there's nothing to draft.
    expect(first.draft.created).toBe(false);
    const again = await ensureReleaseCatalog(db, { version: "1.0.0", changelog: FIXTURE });
    expect(again).toEqual({ seeded: 0, filled: 0, draft: { created: false, version: "1.0.0", features: 0, from: null } });
    const list = await call("admin", "GET", "/releases");
    expect(list.body.releases.map((r: { version: string; status: string }) => [r.version, r.status])).toEqual([
      ["1.0.0", "draft"],
      ["0.9.0", "published"],
    ]);
    const old = list.body.releases[1];
    expect(old).toMatchObject({ title: "Everything before 1.0", source: "seed" });
    expect(old.counts.total).toBeGreaterThanOrEqual(20);
    // Seeding notified nobody, and everyone already here has seen 0.9.0: no What's new dot for what they have.
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release'")).rows[0].n).toBe(0);
    const seen = (await db.query("SELECT email, kind, last_seen_release FROM users ORDER BY email")).rows;
    for (const u of seen) expect(u.last_seen_release, u.email).toBe(u.kind === "human" ? "0.9.0" : null);
    const routes = (await db.query<{ app_route: string }>("SELECT app_route FROM features WHERE app_route IS NOT NULL")).rows.map((r) => r.app_route);
    expect(routes).toContain("#/admin/audit");
    for (const r of routes) expect(r).toMatch(/^#\/[a-z]/);
  });

  it("keeps the 1.0.0 draft with placeholders a draft even when a newer version starts first", async () => {
    // On empty tables, in a transaction that's rolled back: the first server to start runs 1.2.0.
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM releases; DELETE FROM release_autodrafts; UPDATE users SET last_seen_release = NULL");
      expect(await seedReleases(c, "1.2.0")).toBe(SEED_RELEASES.length);
      expect(await autoDraftRelease(c, "1.2.0", FIXTURE)).toMatchObject({ created: true });
      const rows = (await c.query("SELECT version, status FROM releases ORDER BY version")).rows;
      expect(rows).toEqual([
        { version: "0.9.0", status: "published" },
        { version: "1.0.0", status: "draft" },
        { version: "1.2.0", status: "draft" },
      ]);
      expect((await c.query("SELECT DISTINCT last_seen_release AS v FROM users WHERE kind = 'human'")).rows).toEqual([{ v: "0.9.0" }]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("swaps the Skills placeholder of a 1.0.0 draft seeded before Skills merged for the Skills features, once", async () => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM releases; DELETE FROM release_autodrafts; UPDATE users SET last_seen_release = NULL");
      await seedReleases(c, "1.0.0");
      const p = SEED_PLACEHOLDERS[0]!;
      expect(p.replacedBy).toHaveLength(5);
      // The draft as the earlier catalog seeded it: one placeholder where the Skills features are, and the summary's note.
      const rel = (await c.query<{ id: string }>("SELECT id FROM releases WHERE version = '1.0.0'")).rows[0]!.id;
      const first = (await c.query<{ position: number }>("SELECT min(position) AS position FROM features WHERE release_id = $1 AND area = 'skills'", [rel])).rows[0]!.position;
      await c.query("DELETE FROM features WHERE release_id = $1 AND area = 'skills'", [rel]);
      await c.query("UPDATE features SET position = position - 4 WHERE release_id = $1 AND position > $2", [rel, first]);
      await c.query(
        "INSERT INTO features (release_id, title, area, kind, description, how_to, tags, position) VALUES ($1, 'Skills', 'skills', 'new', '*Placeholder.*', '*To be written.*', '{placeholder}', $2)",
        [rel, first],
      );
      await c.query("UPDATE releases SET summary = summary || $2 WHERE id = $1", [rel, p.summaryNote]);
      // An admin's own Skills feature with one of the titles is kept, not duplicated.
      await c.query("INSERT INTO features (release_id, title, area, position) VALUES ($1, $2, 'skills', 99)", [rel, p.replacedBy[4]]);

      expect(await fillSeedPlaceholders(c)).toBe(4);
      const titles = (await c.query<{ title: string }>("SELECT title FROM features WHERE release_id = $1 ORDER BY position, title", [rel])).rows.map((r) => r.title);
      expect(titles).not.toContain("Skills");
      expect(titles.filter((t) => p.replacedBy.includes(t))).toEqual([...p.replacedBy.slice(0, 4), p.replacedBy[4]]);
      expect(new Set(titles).size).toBe(titles.length);
      const seeded = SEED_RELEASES.find((r) => r.version === "1.0.0")!;
      expect(titles.slice(0, seeded.features.length - 1)).toEqual(seeded.features.map((f) => f.title).slice(0, seeded.features.length - 1));
      expect((await c.query("SELECT summary FROM releases WHERE id = $1", [rel])).rows[0].summary).not.toContain("Before publishing");
      expect((await c.query("SELECT 1 FROM audit_log WHERE tool = 'update_release' AND target_id = $1 AND actor_id IS NULL", [rel])).rowCount).toBe(1);
      // Nothing left to fill: the next start changes nothing.
      expect(await fillSeedPlaceholders(c)).toBe(0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("who reads and who writes release notes", () => {
  it("everyone reads published releases; drafts are only for release managers", async () => {
    const rita = await call("rita", "GET", "/releases");
    expect(rita.status).toBe(200);
    expect(rita.body.can_manage).toBe(false);
    expect(rita.body.releases.map((r: { version: string }) => r.version)).toEqual(["0.9.0"]);
    expect((await call("rita", "GET", "/releases/1.0.0")).status).toBe(404);
    expect((await call("rita", "GET", "/releases/0.9.0")).body.features.length).toBeGreaterThan(5);
    const catalog = await call("rita", "GET", "/features?q=service%20accounts");
    expect(catalog.body.features[0]).toMatchObject({ title: "Service accounts", version: "0.9.0", area: "people", area_name: "People and access" });
    // drafts=true is ignored for people who can't manage releases.
    const withDrafts = await call("rita", "GET", "/features?q=audit%20log&drafts=true");
    expect(withDrafts.body.features.map((f: { version: string }) => f.version)).not.toContain("1.0.0");
    expect((await call("admin", "GET", "/features?q=audit%20log&drafts=true")).body.features.map((f: { version: string }) => f.version)).toContain("1.0.0");
    expect((await call("otto", "GET", "/releases")).body).toMatchObject({ can_manage: true });
  });

  it("only Administrators and Manage releases write them", async () => {
    const feature = { title: "Dark mode for charts", area: "knowledge", how_to: "Open **Home**." };
    expect((await call("rita", "POST", "/releases", { version: "1.1.0" })).status).toBe(403);
    expect((await call("rita", "POST", "/releases/1.0.0/features", feature)).status).toBe(403);
    expect((await call("rita", "POST", "/releases/1.0.0/publish")).status).toBe(403);
    const someFeature = (await call("rita", "GET", "/releases/0.9.0")).body.features[0];
    expect((await call("rita", "PATCH", `/features/${someFeature.id}`, { title: "Mine now" })).status).toBe(403);
    expect((await call("rita", "DELETE", `/features/${someFeature.id}`)).status).toBe(403);
    expect((await call("svc", "POST", "/releases", { version: "1.1.0" })).status).toBe(403);

    const created = await call("otto", "POST", "/releases", { version: "1.1.0", title: "Charts", released_on: "2026-12-01" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ version: "1.1.0", status: "draft", source: "manual", released_on: "2026-12-01", counts: { total: 0 } });
    expect((await call("otto", "POST", "/releases", { version: "1.1.0" })).body.error).toMatch(/already a release 1\.1\.0/);
    expect((await call("otto", "POST", "/releases", { version: "1.1" })).status).toBe(400);
    const f = await call("otto", "POST", "/releases/1.1.0/features", { ...feature, app_route: "/graph", tags: ["Charts", "charts", "dark mode"] });
    expect(f.body).toMatchObject({ version: "1.1.0", app_route: "#/graph", tags: ["charts", "dark-mode"], kind: "new", audience: "everyone", position: 0 });
    expect((await call("otto", "POST", "/releases/1.1.0/features", { ...feature, docs_url: "javascript:alert(1)" })).status).toBe(400);
    for (const app_route of ["javascript:alert(1)", "https://evil.example", "//evil.example", "#/", "mailto:x@example.com"]) {
      const bad = await call("otto", "POST", "/releases/1.1.0/features", { ...feature, app_route });
      expect(bad.status, app_route).toBe(400);
      expect(bad.body.error).toMatch(/route like #\/admin\/audit/);
    }
    const g = await call("admin", "POST", "/releases/1.1.0/features", { title: "Faster graph", area: "knowledge", kind: "improved" });
    expect(g.body.position).toBe(1);
    const reordered = await call("otto", "PUT", "/releases/1.1.0/features/order", { ids: [g.body.id, f.body.id] });
    expect(reordered.body.features.map((x: { title: string }) => x.title)).toEqual(["Faster graph", "Dark mode for charts"]);
    expect((await call("otto", "PUT", "/releases/1.1.0/features/order", { ids: [g.body.id] })).status).toBe(400);
    const edited = await call("otto", "PATCH", `/features/${f.body.id}`, { title: "Dark charts", kind: "improved", app_route: null });
    expect(edited.body).toMatchObject({ title: "Dark charts", kind: "improved", app_route: null });
    const renamed = await call("otto", "PATCH", "/releases/1.1.0", { title: "Charts and graphs", summary: "Better **charts**." });
    expect(renamed.body).toMatchObject({ title: "Charts and graphs", summary: "Better **charts**." });

    // Audited with details.
    const rows = (
      await db.query(
        `SELECT tool, details, target_kind, target_label FROM audit_log WHERE tool IN ('create_release', 'create_feature', 'update_feature', 'update_release', 'reorder_features') ORDER BY id`,
      )
    ).rows;
    expect(rows.map((r) => r.tool)).toEqual(["create_release", "create_feature", "create_feature", "reorder_features", "update_feature", "update_release"]);
    expect(rows[0]).toMatchObject({ target_kind: "release", target_label: "Thaliyola 1.1.0", details: { version: "1.1.0", title: "Charts" } });
    expect(rows[4]!.details).toMatchObject({ release: "1.1.0", changed: { title: { from: "Dark mode for charts", to: "Dark charts" }, kind: { from: "new", to: "improved" } } });
    expect(rows[5]!.details.changed.title).toEqual({ from: "Charts", to: "Charts and graphs" });
    const page = await call("admin", "GET", "/audit?action=update_feature");
    expect(page.body.entries[0]).toMatchObject({ label: "Changed a feature", group: "releases", target: { kind: "feature", label: "Dark charts" } });

    // An upper-case scheme is an http(s) address too, stored in lower case.
    const upper = await call("otto", "POST", "/releases/1.1.0/features", { ...feature, title: "Upper", docs_url: "HTTPS://Example.com/Docs" });
    expect(upper.status).toBe(200);
    expect(upper.body.docs_url).toBe("https://Example.com/Docs");
    expect((await call("otto", "DELETE", `/features/${upper.body.id}`)).status).toBe(200);

    // Moving a feature to another release, then deleting the release it left.
    const moved = await call("otto", "PATCH", `/features/${g.body.id}`, { release: "1.0.0" });
    expect(moved.body.version).toBe("1.0.0");
    expect((await call("otto", "DELETE", "/releases/1.1.0")).body).toEqual({ deleted: true, version: "1.1.0", features: 1 });
    expect((await call("otto", "DELETE", `/features/${g.body.id}`)).status).toBe(200);
  });

  it("feature screenshots use the existing assets, read like the feature", async () => {
    const draftFeature = (await call("admin", "GET", "/releases/1.0.0")).body.features[0];
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");
    expect((await call("rita", "POST", "/assets", { target_id: draftFeature.id, filename: "x.png", mime: "image/png", data_base64: png })).status).toBe(403);
    const up = await call("otto", "POST", "/assets", { target_id: draftFeature.id, filename: "names.png", mime: "image/png", data_base64: png, alt_text: "The Account page" });
    expect(up.status).toBe(200);
    expect((await call("otto", "POST", "/assets", { target_id: draftFeature.id, filename: "a.json", mime: "application/json", data_base64: Buffer.from("{}").toString("base64") })).status).toBe(400);
    const feature = (await call("admin", "GET", `/features/${draftFeature.id}`)).body;
    expect(feature.screenshots).toEqual([{ id: up.body.asset_id, alt_text: "The Account page", filename: "names.png" }]);
    // A draft's screenshot is hidden like the draft.
    expect((await fetch(`${base}/api/assets/${up.body.asset_id}`, { headers: { authorization: "Bearer rita" } })).status).toBe(404);
    expect((await fetch(`${base}/api/assets/${up.body.asset_id}`, { headers: { authorization: "Bearer otto" } })).status).toBe(200);
    expect((await call("rita", "DELETE", `/assets/${up.body.asset_id}`)).status).toBe(403);
    expect((await call("otto", "DELETE", `/assets/${up.body.asset_id}`)).status).toBe(200);
  });
});

describe("publishing", () => {
  it("tells everyone once, in the app, and lights What's new until they've seen it", async () => {
    expect((await call("rita", "GET", "/me")).body.whats_new).toMatchObject({ latest: { version: "0.9.0" }, last_seen: "0.9.0", unseen: false });
    expect((await call("rita", "POST", "/releases/seen", {})).body).toMatchObject({ last_seen: "0.9.0", unseen: false });
    // Opening What's new is a page view on the Audit log, not a change.
    const seenRow = (await db.query("SELECT action, is_read FROM audit_log WHERE tool = 'api:list_releases:seen' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(seenRow).toEqual({ action: "list_releases", is_read: true });

    const draft = (await call("admin", "GET", "/releases/1.0.0")).body;
    const before = (await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release'")).rows[0].n;
    const published = await call("admin", "POST", "/releases/1.0.0/publish");
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "published", notified: expect.any(Number) });
    expect(published.body.released_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { rows } = await db.query<{ email: string; title: string; link: string; target_id: string }>(
      "SELECT u.email, n.title, n.link, n.target_id FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'release' ORDER BY u.email",
    );
    expect(rows.length - before).toBe(published.body.notified);
    const emails = rows.map((r) => r.email);
    // Everyone signed in but the publisher; never service accounts.
    expect(emails).toEqual(expect.arrayContaining(["rita@example.com", "otto@example.com", "nell@example.com"]));
    expect(emails).not.toContain("admin@example.com");
    expect(emails).not.toContain("svc-bot@example.com");
    expect(rows[0]).toMatchObject({ title: `Thaliyola 1.0.0: ${countsText(draft.counts)}`, link: "#/whats-new?tab=releases&release=1.0.0", target_id: draft.id });
    expect(countsText({ new: 12, improved: 0, fixed: 0 })).toBe("12 new features");
    expect(countsText({ new: 5, improved: 3, fixed: 1 })).toBe("5 new features, 3 improvements and 1 fix");

    // The bell lists it; the dot is back until rita looks.
    const bell = await call("rita", "GET", "/notifications");
    expect(bell.body.notifications.some((n: { kind: string; title: string }) => n.kind === "release" && n.title.startsWith("Thaliyola 1.0.0"))).toBe(true);
    expect((await call("rita", "GET", "/me")).body.whats_new).toMatchObject({ latest: { version: "1.0.0" }, last_seen: "0.9.0", unseen: true });
    expect((await call("rita", "POST", "/releases/seen", { version: "1.0.0" })).body.unseen).toBe(false);
    // Seen never goes back.
    expect((await call("rita", "POST", "/releases/seen", { version: "0.9.0" })).body.last_seen).toBe("1.0.0");

    // Unpublish and publish again: quiet the second time.
    expect((await call("admin", "POST", "/releases/1.0.0/unpublish")).body.status).toBe("draft");
    expect((await call("rita", "GET", "/releases")).body.releases.map((r: { version: string }) => r.version)).toEqual(["0.9.0"]);
    expect((await call("admin", "POST", "/releases/1.0.0/publish")).body.notified).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'release'")).rows[0].n).toBe(rows.length);
    const audit = (await db.query("SELECT tool, details FROM audit_log WHERE tool IN ('publish_release', 'unpublish_release') ORDER BY id")).rows;
    expect(audit.map((r) => r.tool)).toEqual(["publish_release", "unpublish_release", "publish_release"]);
    expect(audit[0]!.details).toMatchObject({ version: "1.0.0", notified: published.body.notified });

    // A release needs features, and a published one must be unpublished before it's deleted.
    await call("admin", "POST", "/releases", { version: "1.0.1" });
    expect((await call("admin", "POST", "/releases/1.0.1/publish")).body.error).toMatch(/at least one feature/);
    expect((await call("admin", "DELETE", "/releases/1.0.0")).status).toBe(400);
    expect((await call("admin", "DELETE", "/releases/1.0.1")).status).toBe(200);
  });
});

describe("over MCP", () => {
  it("answers what changed and how to use a feature, and gives the version", async () => {
    const client = await mcp("rita");
    const latest = json(await client.callTool({ name: "whats_new", arguments: {} }));
    expect(latest.note).toMatch(/not instructions/);
    expect(latest.current_version).toBe(buildInfo().version);
    expect(latest.releases.map((r: { version: string }) => r.version)).toEqual(["1.0.0"]);
    const audit = latest.releases[0].features.find((f: { title: string }) => f.title === "Audit log");
    expect(audit).toMatchObject({ added_in: "1.0.0", area: "Admin", app_route: "#/admin/audit" });
    expect(audit.how_to).toMatch(/Download CSV/);

    const since = json(await client.callTool({ name: "whats_new", arguments: { since_version: "0.1.0" } }));
    expect(since.releases.map((r: { version: string }) => r.version)).toEqual(["0.9.0", "1.0.0"]);
    const none = json(await client.callTool({ name: "whats_new", arguments: { since_version: "1.0.0" } }));
    expect(none).toMatchObject({ releases: [], message: "Nothing has been published after 1.0.0." });
    expect((await client.callTool({ name: "whats_new", arguments: { since_version: "one" } })).isError).toBe(true);

    const found = json(await client.callTool({ name: "list_features", arguments: { query: "rotate token" } }));
    expect(found.features[0]).toMatchObject({ title: "Token hygiene", added_in: "1.0.0" });
    const area = json(await client.callTool({ name: "list_features", arguments: { area: "security" } }));
    expect(area.features.length).toBeGreaterThanOrEqual(2);
    expect(new Set(area.features.map((f: { area: string }) => f.area))).toEqual(new Set(["Security"]));
    expect(json(await client.callTool({ name: "list_features", arguments: { query: "zzzz nothing" } })).message).toMatch(/No feature matches/);

    const version = json(await client.callTool({ name: "get_version", arguments: {} }));
    expect(version).toMatchObject({ ...buildInfo(), latest_release: { version: "1.0.0" } });
    expect(client.getInstructions()).toMatch(/whats_new/);
    expect(client.getServerVersion()?.version).toBe(buildInfo().version);

    // Reading release notes is a read on the Audit log page, not a change.
    const rows = (await db.query("SELECT tool, is_read FROM audit_log WHERE tool IN ('list_releases:whats_new', 'list_features', 'get_version')")).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.is_read)).toBe(true);
  });

  it("can't write release notes through Claude, even for Administrators", async () => {
    const client = await mcp("admin");
    const { tools } = await client.listTools();
    // Publishing a written release is a decision Claude may make (publish_release); writing one isn't.
    expect(tools.filter((t) => /release|feature|whats_new/.test(t.name)).map((t) => t.name).sort()).toEqual(["list_features", "publish_release", "unpublish_release", "whats_new"]);
    const feature = (await call("admin", "GET", "/releases/1.0.0")).body.features[0];
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const res = await client.callTool({ name: "upload_asset", arguments: { target_id: feature.id, filename: "x.png", mime_type: "image/png", data_base64: png } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/not through Claude/);
  });
});

describe("the permission catalogue", () => {
  it("lists Manage releases, and Administrators hold it", async () => {
    expect(ORG_PERMISSIONS.manage_releases).toMatch(/release notes/);
    const roles = await call("rita", "GET", "/roles");
    expect(roles.body.org_permissions.manage_releases).toBeDefined();
    expect(roles.body.permission_labels.manage_releases).toBe("Manage releases");
    expect((await call("admin", "GET", "/me")).body.permissions).toContain("manage_releases");
    expect((await call("otto", "GET", "/me")).body.permissions).toEqual(["manage_releases"]);
    const stored = (await db.query("SELECT permissions FROM roles WHERE key = 'admin'")).rows[0].permissions;
    expect(stored).toContain("manage_releases");
  });

  it("extends the notification and asset checks without dropping existing kinds", async () => {
    const defs = (
      await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('notifications_kind_check', 'assets_target_kind_check') ORDER BY conname")
    ).rows.map((r) => r.def);
    expect(defs[0]).toMatch(/'feature'.*'article'.*'finding'/);
    expect(defs[1]).toMatch(/'release'.*'review'.*'token'/);
  });
});
