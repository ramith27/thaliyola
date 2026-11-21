import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle, insertFinding, relate } from "../src/core/bootstrap.js";
import { briefChanges, buildBriefing, listBriefings, receiveGitWebhook, renderBriefing, setBriefingMode, setGitWebhook } from "../src/core/briefings.js";
import { createConnection } from "../src/core/connections/manage.js";
import type { RequestContext } from "../src/core/context.js";
import type { Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let mock: Server;
let mockBase: string;
const key = randomBytes(32);
const hits: { method: string; url: string; body: string }[] = [];
let commentSeq = 100;
const files = ["src/refunds/handler.ts", "src/refunds/retry.ts", "package-lock.json", "web/styles/buttons.css"];

const settings = (): Settings => ({
  ...TEST_SETTINGS,
  publicUrl: "https://kb.example.com",
  connections: { enabled: true, keys: { key }, allowPrivate: false, queryMaxRows: 200, queryTimeoutMs: 5000, ownHosts: [], allowLocal: true, endpoints: { github: mockBase, gitlab: `${mockBase}/gl/api/v4` } },
});
const as = async (email: string): Promise<RequestContext> => ({ ...(await ctxFor(db, { email })), settings: settings() });
let scopeId: string;
let api: { id: string; slug: string; repo_url: string };
let connId: string;
let secret: string;

beforeAll(async () => {
  mock = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", body });
      const url = req.url ?? "";
      const send = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (req.method === "GET" && url.startsWith("/repos/acme/shop-api/pulls/7/files")) return send(200, files.map((filename) => ({ filename })));
      if (req.method === "POST" && url === "/repos/acme/shop-api/issues/7/comments") return send(201, { id: ++commentSeq });
      if (req.method === "PATCH" && url.startsWith("/repos/acme/shop-api/issues/comments/")) return send(200, { id: Number(url.split("/").pop()) });
      if (req.method === "GET" && url.startsWith("/gl/api/v4/projects/acme%2Fshop-web/merge_requests/3/changes")) return send(200, { changes: [{ new_path: "src/refunds/handler.ts" }] });
      if (req.method === "POST" && url === "/gl/api/v4/projects/acme%2Fshop-web/merge_requests/3/notes") return send(201, { id: 555 });
      send(404, { message: "Not Found" });
    });
  }).listen({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => mock.once("listening", r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, {
    slug: "shop",
    name: "Shop",
    components: [
      { slug: "api", kind: "backend", repo_url: "https://github.com/acme/shop-api" },
      { slug: "web", kind: "frontend", repo_url: "https://github.com/acme/shop-web" },
    ],
  });
  await adminCreateProject(a, { slug: "secret-app", name: "Secret app", visibility: "members", components: [{ slug: "app", kind: "frontend", repo_url: "https://github.com/acme/secret" }] });
  await adminSetMember(a, "shop", "owner@example.com", "owner");
  scopeId = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  api = (await db.query("SELECT id, slug, repo_url FROM components WHERE scope_id = $1 AND slug = 'api'", [scopeId])).rows[0];
  const web = (await db.query("SELECT id FROM components WHERE scope_id = $1 AND slug = 'web'", [scopeId])).rows[0].id;
  const secretApp = (await db.query("SELECT c.id FROM components c JOIN scopes s ON s.id = c.scope_id WHERE s.slug = 'secret-app'")).rows[0].id;

  // Docs: a page whose facts cite handler.ts, and one whose sources cover src/refunds/.
  const page = await insertArticle(db, { scopeId, type: "system", title: "Refunds flow", body: "## Purpose\nRefunds." });
  const page2 = await insertArticle(db, { scopeId, type: "system", title: "Retry policy", body: "## Purpose\nRetries." });
  await db.query("INSERT INTO doc_pages (scope_id, component, key, article_id, sources) VALUES ($1, 'api', 'refunds', $2, '{src/refunds/handler.ts}'), ($1, 'api', 'retries', $3, '{src/refunds}')", [scopeId, page, page2]);
  await db.query(
    `INSERT INTO claims (article_id, section, text, evidence) VALUES ($1, 'Purpose', 'Refunds are idempotent', '[{"path":"src/refunds/handler.ts","start":10,"end":40}]'),
       ($1, 'Purpose', 'Partial refunds allowed', '[{"path":"src/refunds/handler.ts","start":50,"end":60}]')`,
    [page],
  );
  // A contract the api provides, consumed by the web app and a members-only project.
  const contract = await insertArticle(db, { scopeId, type: "api_contract", title: "Refunds API v1", body: "## Interface\nPOST /refunds" });
  await relate(db, { kind: "article", id: contract }, "provided_by", { kind: "component", id: api.id });
  await relate(db, { kind: "article", id: contract }, "consumed_by", { kind: "component", id: web });
  await relate(db, { kind: "article", id: contract }, "consumed_by", { kind: "component", id: secretApp });
  // Known issues: one naming retry.ts, one not.
  await insertFinding(db, { scopeId, type: "known_issue", title: "Double refund on timeout", symptoms: "Two refunds", rootCause: "retry.ts retries without the idempotency key", fix: "Pass the key", componentIds: [api.id] });
  await insertFinding(db, { scopeId, type: "known_issue", title: "Slow export", symptoms: "Export slow", rootCause: "No index", fix: "Index", componentIds: [api.id] });
  // A vulnerability located in a changed file.
  await db.query(
    "INSERT INTO vulnerabilities (scope_id, component, source, title, severity, location) VALUES ($1, 'api', 'reported', 'SQL injection in refund lookup', 'high', 'src/refunds/handler.ts#L22-L30')",
    [scopeId],
  );
  // Design drift: a hard-coded colour in a changed file.
  await db.query(
    `INSERT INTO design_drift_reports (scope_id, report, differences) VALUES ($1, '{"hardcoded":[{"file":"web/styles/buttons.css","value":"#7c3aed","suggestion":"probably meant primary"}]}', 1)`,
    [scopeId],
  );
  // Another session working on the retry code.
  const u = (await as("bob@example.com")).actor.id;
  const s = (await db.query("INSERT INTO agent_sessions (user_id, handle, client, scope_id, repo_url) VALUES ($1, 'bob/shop-api', 'claude-code', $2, 'git@github.com:acme/shop-api.git') RETURNING id", [u, scopeId])).rows[0].id;
  await db.query("INSERT INTO work_claims (session_id, repo_key, path, expires_at) VALUES ($1, 'github.com/acme/shop-api', 'src/refunds/retry.ts', now() + interval '1 hour')", [s]);

  const conn = await createConnection(await as("owner@example.com"), "shop", { kind: "git", name: "GitHub", config: { provider: "github" }, secret: { token: "ghp_x" } });
  connId = (conn as { id: string }).id;
});
afterAll(async () => {
  await new Promise((r) => mock.close(r));
  await db.end();
});

describe("building a briefing", () => {
  it("finds docs, contracts, known issues, vulnerabilities, lockfiles, design and other sessions for the changed paths", async () => {
    const b = await buildBriefing(db, scopeId, api, files);
    expect(b.docs.map((d) => [d.title, d.claims])).toEqual([
      ["Refunds flow", 2],
      ["Retry policy", 0],
    ]);
    expect(b.contracts).toEqual([expect.objectContaining({ title: "Refunds API v1", consumers: [{ project: "shop", repository: "web" }], hidden_consumers: 1 })]);
    expect(b.known_issues[0]).toMatchObject({ title: "Double refund on timeout", matched: "retry.ts" });
    expect(b.vulnerabilities).toEqual([expect.objectContaining({ title: "SQL injection in refund lookup", severity: "high" })]);
    expect(b.lockfiles).toEqual(["package-lock.json"]);
    expect(b.design?.hardcoded_here).toEqual([{ file: "web/styles/buttons.css", value: "#7c3aed", suggestion: "probably meant primary" }]);
    expect(b.working_here).toEqual([{ session: "bob/shop-api", owner: "bob@example.com", paths: ["src/refunds/retry.ts"] }]);
  });

  it("renders titles and links only, never a members-only project's name", async () => {
    const text = renderBriefing(await buildBriefing(db, scopeId, api, files), "https://kb.example.com", "shop");
    expect(text).toMatch(/^<!-- thaliyola-briefing -->/);
    expect(text).toMatch(/\[Refunds flow\]\(https:\/\/kb\.example\.com\/#\/article\/[0-9a-f-]{36}\): 2 facts cite `src\/refunds\/handler\.ts`/);
    expect(text).toMatch(/used by shop\/web, 1 more/);
    expect(text).not.toMatch(/secret-app|Secret app/);
    expect(text).not.toMatch(/without the idempotency key/);
  });

  it("is empty for files nothing is known about", async () => {
    const b = await buildBriefing(db, scopeId, api, ["docs/README.md"]);
    expect(b.docs.length + b.known_issues.length + b.vulnerabilities.length + b.working_here.length).toBeLessThanOrEqual(2);
  });
});

describe("the pull-request webhook", () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", secret ?? "not-set").update(body).digest("hex")}`;
  const pr = (action = "opened", sha = "abc123") =>
    JSON.stringify({
      action,
      repository: { full_name: "acme/shop-api", html_url: "https://github.com/acme/shop-api" },
      pull_request: { number: 7, title: "Retry refunds safely", html_url: "https://github.com/acme/shop-api/pull/7", user: { login: "alice" }, head: { sha }, draft: false },
    });
  const deliver = (body: string, headers: Record<string, string> = {}) =>
    receiveGitWebhook(db, settings(), connId, { "x-github-event": "pull_request", "x-hub-signature-256": sign(body), ...headers }, Buffer.from(body), (m) => { throw new Error(m); });

  it("needs a secret set by a Project admin, and refuses wrong signatures", async () => {
    expect((await deliver(pr())).status).toBe(404);
    await expect(setGitWebhook(await as("bob@example.com"), connId)).rejects.toThrow();
    const w = await setGitWebhook(await as("owner@example.com"), connId);
    secret = w.secret;
    expect(w.url).toBe(`https://kb.example.com/hooks/git/${connId}`);
    expect(w.how).toMatch(/Pull requests/);
    const body = pr();
    expect((await receiveGitWebhook(db, settings(), connId, { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=bad" }, Buffer.from(body))).status).toBe(401);
    expect((await deliver(pr(), { "x-github-event": "ping" })).body).toMatchObject({ message: "pong" });
  });

  it("does nothing while the project hasn't turned briefings on", async () => {
    expect((await deliver(pr())).body).toMatchObject({ ignored: expect.stringMatching(/off for shop/) });
  });

  it("comments once, then edits the same comment on new commits", async () => {
    await setBriefingMode(await as("owner@example.com"), "shop", "relevant");
    const first = await deliver(pr());
    expect(first.status).toBe(202);
    await first.work;
    const posted = hits.filter((h) => h.method === "POST" && h.url.endsWith("/issues/7/comments"));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!.body).body).toMatch(/Refunds flow/);
    const second = await deliver(pr("synchronize", "def456"));
    await second.work;
    expect(hits.filter((h) => h.method === "POST" && h.url.endsWith("/issues/7/comments"))).toHaveLength(1);
    expect(hits.some((h) => h.method === "PATCH" && h.url === `/repos/acme/shop-api/issues/comments/${commentSeq}`)).toBe(true);
    const list = await listBriefings(await as("owner@example.com"), "shop");
    expect(list.mode).toBe("relevant");
    expect(list.briefings[0]).toMatchObject({ number: 7, status: "posted", head_sha: "def456", items: expect.any(Number) });
  });

  it("ignores closed pull requests and repositories outside the project", async () => {
    expect((await deliver(pr("closed"))).body).toMatchObject({ ignored: expect.any(String) });
    const other = JSON.stringify({ action: "opened", repository: { full_name: "acme/elsewhere", html_url: "https://github.com/acme/elsewhere" }, pull_request: { number: 1, head: {} } });
    expect((await deliver(other)).body).toMatchObject({ ignored: expect.stringMatching(/isn't one of shop's repositories/) });
  });

  it("records a failure (and why) when the token can't comment", async () => {
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/shop-web", html_url: "https://github.com/acme/shop-web" }, pull_request: { number: 9, title: "x", head: { sha: "1" } } });
    const r = await receiveGitWebhook(db, settings(), connId, { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }, Buffer.from(body), () => {});
    await r.work;
    const row = (await db.query("SELECT status, error FROM pr_briefings WHERE number = 9")).rows[0];
    expect(row.status).toBe("failed");
  });
});

describe("for agents", () => {
  it("briefs local changes before a pull request exists", async () => {
    const r = await briefChanges(await as("owner@example.com"), { project: "shop", component: "api", paths: ["src/refunds/handler.ts"] });
    expect(r.items).toBeGreaterThan(0);
    expect(r.briefing.docs[0]!.title).toBe("Refunds flow");
    await expect(briefChanges(await as("owner@example.com"), { project: "shop", paths: [] })).rejects.toThrow(/paths/);
  });
});

describe("GitLab", () => {
  it("lists a merge request's changes and posts a note", async () => {
    const { prFiles, upsertPrComment } = await import("../src/core/connections/git.js");
    const { driverEnv } = await import("../src/core/connections/sync.js");
    const gl = { id: "g", kind: "git" as const, config: { provider: "gitlab" }, secret: { token: "glpat-x" }, options: {} };
    expect(await prFiles(gl, driverEnv(settings()), "acme/shop-web", 3)).toEqual(["src/refunds/handler.ts"]);
    expect(await upsertPrComment(gl, driverEnv(settings()), "acme/shop-web", 3, "hello", null)).toBe("555");
    expect(hits.some((h) => h.method === "POST" && h.url === "/gl/api/v4/projects/acme%2Fshop-web/merge_requests/3/notes" && JSON.parse(h.body).body === "hello")).toBe(true);
  });
});
