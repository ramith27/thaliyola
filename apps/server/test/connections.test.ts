import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicKey } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { ConnectionSettings, Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import type { RequestContext } from "../src/core/context.js";
import { createConnection, deleteConnection, getConnection, listConnections, reserveTest, testConnection, testDraft, TESTS_PER_MINUTE, updateConnection } from "../src/core/connections/manage.js";
import { openSecrets, resealSecrets, runDueConnections, type ConnectionRow } from "../src/core/connections/sync.js";
import { flushDeliveries } from "../src/core/notify.js";
import { createApiToken } from "../src/auth/local.js";
import { createServiceAccount, ensureServiceAccount, listServiceAccounts } from "../src/core/service-accounts.js";
import { systemActor } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_DATABASE_URL, TEST_SETTINGS } from "./helpers.js";

// ---- Sources to connect to: the test Postgres server itself and the MySQL container (skipped when unreachable) --

const PG_ADMIN = (() => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = "/postgres";
  return u;
})();
const MYSQL = { host: "127.0.0.1", port: 53306, user: "root", password: "test", database: "src" };

async function reachable(fn: () => Promise<unknown>) {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}
const pgUp = await reachable(async () => {
  const c = new pg.Client({ connectionString: PG_ADMIN.toString(), connectionTimeoutMillis: 5000 });
  await c.connect();
  await c.end();
});
const mysqlUp = await reachable(async () => {
  const c = await mysql.createConnection({ ...MYSQL, connectTimeout: 5000 });
  await c.end();
});

// ---- A mock of the HTTP services (an API, Slack, Trello, GitHub, ClickHouse, Snowflake, Google) ----------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let mock: Server;
let mockBase: string;
const routes = new Map<string, Handler>();
const hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const keyA = randomBytes(32);
const keyB = randomBytes(32);
let db: Db;

function connSettings(extra: Partial<ConnectionSettings> = {}): Settings {
  return {
    ...TEST_SETTINGS,
    connections: {
      enabled: true,
      keys: { key: keyA },
      allowPrivate: false,
      queryMaxRows: 200,
      queryTimeoutMs: 5000,
      ownHosts: ["127.0.0.1"],
      // The sources here are on this machine: loopback and the own-database check would refuse them otherwise.
      allowLocal: true,
      endpoints: { slack: mockBase, trello: mockBase, github: mockBase, snowflake: mockBase, bigquery: mockBase, google_token: `${mockBase}/token` },
      ...extra,
    },
  };
}

async function as(email: string, settings = connSettings()): Promise<RequestContext> {
  return { ...(await ctxFor(db, { email })), settings };
}
const admin = () => as("admin@example.com");
const owner = () => as("owner@example.com");
const writer = () => as("writer@example.com");
const outsider = () => as("outsider@example.com");

async function row(id: string) {
  return (await db.query<ConnectionRow>("SELECT * FROM connections WHERE id = $1", [id])).rows[0]!;
}
async function notificationsOf(email: string) {
  return (await db.query<{ kind: string; title: string; link: string }>("SELECT n.kind, n.title, n.link FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 AND n.kind = 'connection' ORDER BY n.created_at", [email])).rows;
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body });
      const path = (req.url ?? "").split("?")[0]!;
      const h = routes.get(`${req.method} ${path}`);
      if (h) h(req, body, res);
      else json(res, 404, { message: "no route" });
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => mock.once("listening", r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "billing", name: "Billing", visibility: "members", components: [{ slug: "api", kind: "backend" }] });
  await adminSetMember(a, "billing", "owner@example.com", "owner");
  await adminSetMember(a, "billing", "writer@example.com", "writer");
  await adminCreateProject(a, { slug: "other", name: "Other", visibility: "members" });
});
afterAll(async () => {
  await flushDeliveries();
  if (mock) await new Promise((r) => mock.close(r));
  await db?.end();
});
beforeEach(async () => {
  hits.length = 0;
  routes.clear();
  // Each person may run 20 tests a minute; this file runs more than that, quickly.
  await db.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool IN ('test_connection', 'test_connection_draft')");
});

describe("managing connections", () => {
  it("is for people with Manage settings in the project; secrets never come back", async () => {
    const o = await owner();
    const c = await createConnection(o, "billing", {
      kind: "postgres",
      config: { host: "orders-db.internal.example.com", database: "orders", user: "reader" },
      secret: { password: "correct-horse-battery" },
      component: "api",
    });
    expect(c).toMatchObject({ kind: "postgres", name: "PostgreSQL: orders", scope: "billing", component: "api", health: "untested", label: "PostgreSQL", group: "database" });
    expect(c.config).toEqual({ host: "orders-db.internal.example.com", port: "5432", database: "orders", user: "reader", sslmode: "verify-full" });
    // A password never shows any of its characters (tokens and keys show their last 4).
    expect(c.secrets).toEqual({ password: { set: true, hint: null } });
    expect(JSON.stringify(c)).not.toContain("correct-horse");
    expect(c).not.toHaveProperty("secret");

    const stored = await row(c.id);
    expect(stored.secret).toMatch(/^v1\$/);
    expect(stored.secret).not.toContain("correct-horse");
    expect(stored.next_run_at).not.toBeNull();
    expect((await openSecrets(db, connSettings(), stored)).password).toBe("correct-horse-battery");

    // Writers see that it exists and whether it works, nothing else.
    const seen = await listConnections(await writer(), "billing");
    expect(seen.can_manage).toBe(false);
    expect(seen.kinds).toBeUndefined();
    expect(seen.connections[0]).toEqual({ id: c.id, kind: "postgres", label: "PostgreSQL", group: "database", name: "PostgreSQL: orders", scope: "billing", component: "api", enabled: true, health: "untested", last_ok_at: null, synced_at: null });
    await expect(createConnection(await writer(), "billing", { kind: "http_api", config: { base_url: "https://api.example.com" } })).rejects.toThrow(/Manage settings/);
    await expect(getConnection(await writer(), c.id)).rejects.toThrow(/Manage settings/);
    await expect(deleteConnection(await writer(), c.id)).rejects.toThrow(/Manage settings/);
    // Outside a members-only project, it doesn't exist.
    await expect(listConnections(await outsider(), "billing")).rejects.toThrow(/not found/);
    await expect(getConnection(await outsider(), c.id)).rejects.toThrow(/not found/);
    // Administrators manage every project's connections.
    expect((await listConnections(await admin(), "billing")).connections[0]).toHaveProperty("config");

    const mine = await listConnections(o, "billing");
    expect(mine).toMatchObject({ can_manage: true, enabled: true, key_set: true });
    expect(mine.kinds!.map((k) => k.kind)).toEqual(["postgres", "redshift", "mysql", "clickhouse", "snowflake", "bigquery", "http_api", "git", "slack", "trello", "jira", "linear"]);
    expect(mine.kinds!.find((k) => k.kind === "postgres")!.secret_fields).toEqual([{ key: "password", label: "Password", required: true, hint: undefined, multiline: false, when: undefined }]);
    await deleteConnection(o, c.id);
  });

  it("validates input, names and where connections can live", async () => {
    const o = await owner();
    await expect(createConnection(o, "billing", { kind: "oracle", config: {} })).rejects.toThrow(/kind must be one of/);
    await expect(createConnection(o, "billing", { kind: "postgres", config: { host: "db.example.com", database: "d", user: "u" } })).rejects.toThrow(/Password is required/);
    await expect(createConnection(o, "billing", { kind: "postgres", config: { host: "db", database: "d", user: "u" }, secret: { pwd: "x" } })).rejects.toThrow(/no secret field pwd/);
    await expect(createConnection(o, "billing", { kind: "http_api", config: { base_url: "https://a.example.com" }, interval_minutes: 5 })).rejects.toThrow(/interval_minutes/);
    await expect(createConnection(o, "billing", { kind: "http_api", config: { base_url: "https://a.example.com" }, component: "nope" })).rejects.toThrow(/not found/);
    const a = await createConnection(o, "billing", { kind: "http_api", name: "Orders API", config: { base_url: "https://a.example.com" } });
    expect(a.secrets).toEqual({});
    await expect(createConnection(o, "billing", { kind: "http_api", name: "orders api", config: { base_url: "https://b.example.com" } })).rejects.toThrow(/already exists/);
    // Same name in another project is fine.
    const b = await createConnection(await admin(), "other", { kind: "http_api", name: "Orders API", config: { base_url: "https://b.example.com" } });
    await expect(createConnection(await admin(), "library", { kind: "http_api", config: { base_url: "https://a.example.com" } })).rejects.toThrow(/not the Library/);
    await expect(createConnection(o, "team", { kind: "http_api", config: { base_url: "https://a.example.com" } })).rejects.toThrow(/only admins/);
    // Without CONNECTIONS_KEY nothing secret can be stored; kinds say so.
    const noKey = await as("owner@example.com", connSettings({ keys: {} }));
    await expect(createConnection(noKey, "billing", { kind: "git", config: {}, secret: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } })).rejects.toThrow(/CONNECTIONS_KEY isn't set/);
    const kinds = (await listConnections(noKey, "billing")).kinds!;
    expect(kinds[0]).toMatchObject({ configured: false, needs: "CONNECTIONS_KEY" });
    await deleteConnection(o, a.id);
    await deleteConnection(await admin(), b.id);
  });

  it("keeps a secret that isn't re-entered, replaces one that is, and drops ones that no longer apply", async () => {
    const o = await owner();
    const c = await createConnection(o, "billing", {
      kind: "http_api",
      name: "Billing API",
      config: { base_url: "https://billing.example.com", auth_type: "bearer" },
      secret: { auth_value: "first-token-0000aaaa" },
      options: { allow_write_methods: ["post"], allow_query: true },
    });
    expect(c.options).toEqual({ allow_write_methods: ["POST"] });
    expect(c.next_run_at).not.toBeNull();
    const first = (await row(c.id)).secret;

    let u = await updateConnection(o, c.id, { name: "Billing API v2", interval_minutes: 60 });
    expect(u).toMatchObject({ name: "Billing API v2", interval_minutes: 60, secrets: { auth_value: { set: true, hint: "aaaa" } } });
    expect((await row(c.id)).secret).toBe(first);

    u = await updateConnection(o, c.id, { secret: { auth_value: "second-token-1111bbbb" } });
    expect(u.secrets).toEqual({ auth_value: { set: true, hint: "bbbb" } });
    expect((await openSecrets(db, connSettings(), await row(c.id))).auth_value).toBe("second-token-1111bbbb");

    // Health resets when what the connection points at changes.
    await db.query("UPDATE connections SET health = 'failing', failures = 3, last_error = 'boom' WHERE id = $1", [c.id]);
    u = await updateConnection(o, c.id, { config: { base_url: "https://billing2.example.com", auth_type: "bearer" }, secret: { auth_value: "second-token-1111bbbb" } });
    expect(u).toMatchObject({ health: "untested", failures: 0, last_error: null });

    await expect(updateConnection(o, c.id, { secret: { auth_value: null } })).rejects.toThrow(/Token, key or password is required/);
    // Pointing it somewhere else: the stored token doesn't go along.
    await expect(updateConnection(o, c.id, { config: { base_url: "https://attacker.example.net", auth_type: "bearer" } })).rejects.toThrow(/points somewhere else, so its stored secrets must be entered again/);
    u = await updateConnection(o, c.id, { config: { base_url: "https://billing3.example.com", auth_type: "bearer" }, secret: { auth_value: "third-token-2222cccc" } });
    expect(u.secrets).toEqual({ auth_value: { set: true, hint: "cccc" } });
    routes.set("GET /elsewhere", (_req, _b, res) => json(res, 200, {}));
    hits.length = 0;
    await testDraft(o, "billing", { kind: "http_api", id: c.id, config: { base_url: `${mockBase}/elsewhere`, auth_type: "bearer" }, secret: {} }).catch(() => undefined);
    expect(hits.every((h) => !h.headers.authorization)).toBe(true);
    u = await updateConnection(o, c.id, { config: { base_url: "https://billing2.example.com", auth_type: "none" } });
    expect(u.secrets).toEqual({});
    expect((await row(c.id)).secret).toBeNull();
    u = await updateConnection(o, c.id, { enabled: false });
    expect(u.enabled).toBe(false);
    await deleteConnection(o, c.id);
    await expect(getConnection(o, c.id)).rejects.toThrow(/not found/);
  });

  it("asks for a database password again when its encryption changes", async () => {
    const o = await owner();
    const config = { host: "orders-db.internal.example.com", database: "orders", user: "reader" };
    const c = await createConnection(o, "billing", { kind: "postgres", name: "Encrypted", config, secret: { password: "pw-encrypted-1" } });
    expect(c.config.sslmode).toBe("verify-full");
    const before = (await row(c.id)).secret;
    for (const sslmode of ["require", "disable"]) {
      await expect(updateConnection(o, c.id, { config: { ...config, sslmode } })).rejects.toThrow(/Password is required: this connection now points somewhere else/);
      await expect(testDraft(o, "billing", { kind: "postgres", id: c.id, config: { ...config, sslmode } })).rejects.toThrow(/Password is required/);
    }
    expect((await row(c.id)).secret).toBe(before);
    // With the password entered again, it's saved.
    const u = await updateConnection(o, c.id, { config: { ...config, sslmode: "require" }, secret: { password: "pw-encrypted-1" } });
    expect(u.config.sslmode).toBe("require");
    expect(u.secrets).toEqual({ password: { set: true, hint: null } });
    await deleteConnection(o, c.id);
  });

  it("shows a token's tail only while it's a token", async () => {
    const o = await owner();
    const c = await createConnection(o, "billing", { kind: "http_api", name: "Basic", config: { base_url: "https://basic.example.com", auth_type: "basic", username: "svc" }, secret: { auth_value: "a-long-basic-password" } });
    expect(c.secrets).toEqual({ auth_value: { set: true, hint: null } });
    let u = await updateConnection(o, c.id, { config: { base_url: "https://basic.example.com", auth_type: "bearer" }, secret: { auth_value: "a-long-bearer-token-9z9z" } });
    expect(u.secrets).toEqual({ auth_value: { set: true, hint: "9z9z" } });
    // Switching to basic auth keeps the stored value but stops showing its tail.
    u = await updateConnection(o, c.id, { config: { base_url: "https://basic.example.com", auth_type: "basic", username: "svc" } });
    expect(u.secrets).toEqual({ auth_value: { set: true, hint: null } });
    expect((await openSecrets(db, connSettings(), await row(c.id))).auth_value).toBe("a-long-bearer-token-9z9z");
    await deleteConnection(o, c.id);
  });

  it("Slack and Trello aren't scheduled: they're where notifications go, and Test posts a test message", async () => {
    const o = await as("owner@example.com", connSettings({ endpoints: { slack_hooks: mockBase } }));
    routes.set("POST /services/T000/B000/XXXXXXXXXXXXXXXX", (_req, _b, res) => res.writeHead(200).end("ok"));
    const s = await createConnection(o, "billing", { kind: "slack", config: {}, secret: { webhook_url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX" } });
    expect(s).toMatchObject({ scheduled: false, next_run_at: null, name: "Slack" });
    const t = await testConnection(o, s.id);
    expect(t).toMatchObject({ ok: true, health: "ok", detail: "Connected and posted a test message." });
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body).text).toMatch(/test message from Thaliyola/);
    // A webhook Slack no longer knows: the test fails, and says why without the webhook's address.
    routes.set("POST /services/T000/B000/XXXXXXXXXXXXXXXX", (_req, _b, res) => res.writeHead(404).end("no_service"));
    const gone = await testConnection(o, s.id);
    expect(gone).toMatchObject({ ok: false, health: "failing" });
    expect(JSON.stringify(gone)).not.toContain("XXXXXXXXXXXXXXXX");
    await deleteConnection(o, s.id);
  });
});

describe("testing connections", () => {
  it.skipIf(!pgUp)("reaches Postgres, warns about a superuser, and keeps the password out of errors", async () => {
    const o = await owner();
    const u = new URL(TEST_DATABASE_URL);
    const config = { host: u.hostname, port: u.port || "5432", database: "postgres", user: decodeURIComponent(u.username), sslmode: "disable" };
    const c = await createConnection(o, "billing", { kind: "postgres", name: "Local Postgres", config, secret: { password: decodeURIComponent(u.password) } });
    const ok = await testConnection(o, c.id);
    expect(ok).toMatchObject({ ok: true, health: "ok" });
    expect(ok.ok && ok.detail).toMatch(/^Connected to PostgreSQL [\d.]+ as /);
    expect(ok.ok && ok.warning).toMatch(/superuser/);
    expect(await getConnection(o, c.id)).toMatchObject({ health: "ok", failures: 0, last_detail: expect.stringMatching(/PostgreSQL/), warning: expect.stringMatching(/superuser/) });

    await updateConnection(o, c.id, { secret: { password: "wrong-password-xyz123" } });
    const bad = await testConnection(o, c.id);
    expect(bad).toMatchObject({ ok: false, health: "failing" });
    expect(!bad.ok && bad.error).toMatch(/password authentication failed/);
    expect(JSON.stringify(bad)).not.toContain("wrong-password-xyz123");
    expect((await getConnection(o, c.id)).failures).toBe(1);

    // A draft: the stored secret fills what wasn't re-entered.
    const draft = await testDraft(o, "billing", { kind: "postgres", id: c.id, config, secret: { password: decodeURIComponent(u.password) } });
    expect(draft.ok).toBe(true);
    const stillWrong = await testDraft(o, "billing", { kind: "postgres", id: c.id, config });
    expect(stillWrong.ok).toBe(false);
    await expect(testDraft(await writer(), "billing", { kind: "postgres", config, secret: { password: "x" } })).rejects.toThrow(/Manage settings/);

    // Without the test-only allowance, this machine (and Thaliyola's own database host) is out of reach.
    const strict = await testDraft(await as("owner@example.com", connSettings({ allowLocal: false })), "billing", { kind: "postgres", config, secret: { password: "x" } });
    expect(strict).toMatchObject({ ok: false, error: expect.stringMatching(/own database|loopback/) });
    await deleteConnection(o, c.id);
  });

  it.skipIf(!mysqlUp)("reaches MySQL and warns about a user that can write", async () => {
    const o = await owner();
    const r = await testDraft(o, "billing", {
      kind: "mysql",
      config: { host: MYSQL.host, port: String(MYSQL.port), database: MYSQL.database, user: MYSQL.user, sslmode: "disable" },
      secret: { password: MYSQL.password },
    });
    expect(r).toMatchObject({ ok: true, detail: expect.stringMatching(/^Connected to MySQL 8\.[\d.]+ as root@/), warning: expect.stringMatching(/read-only user/) });
    const bad = await testDraft(o, "billing", {
      kind: "mysql",
      config: { host: MYSQL.host, port: String(MYSQL.port), database: MYSQL.database, user: MYSQL.user, sslmode: "disable" },
      secret: { password: "nope-not-it-42" },
    });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Access denied/) });
    expect(JSON.stringify(bad)).not.toContain("nope-not-it-42");
  });

  it("adds an API's authentication without showing it, and only sends it to the API's own origin", async () => {
    const o = await owner();
    routes.set("GET /v1", (req, _b, res) => (req.headers["x-api-key"] === "k-123456789012" ? json(res, 404, {}) : json(res, 401, { message: "bad key" })));
    routes.set("GET /spec.json", (_req, _b, res) => json(res, 200, { openapi: "3.0.0" }));
    const config = { base_url: `${mockBase}/v1`, auth_type: "header", auth_name: "X-Api-Key" };
    expect(await testDraft(o, "billing", { kind: "http_api", config, secret: { auth_value: "k-123456789012" } })).toMatchObject({ ok: true, detail: expect.stringMatching(/HTTP 404 at the base URL/) });
    expect(await testDraft(o, "billing", { kind: "http_api", config, secret: { auth_value: "wrong" } })).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 401: bad key\. Check the credentials/) });
    // A spec on another origin gets no credentials.
    const other = mockBase.replace("127.0.0.1", "specs.example.test");
    const named = await as("owner@example.com", connSettings({ lookup: async () => [{ address: "127.0.0.1" }] }));
    await testDraft(named, "billing", { kind: "http_api", config: { ...config, spec_url: `${other}/spec.json` }, secret: { auth_value: "k-123456789012" } });
    expect(hits.at(-1)).toMatchObject({ url: "/spec.json" });
    expect(hits.at(-1)!.headers["x-api-key"]).toBeUndefined();
    // Query-string keys and basic auth.
    routes.set("GET /q", (req, _b, res) => json(res, req.url!.includes("api_key=qk-1") ? 200 : 401, {}));
    expect(await testDraft(o, "billing", { kind: "http_api", config: { base_url: `${mockBase}/q`, auth_type: "query", auth_name: "api_key" }, secret: { auth_value: "qk-1" } })).toMatchObject({ ok: true });
    routes.set("GET /b", (req, _b, res) => json(res, req.headers.authorization === `Basic ${Buffer.from("svc:pw-1").toString("base64")}` ? 200 : 401, {}));
    expect(await testDraft(o, "billing", { kind: "http_api", config: { base_url: `${mockBase}/b`, auth_type: "basic", username: "svc" }, secret: { auth_value: "pw-1" } })).toMatchObject({ ok: true });
    // HTTP kinds stay off private networks.
    const strict = await as("owner@example.com", connSettings({ allowLocal: false, lookup: async () => [{ address: "10.1.2.3" }] }));
    expect(await testDraft(strict, "billing", { kind: "http_api", config: { base_url: "https://internal.example.com" } })).toMatchObject({ ok: false, error: expect.stringMatching(/private network/) });
  });

  it("tests Slack bot tokens and Trello lists by posting a test message or card, and checks GitHub and GitLab tokens", async () => {
    const o = await owner();
    routes.set("POST /api/auth.test", (req, _b, res) =>
      json(res, 200, req.headers.authorization === "Bearer xoxb-good-token-1234" ? { ok: true, team: "Acme", user: "thaliyola" } : { ok: false, error: "invalid_auth" }),
    );
    routes.set("POST /api/chat.postMessage", (req, body, res) => json(res, 200, JSON.parse(body).channel === "C0123ABCD" ? { ok: true } : { ok: false, error: "not_in_channel" }));
    expect(await testDraft(o, "billing", { kind: "slack", config: { channel: "C0123ABCD" }, secret: { bot_token: "xoxb-good-token-1234" } })).toMatchObject({
      ok: true,
      detail: "Connected to Slack workspace Acme as thaliyola and posted a test message to C0123ABCD.",
    });
    const posted = hits.find((h) => h.url === "/api/chat.postMessage")!;
    expect(posted.headers.authorization).toBe("Bearer xoxb-good-token-1234");
    expect(JSON.parse(posted.body)).toMatchObject({ channel: "C0123ABCD", text: expect.stringMatching(/test message from Thaliyola/) });
    expect(await testDraft(o, "billing", { kind: "slack", config: { channel: "C0123ABCD" }, secret: { bot_token: "xoxb-bad" } })).toMatchObject({ ok: false, error: "Slack said invalid_auth" });
    expect(await testDraft(o, "billing", { kind: "slack", config: { channel: "C9999ABCD" }, secret: { bot_token: "xoxb-good-token-1234" } })).toMatchObject({
      ok: false,
      error: "Slack said not_in_channel (invite the bot to the channel)",
    });

    const list = "5f2b8c9d0e1f2a3b4c5d6e7f";
    routes.set(`GET /1/lists/${list}`, (req, _b, res) => (req.url!.includes("key=tk-key") && req.url!.includes("token=tk-token") ? json(res, 200, { name: "Inbox", closed: false }) : json(res, 401, {})));
    routes.set("POST /1/cards", (req, body, res) => (req.url!.includes("token=tk-token") && JSON.parse(body).idList === list ? json(res, 200, { id: "c1" }) : json(res, 401, {})));
    expect(await testDraft(o, "billing", { kind: "trello", config: { list_id: list }, secret: { api_key: "tk-key", token: "tk-token" } })).toMatchObject({
      ok: true,
      detail: 'Connected to Trello and added a test card to the list "Inbox".',
    });
    expect(JSON.parse(hits.find((h) => h.url.startsWith("/1/cards"))!.body)).toMatchObject({ idList: list, name: "Thaliyola test card" });
    const bad = await testDraft(o, "billing", { kind: "trello", config: { list_id: list }, secret: { api_key: "tk-key", token: "leaky-token-value" } });
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).not.toContain("leaky-token-value");

    routes.set("GET /user", (req, _b, res) => (req.headers.authorization === "Bearer ghp_good" ? json(res, 200, { login: "octo" }) : json(res, 401, { message: "Bad credentials" })));
    expect(await testDraft(o, "billing", { kind: "git", config: { provider: "github" }, secret: { token: "ghp_good" } })).toMatchObject({ ok: true, detail: "Connected to GitHub as octo." });
    expect(await testDraft(o, "billing", { kind: "git", config: { provider: "github" }, secret: { token: "ghp_bad" } })).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 401: Bad credentials/) });
    routes.set("GET /api/v4/user", (req, _b, res) => (req.headers["private-token"] === "glpat-ok" ? json(res, 200, { username: "gitlabber" }) : json(res, 401, {})));
    // A self-hosted GitLab's API URL must be https; the mock is reached through the test endpoint instead.
    const gl = await as("owner@example.com", connSettings({ endpoints: { gitlab: `${mockBase}/api/v4` } }));
    expect(await testDraft(gl, "billing", { kind: "git", config: { provider: "gitlab" }, secret: { token: "glpat-ok" } })).toMatchObject({ ok: true, detail: "Connected to GitLab as gitlabber." });
  });

  it("queries ClickHouse over HTTP with the password in a header", async () => {
    const o = await owner();
    routes.set("GET /", (req, _b, res) => {
      const q = new URL(req.url!, mockBase).searchParams;
      if (req.headers["x-clickhouse-key"] !== "ch-pass") return void res.writeHead(516).end("Code: 516. DB::Exception: default: Authentication failed");
      res.setHeader("x-clickhouse-server-display-name", "ch1");
      json(res, 200, { data: [{ version: "24.8.1", who: q.get("database") === "analytics" ? "reader" : "?" }], rows: 1 });
    });
    const config = { url: mockBase, database: "analytics", user: "reader" };
    expect(await testDraft(o, "billing", { kind: "clickhouse", config, secret: { password: "ch-pass" } })).toMatchObject({ ok: true, detail: "Connected to ClickHouse 24.8.1 as reader." });
    expect(hits.at(-1)!.url).not.toContain("ch-pass");
    expect(await testDraft(o, "billing", { kind: "clickhouse", config, secret: { password: "nope" } })).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 516: Code: 516/) });
    // The address is just the server: a path on it can't be named.
    await expect(testDraft(o, "billing", { kind: "clickhouse", config: { ...config, url: `${mockBase}/internal/admin` }, secret: { password: "ch-pass" } })).rejects.toThrow(/without a path/);
    // Something else on the network: neither its response nor its status code is read back through the error.
    routes.set("GET /", (_req, _b, res) => json(res, 403, { message: "internal admin panel: token=abc" }));
    const other = await testDraft(o, "billing", { kind: "clickhouse", config, secret: { password: "ch-pass" } });
    expect(other).toEqual({ ok: false, error: "that address didn't answer like a ClickHouse server" });
    // A redirect isn't followed, so the password goes nowhere else (not even on the same origin).
    routes.set("GET /", (_req, _b, res) => void res.writeHead(302, { location: `${mockBase}/elsewhere` }).end());
    routes.set("GET /elsewhere", (_req, _b, res) => json(res, 200, {}));
    hits.length = 0;
    expect(await testDraft(o, "billing", { kind: "clickhouse", config, secret: { password: "ch-pass" } })).toEqual({ ok: false, error: "that address didn't answer like a ClickHouse server" });
    expect(hits.map((h) => h.url.split("?")[0])).toEqual(["/"]);
  });

  it("signs Snowflake key-pair JWTs and BigQuery service-account assertions", async () => {
    const o = await owner();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const pub = createPublicKey(publicKey);

    routes.set("POST /api/v2/statements", (req, body, res) => {
      const token = String(req.headers.authorization).replace("Bearer ", "");
      jwtVerify(token, pub)
        .then(({ payload }) => {
          expect(req.headers["x-snowflake-authorization-token-type"]).toBe("KEYPAIR_JWT");
          expect(payload.sub).toBe("MYORG-ACCT.READER");
          expect(payload.iss).toMatch(/^MYORG-ACCT\.READER\.SHA256:[A-Za-z0-9+/=]+$/);
          expect(JSON.parse(body)).toMatchObject({ statement: expect.stringMatching(/CURRENT_VERSION/), warehouse: "WH" });
          json(res, 200, { code: "090001", data: [["8.40.1", "READER", "ANALYST"]] });
        })
        .catch(() => json(res, 401, { message: "JWT token is invalid." }));
    });
    expect(await testDraft(o, "billing", { kind: "snowflake", config: { account: "myorg-acct", user: "reader", warehouse: "WH" }, secret: { private_key: privateKey } })).toMatchObject({
      ok: true,
      detail: "Connected to Snowflake 8.40.1 as READER (role ANALYST).",
    });

    const sa = { type: "service_account", project_id: "acme-data", client_email: "thaliyola@acme-data.iam.gserviceaccount.com", private_key: privateKey, token_uri: "http://169.254.169.254/evil" };
    routes.set("POST /token", (_req, body, res) => {
      const assertion = new URLSearchParams(body).get("assertion")!;
      jwtVerify(assertion, pub, { audience: "https://oauth2.googleapis.com/token", issuer: sa.client_email })
        .then(({ payload }) => {
          expect(payload.scope).toBe("https://www.googleapis.com/auth/bigquery.readonly");
          json(res, 200, { access_token: "ya29.test" });
        })
        .catch(() => json(res, 400, { error: "invalid_grant" }));
    });
    routes.set("GET /bigquery/v2/projects/acme-data/datasets", (req, _b, res) => (req.headers.authorization === "Bearer ya29.test" ? json(res, 200, { datasets: [{}, {}] }) : json(res, 401, {})));
    const r = await testDraft(o, "billing", { kind: "bigquery", config: {}, secret: { service_account_json: JSON.stringify(sa) } });
    expect(r).toMatchObject({ ok: true, detail: `Connected to BigQuery project acme-data as ${sa.client_email} (2 datasets visible).` });
    // The key's own token_uri is never used.
    expect(hits.some((h) => h.url.includes("evil"))).toBe(false);
    expect(decodeJwt(new URLSearchParams(hits.find((h) => h.url === "/token")!.body).get("assertion")!).aud).toBe("https://oauth2.googleapis.com/token");
  });

  it("limits how many tests one person runs a minute", async () => {
    const w = await as("admin@example.com");
    await db.query("INSERT INTO audit_log (actor_id, tool) SELECT $1, 'test_connection_draft' FROM generate_series(1, 20)", [w.actor.id]);
    await expect(testDraft(w, "billing", { kind: "http_api", config: { base_url: mockBase } })).rejects.toThrow(/20 connection tests in a minute/);
    await db.query("UPDATE audit_log SET at = now() - interval '2 minutes' WHERE actor_id = $1 AND tool = 'test_connection_draft'", [w.actor.id]);
  });

  it("limits tests started in parallel: 2 at a time, and the minute's budget is reserved before each runs", async () => {
    const w = await as("admin@example.com");
    // The two that get through are held until every other one has been refused.
    const held: ServerResponse[] = [];
    routes.set("GET /slow", (_req, _b, res) => void held.push(res));
    const refused: string[] = [];
    const started = Array.from({ length: 30 }, () =>
      testDraft(w, "billing", { kind: "http_api", config: { base_url: `${mockBase}/slow` } }).catch((err: unknown) => void refused.push(String(err))),
    );
    while (refused.length < 28 || held.length < 2) await new Promise((r) => setTimeout(r, 20));
    expect(held).toHaveLength(2);
    for (const res of held) json(res, 200, {});
    const results = await Promise.all(started);
    expect(results.filter((r) => r?.ok)).toHaveLength(2);
    expect(refused).toHaveLength(28);
    for (const r of refused) expect(r).toMatch(/already have 2 connection tests running/);

    // Many instances (no in-process limit): the budget still holds, because each test is counted before it runs.
    await db.query("UPDATE audit_log SET at = now() - interval '2 minutes' WHERE actor_id = $1 AND tool LIKE 'test_connection%'", [w.actor.id]);
    const reservations = await Promise.allSettled(Array.from({ length: 40 }, () => reserveTest(w, "test_connection_draft", null, 1000)));
    expect(reservations.filter((r) => r.status === "fulfilled")).toHaveLength(TESTS_PER_MINUTE);
    for (const r of reservations) if (r.status === "fulfilled") r.value();
    else expect(String(r.reason)).toMatch(/20 connection tests in a minute/);
    // Refused tests aren't counted.
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND tool = 'test_connection_draft' AND at > now() - interval '1 minute'", [w.actor.id])).rows[0].n).toBe(TESTS_PER_MINUTE);
    await db.query("UPDATE audit_log SET at = now() - interval '2 minutes' WHERE actor_id = $1 AND tool LIKE 'test_connection%'", [w.actor.id]);
  });

  it("refuses to test when connections are off", async () => {
    const off = await as("owner@example.com", connSettings({ enabled: false }));
    await expect(testDraft(off, "billing", { kind: "http_api", config: { base_url: mockBase } })).rejects.toThrow(/turned off/);
  });
});

describe("health and the schedule", () => {
  it("backs off while failing, tells the project's admins once, and once more when it works again", async () => {
    const o = await owner();
    let up = false;
    routes.set("GET /health", (_req, _b, res) => json(res, up ? 200 : 503, { message: "down for maintenance" }));
    const c = await createConnection(o, "billing", { kind: "http_api", name: "Flaky", config: { base_url: `${mockBase}/health` }, interval_minutes: 60 });
    const settings = connSettings();
    const due = () => db.query("UPDATE connections SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    const minutesUntilNext = async () => Math.round((new Date((await row(c.id)).next_run_at!).getTime() - Date.now()) / 60_000);
    const logs: string[] = [];

    await runDueConnections(db, settings, (m) => logs.push(m));
    expect(await row(c.id)).toMatchObject({ health: "failing", failures: 1 });
    expect(await minutesUntilNext()).toBe(60);
    expect(logs[0]).toMatch(/connection "Flaky" \(http_api\) failed: .*HTTP 503: down for maintenance/);
    expect(await notificationsOf("owner@example.com")).toEqual([]);

    await due();
    await runDueConnections(db, settings, () => undefined);
    expect(await row(c.id)).toMatchObject({ failures: 2, state: expect.objectContaining({ alerted: true }) });
    expect(await minutesUntilNext()).toBe(120);
    const alerts = await notificationsOf("owner@example.com");
    expect(alerts).toEqual([{ kind: "connection", title: "Connection failing: Flaky (Billing)", link: "#/scope/billing/settings?tab=connections" }]);
    // Writers don't manage it, so they aren't told.
    expect(await notificationsOf("writer@example.com")).toEqual([]);

    await due();
    await runDueConnections(db, settings, () => undefined);
    expect((await row(c.id)).failures).toBe(3);
    expect(await minutesUntilNext()).toBe(240);
    expect(await notificationsOf("owner@example.com")).toHaveLength(1);

    // Backoff stops at a day.
    await db.query("UPDATE connections SET failures = 10 WHERE id = $1", [c.id]);
    await due();
    await runDueConnections(db, settings, () => undefined);
    expect(await minutesUntilNext()).toBe(1440);

    up = true;
    await due();
    await runDueConnections(db, settings, () => undefined);
    expect(await row(c.id)).toMatchObject({ health: "ok", failures: 0, last_error: null });
    expect((await row(c.id)).state.alerted).toBeUndefined();
    expect(await minutesUntilNext()).toBe(60);
    expect((await notificationsOf("owner@example.com")).map((n) => n.title)).toEqual(["Connection failing: Flaky (Billing)", "Connection working again: Flaky (Billing)"]);

    // Not due, disabled or unscheduled: left alone.
    hits.length = 0;
    await runDueConnections(db, settings, () => undefined);
    await updateConnection(o, c.id, { enabled: false });
    await due();
    await runDueConnections(db, settings, () => undefined);
    expect(hits).toHaveLength(0);
    // Turning it back on checks it soon.
    await db.query("UPDATE connections SET next_run_at = now() + interval '1 day' WHERE id = $1", [c.id]);
    await updateConnection(o, c.id, { enabled: true });
    expect(await minutesUntilNext()).toBeLessThanOrEqual(0);
    await deleteConnection(o, c.id);
  });

  it("doesn't check connections of archived projects or projects in the trash", async () => {
    const a = await admin();
    await adminCreateProject(a, { slug: "shelved", name: "Shelved", visibility: "members" });
    routes.set("GET /shelved", (_req, _b, res) => json(res, 200, {}));
    const c = await createConnection(a, "shelved", { kind: "http_api", name: "Shelved API", config: { base_url: `${mockBase}/shelved` } });
    const due = () => db.query("UPDATE connections SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    for (const status of ["deleted", "archived"]) {
      await db.query("UPDATE scopes SET status = $2 WHERE slug = $1", ["shelved", status]);
      await due();
      hits.length = 0;
      await runDueConnections(db, connSettings(), () => undefined);
      expect(hits, status).toHaveLength(0);
      expect((await row(c.id)).health).toBe("untested");
    }
    // Restored: checked again.
    await db.query("UPDATE scopes SET status = 'active' WHERE slug = 'shelved'");
    await runDueConnections(db, connSettings(), () => undefined);
    expect(hits.map((h) => h.url)).toEqual(["/shelved"]);
    expect((await row(c.id)).health).toBe("ok");
    await deleteConnection(a, c.id);
  });

  it("manual tests record health but don't send alerts; the schedule waits when the key is missing", async () => {
    const o = await owner();
    routes.set("GET /down", (_req, _b, res) => json(res, 500, {}));
    const c = await createConnection(o, "billing", { kind: "http_api", name: "Down", config: { base_url: `${mockBase}/down`, auth_type: "bearer" }, secret: { auth_value: "bearer-secret-123456" } });
    await testConnection(o, c.id);
    await testConnection(o, c.id);
    expect(await row(c.id)).toMatchObject({ health: "failing", failures: 2 });
    expect((await notificationsOf("owner@example.com")).filter((n) => n.title.includes("Down"))).toEqual([]);

    await db.query("UPDATE connections SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    const logs: string[] = [];
    hits.length = 0;
    await runDueConnections(db, connSettings({ keys: {} }), (m) => logs.push(m));
    expect(hits).toHaveLength(0);
    expect(logs).toEqual(["1 connection(s) not checked: CONNECTIONS_KEY isn't set, so their secrets can't be opened"]);
    expect((await row(c.id)).failures).toBe(2);
    await deleteConnection(o, c.id);
  });

  it("re-seals secrets after a key rotation", async () => {
    const o = await owner();
    const c = await createConnection(o, "billing", { kind: "git", config: { provider: "github" }, secret: { token: "ghp_rotation_token_123456" } });
    const before = (await row(c.id)).secret;
    const rotating = connSettings({ keys: { key: keyB, oldKey: keyA } });
    const logs: string[] = [];
    expect(await resealSecrets(db, rotating, (m) => logs.push(m))).toEqual({ resealed: 1, unreadable: 0 });
    expect(logs[0]).toMatch(/re-sealed 1 connection secret/);
    const after = (await row(c.id)).secret;
    expect(after).not.toBe(before);
    expect((await openSecrets(db, connSettings({ keys: { key: keyB } }), await row(c.id))).token).toBe("ghp_rotation_token_123456");
    expect(await resealSecrets(db, rotating, () => undefined)).toEqual({ resealed: 0, unreadable: 0 });
    // A key nobody has any more: reported, and the connection asks for the secret again.
    expect(await resealSecrets(db, connSettings({ keys: { key: randomBytes(32) } }), () => undefined)).toEqual({ resealed: 0, unreadable: 1 });
    const t = await testConnection(await as("owner@example.com", connSettings({ keys: { key: randomBytes(32) } })), c.id);
    expect(t).toMatchObject({ ok: false, error: expect.stringMatching(/Enter the secret again/) });
    await deleteConnection(await as("owner@example.com", connSettings({ keys: { key: keyB } })), c.id);
  });
});

describe("migration 040", () => {
  it("adds notification and relation kinds without dropping the ones already there", async () => {
    const def = async (name: string) => (await db.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1", [name])).rows[0]!.d;
    const notifications = await def("notifications_kind_check");
    for (const k of ["review", "decided", "change", "watch", "stale", "comment", "assigned", "invite", "security", "token", "connection", "access"]) expect(notifications).toContain(`'${k}'`);
    const relations = await def("relations_kind_check");
    for (const k of ["same_root_cause", "supersedes", "related", "promoted_into", "uses", "published_as", "provided_by", "consumed_by", "depends_on", "reads", "writes"]) expect(relations).toContain(`'${k}'`);
    await expect(db.query("INSERT INTO notifications (user_id, kind, title, link) SELECT id, 'bogus', 't', '#/' FROM users LIMIT 1")).rejects.toThrow(/notifications_kind_check/);
  });
});

describe("the system actor", () => {
  it("is one service identity, hidden from service accounts and reserved", async () => {
    // An account that was called thaliyola-sync before the name was reserved loses its tokens and roles: it's hidden
    // from Administrators now, so nobody could revoke them any more.
    const old = await ensureServiceAccount(db, "thaliyola-sync", { displayName: "Someone's old bot" });
    await createApiToken(db, old, "ci");
    await db.query("INSERT INTO user_roles (user_id, role) SELECT $1, key FROM roles WHERE kind = 'org' LIMIT 1", [old]);
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) SELECT id, $1, 'owner' FROM scopes WHERE slug = 'billing'", [old]);
    await db.query("UPDATE users SET is_admin = true WHERE id = $1", [old]);

    const a = await systemActor(db);
    expect(a.id).toBe(old);
    const left = await db.query<{ tokens: number; roles: number; members: number; admin: boolean }>(
      `SELECT (SELECT count(*)::int FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL) AS tokens,
              (SELECT count(*)::int FROM user_roles WHERE user_id = $1) AS roles,
              (SELECT count(*)::int FROM scope_members WHERE user_id = $1) AS members,
              (SELECT is_admin FROM users WHERE id = $1) AS admin`,
      [old],
    );
    expect(left.rows[0]).toEqual({ tokens: 0, roles: 0, members: 0, admin: false });
    const b = await systemActor(db);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ subject: "service:thaliyola-sync", kind: "service", email: null });
    expect((await db.query("SELECT display_name FROM users WHERE id = $1", [a.id])).rows[0].display_name).toBe("Thaliyola sync");
    const ad = await admin();
    expect((await listServiceAccounts(ad)).service_accounts.map((s) => s.name)).not.toContain("thaliyola-sync");
    await expect(createServiceAccount(ad, { name: "thaliyola-sync" })).rejects.toThrow(/reserved/);
  });
});

describe("REST", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ db, authenticate: devAuthenticator("own=owner@example.com,wri=writer@example.com,adm=admin@example.com"), settings: connSettings() }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };

  it("creates, lists, tests, updates and deletes, and never sends a secret back", async () => {
    routes.set("GET /ok", (_req, _b, res) => json(res, 200, {}));
    const secret = "super-secret-bearer-9876";
    const created = await call("own", "POST", "/api/projects/billing/connections", { kind: "http_api", name: "REST API", config: { base_url: `${mockBase}/ok`, auth_type: "bearer" }, secret: { auth_value: secret } });
    expect(created.status).toBe(200);
    expect(created.text).not.toContain(secret);
    const id = JSON.parse(created.text).id as string;
    for (const [method, p, body] of [
      ["GET", "/api/projects/billing/connections"],
      ["GET", `/api/connections/${id}`],
      ["POST", `/api/connections/${id}/test`],
      ["POST", "/api/projects/billing/connections/test", { kind: "http_api", id, config: { base_url: `${mockBase}/ok`, auth_type: "bearer" } }],
      ["PATCH", `/api/connections/${id}`, { name: "REST API 2" }],
      ["GET", "/api/connection-kinds"],
    ] as [string, string, unknown?][]) {
      const r = await call("own", method, p, body);
      expect(r.status, `${method} ${p}: ${r.text}`).toBe(200);
      expect(r.text).not.toContain(secret);
      expect(r.text).not.toContain("v1$");
    }
    expect(hits.filter((h) => h.url === "/ok").every((h) => h.headers.authorization === `Bearer ${secret}`)).toBe(true);
    expect((await call("wri", "GET", `/api/connections/${id}`)).status).toBe(403);
    expect((await call("wri", "POST", "/api/projects/billing/connections", { kind: "http_api", config: { base_url: "https://x.example.com" } })).status).toBe(403);
    expect((await call("own", "POST", "/api/projects/billing/connections", { kind: "http_api", config: {} })).status).toBe(400);
    expect((await call("own", "DELETE", `/api/connections/${id}`)).status).toBe(200);
    const audit = await db.query<{ tool: string }>("SELECT tool FROM audit_log WHERE target_id = $1 ORDER BY at", [id]);
    expect(audit.rows.map((r) => r.tool)).toEqual(expect.arrayContaining(["create_connection", "test_connection", "update_connection", "delete_connection"]));

    // The Audit log page: each change once (the web call that wrapped it is hidden), with the connection as target,
    // its name, and what changed; secrets only by field name.
    const page = await call("adm", "GET", `/api/audit?target=${id}`);
    expect(page.status, page.text).toBe(200);
    expect(page.text).not.toContain(secret);
    const entries = JSON.parse(page.text).entries as { action: string; group: string; label: string; target: { kind: string; label: string } | null; details: Record<string, unknown> | null }[];
    const one = (action: string) => {
      const found = entries.filter((e) => e.action === action);
      expect(found, action).toHaveLength(1);
      return found[0]!;
    };
    expect(one("create_connection")).toMatchObject({
      group: "connections",
      label: "Added a connection",
      target: { kind: "connection", label: "REST API" },
      details: { project: "billing", connection_kind: "http_api", name: "REST API", secret_fields: ["auth_value"] },
    });
    expect(one("update_connection")).toMatchObject({ target: { kind: "connection" }, details: { name_before: "REST API", name_after: "REST API 2", fields: ["name"] } });
    expect(one("test_connection")).toMatchObject({ label: "Tested a connection", target: { kind: "connection" }, details: { connection_kind: "http_api" } });
    expect(one("test_connection_draft")).toMatchObject({ details: { project: "billing", draft: true } });
    expect(one("delete_connection")).toMatchObject({ target: { kind: "connection", label: "REST API 2" } });
    // Read-only connection calls are page views, as on the database side (migration 050).
    const kinds = await db.query<{ is_read: boolean }>("SELECT is_read FROM audit_log WHERE tool = 'api:connection_kinds' ORDER BY id DESC LIMIT 1");
    expect(kinds.rows[0]?.is_read).toBe(true);
  });
});
