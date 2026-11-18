import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import type { RequestContext } from "../src/core/context.js";
import { createConnection } from "../src/core/connections/manage.js";
import { resolveTarget } from "../src/core/connections/network.js";
import { writeTar } from "../src/core/skills/archive.js";
import type { SourceRow } from "../src/core/skills/importer.js";
import { checkSkillApiUrl, gitError, skillsNetPolicy } from "../src/core/skills/net.js";
import { flushSkillImports, resealSkillSources, runDueSources, runSource, startSkillJobs } from "../src/core/skills/sources.js";
import { actorById } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { enc, fixtureFiles, startApp, type TestApp } from "./skills-helpers.js";

/**
 * Skill sources that read a GitLab or GitHub repository through its API, against mock servers on this machine: the
 * token travels only in a header, the archive (or the tree and raw files when the archive is refused) is imported at
 * one commit, the same commit is skipped, and every run re-checks who may still use the source and its token.
 */

const TOKEN = "glpat-ownToken1234567890abcd";
const CONN_TOKEN = "glpat-teamToken0987654321wxyz";
const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const keyA = randomBytes(32);

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}
let seen: Seen[] = [];
let seen2: Seen[] = [];
const mockState = { sha: SHA1, archive: "ok" as "ok" | "429" | "html500", files: fixtureFiles(), tooLong: false };

let mock: Server;
let other: Server;
let mockBase: string;
let otherBase: string;
let db: Db;
let app: TestApp;
let settings: Settings;

const tarGzOf = (files: Map<string, Uint8Array>, prefix: string) => gzipSync(writeTar([...files].map(([p, data]) => ({ path: `${prefix}/${p}`, data }))));

function gitlab(req: IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url!, mockBase);
  const p = url.pathname;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const base = "/api/v4/projects/cap%2Fclaude-skills";
  if (p === "/api/v4/projects/missing%2Frepo") return json(404, { message: "404 Project Not Found" });
  if (p === "/api/v4/projects/broken%2Frepo") {
    res.writeHead(500, { "content-type": "text/html" });
    return res.end(`<html><body>Internal error at 10.1.2.3 ${TOKEN}</body></html>`);
  }
  if (p === "/api/v4/projects/echo%2Frepo") return json(401, { message: `invalid token ${req.headers["private-token"]} ${"x".repeat(300)}` });
  if (p === base) return json(200, { default_branch: "main" });
  if (p === `${base}/repository/commits/main` || p === `${base}/repository/commits/${mockState.sha}`) return json(200, { id: mockState.sha });
  if (p === `${base}/repository/archive.tar.gz`) {
    if (mockState.archive === "429") return json(429, { message: "429 Too Many Requests" });
    res.writeHead(200, { "content-type": "application/gzip" });
    return res.end(tarGzOf(mockState.files, `claude-skills-${url.searchParams.get("sha")}-${url.searchParams.get("sha")}`));
  }
  if (p === `${base}/repository/tree`) {
    const all = [...mockState.files.keys()].sort();
    const page = Number(url.searchParams.get("page_token") ?? "0");
    const slice = all.slice(page, page + 40).map((path) => ({ path, type: "blob", mode: "100644" }));
    const next: Record<string, string> = page + 40 < all.length ? { link: `<${mockBase}${base}/repository/tree?ref=${mockState.sha}&recursive=true&per_page=100&pagination=keyset&page_token=${page + 40}>; rel="next"` } : {};
    return json(200, slice, next);
  }
  const raw = /^\/api\/v4\/projects\/cap%2Fclaude-skills\/repository\/files\/(.+)\/raw$/.exec(p);
  if (raw) {
    const data = mockState.files.get(decodeURIComponent(raw[1]!));
    if (!data) return json(404, { message: "404 File Not Found" });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(Buffer.from(data));
  }
  // GitHub
  if (p === "/repos/octo/skills/commits/main") return json(200, { sha: SHA2 });
  if (p === `/repos/octo/skills/tarball/${SHA2}`) {
    res.writeHead(302, { location: `${otherBase}/codeload/octo-skills-${SHA2}.tar.gz?token=short-lived` });
    return res.end();
  }
  json(404, { message: "Not Found" });
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    gitlab(req, res);
  }).listen(0, "127.0.0.1");
  other = createServer((req, res) => {
    seen2.push({ method: req.method!, url: req.url!, headers: req.headers });
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(tarGzOf(mockState.files, `octo-skills-${SHA2.slice(0, 7)}`));
  }).listen(0, "127.0.0.1");
  await Promise.all([new Promise((r) => mock.once("listening", r)), new Promise((r) => other.once("listening", r))]);
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  // Another origin (a different port) for GitHub's codeload redirect.
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  settings = {
    ...TEST_SETTINGS,
    connections: { enabled: true, keys: { key: keyA }, allowPrivate: false, queryMaxRows: 200, queryTimeoutMs: 5000, ownHosts: [], allowLocal: true, endpoints: { gitlab: `${mockBase}/api/v4`, github: mockBase } },
    skills: { importMaxBytes: 50 * 1024 * 1024, usageDays: 365, gitHosts: [] },
  } as Settings;
  ({ db } = await freshDb());
  app = await startApp(db, settings);
});
afterAll(async () => {
  await flushSkillImports();
  await app.close();
  await db.end();
  mock.close();
  other.close();
});
beforeEach(() => {
  seen = [];
  seen2 = [];
});

async function syncAndWait(who: string, id: string, body: Record<string, unknown> = {}) {
  const r = await app.call(who, "POST", `/api/skill-sources/${id}/sync`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.status).toBe("running");
  await flushSkillImports();
  return (await app.call(who, "GET", `/api/skill-imports/${r.body.import_id}`)).body;
}
const EXCLUDE = ["plugins/im-knowledge-base/**"];

describe("a GitLab repository with the source's own token", () => {
  let sourceId: string;

  it("stores the token sealed and never shows it", async () => {
    const r = await app.call("manager", "POST", "/api/skill-sources", { name: "IM skills", provider: "gitlab", repository: "cap/claude-skills", api_url: `${mockBase}/api/v4`, token: TOKEN, exclude: EXCLUDE, no_deliver: ["evals/**"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sourceId = r.body.id;
    expect(r.body.token).toEqual({ set: true, hint: "…abcd" });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const row = (await db.query("SELECT secret FROM skill_sources WHERE id = $1", [sourceId])).rows[0];
    expect(row.secret).not.toContain(TOKEN);
    expect(JSON.stringify((await app.call("manager", "GET", "/api/skill-sources")).body)).not.toContain(TOKEN);
    const a = (await db.query("SELECT details FROM audit_log WHERE tool = 'create_skill_source' AND details IS NOT NULL")).rows[0];
    expect(JSON.stringify(a.details)).not.toContain(TOKEN);
  });

  it("imports the archive at the default branch's commit, sending the token only in a header", async () => {
    const imp = await syncAndWait("manager", sourceId);
    expect(imp).toMatchObject({ status: "done", commit: SHA1, ref: "main", layout: "marketplace" });
    expect(imp.report.added.length).toBe(14);
    expect(seen.map((s) => new URL(s.url, mockBase).pathname)).toEqual([
      "/api/v4/projects/cap%2Fclaude-skills",
      "/api/v4/projects/cap%2Fclaude-skills/repository/commits/main",
      "/api/v4/projects/cap%2Fclaude-skills/repository/archive.tar.gz",
    ]);
    for (const s of seen) {
      expect(s.headers["private-token"]).toBe(TOKEN);
      expect(s.url).not.toContain(TOKEN);
      expect(s.headers.authorization).toBeUndefined();
    }
    const v = (await db.query("SELECT v.source_commit, v.source_ref, s.source_path FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.name = 'uses-tableau'")).rows[0];
    expect(v).toEqual({ source_commit: SHA1, source_ref: "main", source_path: "plugins/alpha/skills/uses-tableau" });
    expect((await db.query("SELECT last_commit, last_error, failures FROM skill_sources WHERE id = $1", [sourceId])).rows[0]).toEqual({ last_commit: SHA1, last_error: null, failures: 0 });
  });

  it("skips the same commit without downloading; force and changed filters run again", async () => {
    let imp = await syncAndWait("manager", sourceId);
    expect(imp.report).toMatchObject({ unchanged_all: true, message: `nothing changed since ${SHA1.slice(0, 7)}` });
    expect(seen.some((s) => s.url.includes("archive"))).toBe(false);
    imp = await syncAndWait("manager", sourceId, { force: true });
    expect(seen.some((s) => s.url.includes("archive"))).toBe(true);
    expect(imp.report.unchanged.length).toBe(14);
    seen = [];
    expect((await app.call("manager", "PATCH", `/api/skill-sources/${sourceId}`, { exclude: [...EXCLUDE, "plugins/gamma/skills/hidden"] })).status).toBe(200);
    imp = await syncAndWait("manager", sourceId);
    expect(seen.some((s) => s.url.includes("archive"))).toBe(true);
    expect(imp.report.excluded.map((e: { path: string }) => e.path)).toContain("plugins/gamma/skills/hidden");
    expect(imp.report.not_covered.map((n: { name: string }) => n.name)).toEqual(["hidden"]);
    expect((await db.query("SELECT status FROM skills WHERE name = 'hidden'")).rows[0].status).toBe("active");
  });

  it("falls back to the tree and raw files when GitLab refuses the archive", async () => {
    mockState.sha = SHA2;
    mockState.archive = "429";
    mockState.files = fixtureFiles((f) => f.set("plugins/alpha/skills/plain-alpha/references/new.md", enc.encode("# New\n")));
    try {
      const imp = await syncAndWait("manager", sourceId);
      expect(imp.status, JSON.stringify(imp)).toBe("done");
      expect(imp.commit).toBe(SHA2);
      // plain-alpha's v1 was still pending: the new content supersedes it.
      expect(imp.report.changed).toEqual([expect.objectContaining({ name: "plain-alpha", from: null, to: 2, state: "pending", superseded: 1 })]);
      expect(imp.report.added).toEqual([]);
      const paths = seen.map((s) => new URL(s.url, mockBase).pathname);
      expect(paths.filter((p) => p.endsWith("/repository/tree")).length).toBeGreaterThan(1); // keyset pages
      expect(paths).toContain("/api/v4/projects/cap%2Fclaude-skills/repository/files/plugins%2Falpha%2Fskills%2Fplain-alpha%2Freferences%2Fnew.md/raw");
      for (const s of seen) expect(s.headers["private-token"]).toBe(TOKEN);
      const files = (await db.query("SELECT f.path FROM skill_files f JOIN skill_versions v ON v.id = f.version_id JOIN skills s ON s.id = v.skill_id WHERE s.name = 'plain-alpha' AND v.state = 'pending'")).rows.map((r) => r.path);
      expect(files).toContain("references/new.md");
    } finally {
      mockState.archive = "ok";
    }
  });

  it("says what the provider said, briefly, and never the token or a page", async () => {
    const mk = async (repository: string) => (await app.call("manager", "POST", "/api/skill-sources", { name: `src ${repository}`, provider: "gitlab", repository, api_url: `${mockBase}/api/v4`, token: TOKEN })).body.id;
    let imp = await syncAndWait("manager", await mk("missing/repo"));
    expect(imp).toMatchObject({ status: "failed", error: "GitLab answered 404: 404 Project Not Found" });
    imp = await syncAndWait("manager", await mk("broken/repo"));
    expect(imp.error).toBe("GitLab answered 500");
    imp = await syncAndWait("manager", await mk("echo/repo"));
    expect(imp.error).toMatch(/^GitLab answered 401: invalid token \[hidden\] x+…$/);
    expect(imp.error).not.toContain(TOKEN);
    expect(imp.error.length).toBeLessThan(240);
    const src = (await db.query("SELECT last_error, failures FROM skill_sources WHERE name = 'src echo/repo'")).rows[0];
    expect(src.failures).toBe(1);
    expect(src.last_error).not.toContain(TOKEN);
    // The first failure tells the owner.
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'skill' AND title LIKE 'Skill source src echo/repo: the import failed%'", [app.ids.manager])).rows[0].n).toBe(1);
    expect(gitError({ status: 503, text: "", headers: { "content-type": "text/html" } }, "github")).toBe("GitHub answered 503");
  });

  it("refuses own-token API URLs outside gitlab.com, api.github.com and SKILLS_GIT_HOSTS", async () => {
    const r = await app.call("manager", "POST", "/api/skill-sources", { name: "elsewhere", provider: "gitlab", repository: "a/b", api_url: "https://git.cap-cloud.co/api/v4", token: TOKEN });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/git\.cap-cloud\.co isn't one of the git hosts .* SKILLS_GIT_HOSTS/);
    const listed = { ...settings, skills: { ...settings.skills!, gitHosts: ["git.cap-cloud.co"] } };
    expect(checkSkillApiUrl("https://git.cap-cloud.co", "gitlab", listed)).toBe("https://git.cap-cloud.co/api/v4");
    expect(checkSkillApiUrl("https://github.com/", "github", settings)).toBe("https://api.github.com");
    expect(() => checkSkillApiUrl("https://user:pw@gitlab.com/api/v4", "gitlab", settings)).toThrow(/credentials/);
    expect(() => checkSkillApiUrl("http://gitlab.com/api/v4", "gitlab", settings)).toThrow(/https/);
    // A source saved while the host was listed stops when the list shrinks.
    await db.query("INSERT INTO skill_sources (name, kind, provider, repository, api_url, owner_id, created_by) VALUES ('was-listed', 'git', 'gitlab', 'a/b', 'https://git.cap-cloud.co/api/v4', $1, $1)", [app.ids.manager]);
    const id = (await db.query("SELECT id FROM skill_sources WHERE name = 'was-listed'")).rows[0].id;
    const s = await app.call("manager", "POST", `/api/skill-sources/${id}/sync`, {});
    expect(s.status).toBe(400);
    expect(s.body.error).toMatch(/isn't one of the git hosts/);
  });
});

describe("a GitHub repository", () => {
  it("follows the tarball redirect to another origin without the token", async () => {
    const r = await app.call("manager", "POST", "/api/skill-sources", { name: "GitHub skills", provider: "github", repository: "octo/skills", ref: "main", api_url: mockBase, token: GH_TOKEN, exclude: EXCLUDE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Another source owns these collections: the skills are rejected, which proves the archive arrived and was read.
    const imp = await syncAndWait("manager", r.body.id);
    expect(imp.status, JSON.stringify(imp)).toBe("done");
    expect(imp.commit).toBe(SHA2);
    expect(imp.report.rejected.find((x: { name: string }) => x.name === "uses-tableau").reasons).toEqual(["the collection 'alpha' belongs to another source"]);
    expect(seen.find((s) => s.url.includes("/tarball/"))!.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
    expect(seen2).toHaveLength(1);
    expect(seen2[0]!.headers.authorization).toBeUndefined();
  });
});

describe("a source that borrows a git connection", () => {
  let teamConn: string;
  let projectConn: string;

  beforeAll(async () => {
    const admin: RequestContext = { db, settings, actor: (await actorById(db, app.ids.admin))! };
    teamConn = (await createConnection(admin, "team", { kind: "git", name: "Team GitLab", config: { provider: "gitlab" }, secret: { token: CONN_TOKEN } })).id;
    projectConn = (await createConnection(admin, "order-service", { kind: "git", name: "Orders GitLab", config: { provider: "gitlab" }, secret: { token: CONN_TOKEN } })).id;
    mockState.files = fixtureFiles();
  });

  it("uses the Team space's connection (any Skills manager may) and its token", async () => {
    const list = await app.call("manager", "GET", "/api/skill-sources");
    expect(list.body.git_connections.map((c: { name: string }) => c.name)).toEqual(["Team GitLab"]);
    const r = await app.call("manager", "POST", "/api/skill-sources", { name: "Via team", provider: "gitlab", repository: "cap/claude-skills", connection: "Team GitLab", path: "plugins/alpha" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.connection).toMatchObject({ name: "Team GitLab", space: "team" });
    const imp = await syncAndWait("manager", r.body.id);
    expect(imp.status, JSON.stringify(imp)).toBe("done");
    for (const s of seen) expect(s.headers["private-token"]).toBe(CONN_TOKEN);
    // Switched off: a clear failure.
    await db.query("UPDATE connections SET enabled = false WHERE id = $1", [teamConn]);
    const off = await app.call("manager", "POST", `/api/skill-sources/${r.body.id}/sync`, { force: true });
    expect(off.body.error).toBe("the git connection Team GitLab is switched off");
    await db.query("UPDATE connections SET enabled = true WHERE id = $1", [teamConn]);
    const src = (await db.query<SourceRow>("SELECT * FROM skill_sources WHERE id = $1", [r.body.id])).rows[0]!;
    const ctx: RequestContext = { db, settings: { ...settings, connections: { ...settings.connections!, enabled: false } }, actor: (await actorById(db, app.ids.manager))! };
    const importId = (await db.query("INSERT INTO skill_imports (source_id, kind, started_by) VALUES ($1, 'git', $2) RETURNING id", [src.id, app.ids.manager])).rows[0].id;
    const out = await runSource(ctx, src, { importId, force: true, dryRun: false, scheduled: false });
    expect(out).toMatchObject({ status: "failed", error: "Connections are switched off (CONNECTIONS=off), so the git connection can't be used" });
  });

  it("needs Manage settings in a project to borrow its connection, at setup and on every run", async () => {
    const no = await app.call("manager", "POST", "/api/skill-sources", { name: "Via project", provider: "gitlab", repository: "cap/claude-skills", connection: "Orders GitLab" });
    expect(no.status).toBe(403);
    // carol is a Skills manager and Project admin of order-service.
    const orders = (await db.query("SELECT id FROM scopes WHERE slug = 'order-service'")).rows[0].id;
    await db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'skills_manager')", [app.ids.carol]);
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner')", [orders, app.ids.carol]);
    // A project's connection reads only the project's registered repositories.
    const unregistered = await app.call("carol", "POST", "/api/skill-sources", { name: "Via project", provider: "gitlab", repository: "cap/claude-skills", connection: projectConn, path: "plugins/beta", interval_minutes: 60 });
    expect(unregistered.status).toBe(400);
    expect(unregistered.body.error).toMatch(/reads only that project's registered repositories/);
    await db.query("INSERT INTO components (scope_id, slug, kind, repo_url) VALUES ($1, 'skills-repo', 'other', 'https://gitlab.example.com/cap/claude-skills.git')", [orders]);
    const ok = await app.call("carol", "POST", "/api/skill-sources", { name: "Via project", provider: "gitlab", repository: "cap/claude-skills", connection: projectConn, path: "plugins/beta", interval_minutes: 60 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.connection).toMatchObject({ name: "Orders GitLab", space: "order-service" });
    // She loses Project admin there: the next (scheduled) run stops with the reason.
    await db.query("DELETE FROM scope_members WHERE scope_id = $1 AND user_id = $2", [orders, app.ids.carol]);
    await db.query("UPDATE skill_sources SET next_run_at = now() - interval '1 minute' WHERE id = $1", [ok.body.id]);
    await runDueSources(db, settings, () => {});
    const last = (await db.query("SELECT status, error, scheduled FROM skill_imports WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1", [ok.body.id])).rows[0];
    expect(last).toEqual({ status: "failed", error: "the git connection Orders GitLab is no longer yours to use", scheduled: true });
    // And when the owner can't manage skills any more at all.
    await db.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'skills_manager'", [app.ids.carol]);
    await db.query("UPDATE skill_sources SET next_run_at = now() - interval '1 minute' WHERE id = $1", [ok.body.id]);
    const jobs = startSkillJobs(db, settings, () => {}, { firstDelayMs: 1e9, intervalMs: 1e9 });
    await jobs.tick();
    await jobs.stop();
    const again = (await db.query("SELECT error FROM skill_imports WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1", [ok.body.id])).rows[0];
    expect(again.error).toBe("the source's owner can't manage skills any more; a Skills manager can take it over");
    // Taking it over makes it the new owner's.
    expect((await app.call("manager", "PATCH", `/api/skill-sources/${ok.body.id}`, { owner: "me" })).body.run_as).toBe("manager@example.com");
  });

  it("keeps a members-only project's connection to that project's own sources, and never names it to others", async () => {
    const admin: RequestContext = { db, settings, actor: (await actorById(db, app.ids.admin))! };
    const vault = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility) VALUES ('project', 'git-vault', 'Git Vault', 'members') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'skills_manager') ON CONFLICT DO NOTHING", [app.ids.carol]);
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner')", [vault, app.ids.carol]);
    await db.query("INSERT INTO components (scope_id, slug, kind, repo_url) VALUES ($1, 'vault-skills', 'other', 'https://gitlab.example.com/vault/skills')", [vault]);
    const vaultConn = (await createConnection(admin, "git-vault", { kind: "git", name: "Vault GitLab", config: { provider: "gitlab" }, secret: { token: CONN_TOKEN } })).id;
    const orgWide = await app.call("carol", "POST", "/api/skill-sources", { name: "Vault org-wide", provider: "gitlab", repository: "vault/skills", connection: vaultConn });
    expect(orgWide.status).toBe(400);
    expect(orgWide.body.error).toMatch(/members-only project: only that project's own skill sources can use it/);
    const own = await app.call("carol", "POST", "/api/skill-sources", { name: "Vault own", provider: "gitlab", repository: "vault/skills", connection: vaultConn, project: "git-vault" });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    // An organisation-wide source on it from before: listed for every Skills manager, without the project's name.
    await db.query("INSERT INTO skill_sources (name, kind, provider, repository, connection_id, owner_id, created_by) VALUES ('Legacy vault', 'git', 'gitlab', 'vault/skills', $1, $2, $2)", [vaultConn, app.ids.carol]);
    const list = await app.call("manager", "GET", "/api/skill-sources");
    const legacy = list.body.sources.find((s: { name: string }) => s.name === "Legacy vault");
    expect(legacy.connection).toMatchObject({ space: null, space_name: "A members-only project" });
    expect(JSON.stringify(list.body)).not.toMatch(/git-vault|Git Vault|Vault GitLab/);
    expect((await app.call("carol", "GET", "/api/skill-sources")).body.sources.find((s: { name: string }) => s.name === "Legacy vault").connection).toMatchObject({ space: "git-vault", name: "Vault GitLab" });
    // The Team space's token doesn't read a repository registered in a project the caller can't read.
    const viaTeam = await app.call("manager", "POST", "/api/skill-sources", { name: "Via team", provider: "gitlab", repository: "vault/skills", connection: teamConn });
    expect(viaTeam.status).toBe(400);
    expect(viaTeam.body.error).toMatch(/can't read vault\/skills for you/);
  });
});

describe("tokens and the network boundary", () => {
  it("re-seals own tokens with a new key, whether or not Connections are on", async () => {
    const keyB = randomBytes(32);
    const id = (await db.query("SELECT id FROM skill_sources WHERE name = 'IM skills'")).rows[0].id;
    const rotating = { ...settings, connections: { ...settings.connections!, enabled: false, keys: { key: keyB, oldKey: keyA } } } as Settings;
    const logs: string[] = [];
    const withToken = (await db.query("SELECT count(*)::int AS n FROM skill_sources WHERE secret IS NOT NULL")).rows[0].n;
    expect(withToken).toBeGreaterThan(1);
    expect(await resealSkillSources(db, rotating, (m) => logs.push(m))).toEqual({ resealed: withToken, unreadable: 0 });
    expect(logs[0]).toMatch(new RegExp(`re-sealed ${withToken} token`));
    expect(await resealSkillSources(db, rotating, () => {})).toEqual({ resealed: 0, unreadable: 0 });
    // The source still works with the new key alone.
    const keyOnly = { ...settings, connections: { ...settings.connections!, keys: { key: keyB } } } as Settings;
    const src = (await db.query<SourceRow>("SELECT * FROM skill_sources WHERE id = $1", [id])).rows[0]!;
    const importId = (await db.query("INSERT INTO skill_imports (source_id, kind, started_by) VALUES ($1, 'git', $2) RETURNING id", [id, app.ids.manager])).rows[0].id;
    const out = await runSource({ db, settings: keyOnly, actor: (await actorById(db, app.ids.manager))! }, src, { importId, force: false, dryRun: true, scheduled: false });
    expect(out.status).toBe("done");
  });

  it("keeps skill imports off private networks unless the host is listed, and off loopback and metadata always", async () => {
    const lookup = (addr: string) => async () => [{ address: addr, family: 4 }];
    const base = { ...settings, connections: { ...settings.connections!, allowLocal: false, allowPrivate: true } } as Settings;
    const policy = (s: Settings, addr: string) => ({ ...skillsNetPolicy(s), lookup: lookup(addr) });
    await expect(resolveTarget("git.cap-cloud.co", "http", policy(base, "10.1.2.3"))).rejects.toThrow(/private network .*SKILLS_GIT_HOSTS/);
    const listed = { ...base, skills: { ...settings.skills!, gitHosts: ["git.cap-cloud.co"] } } as Settings;
    await expect(resolveTarget("git.cap-cloud.co", "http", policy(listed, "10.1.2.3"))).resolves.toMatchObject({ address: "10.1.2.3" });
    await expect(resolveTarget("other.internal", "http", policy(listed, "10.1.2.3"))).rejects.toThrow(/private network/);
    await expect(resolveTarget("git.cap-cloud.co", "http", policy(listed, "127.0.0.1"))).rejects.toThrow(/loopback/);
    await expect(resolveTarget("git.cap-cloud.co", "http", policy(listed, "169.254.169.254"))).rejects.toThrow(/metadata/);
    await expect(resolveTarget("127.0.0.1", "http", skillsNetPolicy(base))).rejects.toThrow(/loopback/);
  });
});
