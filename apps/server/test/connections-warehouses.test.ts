import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { ConnectionSettings, Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle } from "../src/core/bootstrap.js";
import type { RequestContext } from "../src/core/context.js";
import { bigqueryValue } from "../src/core/connections/bigquery.js";
import { describeColumns, findTable, getTable, getTableSchema, listCalls, projectData } from "../src/core/connections/data.js";
import { readonlyProfiles } from "../src/core/connections/clickhouse.js";
import { createConnection, syncConnection, testConnection } from "../src/core/connections/manage.js";
import { queryDatabase } from "../src/core/connections/query.js";
import { snowflakeCell } from "../src/core/connections/snowflake.js";
import { guardSql } from "../src/core/connections/sql-guard.js";
import { knowledgeGraph } from "../src/core/insights.js";
import { getArticle, relatedItems } from "../src/core/items.js";
import { flushDeliveries } from "../src/core/notify.js";
import { linkEntries, unlinkEntries } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

/**
 * More databases and lineage (phase 5 of Connections): ClickHouse, Snowflake and BigQuery sync and read-only queries
 * against mock servers that answer the way each service does, and reads/writes links from repositories to tables.
 */

// ---- One mock for ClickHouse's HTTP interface, Snowflake's SQL API, Google's token endpoint and BigQuery ----------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse, url: URL) => void;
let mock: Server;
let mockBase: string;
let handler: Handler = (_req, _body, res) => json(res, 404, { message: "no route" });
const hits: { method: string; url: URL; headers: IncomingMessage["headers"]; body: string }[] = [];
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

const key = randomBytes(32);
let db: Db;

function connSettings(extra: Partial<ConnectionSettings> = {}): Settings {
  return {
    ...TEST_SETTINGS,
    connections: {
      enabled: true,
      keys: { key },
      allowPrivate: false,
      queryMaxRows: 200,
      queryTimeoutMs: 4000,
      ownHosts: ["10.9.9.9"],
      // The mock runs on this machine: loopback would be refused otherwise.
      allowLocal: true,
      endpoints: { snowflake: mockBase, bigquery: mockBase, google_token: `${mockBase}/token` },
      ...extra,
    },
  };
}
async function as(email: string): Promise<RequestContext> {
  return { ...(await ctxFor(db, { email })), settings: connSettings() };
}
const owner = () => as("owner@example.com");
const writer = () => as("writer@example.com");
const reader = () => as("reader@example.com");
const admin = () => as("admin@example.com");
/** A caller whose queries get a short time limit (the client still waits 5 s more for the server). */
const hurried = async (email: string) => ({ ...(await ctxFor(db, { email })), settings: connSettings({ queryTimeoutMs: 300 }) });
/** A caller who may ask for 1,000 rows. */
const roomy = async (email: string) => ({ ...(await ctxFor(db, { email })), settings: connSettings({ queryMaxRows: 1000 }) });
/** Rows of 10,000 control characters: 60 KB each as JSON (\u0001), 10 KB each as text. */
const wideCell = "\u0001".repeat(10_000);

beforeAll(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", mockBase);
      hits.push({ method: req.method ?? "GET", url, headers: req.headers, body });
      handler(req, body, res, url);
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => mock.once("listening", r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "lake", name: "Lake", visibility: "members", components: [{ slug: "ingest", kind: "backend" }, { slug: "web", kind: "frontend" }] });
  await adminSetMember(a, "lake", "owner@example.com", "owner");
  await adminSetMember(a, "lake", "writer@example.com", "writer");
  await adminSetMember(a, "lake", "reader@example.com", "reader");
  await adminCreateProject(a, { slug: "elsewhere", name: "Elsewhere", visibility: "members", components: [{ slug: "jobs", kind: "backend" }] });
  await adminSetMember(a, "elsewhere", "writer@example.com", "writer");
});
afterAll(async () => {
  await flushDeliveries();
  if (mock) await new Promise((r) => mock.close(r));
  await db?.end();
});
beforeEach(async () => {
  hits.length = 0;
  await db?.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool IN ('test_connection', 'test_connection_draft', 'sync_connection')");
  await db?.query("UPDATE connection_calls SET at = at - interval '2 minutes'");
});

// ---- ClickHouse -------------------------------------------------------------------------------------------------

describe("ClickHouse", () => {
  let connId: string;
  let profileReadOnly = false;
  /** The read-only profile's own max_execution_time, as system.settings reports it. */
  let profileMaxExec = "0";
  let dropped = false;
  const ch = (res: ServerResponse, status: number, body: unknown) => json(res, status, body, { "x-clickhouse-server-display-name": "ch1", "x-clickhouse-query-id": "q1" });
  const chError = (res: ServerResponse, code: number, text: string) => res.writeHead(code === 164 ? 500 : 400, { "x-clickhouse-exception-code": String(code) }).end(`Code: ${code}. DB::Exception: ${text}`);

  beforeAll(async () => {
    handler = (req, _body, res, url) => {
      if (req.method !== "GET" || url.pathname !== "/") return json(res, 404, {});
      if (req.headers["x-clickhouse-user"] !== "reader" || req.headers["x-clickhouse-key"] !== "ch-pass") return chError(res, 516, "reader: Authentication failed");
      const q = url.searchParams.get("query") ?? "";
      const settings = [...url.searchParams.keys()].filter((k) => !["database", "default_format", "query"].includes(k) && !k.startsWith("param_"));
      if (q.includes("readonly_refusal")) return chError(res, 164, "reader: Cannot execute query in readonly mode");
      if (profileReadOnly && settings.length) return chError(res, 164, "Cannot modify 'max_execution_time' setting in readonly mode");
      if (q === "SELECT value FROM system.settings WHERE name = 'max_execution_time'") return ch(res, 200, { meta: [{ name: "value", type: "String" }], data: [{ value: profileMaxExec }], rows: 1 });
      if (q.startsWith("SELECT version()")) return ch(res, 200, { data: [{ version: "24.8.1", who: "reader" }], rows: 1 });
      if (q.includes("FROM system.tables")) {
        expect(url.searchParams.get("param_dbs")).toBe("['analytics']");
        return ch(res, 200, {
          data: [
            { database: "analytics", name: "customers", engine: "MergeTree", total_rows: "2", comment: "", as_select: "" },
            { database: "analytics", name: "daily_events", engine: "View", total_rows: null, comment: "", as_select: "SELECT toDate(at) AS day, count() AS n FROM analytics.events GROUP BY day" },
            { database: "analytics", name: "events", engine: "MergeTree", total_rows: "120000", comment: "Clicks and views", as_select: "" },
          ],
          rows: 3,
        });
      }
      if (q.includes("FROM system.columns")) {
        const cols = [
          { database: "analytics", table: "customers", name: "id", type: "UInt64", default_kind: "", default_expression: "", is_in_primary_key: 1, comment: "" },
          { database: "analytics", table: "customers", name: "email", type: "String", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          { database: "analytics", table: "customers", name: "country", type: "LowCardinality(String)", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          { database: "analytics", table: "daily_events", name: "day", type: "Date", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          { database: "analytics", table: "daily_events", name: "n", type: "UInt64", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          { database: "analytics", table: "events", name: "at", type: "DateTime64(3)", default_kind: "DEFAULT", default_expression: "now64()", is_in_primary_key: 1, comment: "When it happened" },
          { database: "analytics", table: "events", name: "kind", type: "Enum8('click' = 1, 'view' = 2)", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          { database: "analytics", table: "events", name: "customer_id", type: "Nullable(UInt64)", default_kind: "", default_expression: "", is_in_primary_key: 0, comment: "" },
          ...(dropped ? [] : [{ database: "analytics", table: "events", name: "referrer", type: "String", default_kind: "MATERIALIZED", default_expression: "''", is_in_primary_key: 0, comment: "" }]),
        ];
        return ch(res, 200, { data: cols, rows: cols.length });
      }
      // query_database: read-only, limits first, readonly=1 last before the query.
      const keys = [...url.searchParams.keys()];
      if (!profileReadOnly) {
        expect(keys.slice(-2)).toEqual(["readonly", "query"]);
        expect(url.searchParams.get("readonly")).toBe("1");
        expect(url.searchParams.get("max_result_rows")).toMatch(/^\d+$/);
        expect(url.searchParams.get("result_overflow_mode")).toBe("break");
        expect(url.searchParams.get("max_execution_time")).toBe("4");
      }
      expect(url.searchParams.get("default_format")).toBe("JSONCompact");
      if (q.includes("wide_rows")) {
        // 200 rows, 12 MB as JSON: past what's read (8 MB), well under the 4 MB of text a result may hold.
        const data = Array.from({ length: 200 }, (_, i) => [i + 1, wideCell]);
        return ch(res, 200, { meta: [{ name: "id", type: "UInt64" }, { name: "payload", type: "String" }], data, rows: data.length });
      }
      if (q.includes("no_such_column")) return chError(res, 47, "Missing columns: 'no_such_column' while processing query: 'SELECT … WHERE email = 'ann@example.com''");
      if (q.includes("FROM analytics.customers")) {
        return ch(res, 200, {
          meta: [
            { name: "id", type: "UInt64" },
            { name: "email", type: "String" },
            { name: "country", type: "LowCardinality(String)" },
          ],
          data: [
            [1, "ann@example.com", "NL"],
            [2, "bob@example.com", "FR"],
          ],
          rows: 2,
        });
      }
      return ch(res, 200, {
        meta: [
          { name: "kind", type: "String" },
          { name: "n", type: "UInt64" },
        ],
        data: [
          ["click", "61000"],
          ["view", "59000"],
          ["other", "1"],
          ["more", "1"],
          ["even more", "1"],
        ].slice(0, 4),
        rows: 4,
      });
    };
    const c = await createConnection(await owner(), "lake", {
      kind: "clickhouse",
      name: "Clicks",
      config: { url: mockBase, database: "analytics", user: "reader" },
      secret: { password: "ch-pass" },
      options: { allow_query: true },
      component: "ingest",
    });
    connId = c.id;
  });

  it("syncs tables and views from system.tables and system.columns into table articles", async () => {
    const r = await syncConnection(await owner(), connId);
    expect(r).toMatchObject({ ok: true, health: "ok", sync: { tables: 2, views: 1 } });
    // The password goes in a header, never in the URL.
    expect(hits.every((h) => !h.url.toString().includes("ch-pass"))).toBe(true);
    const data = await projectData(await reader(), "lake");
    const tables = data.connections.find((c) => c.name === "Clicks")!.schemas[0]!.tables;
    expect(tables.map((t) => [t.key, t.kind, t.columns, t.rows])).toEqual([
      ["analytics.customers", "table", 3, 2],
      ["analytics.daily_events", "view", 2, null],
      ["analytics.events", "table", 4, 120000],
    ]);
    const events = await getTableSchema(await reader(), { project: "lake", table: "analytics.events" });
    expect(events.comment).toBe("Clicks and views");
    expect(events.columns).toEqual([
      { name: "at", type: "DateTime64(3)", nullable: false, default: "now64()", pk: true, description: "When it happened" },
      { name: "kind", type: "Enum8('click' = 1, 'view' = 2)", nullable: false },
      { name: "customer_id", type: "Nullable(UInt64)", nullable: true },
      { name: "referrer", type: "String", nullable: false, default: "MATERIALIZED ''" },
    ]);
    // A view records what it reads, so masking can follow it.
    const view = (await db.query<{ uses: string[] }>("SELECT definition->'uses' AS uses FROM connection_objects WHERE connection_id = $1 AND key = 'analytics.daily_events'", [connId])).rows[0]!;
    expect(view.uses).toEqual(["analytics.events"]);
    expect(events.article).not.toBeNull();
  });

  it("runs read-only queries with readonly=1 and the server's own limits, masking personal data", async () => {
    const w = await writer();
    await expect(queryDatabase(await reader(), { project: "lake", connection: "Clicks", sql: "SELECT 1" })).rejects.toThrow(/needs Propose/);
    const r = await queryDatabase(w, { project: "lake", connection: "Clicks", sql: "SELECT kind, count() AS n FROM analytics.events GROUP BY kind", limit: 3 });
    expect(r).toMatchObject({ columns: [{ name: "kind" }, { name: "n" }], rows: [["click", "61000"], ["view", "59000"], ["other", "1"]], row_count: 3, truncated: true });
    // The statement is wrapped so the server stops at the cap.
    expect(hits.at(-1)!.url.searchParams.get("query")).toBe("SELECT * FROM (SELECT kind, count() AS n FROM analytics.events GROUP BY kind) LIMIT 4");
    expect(hits.at(-1)!.url.searchParams.get("max_result_rows")).toBe("4");

    // Personal data: the dictionary flags customers.email.
    await describeColumns(w, { project: "lake", table: "analytics.customers", notes: [{ column: "email", description: "Login", pii: true }] });
    const p = await queryDatabase(w, { project: "lake", connection: "Clicks", sql: "SELECT id, email, country FROM analytics.customers" });
    expect(p.columns).toEqual([{ name: "id" }, { name: "email", masked: true }, { name: "country" }]);
    expect(p.rows).toEqual([
      [1, "[masked]", "NL"],
      [2, "[masked]", "FR"],
    ]);
    // An error about a query that reads personal data doesn't repeat the server's text (it can quote values).
    const err = await queryDatabase(w, { project: "lake", connection: "Clicks", sql: "SELECT no_such_column FROM analytics.customers" }).catch((e: Error) => e.message);
    expect(err).toMatch(/ClickHouse error 47; the database's message is hidden/);
    expect(err).not.toContain("ann@example.com");
    const calls = await listCalls(await owner(), connId);
    expect(JSON.stringify(calls)).not.toContain("ann@example.com");
  });

  it("refuses what ClickHouse would run differently or that reaches outside", async () => {
    const w = await writer();
    const run = (sql: string) => queryDatabase(w, { project: "lake", connection: "Clicks", sql });
    await expect(run("SELECT * FROM url('http://169.254.169.254/latest', CSV)")).rejects.toThrow(/url\(\) isn't allowed/);
    await expect(run("SELECT * FROM remoteSecure('db:9440', system.users)")).rejects.toThrow(/remotesecure\(\) isn't allowed/);
    await expect(run("SELECT * FROM s3Cluster('c', 'https://x/y')")).rejects.toThrow(/s3cluster\(\) isn't allowed/);
    await expect(run("SELECT * FROM merge('analytics', '^cust')")).rejects.toThrow(/MERGE isn't allowed/);
    await expect(run("SELECT * FROM loop('analytics', concat('cust', 'omers'))")).rejects.toThrow(/loop\(\) isn't allowed/);
    await expect(run("SELECT 1 SETTINGS readonly = 0")).rejects.toThrow(/SETTINGS isn't allowed/);
    await expect(run("SELECT * FROM analytics.events INTO OUTFILE 'x'")).rejects.toThrow(/INTO isn't allowed/);
    await expect(run("SELECT * FROM dictionary(concat('cust', 'omers_dict'))")).rejects.toThrow(/as one string/);
    await expect(run("SELECT query FROM system.query_log")).rejects.toThrow(/query history isn't allowed/);
    await expect(run("SELECT $heredoc$x$heredoc$")).rejects.toThrow(/\$ outside/);
    await expect(run('SELECT "a\\"b" FROM t')).rejects.toThrow(/backslashes inside quoted names/);
    await expect(run("SELECT 1 # comment\n; DROP TABLE x")).rejects.toThrow(/one statement/);
  });

  it("asks the server to cancel a query when the client goes away", async () => {
    await queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql: "SELECT kind, count() AS n FROM analytics.events GROUP BY kind" });
    expect(hits.at(-1)!.url.searchParams.get("cancel_http_readonly_queries_on_client_close")).toBe("1");
  });

  it("runs queries for a user whose profile is read-only only when the profile limits their time", async () => {
    const sql = "SELECT kind, count() AS n FROM analytics.events GROUP BY kind";
    profileReadOnly = true;
    readonlyProfiles.clear();
    try {
      // No max_execution_time in the profile: a query that outlives the request would keep running, so it's refused.
      profileMaxExec = "0";
      const err = await queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql }).catch((e: Error) => e.message);
      expect(err).toMatch(/profile is read-only \(readonly=1\).*max_execution_time is not set.*readonly=2/);
      // The settings were tried, then the profile's limit read; the query itself never went without them.
      expect(hits.map((h) => h.url.searchParams.get("query"))).toEqual([expect.stringContaining(sql), "SELECT value FROM system.settings WHERE name = 'max_execution_time'"]);
      // Test says so.
      const t = await testConnection(await owner(), connId);
      expect(t).toMatchObject({ ok: true, warning: expect.stringMatching(/^This ClickHouse user's profile is read-only.*at most 60 seconds\.$/) });

      // A limit longer than allowed is refused too; one within it lets queries run without settings.
      readonlyProfiles.clear();
      profileMaxExec = "3600";
      await expect(queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql })).rejects.toThrow(/max_execution_time is 3600 seconds/);
      readonlyProfiles.clear();
      profileMaxExec = "30";
      hits.length = 0;
      const r = await queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql });
      expect(r.row_count).toBe(4);
      expect(hits.map((h) => [...h.url.searchParams.keys()])).toEqual([
        expect.arrayContaining(["max_execution_time", "readonly"]),
        ["database", "default_format", "query"],
        ["database", "default_format", "query"],
      ]);
      // The profile's limit is remembered for a while: the next query doesn't read it again.
      hits.length = 0;
      await queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql });
      expect(hits).toHaveLength(2);
      expect((await testConnection(await owner(), connId)).warning).toBeNull();
    } finally {
      profileReadOnly = false;
      profileMaxExec = "0";
      readonlyProfiles.clear();
    }
    // Code 164 for anything but a setting isn't retried without the limits.
    hits.length = 0;
    await expect(queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql: "SELECT 1 AS readonly_refusal" })).rejects.toThrow(/ClickHouse/);
    expect(hits).toHaveLength(1);
  });

  it("returns the rows read so far, marked cut, when the response outgrows what's read", async () => {
    const r = await queryDatabase(await roomy("writer@example.com"), { project: "lake", connection: "Clicks", sql: "SELECT id, payload FROM analytics.wide_rows", limit: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.row_count).toBeGreaterThan(100);
    expect(r.row_count).toBeLessThan(200);
    expect(r.rows.at(-1)![0]).toBe(r.row_count);
    expect(r.hint).toMatch(/limited to 4 MB/);
  });

  it("reads nothing back from an address that doesn't answer like ClickHouse", async () => {
    const own = handler;
    handler = (_req, _body, res) => json(res, 500, { error: "internal-admin-panel: token abc123 rejected" });
    try {
      const err = await queryDatabase(await writer(), { project: "lake", connection: "Clicks", sql: "SELECT 1" }).catch((e: Error) => e.message);
      expect(err).toMatch(/didn't answer like a ClickHouse server/);
      expect(err).not.toMatch(/abc123|internal-admin|500/);
    } finally {
      handler = own;
    }
  });

  it("links repositories that read or write a table (lineage), shown on the table, its article and the graph", async () => {
    const w = await writer();
    const eventsId = await findTable(w, { project: "lake", table: "analytics.events" });
    const article = (await getTable(w, eventsId)).article!;

    // Contributors in the repository's project link it; readers can't.
    await expect(linkEntries(await reader(), { from: "component:lake/ingest", relation: "writes", to: article.id })).rejects.toThrow(/Propose|permission|not allowed/i);
    await linkEntries(w, { from: "component:lake/ingest", relation: "writes", to: article.id });
    await linkEntries(w, { from: "component:lake/web", relation: "reads", to: article.id });
    await linkEntries(w, { from: "component:elsewhere/jobs", relation: "reads", to: article.id });
    // Lineage points at a table article, from a repository.
    const lake = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = 'lake'")).rows[0]!.id;
    const guide = await insertArticle(db, { scopeId: lake, type: "runbook", title: "Replaying events", body: "Steps" });
    await expect(linkEntries(w, { from: "component:lake/ingest", relation: "reads", to: guide })).rejects.toThrow(/table article/);
    await expect(linkEntries(w, { from: guide, relation: "reads", to: article.id })).rejects.toThrow(/component → article/);

    // The Data view: every link the viewer may see, who may remove which, and repositories they may add.
    const view = await getTable(w, eventsId, { choices: true });
    expect(view.lineage).toEqual([
      { kind: "reads", component: "jobs", project: "elsewhere", can_remove: true },
      { kind: "writes", component: "ingest", project: "lake", can_remove: true },
      { kind: "reads", component: "web", project: "lake", can_remove: true },
    ]);
    expect(view.lineage_choices!.map((c) => `${c.project}/${c.component}`)).toEqual(expect.arrayContaining(["elsewhere/jobs", "lake/ingest", "lake/web"]));
    const asReader = await getTable(await reader(), eventsId, { choices: true });
    expect(asReader.lineage).toEqual([
      { kind: "writes", component: "ingest", project: "lake", can_remove: false },
      { kind: "reads", component: "web", project: "lake", can_remove: false },
    ]);
    // Not the project where they only read (the seeded team-wide project lets everyone propose).
    expect(asReader.lineage_choices!.filter((c) => c.project === "lake" || c.project === "elsewhere")).toEqual([]);
    // Agents see the links in get_table_schema, without the UI's flags.
    expect((await getTableSchema(await reader(), { project: "lake", table: "analytics.events" })).lineage).toEqual([
      { kind: "writes", component: "ingest", project: "lake" },
      { kind: "reads", component: "web", project: "lake" },
    ]);
    expect(await getTable(w, eventsId)).not.toHaveProperty("lineage_choices");

    // The article lists them as related items; the knowledge graph draws them.
    const related = await relatedItems(db, article.id);
    expect(related.filter((r) => r.kind === "component").map((r) => [r.relation, r.direction, r.label]).sort()).toEqual([
      ["reads", "in", "Elsewhere / jobs"],
      ["reads", "in", "Lake / web"],
      ["writes", "in", "Lake / ingest"],
    ]);
    // The article knows its table, so it can link to the Data view where lineage is edited.
    expect((await getArticle(await reader(), article.id)).synced_table).toEqual({ id: eventsId, key: "analytics.events", connection: "Clicks", project: "lake" });
    const graph = await knowledgeGraph(await reader(), { scope: "lake" });
    const ingest = (await db.query<{ id: string }>("SELECT id FROM components WHERE slug = 'ingest'")).rows[0]!.id;
    expect(graph.edges).toContainEqual({ source: ingest, target: article.id, kind: "writes" });

    // A breaking change reaches the repositories that read or write the table.
    dropped = true;
    const r = await syncConnection(await owner(), connId);
    expect(r.ok && r.detail).toMatch(/1 changed/);
    const notices = (await db.query<{ component: string | null; summary: string }>(
      "SELECT c.slug AS component, n.summary FROM impact_notices n LEFT JOIN components c ON c.id = n.component_id WHERE n.source_id = $1 AND n.component_id IS NOT NULL ORDER BY 1",
      [article.id],
    )).rows;
    expect(notices.map((n) => n.component)).toEqual(["ingest", "web"]);
    expect(notices[0]!.summary).toBe("Clicks: analytics.events: column referrer removed");

    // Links are removed by the same people who may add them, and only lineage links this way.
    await expect(unlinkEntries(await reader(), { from: "component:lake/web", relation: "reads", to: article.id })).rejects.toThrow(/Propose|permission|not allowed/i);
    await unlinkEntries(w, { from: "component:lake/web", relation: "reads", to: article.id });
    await expect(unlinkEntries(w, { from: "component:lake/web", relation: "reads", to: article.id })).rejects.toThrow(/not found|no such|a reads link/i);
    await expect(unlinkEntries(w, { from: guide, relation: "related", to: article.id })).rejects.toThrow(/only reads and writes/);
    expect((await getTable(w, eventsId)).lineage.map((l) => l.component)).toEqual(["jobs", "ingest"]);
  });

  it("adds and removes lineage links through the REST API, auditing both", async () => {
    const eventsId = await findTable(await writer(), { project: "lake", table: "analytics.events" });
    const article = (await getTable(await writer(), eventsId)).article!;
    const server: Server = createApp({ db, authenticate: devAuthenticator("w-token=writer@example.com,r-token=reader@example.com"), settings: connSettings() }).listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const send = (method: string, token: string, body: unknown) =>
      fetch(`${base}/links`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const link = { from: "component:lake/web", relation: "reads", to: article.id };
    try {
      expect((await send("POST", "r-token", link)).status).toBe(403);
      expect((await send("POST", "w-token", link)).status).toBe(200);
      expect((await getTable(await reader(), eventsId)).lineage.map((l) => `${l.kind}:${l.component}`)).toContain("reads:web");
      // Only reads and writes links can be removed, and only by people who may add them.
      expect((await send("DELETE", "w-token", { ...link, relation: "related" })).status).toBe(400);
      expect((await send("DELETE", "r-token", link)).status).toBe(403);
      expect((await send("DELETE", "w-token", link)).status).toBe(200);
      expect((await getTable(await reader(), eventsId)).lineage.map((l) => `${l.kind}:${l.component}`)).not.toContain("reads:web");
      expect((await send("DELETE", "w-token", link)).status).toBe(404);
      const writerId = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'writer@example.com'")).rows[0]!.id;
      const logged = await db.query<{ tool: string }>("SELECT tool FROM audit_log WHERE actor_id = $1 AND tool IN ('api:link_entries', 'api:unlink_entries') ORDER BY at", [writerId]);
      expect(logged.rows.map((r) => r.tool)).toEqual(["api:link_entries", "api:unlink_entries"]);
      // The change itself is recorded as the repository's event, naming the table (so the Audit log lists it once).
      const changes = await db.query<{ tool: string; target_kind: string; target_label: string; details: Record<string, unknown> }>(
        "SELECT tool, target_kind, target_label, details FROM audit_log WHERE actor_id = $1 AND tool IN ('link_entries', 'unlink_entries') ORDER BY at",
        [writerId],
      );
      expect(changes.rows.slice(-2).map((r) => [r.tool, r.target_kind, r.target_label, r.details.relation, r.details.table])).toEqual([
        ["link_entries", "repository", "lake/web", "reads", article.title],
        ["unlink_entries", "repository", "lake/web", "reads", article.title],
      ]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ---- Snowflake --------------------------------------------------------------------------------------------------

describe("Snowflake", () => {
  let connId: string;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const statements: Record<string, unknown>[] = [];
  /** The statement never finishes. */
  let slow = false;
  const handle = "01b2c3d4-0000-1111-2222-333344445555";
  const result = (cols: string[], data: (string | null)[][], extra: Record<string, unknown> = {}) => ({
    code: "090001",
    statementHandle: "01b2c3d4-0000-1111-2222-333344445555",
    resultSetMetaData: { numRows: data.length, rowType: cols.map((name) => ({ name, type: "text" })), ...extra },
    data,
  });

  beforeAll(async () => {
    handler = (req, body, res, url) => {
      if (req.headers["x-snowflake-authorization-token-type"] !== "KEYPAIR_JWT" || !String(req.headers.authorization).startsWith("Bearer ey")) return json(res, 401, { message: "JWT token is invalid." });
      if (req.method === "POST" && url.pathname === "/api/v2/statements") {
        const b = JSON.parse(body) as { statement: string; bindings?: Record<string, { value: string }>; parameters: Record<string, string>; database?: string };
        statements.push(b);
        expect(b.parameters.multi_statement_count).toBe("1");
        const s = b.statement;
        if (s.includes("CURRENT_VERSION()")) return json(res, 200, result(["V", "U", "R"], [["8.40.1", "READER", "ANALYST"]]));
        if (s.includes("INFORMATION_SCHEMA.TABLES")) {
          return json(res, 200, result(["TABLE_SCHEMA", "TABLE_NAME", "TABLE_TYPE", "ROW_COUNT", "COMMENT"], [
            ["PUBLIC", "CUSTOMERS", "BASE TABLE", "2", null],
            ["PUBLIC", "ORDERS", "BASE TABLE", "300", "One row per order"],
            ["PUBLIC", "ORDER_TOTALS", "VIEW", null, null],
            ["STAGING", "RAW_ORDERS", "BASE TABLE", "9", null],
          ]));
        }
        if (s.includes("INFORMATION_SCHEMA.COLUMNS")) {
          expect(Object.values(b.bindings ?? {}).map((x) => x.value)).toEqual(["PUBLIC"]);
          return json(res, 200, result(["TABLE_SCHEMA", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "CHARACTER_MAXIMUM_LENGTH", "NUMERIC_PRECISION", "NUMERIC_SCALE", "IS_NULLABLE", "COLUMN_DEFAULT", "COMMENT"], [
            ["PUBLIC", "CUSTOMERS", "ID", "NUMBER", null, "38", "0", "NO", null, null],
            ["PUBLIC", "CUSTOMERS", "EMAIL", "TEXT", "16777216", null, null, "NO", null, null],
            ["PUBLIC", "CUSTOMERS", "PAID", "BOOLEAN", null, null, null, "YES", null, null],
            ["PUBLIC", "CUSTOMERS", "AT", "TIMESTAMP_NTZ", null, null, null, "YES", null, null],
            ["PUBLIC", "CUSTOMERS", "DAY", "DATE", null, null, null, "YES", null, null],
            ["PUBLIC", "ORDERS", "ID", "NUMBER", null, "38", "0", "NO", null, null],
            ["PUBLIC", "ORDERS", "CUSTOMER_ID", "NUMBER", null, "38", "0", "NO", null, null],
            ["PUBLIC", "ORDERS", "STATUS", "TEXT", "20", null, null, "YES", "'new'", "Lifecycle"],
            ["PUBLIC", "ORDER_TOTALS", "CUSTOMER_ID", "NUMBER", null, "38", "0", "YES", null, null],
            ["PUBLIC", "ORDER_TOTALS", "TOTAL", "NUMBER", null, "12", "2", "YES", null, null],
          ]));
        }
        if (s.startsWith("SHOW PRIMARY KEYS")) return json(res, 200, result(["schema_name", "table_name", "column_name"], [["PUBLIC", "ORDERS", "ID"], ["PUBLIC", "CUSTOMERS", "ID"]]));
        if (s.startsWith("SHOW IMPORTED KEYS")) return json(res, 422, { code: "003001", message: "Insufficient privileges", sqlState: "42501" });
        if (s.includes("INFORMATION_SCHEMA.VIEWS")) return json(res, 200, result(["TABLE_SCHEMA", "TABLE_NAME", "VIEW_DEFINITION"], [["PUBLIC", "ORDER_TOTALS", "create view ORDER_TOTALS as select customer_id, sum(total) as total from PUBLIC.ORDERS group by 1"]]));
        if (/wide_rows/i.test(s)) {
          // As Snowflake writes it: metadata, then rows, then the handle. 12 MB, with a second partition never read.
          const data = Array.from({ length: 200 }, (_, i) => [String(i + 1), wideCell]);
          return json(res, 200, { resultSetMetaData: { numRows: 400, rowType: [{ name: "ID", type: "fixed", scale: 0 }, { name: "PAYLOAD", type: "text" }], partitionInfo: [{ rowCount: 200 }, { rowCount: 200 }] }, data, code: "090001", statementHandle: handle });
        }
        if (/bad_column/i.test(s)) return json(res, 422, { code: "000904", sqlState: "42000", message: "SQL compilation error: invalid identifier 'BAD_COLUMN' near 'ann@example.com'" });
        // A query: still running at first, then three partitions.
        return json(res, 202, { code: "333334", message: "Asynchronous execution in progress.", statementHandle: "01b2c3d4-0000-1111-2222-333344445555" });
      }
      if (req.method === "POST" && url.pathname === `/api/v2/statements/${handle}/cancel`) return json(res, 200, { code: "000604", message: "Statement cancelled." });
      if (req.method === "GET" && url.pathname === `/api/v2/statements/${handle}` && slow) return json(res, 202, { code: "333334", message: "Asynchronous execution in progress.", statementHandle: handle });
      if (req.method === "GET" && url.pathname === "/api/v2/statements/01b2c3d4-0000-1111-2222-333344445555") {
        const part = Number(url.searchParams.get("partition") ?? 0);
        const meta = {
          numRows: 5,
          rowType: [
            { name: "ID", type: "fixed", scale: 0 },
            { name: "EMAIL", type: "text" },
            { name: "PAID", type: "boolean" },
            { name: "AT", type: "timestamp_ntz" },
            { name: "DAY", type: "date" },
          ],
          partitionInfo: [{ rowCount: 2 }, { rowCount: 2 }, { rowCount: 1 }],
        };
        const rows = [
          [["1", "ann@example.com", "true", "1700000000.000000000", "19675"], ["2", "bob@example.com", "false", "1700000060.500000000", "19676"]],
          [["3", "cy@example.com", "true", null, null], ["4", "di@example.com", "false", null, null]],
          [["5", "ed@example.com", "true", null, null]],
        ][part]!;
        return json(res, 200, part === 0 ? { code: "090001", statementHandle: "01b2c3d4-0000-1111-2222-333344445555", resultSetMetaData: meta, data: rows } : { data: rows });
      }
      json(res, 404, { message: "no route" });
    };
    const c = await createConnection(await owner(), "lake", {
      kind: "snowflake",
      name: "Warehouse",
      config: { account: "myorg-acct", user: "reader", warehouse: "WH", database: "SHOP", schema: "PUBLIC", role: "ANALYST" },
      secret: { private_key: privateKey },
      options: { allow_query: true },
    });
    connId = c.id;
  });

  it("syncs a schema's tables and views from INFORMATION_SCHEMA, with keys when the role may read them", async () => {
    const r = await syncConnection(await owner(), connId);
    expect(r).toMatchObject({ ok: true, sync: { tables: 2, views: 1 } });
    expect(statements[0]).toMatchObject({ warehouse: "WH", database: "SHOP", schema: "PUBLIC", role: "ANALYST" });
    const orders = await getTableSchema(await reader(), { project: "lake", connection: "Warehouse", table: "PUBLIC.ORDERS" });
    expect(orders).toMatchObject({ rows_estimate: 300, comment: "One row per order" });
    expect(orders.columns).toEqual([
      { name: "ID", type: "NUMBER(38,0)", nullable: false, pk: true },
      { name: "CUSTOMER_ID", type: "NUMBER(38,0)", nullable: false },
      { name: "STATUS", type: "VARCHAR(20)", nullable: true, default: "'new'", description: "Lifecycle" },
    ]);
    const view = (await db.query<{ uses: string[] }>("SELECT definition->'uses' AS uses FROM connection_objects WHERE connection_id = $1 AND key = 'PUBLIC.ORDER_TOTALS'", [connId])).rows[0]!;
    expect(view.uses).toEqual(["PUBLIC.ORDERS"]);
    // STAGING is outside the configured schema.
    expect((await db.query("SELECT 1 FROM connection_objects WHERE connection_id = $1 AND key LIKE 'STAGING.%'", [connId])).rowCount).toBe(0);
  });

  it("waits for a running statement, reads its partitions up to the cap and types the cells", async () => {
    const w = await writer();
    await describeColumns(w, { project: "lake", connection: "Warehouse", table: "PUBLIC.CUSTOMERS", notes: [{ column: "EMAIL", pii: true }] });
    const r = await queryDatabase(w, { project: "lake", connection: "Warehouse", sql: "SELECT id, email, paid, at, day FROM PUBLIC.CUSTOMERS", limit: 3 });
    expect(r.columns).toEqual([{ name: "ID" }, { name: "EMAIL", masked: true }, { name: "PAID" }, { name: "AT" }, { name: "DAY" }]);
    expect(r.rows).toEqual([
      [1, "[masked]", true, "2023-11-14T22:13:20.000Z", "2023-11-14"],
      [2, "[masked]", false, "2023-11-14T22:14:20.500Z", "2023-11-15"],
      [3, "[masked]", true, null, null],
    ]);
    expect(r.truncated).toBe(true);
    const sent = statements.at(-1)!;
    expect(sent).toMatchObject({ statement: "SELECT * FROM (SELECT id, email, paid, at, day FROM PUBLIC.CUSTOMERS) LIMIT 4", timeout: 4 });
    expect((sent.parameters as Record<string, string>).rows_per_resultset).toBe("4");
    // Partition 2 is never fetched: the cap was reached in partition 1.
    expect(hits.filter((h) => h.url.searchParams.get("partition") === "2")).toHaveLength(0);

    const err = await queryDatabase(w, { project: "lake", connection: "Warehouse", sql: "SELECT bad_column FROM PUBLIC.CUSTOMERS" }).catch((e: Error) => e.message);
    expect(err).toMatch(/SQLSTATE 42000; the database's message is hidden/);
    expect(err).not.toContain("ann@example.com");
    const plain = await queryDatabase(w, { project: "lake", connection: "Warehouse", sql: "SELECT bad_column FROM PUBLIC.ORDERS" }).catch((e: Error) => e.message);
    expect(plain).toMatch(/invalid identifier 'BAD_COLUMN'/);
  });

  it("refuses stages, IDENTIFIER(), TABLE('name'), SYSTEM$ functions and other dialect tricks", async () => {
    const w = await writer();
    const run = (sql: string) => queryDatabase(w, { project: "lake", connection: "Warehouse", sql });
    await expect(run("SELECT $1 FROM @my_stage")).rejects.toThrow(/\$ outside/);
    await expect(run("SELECT * FROM @my_stage")).rejects.toThrow(/stages/);
    await expect(run("SELECT * FROM IDENTIFIER('CUST' || 'OMERS')")).rejects.toThrow(/identifier\(\) isn't allowed/);
    await expect(run("SELECT * FROM TABLE('CUST' || 'OMERS')")).rejects.toThrow(/TABLE\(…\) may only wrap a table function/);
    await expect(run("SELECT SYSTEM$WAIT(60)")).rejects.toThrow(/system\$wait\(\) isn't allowed/);
    await expect(run("SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))")).rejects.toThrow(/result_scan\(\) isn't allowed/);
    await expect(run("SELECT 1 // hidden\n; DROP TABLE x")).rejects.toThrow(/one statement/);
    await expect(run("SELECT 'a\\'b'")).rejects.toThrow(/backslashes/);
    // Table functions are fine.
    expect(guardSql("SELECT * FROM TABLE(FLATTEN(input => PARSE_JSON('[1,2]')))", "snowflake").verb).toBe("SELECT");
    // Other people's queries can quote personal data.
    await expect(run("SELECT query_text FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())")).rejects.toThrow(/query history isn't allowed/);
  });

  it("cancels a statement that runs past its time", async () => {
    slow = true;
    try {
      const err = await queryDatabase(await hurried("writer@example.com"), { project: "lake", connection: "Warehouse", sql: "SELECT id FROM PUBLIC.ORDERS" }).catch((e: Error) => e.message);
      expect(err).toMatch(/the query failed: timed out/);
      expect(statements.at(-1)).toMatchObject({ timeout: 1 });
      // It was polled until the deadline, then cancelled.
      expect(hits.filter((h) => h.method === "GET" && h.url.pathname === `/api/v2/statements/${handle}`).length).toBeGreaterThan(2);
      expect(hits.at(-1)).toMatchObject({ method: "POST", url: expect.objectContaining({ pathname: `/api/v2/statements/${handle}/cancel` }) });
    } finally {
      slow = false;
    }
  }, 15_000);

  it("returns the rows read so far, marked cut, when a partition outgrows what's read", async () => {
    const r = await queryDatabase(await roomy("writer@example.com"), { project: "lake", connection: "Warehouse", sql: "SELECT id, payload FROM PUBLIC.WIDE_ROWS", limit: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.row_count).toBeGreaterThan(100);
    expect(r.row_count).toBeLessThan(200);
    expect(r.rows.at(-1)![0]).toBe(r.row_count);
    expect(r.hint).toMatch(/limited to 4 MB/);
    expect(hits.some((h) => h.url.searchParams.has("partition"))).toBe(false);
  });

  it("turns Snowflake's text cells into what they are", () => {
    expect(snowflakeCell("42", { name: "N", type: "fixed", scale: 0 })).toBe(42);
    expect(snowflakeCell("12345678901234567890", { name: "N", type: "fixed", scale: 0 })).toBe("12345678901234567890");
    expect(snowflakeCell("1.50", { name: "N", type: "fixed", scale: 2 })).toBe("1.50");
    expect(snowflakeCell("2.5", { name: "R", type: "real" })).toBe(2.5);
    expect(snowflakeCell("1700000000.000000000 1440", { name: "T", type: "timestamp_tz" })).toBe("2023-11-14T22:13:20.000Z");
    expect(snowflakeCell("3600.5", { name: "T", type: "time" })).toBe("01:00:00.500");
    expect(snowflakeCell(null, { name: "X", type: "text" })).toBeNull();
  });
});

// ---- BigQuery ---------------------------------------------------------------------------------------------------

describe("BigQuery", () => {
  let connId: string;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const sa = { type: "service_account", project_id: "acme-data", client_email: "reader@acme-data.iam.gserviceaccount.com", private_key: privateKey };
  const jobs: Record<string, unknown>[] = [];
  const answer = (fields: string[], rows: unknown[][], extra: Record<string, unknown> = {}) => ({
    jobComplete: true,
    jobReference: { projectId: "acme-data", jobId: "job_1", location: "EU" },
    schema: { fields: fields.map((name) => ({ name, type: "STRING" })) },
    rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })),
    totalRows: String(rows.length),
    ...extra,
  });
  const refused = (res: ServerResponse, status: number, reason: string, message: string) => json(res, status, { error: { code: status, message, errors: [{ reason, message }], status: "INVALID_ARGUMENT" } });

  beforeAll(async () => {
    handler = (req, body, res, url) => {
      if (req.method === "POST" && url.pathname === "/token") return json(res, 200, { access_token: "ya29.mock", expires_in: 3600 });
      if (req.headers.authorization !== "Bearer ya29.mock") return json(res, 401, { error: { message: "no" } });
      if (req.method === "GET" && url.pathname === "/bigquery/v2/projects/acme-data/datasets") {
        if (!url.searchParams.get("pageToken")) return json(res, 200, { datasets: [{ datasetReference: { datasetId: "sales" }, location: "EU" }], nextPageToken: "p2" });
        return json(res, 200, { datasets: [{ datasetReference: { datasetId: "tmp_scratch" }, location: "US" }] });
      }
      if (req.method === "POST" && url.pathname === "/bigquery/v2/projects/acme-data/queries") {
        const b = JSON.parse(body) as { query: string; useLegacySql: boolean; queryParameters?: { name: string; parameterValue: { arrayValues?: { value: string }[] } }[]; maximumBytesBilled?: string; location?: string };
        jobs.push(b);
        expect(b.useLegacySql).toBe(false);
        const q = b.query;
        if (q.includes("INFORMATION_SCHEMA.")) {
          expect(b.queryParameters?.find((p) => p.name === "schemas")?.parameterValue.arrayValues?.map((v) => v.value)).toEqual(["sales"]);
          expect(b.location).toBe("EU");
        }
        if (q.includes("INFORMATION_SCHEMA.TABLES")) {
          expect(q).toContain("`acme-data`.`region-eu`.INFORMATION_SCHEMA.TABLES");
          return json(res, 200, answer(["table_schema", "table_name", "table_type"], [["sales", "customers", "BASE TABLE"], ["sales", "orders", "BASE TABLE"], ["sales", "paid_orders", "VIEW"]]));
        }
        if (q.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return json(res, 200, answer(["table_schema", "table_name", "column_name", "data_type", "is_nullable", "column_default", "description"], [
            ["sales", "customers", "id", "INT64", "NO", "NULL", null],
            ["sales", "customers", "email", "STRING", "YES", "NULL", "Login"],
            ["sales", "customers", "items", "ARRAY<STRUCT<sku STRING, qty INT64>>", "NO", "NULL", null],
            ["sales", "orders", "id", "INT64", "NO", "NULL", null],
            ["sales", "orders", "customer_id", "INT64", "YES", "NULL", null],
            ["sales", "orders", "items", "ARRAY<STRUCT<sku STRING, qty INT64>>", "NO", "NULL", null],
            ["sales", "paid_orders", "id", "INT64", "YES", "NULL", null],
          ]));
        }
        if (q.includes("TABLE_OPTIONS")) return json(res, 200, answer(["table_schema", "table_name", "option_value"], [["sales", "orders", '"One row per order"']]));
        // The region's storage view needs more than the account has; neither may each dataset's.
        if (q.includes("TABLE_STORAGE")) return refused(res, 403, "accessDenied", "Access Denied: Table acme-data:region-eu.INFORMATION_SCHEMA.TABLE_STORAGE");
        if (q.includes("KEY_COLUMN_USAGE")) return json(res, 200, answer(["table_schema", "table_name", "column_name", "constraint_type", "ref_schema", "ref_table", "ref_column"], [["sales", "orders", "id", "PRIMARY KEY", null, null, null], ["sales", "orders", "customer_id", "FOREIGN KEY", "sales", "customers", "id"]]));
        if (q.includes("INFORMATION_SCHEMA.VIEWS")) return json(res, 200, answer(["table_schema", "table_name", "view_definition"], [["sales", "paid_orders", "SELECT * FROM `acme-data.sales.orders` WHERE paid"]]));
        if (q.includes("bad_column")) return refused(res, 400, "invalidQuery", "Unrecognized name: bad_column; did you mean 'ann@example.com'?");
        if (q.includes("slow_job")) return json(res, 200, { jobComplete: false, jobReference: { projectId: "acme-data", jobId: "job_slow", location: "EU" } });
        if (q.includes("wide_rows")) {
          // As BigQuery writes it: schema, rows, then jobComplete and the rest. 12 MB.
          const rows = Array.from({ length: 200 }, (_, i) => ({ f: [{ v: String(i + 1) }, { v: wideCell }] }));
          return json(res, 200, { kind: "bigquery#queryResponse", schema: { fields: [{ name: "id", type: "INTEGER" }, { name: "payload", type: "STRING" }] }, jobReference: { projectId: "acme-data", jobId: "job_wide", location: "EU" }, totalRows: "200", rows, jobComplete: true });
        }
        // A query: not done within the first wait, then two pages.
        expect(b.maximumBytesBilled).toBe(String(2 * 1024 * 1024 * 1024));
        return json(res, 200, { jobComplete: false, jobReference: { projectId: "acme-data", jobId: "job_42", location: "EU" } });
      }
      if (req.method === "GET" && url.pathname === "/bigquery/v2/projects/acme-data/queries/job_slow") return json(res, 200, { jobComplete: false, jobReference: { projectId: "acme-data", jobId: "job_slow", location: "EU" } });
      if (req.method === "POST" && url.pathname === "/bigquery/v2/projects/acme-data/jobs/job_slow/cancel") return json(res, 200, { kind: "bigquery#jobCancelResponse" });
      if (req.method === "GET" && url.pathname === "/bigquery/v2/projects/acme-data/queries/job_42") {
        expect(url.searchParams.get("location")).toBe("EU");
        const fields = [
          { name: "id", type: "INTEGER" },
          { name: "email", type: "STRING" },
          { name: "items", type: "RECORD", mode: "REPEATED", fields: [{ name: "sku", type: "STRING" }, { name: "qty", type: "INTEGER" }] },
        ];
        if (url.searchParams.get("pageToken") === "page2") return json(res, 200, { jobComplete: true, schema: { fields }, rows: [{ f: [{ v: "3" }, { v: "cy@example.com" }, { v: [] }] }], totalRows: "3" });
        return json(res, 200, {
          jobComplete: true,
          schema: { fields },
          rows: [
            { f: [{ v: "1" }, { v: "ann@example.com" }, { v: [{ v: { f: [{ v: "A-1" }, { v: "2" }] } }] }] },
            { f: [{ v: "2" }, { v: "bob@example.com" }, { v: [] }] },
          ],
          totalRows: "3",
          pageToken: "page2",
        });
      }
      json(res, 404, { error: { message: "no route" } });
    };
    const c = await createConnection(await owner(), "lake", {
      kind: "bigquery",
      name: "BQ",
      config: { location: "EU", max_gb_billed: "2" },
      secret: { service_account_json: JSON.stringify(sa) },
      options: { allow_query: true, schemas_exclude: ["tmp_*"] },
    });
    connId = c.id;
  });

  it("syncs datasets through INFORMATION_SCHEMA per region, without what the account can't read", async () => {
    const r = await syncConnection(await owner(), connId);
    expect(r).toMatchObject({ ok: true, sync: { tables: 2, views: 1 } });
    const orders = await getTableSchema(await reader(), { project: "lake", connection: "BQ", table: "sales.orders" });
    expect(orders).toMatchObject({ comment: "One row per order", rows_estimate: null });
    expect(orders.columns).toEqual([
      { name: "id", type: "INT64", nullable: false, pk: true },
      { name: "customer_id", type: "INT64", nullable: true, fk: "sales.customers.id" },
      { name: "items", type: "ARRAY<STRUCT<sku STRING, qty INT64>>", nullable: false },
    ]);
    const customers = await getTableSchema(await reader(), { project: "lake", connection: "BQ", table: "sales.customers" });
    expect(customers.columns.find((c) => c.name === "email")).toMatchObject({ description: "Login" });
    const view = (await db.query<{ uses: string[] }>("SELECT definition->'uses' AS uses FROM connection_objects WHERE connection_id = $1 AND key = 'sales.paid_orders'", [connId])).rows[0]!;
    expect(view.uses).toEqual(["sales.orders"]);
    // The excluded dataset was never queried.
    expect(JSON.stringify(jobs)).not.toContain("tmp_scratch");
  });

  it("runs a query job with a billing cap, waits for it, reads its pages and masks personal data", async () => {
    const w = await writer();
    await describeColumns(w, { project: "lake", connection: "BQ", table: "sales.customers", notes: [{ column: "email", pii: true }] });
    const r = await queryDatabase(w, { project: "lake", connection: "BQ", sql: "SELECT id, email, items FROM `acme-data.sales.customers`" });
    expect(r.columns).toEqual([{ name: "id" }, { name: "email", masked: true }, { name: "items" }]);
    expect(r.rows).toEqual([
      [1, "[masked]", '[{"sku":"A-1","qty":2}]'],
      [2, "[masked]", "[]"],
      [3, "[masked]", "[]"],
    ]);
    expect(r.truncated).toBe(false);
    expect(jobs.at(-1)).toMatchObject({ query: "SELECT * FROM (SELECT id, email, items FROM `acme-data.sales.customers`) LIMIT 201", location: "EU", labels: { source: "thaliyola" } });

    // A whole-row value of a table named as `project.dataset.table` still counts as reading it.
    const g = await queryDatabase(w, { project: "lake", connection: "BQ", sql: "SELECT TO_JSON_STRING(t) AS j, 1 AS one FROM `acme-data.sales.customers` t" });
    expect(g.columns).toEqual([{ name: "id", masked: true }, { name: "email", masked: true }, { name: "items", masked: true }]);

    const err = await queryDatabase(w, { project: "lake", connection: "BQ", sql: "SELECT bad_column FROM `acme-data.sales.cust*`" }).catch((e: Error) => e.message);
    expect(err).toMatch(/BigQuery invalidQuery; the database's message is hidden/);
    expect(err).not.toContain("ann@example.com");
  });

  it("refuses EXTERNAL_QUERY, @parameters and quoting BigQuery reads differently", async () => {
    const w = await writer();
    const run = (sql: string) => queryDatabase(w, { project: "lake", connection: "BQ", sql });
    await expect(run("SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')")).rejects.toThrow(/external_query\(\) isn't allowed/);
    await expect(run("SELECT @@project_id")).rejects.toThrow(/@parameters/);
    await expect(run("SELECT '''a'''")).rejects.toThrow(/triple-quoted|doubled quote/);
    await expect(run("SELECT 'it''s'")).rejects.toThrow(/doubled quote/);
    await expect(run("SELECT `a``b` FROM t")).rejects.toThrow(/doubled backtick/);
    await expect(run("SELECT 1 # x\n; DELETE FROM sales.orders WHERE true")).rejects.toThrow(/one statement/);
  });

  it("polls an unfinished job until its deadline, then cancels it", async () => {
    const err = await queryDatabase(await hurried("writer@example.com"), { project: "lake", connection: "BQ", sql: "SELECT id FROM sales.slow_job" }).catch((e: Error) => e.message);
    expect(err).toMatch(/the query failed: timed out/);
    // The job carries the same deadline, so BigQuery stops it even if cancelling isn't allowed.
    expect(jobs.at(-1)).toMatchObject({ jobTimeoutMs: "300" });
    const polls = hits.filter((h) => h.method === "GET" && h.url.pathname.endsWith("/queries/job_slow"));
    expect(polls.length).toBeGreaterThan(2);
    expect(polls.every((h) => h.url.searchParams.get("location") === "EU")).toBe(true);
    const cancel = hits.at(-1)!;
    expect(cancel).toMatchObject({ method: "POST", url: expect.objectContaining({ pathname: "/bigquery/v2/projects/acme-data/jobs/job_slow/cancel" }) });
    expect(cancel.url.searchParams.get("location")).toBe("EU");
  }, 15_000);

  it("returns the rows read so far, marked cut, when a page outgrows what's read", async () => {
    const r = await queryDatabase(await roomy("writer@example.com"), { project: "lake", connection: "BQ", sql: "SELECT id, payload FROM sales.wide_rows", limit: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.row_count).toBeGreaterThan(100);
    expect(r.row_count).toBeLessThan(200);
    expect(r.rows.at(-1)![0]).toBe(r.row_count);
    expect(r.hint).toMatch(/limited to 4 MB/);
  });

  it("refuses the jobs views, which show other people's queries", async () => {
    await expect(queryDatabase(await writer(), { project: "lake", connection: "BQ", sql: "SELECT query FROM `region-eu`.INFORMATION_SCHEMA.JOBS" })).rejects.toThrow(/query history isn't allowed/);
  });

  it("turns BigQuery's cells into JSON values", () => {
    expect(bigqueryValue("12", { name: "n", type: "INT64" })).toBe(12);
    expect(bigqueryValue("9007199254740993", { name: "n", type: "INT64" })).toBe("9007199254740993");
    expect(bigqueryValue("true", { name: "b", type: "BOOL" })).toBe(true);
    expect(bigqueryValue("1.7E9", { name: "t", type: "TIMESTAMP" })).toBe("2023-11-14T22:13:20.000Z");
    expect(bigqueryValue({ f: [{ v: "x" }] }, { name: "r", type: "RECORD", fields: [{ name: "a", type: "STRING" }] })).toEqual({ a: "x" });
    expect(bigqueryValue(null, { name: "x", type: "STRING" })).toBeNull();
  });
});
