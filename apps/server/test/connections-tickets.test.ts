import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { ConnectionSettings, Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { createConnection, getConnection, listConnections, testConnection, updateConnection } from "../src/core/connections/manage.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  clearTrackerBackoff,
  createTicket,
  defaultDescription,
  linkTicket,
  LINKS_PER_MINUTE,
  listTickets,
  refreshDueTickets,
  TICKETS_PER_ITEM,
  TICKETS_PER_MINUTE,
} from "../src/core/connections/tickets.js";
import { jiraDescription, linearDescription, parseTicketUrl } from "../src/core/connections/trackers.js";
import type { RequestContext } from "../src/core/context.js";
import { getFinding, getArticle } from "../src/core/items.js";
import { addSourceLinkTo, createArticle, proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// ---- A mock of Jira Cloud's REST API and Linear's GraphQL API ------------------------------------------------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let mock: Server;
let mockBase: string;
const handlers = new Map<string, Handler>();
const hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const key = randomBytes(32);
let db: Db;
const PUBLIC = "https://kb.example.com";
const SITE = "https://acme.atlassian.net";
const JIRA_TOKEN = "jira-token-Zx9Qw81";
const LINEAR_KEY = "lin_api_secretkey12345";

function connSettings(extra: Partial<ConnectionSettings> = {}, more: Partial<Settings> = {}): Settings {
  return {
    ...TEST_SETTINGS,
    publicUrl: PUBLIC,
    ...more,
    connections: {
      enabled: true,
      keys: { key },
      allowPrivate: false,
      queryMaxRows: 200,
      queryTimeoutMs: 5000,
      ownHosts: ["127.0.0.1"],
      allowLocal: true,
      endpoints: { jira: mockBase, linear: mockBase },
      ...extra,
    },
  };
}
const as = async (email: string, settings = connSettings()): Promise<RequestContext> => ({ ...(await ctxFor(db, { email })), settings });
const admin = () => as("admin@example.com");
const owner = () => as("owner@example.com");
const writer = () => as("writer@example.com");
const reader = () => as("reader@example.com");
const outsider = () => as("outsider@example.com");

/** Jira issues the mock knows: key → [summary, status, category]. */
const jiraIssues = new Map<string, [string, string, string]>();
/** Linear issues: identifier → [title, state, type, workspace]. */
const linearIssues = new Map<string, [string, string, string, string]>();
let nextJira = 1;

const jiraPosts = () => hits.filter((h) => h.method === "POST" && h.url === "/rest/api/3/issue");
const issueGets = () => hits.filter((h) => h.method === "GET" && h.url.startsWith("/rest/api/3/issue/"));
const searches = () => hits.filter((h) => h.method === "POST" && h.url === "/rest/api/3/search/jql");
/** Every Jira issue key asked about: one at a time (GET) or in a search. */
const askedKeys = () => [
  ...issueGets().map((h) => h.url.split("?")[0]!.split("/").pop()!),
  ...searches().flatMap((h) => /key in \(([^)]*)\)/.exec((JSON.parse(h.body) as { jql: string }).jql)![1]!.split(/,\s*/)),
];
const gql = () => hits.filter((h) => h.url === "/graphql").map((h) => JSON.parse(h.body) as { query: string; variables: Record<string, unknown> });

function linearHandler(_req: IncomingMessage, body: string, res: ServerResponse) {
  const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
  if (_req.headers.authorization !== LINEAR_KEY) return json(res, 400, { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] });
  if (query.startsWith("query Team")) {
    const teams = variables.key === "ENG" ? [{ id: "team-eng-id", key: "ENG", name: "Engineering" }] : [];
    return json(res, 200, { data: { viewer: { name: "Bot User" }, organization: { name: "Acme", urlKey: "acme" }, teams: { nodes: teams } } });
  }
  if (query.startsWith("mutation Create")) {
    const input = variables.input as { teamId: string; title: string; description: string };
    const id = `ENG-${100 + linearIssues.size}`;
    linearIssues.set(id, [input.title, "Todo", "unstarted", "acme"]);
    return json(res, 200, { data: { issueCreate: { success: true, issue: { identifier: id, url: `https://linear.app/acme/issue/${id}/some-slug`, title: input.title, state: { name: "Todo", type: "unstarted" } } } } });
  }
  if (query.startsWith("query Issues")) {
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const [v, id] of Object.entries(variables)) {
      const alias = `i${v.slice(1)}`;
      const i = linearIssues.get(id as string);
      if (i) data[alias] = { identifier: id, url: `https://linear.app/${i[3]}/issue/${id}/slug`, title: i[0], state: { name: i[1], type: i[2] } };
      else {
        data[alias] = null;
        errors.push({ message: "Entity not found: Issue", path: [alias] });
      }
    }
    return json(res, 200, { data, ...(errors.length ? { errors } : {}) });
  }
  json(res, 400, { errors: [{ message: "unknown query" }] });
}

function jiraAuthed(req: IncomingMessage) {
  return req.headers.authorization === `Basic ${Buffer.from(`bot@acme.com:${JIRA_TOKEN}`).toString("base64")}`;
}

function defaultHandlers() {
  handlers.clear();
  handlers.set("GET /rest/api/3/myself", (req, _b, res) => (jiraAuthed(req) ? json(res, 200, { displayName: "Acme Bot", accountId: "a1" }) : json(res, 401, { errorMessages: ["Unauthorized"] })));
  handlers.set("GET /rest/api/3/project/OPS", (_req, _b, res) => json(res, 200, { key: "OPS", name: "Operations", issueTypes: [{ name: "Task" }, { name: "Bug" }, { name: "Sub-task", subtask: true }] }));
  handlers.set("POST /rest/api/3/issue", (req, body, res) => {
    if (!jiraAuthed(req)) return json(res, 401, {});
    const f = (JSON.parse(body) as { fields: { summary: string } }).fields;
    const k = `OPS-${nextJira++}`;
    jiraIssues.set(k, [f.summary, "To Do", "new"]);
    json(res, 201, { id: "10001", key: k, self: `${SITE}/rest/api/3/issue/10001` });
  });
  handlers.set("POST /graphql", linearHandler);
  // Jira's search: a key that doesn't exist fails the whole search (HTTP 400, naming it), as Jira Cloud does.
  handlers.set("POST /rest/api/3/search/jql", (req, body, res) => {
    if (!jiraAuthed(req)) return json(res, 401, {});
    const { jql, fields } = JSON.parse(body) as { jql: string; fields: string[] };
    const keys = /^key in \(([^)]*)\)$/.exec(jql)![1]!.split(/,\s*/);
    expect(fields).toEqual(["summary", "status"]);
    const missing = keys.filter((k) => !jiraIssues.has(k));
    if (missing.length) return json(res, 400, { errorMessages: missing.map((k) => `An issue with key '${k}' does not exist for field 'key'.`) });
    json(res, 200, { issues: keys.map((k) => ({ key: k, fields: { summary: jiraIssues.get(k)![0], status: { name: jiraIssues.get(k)![1], statusCategory: { key: jiraIssues.get(k)![2] } } } })) });
  });
}

function route(req: IncomingMessage, body: string, res: ServerResponse) {
  const path = (req.url ?? "").split("?")[0]!;
  const h = handlers.get(`${req.method} ${path}`);
  if (h) return h(req, body, res);
  const issue = /^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)$/.exec(path);
  if (req.method === "GET" && issue) {
    if (!jiraAuthed(req)) return json(res, 401, {});
    const i = jiraIssues.get(issue[1]!);
    return i ? json(res, 200, { key: issue[1], fields: { summary: i[0], status: { name: i[1], statusCategory: { key: i[2] } } } }) : json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
  }
  json(res, 404, { message: "no route" });
}

let jiraConn: string;
let linearConn: string;
let finding: string;
let article: string;

async function newFinding(ctx: RequestContext, project: string, title: string) {
  const r = (await proposeFinding(ctx, { project, type: "known_issue", title, symptoms: `Checkout fails with 502 (${title})`, root_cause: "The payments pool runs out of connections.", fix: "Raise the pool size.", force_new: true })) as { finding_id?: string };
  return r.finding_id!;
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body });
      route(req, body, res);
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => mock.once("listening", r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "billing", name: "Billing", visibility: "members" });
  await adminCreateProject(a, { slug: "shop", name: "Shop", visibility: "members" });
  await adminCreateProject(a, { slug: "shop-api", name: "Shop API", visibility: "members", parent: "shop" });
  await adminCreateProject(a, { slug: "lonely", name: "Lonely", visibility: "members" });
  await adminCreateProject(a, { slug: "open", name: "Open", visibility: "team" });
  // Team-visible with nobody in it: anyone signed in may propose there.
  await adminCreateProject(a, { slug: "plaza", name: "Plaza", visibility: "team" });
  // Someone in the sub-project only: the project above (and its connections) isn't theirs to read.
  await adminSetMember(a, "shop-api", "sub@example.com", "writer");
  for (const p of ["billing", "shop", "lonely", "open"]) {
    await adminSetMember(a, p, "owner@example.com", "owner");
    await adminSetMember(a, p, "writer@example.com", "writer");
    await adminSetMember(a, p, "reader@example.com", "reader");
  }
  defaultHandlers();
  const o = await owner();
  jiraConn = (await createConnection(o, "billing", { kind: "jira", name: "Ops Jira", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS" }, secret: { api_token: JIRA_TOKEN } })).id;
  linearConn = (await createConnection(o, "shop", { kind: "linear", name: "Eng Linear", config: { team: "ENG" }, secret: { api_key: LINEAR_KEY } })).id;
  finding = await newFinding(await writer(), "billing", "Checkout 502s at peak");
  const art = (await createArticle(await writer(), { project: "shop-api", type: "runbook", title: "Restarting the shop API", body_md: "## Steps\n\nRestart the pods one at a time.\n\n<!-- thaliyola:sync -->hidden<!-- /thaliyola:sync -->" })) as { article_id?: string };
  article = art.article_id!;
});
afterAll(async () => {
  // A slow-tracker response may still be pending: don't wait for it.
  mock?.closeAllConnections();
  if (mock) await new Promise((r) => mock.close(r));
  await db?.end();
});
beforeEach(async () => {
  hits.length = 0;
  defaultHandlers();
  // Each test starts with the per-minute ticket budgets unused, and no tracker rate limiting.
  await db.query("UPDATE connection_calls SET at = at - interval '2 minutes' WHERE kind = 'ticket'");
  await db.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool = 'link_ticket'");
  clearTrackerBackoff();
});

describe("issue tracker URLs", () => {
  it("reads Jira and Linear issue links, and nothing else", () => {
    expect(parseTicketUrl("https://acme.atlassian.net/browse/OPS-12")).toMatchObject({ tracker: "jira", key: "OPS-12", url: "https://acme.atlassian.net/browse/OPS-12", host: "acme.atlassian.net" });
    expect(parseTicketUrl("https://Acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=ops-7")).toMatchObject({ key: "OPS-7", url: "https://acme.atlassian.net/browse/OPS-7" });
    expect(parseTicketUrl("https://linear.app/acme/issue/ENG-42/fix-the-thing")).toMatchObject({ tracker: "linear", key: "ENG-42", url: "https://linear.app/acme/issue/ENG-42", workspace: "acme" });
    for (const bad of [
      "http://acme.atlassian.net/browse/OPS-1",
      "https://acme.atlassian.net:8443/browse/OPS-1",
      "https://user:pw@acme.atlassian.net/browse/OPS-1",
      "https://evil.example.com/browse/OPS-1",
      "https://acme.atlassian.net.evil.com/browse/OPS-1",
      "https://acme.atlassian.net/browse/OPS-0",
      "https://acme.atlassian.net/jira/software/projects/OPS/boards/1",
      "https://linear.app/acme/project/roadmap",
      "not a url",
    ])
      expect(parseTicketUrl(bad), bad).toBeNull();
  });

  it("writes descriptions that link back, in Jira's document format and Linear's Markdown", () => {
    const t = { title: "T", description: "First line\nsecond line\n\nNext paragraph", link: `${PUBLIC}/#/finding/x`, linkLabel: "Checkout [502s]" };
    const doc = jiraDescription(t);
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0]!.content!.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
    expect(doc.content[2]!.content![1]).toEqual({ type: "text", text: "Checkout [502s]", marks: [{ type: "link", attrs: { href: `${PUBLIC}/#/finding/x` } }] });
    expect(linearDescription(t)).toBe(`First line\nsecond line\n\nNext paragraph\n\nFrom Thaliyola: [Checkout 502s](${PUBLIC}/#/finding/x)`);
    expect(defaultDescription({ kind: "finding", body: null, symptoms: "S", root_cause: "R", fix: "" })).toBe("Symptoms:\nS\n\nRoot cause:\nR");
    expect(defaultDescription({ kind: "article", body: "Intro <!-- thaliyola:sync -->x<!-- /thaliyola:sync -->", symptoms: null, root_cause: null, fix: null })).toBe("Intro");
  });
});

describe("Jira and Linear connections", () => {
  it("are validated: Jira Cloud sites only, project and team keys, secrets never returned", async () => {
    const o = await owner();
    await expect(createConnection(o, "billing", { kind: "jira", config: { site_url: "https://jira.internal.example.com", email: "bot@acme.com", project_key: "OPS" }, secret: { api_token: "x" } })).rejects.toThrow(/Jira Cloud address/);
    await expect(createConnection(o, "billing", { kind: "jira", config: { site_url: SITE, email: "bot@acme.com", project_key: "ops" }, secret: { api_token: "x" } })).rejects.toThrow(/Project key/);
    await expect(createConnection(o, "billing", { kind: "jira", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS" } })).rejects.toThrow(/API token is required/);
    await expect(createConnection(o, "shop", { kind: "linear", config: { team: "eng team" }, secret: { api_key: "k" } })).rejects.toThrow(/Team key/);
    const c = await getConnection(o, jiraConn);
    expect(c).toMatchObject({ kind: "jira", group: "tracker", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS", issue_type: "Task" } });
    expect(JSON.stringify(c)).not.toContain(JIRA_TOKEN);
    expect(c.secrets.api_token).toEqual({ set: true, hint: JIRA_TOKEN.slice(-4) });
    // Readers see that it exists, not how it's set up.
    const list = await listConnections(await reader(), "billing");
    expect(list.connections[0]).not.toHaveProperty("config");
    // Pointing it at another site (or account) means entering the token again.
    await expect(updateConnection(o, jiraConn, { config: { site_url: "https://other.atlassian.net", email: "bot@acme.com", project_key: "OPS" } })).rejects.toThrow(/entered again/);
  });

  it("Test checks the account, the project and its issue type (Jira) or the team (Linear), and creates nothing", async () => {
    const o = await owner();
    const j = await testConnection(o, jiraConn);
    expect(j).toMatchObject({ ok: true, health: "ok" });
    expect(j.ok && j.detail).toBe("Connected to Jira as Acme Bot. New issues go to OPS (Operations) as Task.");
    expect(jiraPosts()).toHaveLength(0);
    const l = await testConnection(o, linearConn);
    expect(l.ok && l.detail).toBe("Connected to Linear (Acme) as Bot User. New issues go to the Engineering team (ENG).");
    expect(gql().every((q) => !q.query.startsWith("mutation"))).toBe(true);

    // An issue type the project doesn't have: it works, with a warning.
    const bugs = (await createConnection(o, "lonely", { kind: "jira", name: "Bugs", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS", issue_type: "Incident" }, secret: { api_token: JIRA_TOKEN } })).id;
    const w = await testConnection(o, bugs);
    expect(w.ok && w.warning).toMatch(/no issue type "Incident"; it has Task, Bug/);
    // A token Jira refuses.
    await updateConnection(o, bugs, { secret: { api_token: "wrong-token" } });
    const bad = await testConnection(o, bugs);
    expect(bad).toMatchObject({ ok: false, health: "failing" });
    expect(!bad.ok && bad.error).toMatch(/didn't accept the email and API token/);
    // A team the key can't see.
    const other = (await createConnection(o, "lonely", { kind: "linear", name: "Design Linear", config: { team: "DES" }, secret: { api_key: LINEAR_KEY } })).id;
    expect(await testConnection(o, other)).toMatchObject({ ok: false, error: expect.stringMatching(/no team with the key DES/) });
    await db.query("DELETE FROM connections WHERE id = ANY($1)", [[bugs, other]]);
  });
});

describe("create_ticket", () => {
  it("opens a Jira issue for a finding, linking back, and links the issue on the finding", async () => {
    const w = await writer();
    const r = await createTicket(w, { item: finding });
    expect(r.ticket).toMatchObject({ tracker: "jira", key: "OPS-1", url: `${SITE}/browse/OPS-1`, title: "Checkout 502s at peak", status: "To Do", category: "todo", connection: { id: jiraConn, name: "Ops Jira" } });
    const post = jiraPosts()[0]!;
    const fields = (JSON.parse(post.body) as { fields: Record<string, unknown> }).fields;
    expect(fields).toMatchObject({ project: { key: "OPS" }, issuetype: { name: "Task" }, summary: "Checkout 502s at peak" });
    const text = JSON.stringify(fields.description);
    expect(text).toContain("Root cause:");
    expect(text).toContain(`"href":"${PUBLIC}/#/finding/${finding}"`);
    // The link is a source link on the finding, with the status the tracker gave.
    const f = await getFinding(w, finding);
    expect(f.source_links).toContainEqual(expect.objectContaining({ system: "jira", url: `${SITE}/browse/OPS-1`, label: "OPS-1: Checkout 502s at peak", ticket: expect.objectContaining({ key: "OPS-1", status: "To Do", category: "todo" }) }));
    // Logged: the call (no secrets) and the audit log.
    const calls = (await db.query<{ kind: string; text: string; status: number }>("SELECT kind, text, status FROM connection_calls WHERE connection_id = $1 AND kind = 'ticket'", [jiraConn])).rows;
    expect(calls).toEqual([{ kind: "ticket", text: `create OPS-1 for finding ${finding}`, status: 201 }]);
    expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'create_ticket' AND target_id = $1", [finding])).rowCount).toBe(1);
  });

  it("takes a title and description, and opens Linear issues through a project above (articles too)", async () => {
    const w = await writer();
    const r = await createTicket(w, { item: article, title: "Automate the shop API restart", description: "Restarting by hand takes 20 minutes." });
    expect(r.ticket).toMatchObject({ tracker: "linear", key: "ENG-100", url: "https://linear.app/acme/issue/ENG-100", title: "Automate the shop API restart", status: "Todo", category: "todo", connection: { name: "Eng Linear" } });
    const create = gql().find((q) => q.query.startsWith("mutation"))!;
    expect(create.variables.input).toEqual({
      teamId: "team-eng-id",
      title: "Automate the shop API restart",
      description: `Restarting by hand takes 20 minutes.\n\nFrom Thaliyola: [Restarting the shop API](${PUBLIC}/#/article/${article})`,
    });
    expect(hits.find((h) => h.url === "/graphql")!.headers.authorization).toBe(LINEAR_KEY);
    expect((await getArticle(w, article)).source_links[0]).toMatchObject({ system: "linear", ticket: { key: "ENG-100" } });
  });

  it("needs Propose in the item's project, a tracker that reaches it, and one choice when there are several", async () => {
    await expect(createTicket(await reader(), { item: finding })).rejects.toThrow(/can't propose/);
    await expect(createTicket(await outsider(), { item: finding })).rejects.toThrow(/not found/);
    const lonely = await newFinding(await writer(), "lonely", "Nothing to file it in");
    await expect(createTicket(await writer(), { item: lonely })).rejects.toThrow(/no Jira or Linear connection reaches lonely/);
    await expect(createTicket(await writer(), { item: finding, connection: "Eng Linear" })).rejects.toThrow(/Ops Jira \(billing\)/);
    // The Team space's trackers reach every team-visible project; the project's own come first.
    const a = await admin();
    const team = (await createConnection(a, "team", { kind: "linear", name: "Team Linear", config: { team: "ENG" }, secret: { api_key: LINEAR_KEY } })).id;
    const open = await newFinding(await writer(), "open", "Seen by everyone");
    expect((await createTicket(await writer(), { item: open })).ticket.connection).toMatchObject({ name: "Team Linear" });
    // A members-only project's content never goes to the Team space's trackers (as with notification routes).
    const before = gql().length;
    await expect(createTicket(await writer(), { item: lonely })).rejects.toThrow(/lonely is members-only, so its findings and articles don't go to the Team space's issue trackers/);
    await expect(createTicket(await writer(), { item: finding, connection: "team linear" })).rejects.toThrow(/billing is members-only.*use one of the project's own \(Ops Jira \(billing\)\)/);
    expect(gql().length).toBe(before);
    expect(await listTickets(await writer(), lonely)).toMatchObject({ can_create: false, trackers: [], create_blocked: expect.stringMatching(/members-only/) });
    expect((await createTicket(await writer(), { item: finding })).ticket.connection).toMatchObject({ name: "Ops Jira" });
    // Two in the project itself: say which.
    const second = (await createConnection(await owner(), "billing", { kind: "linear", name: "Billing Linear", config: { team: "ENG" }, secret: { api_key: LINEAR_KEY } })).id;
    await expect(createTicket(await writer(), { item: finding })).rejects.toThrow(/several issue trackers; pass connection \(one of: Billing Linear \(billing\), Ops Jira \(billing\)\)/);
    // Paused ones aren't used.
    await updateConnection(await owner(), second, { enabled: false });
    await expect(createTicket(await writer(), { item: finding, connection: "Billing Linear" })).rejects.toThrow(/paused/);
    await db.query("DELETE FROM connections WHERE id = ANY($1)", [[team, second]]);
    // Without PUBLIC_URL the issue couldn't link back.
    await expect(createTicket(await as("writer@example.com", connSettings({}, { publicUrl: undefined })), { item: finding })).rejects.toThrow(/PUBLIC_URL/);
    // Connections off.
    await expect(createTicket(await as("writer@example.com", connSettings({ enabled: false })), { item: finding })).rejects.toThrow(/turned off/);
  });

  it("reports the tracker's refusal without the token, and marks the connection failing when its token stops working", async () => {
    handlers.set("POST /rest/api/3/issue", (_req, _b, res) => json(res, 400, { errorMessages: [], errors: { summary: `bad summary near ${JIRA_TOKEN}` } }));
    const err = await createTicket(await writer(), { item: finding }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Ops Jira didn't create the issue: Jira didn't create the issue \(HTTP 400\): summary: bad summary near/);
    expect(String(err)).not.toContain(JIRA_TOKEN);
    const logged = (await db.query<{ error: string }>("SELECT error FROM connection_calls WHERE kind = 'ticket' AND error IS NOT NULL ORDER BY at DESC LIMIT 1")).rows[0]!;
    expect(logged.error).not.toContain(JIRA_TOKEN);
    handlers.set("POST /rest/api/3/issue", (_req, _b, res) => json(res, 401, {}));
    await expect(createTicket(await writer(), { item: finding })).rejects.toThrow(/didn't accept/);
    expect((await db.query<{ health: string }>("SELECT health FROM connections WHERE id = $1", [jiraConn])).rows[0]!.health).toBe("failing");
  });

  it("doesn't follow redirects (credentials never leave the site)", async () => {
    let followed = false;
    handlers.set("GET /elsewhere", (_req, _b, res) => {
      followed = true;
      json(res, 200, {});
    });
    handlers.set("POST /rest/api/3/issue", (_req, _b, res) => res.writeHead(307, { location: `${mockBase}/elsewhere` }).end());
    await expect(createTicket(await writer(), { item: finding })).rejects.toThrow(/HTTP 307/);
    expect(followed).toBe(false);
  });

  it("is limited to 10 tickets a minute per person", async () => {
    await db.query("DELETE FROM connection_calls WHERE kind = 'ticket'");
    const w = await writer();
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'writer@example.com'");
    for (let i = 0; i < TICKETS_PER_MINUTE; i++) await db.query("INSERT INTO connection_calls (connection_id, actor_id, kind, text) VALUES ($1, $2, 'ticket', 'x')", [jiraConn, rows[0]!.id]);
    await expect(createTicket(w, { item: finding })).rejects.toThrow(/10 tickets in a minute/);
    await db.query("UPDATE connection_calls SET at = at - interval '2 minutes' WHERE kind = 'ticket'");
  });
});

describe("link_ticket and the cached status", () => {
  it("links an existing issue by URL once, and reads its status through the connection for that site", async () => {
    jiraIssues.set("OPS-77", ["Pool exhaustion", "In Progress", "indeterminate"]);
    const item = await newFinding(await writer(), "billing", "Pool exhaustion at noon");
    const r = await linkTicket(await writer(), { item, url: "https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-77" });
    expect(r).toMatchObject({ linked: true, ticket: { key: "OPS-77", url: `${SITE}/browse/OPS-77`, title: "Pool exhaustion", status: "In Progress", category: "in_progress", connection: { name: "Ops Jira" } } });
    expect(await linkTicket(await writer(), { item, url: `${SITE}/browse/OPS-77` })).toMatchObject({ linked: false, already_linked: true });
    // Another site: linked, but nothing reads its status.
    const other = await linkTicket(await writer(), { item, url: "https://elsewhere.atlassian.net/browse/OPS-77" });
    expect(other).toMatchObject({ linked: true, ticket: { connection: null, status: null, category: "unknown" }, note: expect.stringMatching(/No Jira connection for elsewhere.atlassian.net/) });
    await expect(linkTicket(await writer(), { item, url: "https://github.com/acme/shop/issues/1" })).rejects.toThrow(/isn't a Jira issue link/);
    await expect(linkTicket(await writer(), { item, url: `${SITE}/browse/OPS-78`, connection: "Eng Linear" })).rejects.toThrow(/issue tracker connection "Eng Linear"/);
    await expect(linkTicket(await reader(), { item, url: `${SITE}/browse/OPS-78` })).rejects.toThrow(/can't propose/);
    // A missing issue is linked with the tracker's answer as its error.
    const gone = await linkTicket(await writer(), { item, url: `${SITE}/browse/OPS-999` });
    expect(gone.ticket).toMatchObject({ key: "OPS-999", error: expect.stringMatching(/no issue OPS-999/) });
  });

  it("add_source_link with system jira or linear makes a ticket too", async () => {
    linearIssues.set("ENG-5", ["Cache warmup", "Done", "completed", "acme"]);
    const item = await newFinding(await writer(), "shop", "Cold cache after deploys");
    await addSourceLinkTo(await writer(), item, { system: "linear", url: "https://linear.app/acme/issue/ENG-5/cache-warmup" });
    await addSourceLinkTo(await writer(), item, { system: "jira", url: `${SITE}/secure/Dashboard.jspa` });
    const before = await listTickets(await reader(), item, { refresh: false });
    expect(before.tickets).toEqual([expect.objectContaining({ key: "ENG-5", status: null, checked_at: null, connection: expect.objectContaining({ name: "Eng Linear" }) })]);
    // Viewing refreshes it, and readers may view.
    const viewed = await listTickets(await reader(), item);
    expect(viewed.tickets[0]).toMatchObject({ title: "Cache warmup", status: "Done", category: "done" });
    expect(viewed).toMatchObject({ can_link: false, can_create: false, trackers: [] });
    // A Linear link into another workspace isn't the connection's issue.
    linearIssues.set("ENG-6", ["Same key, other workspace", "Todo", "unstarted", "acme"]);
    const wrong = await linkTicket(await writer(), { item, url: "https://linear.app/other-co/issue/ENG-6" });
    expect(wrong.ticket.error).toMatch(/for the Linear workspace acme; this issue is in other-co/);
  });

  it("is refreshed on view only when the cache is old, and by the job (closed issues less often)", async () => {
    jiraIssues.set("OPS-80", ["Slow refunds", "To Do", "new"]);
    const item = await newFinding(await writer(), "billing", "Slow refunds");
    await linkTicket(await writer(), { item, url: `${SITE}/browse/OPS-80` });
    hits.length = 0;
    jiraIssues.set("OPS-80", ["Slow refunds", "Done", "done"]);
    const w = await writer();
    expect((await listTickets(w, item)).tickets[0]!.status).toBe("To Do");
    expect(issueGets()).toHaveLength(0);
    await db.query("UPDATE tickets SET checked_at = now() - interval '6 minutes' WHERE key = 'OPS-80'");
    const fresh = await listTickets(w, item);
    expect(fresh.tickets[0]).toMatchObject({ status: "Done", category: "done" });
    expect(fresh).toMatchObject({ can_link: true, can_create: true, trackers: [expect.objectContaining({ name: "Ops Jira", destination: "OPS", site: "acme.atlassian.net" })] });
    expect(issueGets()).toHaveLength(1);

    // The job: open tickets after 30 minutes, closed ones after a day.
    await db.query("UPDATE tickets SET checked_at = now() - interval '2 hours'");
    hits.length = 0;
    await refreshDueTickets(db, connSettings());
    const asked = new Set(askedKeys());
    expect(asked.has("OPS-77")).toBe(true);
    expect(asked.has("OPS-80")).toBe(false);
    // A token that stops working: every ticket of the connection says so, and the connection shows failing.
    await db.query("UPDATE tickets SET checked_at = now() - interval '2 hours'");
    await db.query("UPDATE connections SET health = 'ok' WHERE id = $1", [jiraConn]);
    handlers.set("GET /rest/api/3/issue/OPS-77", (_req, _b, res) => json(res, 401, {}));
    handlers.set("POST /rest/api/3/search/jql", (_req, _b, res) => json(res, 401, {}));
    await refreshDueTickets(db, connSettings());
    const t77 = (await db.query<{ error: string }>("SELECT error FROM tickets WHERE key = 'OPS-77'")).rows[0]!;
    expect(t77.error).toMatch(/didn't accept the email and API token/);
    expect((await db.query<{ health: string }>("SELECT health FROM connections WHERE id = $1", [jiraConn])).rows[0]!.health).toBe("failing");
  });

  it("attaches tickets to a connection added later, and detaches them when the connection moves away", async () => {
    const item = await newFinding(await writer(), "lonely", "Linked before Jira was connected");
    jiraIssues.set("OPS-90", ["Later", "In Review", "indeterminate"]);
    const r = await linkTicket(await writer(), { item, url: `${SITE}/browse/OPS-90` });
    expect(r.ticket.connection).toBeNull();
    const conn = (await createConnection(await owner(), "lonely", { kind: "jira", name: "Lonely Jira", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS" }, secret: { api_token: JIRA_TOKEN } })).id;
    await refreshDueTickets(db, connSettings());
    expect((await listTickets(await writer(), item, { refresh: false })).tickets[0]).toMatchObject({ status: "In Review", connection: { id: conn } });
    // The item moves to a project that can't use that connection: the ticket isn't read through it any more.
    await db.query("UPDATE findings SET scope_id = (SELECT id FROM scopes WHERE slug = 'shop') WHERE id = $1", [item]);
    await db.query("UPDATE tickets SET checked_at = NULL");
    await refreshDueTickets(db, connSettings());
    expect((await db.query<{ connection_id: string | null }>("SELECT t.connection_id FROM tickets t JOIN source_links l ON l.id = t.source_link_id WHERE l.target_id = $1", [item])).rows[0]!.connection_id).toBeNull();
    await db.query("DELETE FROM connections WHERE id = $1", [conn]);
  });
});

describe("which issues a connection reads", () => {
  it("Jira: only its own project's, unless a Project admin allows more; others stay plain links, never fetched", async () => {
    const item = await newFinding(await writer(), "billing", "Linked from another project");
    jiraIssues.set("HR-7", ["Salary review: Jane Doe", "To Do", "new"]);
    hits.length = 0;
    const r = await linkTicket(await writer(), { item, url: `${SITE}/browse/HR-7` });
    expect(r).toMatchObject({
      linked: true,
      ticket: { key: "HR-7", title: null, status: null, connected: false, connection: null, error: expect.stringMatching(/^Not in this tracker's project: the connection reads OPS issues only/) },
      note: expect.stringMatching(/Not in this tracker's project/),
    });
    // Not on view, not by the job.
    await db.query("UPDATE tickets SET checked_at = now() - interval '2 hours' WHERE key = 'HR-7'");
    await listTickets(await reader(), item);
    await refreshDueTickets(db, connSettings());
    expect(askedKeys()).not.toContain("HR-7");
    expect(JSON.stringify(await getFinding(await reader(), item))).not.toContain("Salary");
    // Naming the connection doesn't get around it.
    await expect(linkTicket(await writer(), { item, url: `${SITE}/browse/SEC-1`, connection: "Ops Jira" })).rejects.toThrow(/Ops Jira reads OPS issues only; SEC-1 isn't one/);
    await expect(updateConnection(await owner(), jiraConn, { options: { allowed_projects: ["not a key"] } })).rejects.toThrow(/allowed_projects lists Jira project keys/);

    // A Project admin allows HR: read from then on (the job picks it up).
    await updateConnection(await owner(), jiraConn, { options: { allowed_projects: ["hr"] } });
    expect((await getConnection(await owner(), jiraConn)).options).toEqual({ allowed_projects: ["HR"] });
    await db.query("UPDATE tickets SET checked_at = NULL WHERE key = 'HR-7'");
    await refreshDueTickets(db, connSettings());
    expect((await listTickets(await reader(), item, { refresh: false })).tickets[0]).toMatchObject({ title: "Salary review: Jane Doe", connected: true, error: null });
    // Allowed no more: what was read is forgotten.
    await updateConnection(await owner(), jiraConn, { options: {} });
    await db.query("UPDATE tickets SET checked_at = now() - interval '2 hours' WHERE key = 'HR-7'");
    await refreshDueTickets(db, connSettings());
    expect((await listTickets(await reader(), item, { refresh: false })).tickets[0]).toMatchObject({ title: null, status: null, connected: false, error: expect.stringMatching(/reads OPS issues only/) });
  });

  it("Linear: only its own team's, unless more are allowed (* for any)", async () => {
    linearIssues.set("DES-3", ["Design review notes", "Todo", "unstarted", "acme"]);
    const item = await newFinding(await writer(), "shop", "Linked design issue");
    const before = gql().length;
    const r = await linkTicket(await writer(), { item, url: "https://linear.app/acme/issue/DES-3/notes" });
    expect(r.ticket).toMatchObject({ key: "DES-3", title: null, connected: false, error: expect.stringMatching(/^Not in this tracker's team: the connection reads ENG issues only/) });
    expect(gql().length).toBe(before);
    await updateConnection(await owner(), linearConn, { options: { allowed_teams: ["*"] } });
    await db.query("UPDATE tickets SET checked_at = NULL WHERE key = 'DES-3'");
    await refreshDueTickets(db, connSettings());
    expect((await listTickets(await reader(), item, { refresh: false })).tickets[0]).toMatchObject({ title: "Design review notes", status: "Todo", connected: true });
    await updateConnection(await owner(), linearConn, { options: {} });
  });

  it("someone with no role anywhere, proposing in a team-visible project, can't read issues outside the Team tracker's project", async () => {
    const teamJira = (await createConnection(await admin(), "team", { kind: "jira", name: "Team Jira", config: { site_url: SITE, email: "bot@acme.com", project_key: "OPS" }, secret: { api_token: JIRA_TOKEN } })).id;
    try {
      jiraIssues.set("HR-7", ["Salary review: Jane Doe", "To Do", "new"]);
      hits.length = 0;
      const out = await outsider();
      const r = (await proposeFinding(out, {
        project: "plaza",
        type: "known_issue",
        title: "Probing HR",
        symptoms: "s",
        root_cause: "r",
        source_links: [
          { system: "jira", url: `${SITE}/browse/HR-7` },
          { system: "jira", url: `${SITE}/browse/OPS-77` },
        ],
        force_new: true,
      })) as { finding_id: string };
      const list = await listTickets(out, r.finding_id);
      expect(list.tickets.find((t) => t.key === "HR-7")).toMatchObject({ title: null, connected: false });
      expect(list.tickets.find((t) => t.key === "OPS-77")).toMatchObject({ title: "Pool exhaustion", connected: true });
      expect(askedKeys()).not.toContain("HR-7");
    } finally {
      await db.query("DELETE FROM connections WHERE id = $1", [teamJira]);
    }
  });

  it("doesn't name connections of a project above that the caller can't read", async () => {
    const sub = await as("sub@example.com");
    const list = await listTickets(sub, article, { refresh: false });
    expect(list.trackers).toEqual([expect.objectContaining({ name: "Eng Linear", scope: null, scope_name: "a project above" })]);
    expect(list.tickets[0]).toMatchObject({ key: "ENG-100", connected: true, connection: null });
    // People who can read that project see it.
    expect((await listTickets(await writer(), article, { refresh: false })).tickets[0]!.connection).toMatchObject({ name: "Eng Linear" });
    await expect(createTicket(sub, { item: article, connection: "Nope" })).rejects.toThrow(/it can use: Eng Linear \(a project above\)/);
  });
});

describe("limits", () => {
  it("links an issue once per item, whichever way and however often it's added", async () => {
    const w = await writer();
    const item = await newFinding(w, "billing", "Linked three ways at once");
    const results = await Promise.all([
      addSourceLinkTo(w, item, { system: "jira", url: `${SITE}/browse/OPS-77` }),
      addSourceLinkTo(w, item, { system: "jira", url: "https://ACME.atlassian.net/browse/ops-77" }),
      linkTicket(w, { item, url: `${SITE}/jira/software/projects/OPS/boards/1?selectedIssue=OPS-77` }),
    ]);
    expect(results).toHaveLength(3);
    expect((await listTickets(w, item, { refresh: false })).tickets.map((t) => t.key)).toEqual(["OPS-77"]);
    expect((await getFinding(w, item)).source_links.filter((l: { system: string }) => l.system === "jira")).toEqual([expect.objectContaining({ url: `${SITE}/browse/OPS-77` })]);
    // A new finding given the same issue twice.
    const made = (await proposeFinding(w, {
      project: "shop",
      type: "known_issue",
      title: "Same issue twice",
      symptoms: "s",
      root_cause: "r",
      source_links: [
        { system: "linear", url: "https://linear.app/acme/issue/ENG-5/a" },
        { system: "linear", url: "https://linear.app/acme/issue/eng-5/b" },
      ],
      force_new: true,
    })) as { finding_id: string };
    expect((await listTickets(w, made.finding_id, { refresh: false })).tickets.map((t) => t.url)).toEqual(["https://linear.app/acme/issue/ENG-5"]);
    // The database refuses a second link too.
    await expect(db.query("INSERT INTO source_links (target_kind, target_id, system, url) VALUES ('finding', $1, 'jira', $2)", [item, `${SITE}/browse/OPS-77`])).rejects.toThrow(/source_links_one_issue/);
  });

  it("is 30 links a minute per person (no request made past it), and 25 tickets per item", async () => {
    const w = await writer();
    const uid = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'writer@example.com'")).rows[0]!.id;
    const item = await newFinding(w, "billing", "Linked too often");
    await db.query("INSERT INTO audit_log (actor_id, tool, target_id) SELECT $1, 'link_ticket', $2 FROM generate_series(1, $3::int)", [uid, item, LINKS_PER_MINUTE]);
    hits.length = 0;
    await expect(linkTicket(w, { item, url: `${SITE}/browse/OPS-80` })).rejects.toThrow(/30 tickets linked in a minute/);
    await expect(addSourceLinkTo(w, item, { system: "jira", url: `${SITE}/browse/OPS-81` })).rejects.toThrow(/30 tickets linked in a minute/);
    expect(hits).toHaveLength(0);
    // Plain links (not an issue) aren't tickets, and aren't counted.
    await addSourceLinkTo(w, item, { system: "jira", url: `${SITE}/secure/Dashboard.jspa` });
    await db.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool = 'link_ticket'");

    const full = await newFinding(w, "billing", "Full of tickets");
    await db.query("INSERT INTO source_links (target_kind, target_id, system, url) SELECT 'finding', $1, 'jira', $2 || '/browse/OPS-' || (2000 + g) FROM generate_series(1, $3::int) g", [full, SITE, TICKETS_PER_ITEM]);
    await db.query("INSERT INTO tickets (source_link_id, tracker, key, checked_at) SELECT id, 'jira', substring(url from '[A-Z]+-[0-9]+$'), now() FROM source_links WHERE target_id = $1", [full]);
    await expect(linkTicket(w, { item: full, url: `${SITE}/browse/OPS-82` })).rejects.toThrow(/has 25 tickets, the most one can have/);
    await expect(createTicket(w, { item: full })).rejects.toThrow(/has 25 tickets/);
    expect(jiraPosts()).toHaveLength(0);
    expect(await listTickets(w, full, { refresh: false })).toMatchObject({ can_link: false, can_create: false, create_blocked: expect.stringMatching(/25 tickets/) });
  });

  it("refuses items in a personal space or in the trash, and the job skips trashed ones", async () => {
    const w = await writer();
    const mine = (await proposeFinding(w, { scope: "me", type: "known_issue", title: "Just mine", symptoms: "s", root_cause: "r", force_new: true })) as { finding_id: string };
    await expect(linkTicket(w, { item: mine.finding_id, url: `${SITE}/browse/OPS-77` })).rejects.toThrow(/personal space/);
    await expect(createTicket(w, { item: mine.finding_id })).rejects.toThrow(/personal space/);

    jiraIssues.set("OPS-83", ["Trashed later", "To Do", "new"]);
    const item = await newFinding(w, "billing", "Trashed with its ticket");
    await linkTicket(w, { item, url: `${SITE}/browse/OPS-83` });
    await db.query("UPDATE findings SET status = 'deleted' WHERE id = $1", [item]);
    await expect(linkTicket(w, { item, url: `${SITE}/browse/OPS-84` })).rejects.toThrow(/not found/);
    await expect(linkTicket(await owner(), { item, url: `${SITE}/browse/OPS-84` })).rejects.toThrow(/in the trash/);
    await expect(createTicket(await owner(), { item })).rejects.toThrow(/in the trash/);
    await db.query("UPDATE tickets SET checked_at = now() - interval '2 hours' WHERE key = 'OPS-83'");
    hits.length = 0;
    await refreshDueTickets(db, connSettings());
    expect(askedKeys()).not.toContain("OPS-83");
  });
});

describe("refreshing Jira", () => {
  let item: string;
  beforeAll(async () => {
    item = await newFinding(await writer(), "billing", "Ten tickets at once");
    for (let i = 1; i <= 10; i++) jiraIssues.set(`OPS-3${i}`, [`Issue ${i}`, "To Do", "new"]);
    await db.query(
      "WITH l AS (INSERT INTO source_links (target_kind, target_id, system, url) SELECT 'finding', $1, 'jira', $2 || '/browse/OPS-3' || g FROM generate_series(1, 10) g RETURNING id, url) INSERT INTO tickets (source_link_id, connection_id, tracker, key) SELECT id, $3, 'jira', substring(url from '[A-Z]+-[0-9]+$') FROM l",
      [item, SITE, jiraConn],
    );
  });
  const stale = () => db.query("UPDATE tickets SET checked_at = NULL FROM source_links l WHERE l.id = tickets.source_link_id AND l.target_id = $1", [item]);

  it("reads them in one search; an issue that's gone is left out and the search asked again", async () => {
    const list = await listTickets(await writer(), item);
    expect(searches()).toHaveLength(1);
    expect(issueGets()).toHaveLength(0);
    expect(list.tickets.map((t) => t.title).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `Issue ${i + 1}`).sort());
    jiraIssues.delete("OPS-310");
    await stale();
    hits.length = 0;
    const again = await listTickets(await writer(), item);
    expect(searches()).toHaveLength(2);
    expect(again.tickets.find((t) => t.key === "OPS-310")).toMatchObject({ error: expect.stringMatching(/no issue OPS-310/) });
    expect(again.tickets.find((t) => t.key === "OPS-31")).toMatchObject({ title: "Issue 1", error: null });
  });

  it("doesn't keep the page waiting on a slow tracker", { timeout: 30_000 }, async () => {
    // The tracker takes 8 s; the page gives up after 300 ms. The margin is wide so a loaded full run can't fail it.
    handlers.set("POST /rest/api/3/search/jql", (_req, _b, res) => void setTimeout(() => json(res, 200, { issues: [] }), 8_000));
    await stale();
    const ctx = await as("writer@example.com", connSettings({ queryTimeoutMs: 300 }));
    const started = Date.now();
    const list = await listTickets(ctx, item);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(list.tickets[0]!.error).toMatch(/timed out/);
  });

  it("stops on a 429 and leaves the tracker alone until its Retry-After, keeping what's cached", async () => {
    await stale();
    await listTickets(await writer(), item);
    handlers.set("POST /rest/api/3/search/jql", (_req, _b, res) => res.writeHead(429, { "retry-after": "120", "content-type": "application/json" }).end("{}"));
    await stale();
    hits.length = 0;
    await refreshDueTickets(db, connSettings());
    expect(searches()).toHaveLength(1);
    expect((await listTickets(await writer(), item, { refresh: false })).tickets[0]).toMatchObject({ title: "Issue 1", error: null });
    hits.length = 0;
    await refreshDueTickets(db, connSettings());
    await listTickets(await writer(), item);
    expect(searches()).toHaveLength(0);
    expect(issueGets()).toHaveLength(0);
  });
});

describe("REST", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ db, authenticate: devAuthenticator("wri=writer@example.com,rea=reader@example.com"), settings: connSettings() }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  it("lists, creates and links tickets; readers only list", async () => {
    await db.query("UPDATE connections SET health = 'ok', enabled = true");
    const item = await newFinding(await writer(), "billing", "Webhook retries pile up");
    expect((await call("wri", "GET", `/api/items/${item}/tickets`)).body).toMatchObject({ tickets: [], can_create: true });
    const made = await call("wri", "POST", `/api/items/${item}/tickets`, { title: "Cap webhook retries" });
    expect(made.status).toBe(200);
    expect(made.body.ticket).toMatchObject({ tracker: "jira", title: "Cap webhook retries" });
    jiraIssues.set("OPS-81", ["Related", "To Do", "new"]);
    expect((await call("wri", "POST", `/api/items/${item}/tickets/link`, { url: `${SITE}/browse/OPS-81` })).body.ticket.key).toBe("OPS-81");
    expect((await call("rea", "POST", `/api/items/${item}/tickets/link`, { url: `${SITE}/browse/OPS-82` })).status).toBe(403);
    expect((await call("rea", "POST", `/api/items/${item}/tickets`, {})).status).toBe(403);
    const listed = await call("rea", "GET", `/api/items/${item}/tickets`);
    expect(listed.body.tickets.map((t: { key: string }) => t.key)).toEqual([made.body.ticket.key, "OPS-81"]);
    expect(JSON.stringify(listed.body)).not.toContain(JIRA_TOKEN);
  });

  it("create_ticket and link_ticket work over MCP", async () => {
    const item = await newFinding(await writer(), "billing", "Filed by an agent");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer wri" } } }));
    const parse = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
    try {
      const made = parse(await client.callTool({ name: "create_ticket", arguments: { item, title: "Agent-filed issue", description: "Found while debugging." } }));
      expect(made).toMatchObject({ created: true, ticket: { tracker: "jira", title: "Agent-filed issue", connected: true } });
      expect(JSON.stringify(jiraPosts().at(-1)!.body)).toContain("Found while debugging.");
      const linked = parse(await client.callTool({ name: "link_ticket", arguments: { item, url: `${SITE}/browse/OPS-77` } }));
      expect(linked).toMatchObject({ linked: true, ticket: { key: "OPS-77", title: "Pool exhaustion" } });
      expect(parse(await client.callTool({ name: "link_ticket", arguments: { item, url: `${SITE}/browse/OPS-77` } }))).toMatchObject({ linked: false, already_linked: true });
      const bad = await client.callTool({ name: "link_ticket", arguments: { item, url: "https://github.com/acme/shop/issues/1" } });
      expect(bad.isError).toBe(true);
      const f = parse(await client.callTool({ name: "get_finding", arguments: { id: item } }));
      expect(f.source_links.map((l: { ticket?: { key: string } }) => l.ticket?.key).sort()).toEqual([made.ticket.key, "OPS-77"].sort());
      expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'link_ticket' AND target_id = $1", [item])).rowCount).toBeGreaterThan(0);
      // Recorded with the audit log's conventions: the item's kind and title, and which issue through which connection.
      const events = (await db.query<{ tool: string; target_kind: string; target_label: string; details: Record<string, unknown> }>(
        "SELECT tool, target_kind, target_label, details FROM audit_log WHERE tool IN ('create_ticket', 'link_ticket') AND target_id = $1 AND via IS NULL ORDER BY at",
        [item],
      )).rows;
      expect(events.map((e) => [e.tool, e.target_kind, e.target_label, e.details.tracker])).toEqual([
        ["create_ticket", "finding", "Filed by an agent", "jira"],
        ["link_ticket", "finding", "Filed by an agent", "jira"],
      ]);
      expect(events[1]!.details).toMatchObject({ ticket: "OPS-77" });
    } finally {
      await client.close();
    }
  });
});
