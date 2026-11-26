import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { fetchSource, validateConfig, type ConnectorEnv } from "../src/core/connectors.js";
import { createConnection, testConnection } from "../src/core/connections/manage.js";
import { createTicket, linkTicket } from "../src/core/connections/tickets.js";
import { parseTicketUrl } from "../src/core/connections/trackers.js";
import type { RequestContext } from "../src/core/context.js";
import { proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// A mock of ClickUp's API: list 901 is the connection's, list 902 another one.
const TOKEN = "pk_1234_ABCDEF";
let mock: Server;
let base: string;
const hits: { method: string; url: string; auth?: string; body: string }[] = [];
const tasks = new Map<string, { name: string; list: string; status: string; type: string; custom_id?: string }>([
  ["86other1", { name: "Somebody else's task", list: "902", status: "to do", type: "open" }],
  ["86done01", { name: "Shipped retries", list: "901", status: "complete", type: "closed", custom_id: "ENG-7" }],
]);
let seq = 0;
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const asTask = (id: string) => {
  const t = tasks.get(id)!;
  return { id, custom_id: t.custom_id ?? null, name: t.name, url: `https://app.clickup.com/t/${id}`, status: { status: t.status, type: t.type }, list: { id: t.list }, team_id: "9000" };
};

let db: Db;
const key = randomBytes(32);
const settings = (): Settings => ({
  ...TEST_SETTINGS,
  publicUrl: "https://kb.example.com",
  connections: { enabled: true, keys: { key }, allowPrivate: false, queryMaxRows: 200, queryTimeoutMs: 5000, ownHosts: ["127.0.0.1"], allowLocal: true, endpoints: { clickup: base } },
});
const as = async (email: string): Promise<RequestContext> => ({ ...(await ctxFor(db, { email })), settings: settings() });
let finding: string;
let conn: string;

beforeAll(async () => {
  mock = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      hits.push({ method: req.method ?? "", url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== TOKEN) return json(res, 401, { err: "Token invalid", ECODE: "OAUTH_025" });
      if (url === "/user") return json(res, 200, { user: { username: "kb-bot" } });
      if (url === "/list/901") return json(res, 200, { id: "901", name: "Engineering", space: { name: "Product" } });
      if (req.method === "POST" && url === "/list/901/task") {
        const id = `86new${++seq}`;
        tasks.set(id, { name: JSON.parse(body).name, list: "901", status: "to do", type: "open" });
        return json(res, 200, asTask(id));
      }
      const m = /^\/task\/([^/?]+)(\?.*)?$/.exec(url);
      if (m) {
        const q = new URLSearchParams(m[2] ?? "");
        const id = q.get("custom_task_ids") ? [...tasks.keys()].find((k) => tasks.get(k)!.custom_id === m[1]) : m[1];
        return id && tasks.has(id) ? json(res, 200, asTask(id)) : json(res, 404, { err: "Task not found", ECODE: "ITEM_015" });
      }
      json(res, 404, { err: "no route" });
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => mock.once("listening", r));
  base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop", visibility: "members" });
  await adminSetMember(a, "shop", "owner@example.com", "owner");
  await adminSetMember(a, "shop", "writer@example.com", "writer");
  const r = (await proposeFinding(await as("writer@example.com"), { project: "shop", type: "known_issue", title: "Refund retries double-charge", symptoms: "Two refunds", root_cause: "No idempotency key", fix: "Send one", force_new: true })) as { finding_id?: string };
  finding = r.finding_id!;
});
afterAll(async () => {
  mock?.closeAllConnections();
  await new Promise((r) => mock.close(r));
  await db.end();
});

describe("ClickUp task links", () => {
  it("are read from app.clickup.com, by task ID or custom task ID", () => {
    expect(parseTicketUrl("https://app.clickup.com/t/86A1B2C3D")).toEqual({ tracker: "clickup", key: "86a1b2c3d", url: "https://app.clickup.com/t/86a1b2c3d", host: "app.clickup.com" });
    expect(parseTicketUrl("https://app.clickup.com/t/9000/eng-42")).toMatchObject({ tracker: "clickup", key: "ENG-42", workspace: "9000", url: "https://app.clickup.com/t/9000/ENG-42" });
    expect(parseTicketUrl("https://app.clickup.com/9000/v/li/901")).toBeNull();
    expect(parseTicketUrl("http://app.clickup.com/t/86a1b2c3d")).toBeNull();
  });
});

describe("a ClickUp connection", () => {
  it("checks the token and the list, and refuses a token that isn't one", async () => {
    const o = await as("owner@example.com");
    await expect(createConnection(o, "shop", { kind: "clickup", name: "x", config: { list_id: "901" }, secret: { api_token: "not a token" } })).rejects.toThrow(/starts with pk_/);
    await expect(createConnection(o, "shop", { kind: "clickup", name: "x", config: { list_id: "eng" }, secret: { api_token: TOKEN } })).rejects.toThrow(/List ID/);
    conn = (await createConnection(o, "shop", { kind: "clickup", name: "Eng ClickUp", config: { list_id: "901", team_id: "9000" }, secret: { api_token: TOKEN } })).id;
    const t = (await testConnection(o, conn)) as { ok: boolean; detail?: string };
    expect(t).toMatchObject({ ok: true, detail: "Connected to ClickUp as kb-bot. New tasks go to Engineering (Product)." });
  });

  it("opens a task from a finding, with a link back, and shows its status", async () => {
    const r = await createTicket(await as("writer@example.com"), { item: finding });
    expect(r.ticket).toMatchObject({ tracker: "clickup", key: "86new1", url: "https://app.clickup.com/t/86new1", status: "to do", category: "todo" });
    const sent = JSON.parse(hits.find((h) => h.method === "POST")!.body);
    expect(sent).toMatchObject({ name: "Refund retries double-charge" });
    expect(sent.markdown_description).toMatch(/From Thaliyola: \[.+\]\(https:\/\/kb\.example\.com\/#\/finding\//);
  });

  it("links an existing task by its custom ID, and refuses one in a list it doesn't read", async () => {
    const w = await as("writer@example.com");
    const ok = await linkTicket(w, { item: finding, url: "https://app.clickup.com/t/9000/ENG-7" });
    expect(ok.ticket).toMatchObject({ key: "ENG-7", status: "complete", category: "done" });
    const other = await linkTicket(w, { item: finding, url: "https://app.clickup.com/t/86other1" });
    expect(other.ticket).toMatchObject({ key: "86other1", error: expect.stringMatching(/Not in a list this connection reads/) });
    expect(other.ticket?.title ?? null).toBeNull();
  });
});

describe("a ClickUp source", () => {
  it("imports tasks closed since last time, with their comments", async () => {
    const env: ConnectorEnv = {
      clickupToken: TOKEN,
      fetch: (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.includes("/comment")) return new Response(JSON.stringify({ comments: [{ comment_text: "Fixed by adding an idempotency key", user: { username: "ana" } }] }));
        const done = Date.parse("2026-11-20T10:00:00Z");
        return new Response(JSON.stringify({ tasks: [
          { id: "t1", custom_id: "ENG-9", name: "Refunds double-charged", text_content: "Customers saw two refunds.", url: "https://app.clickup.com/t/t1", date_done: String(done), creator: { username: "bo" } },
          { id: "t2", name: "Still open", url: "https://app.clickup.com/t/t2", date_done: null },
        ] }));
      }) as typeof fetch,
    };
    const cfg = validateConfig("clickup", { list_id: "901", tag: "postmortem" }, env);
    const r = await fetchSource("clickup", cfg, { since: String(Date.parse("2026-11-01T00:00:00Z")) }, env);
    expect(r.items).toEqual([expect.objectContaining({ title: "ENG-9: Refunds double-charged", author: "bo", body: expect.stringMatching(/two refunds[\s\S]*\*\*ana:\*\* Fixed by adding/) })]);
    expect(r.state).toEqual({ since: String(Date.parse("2026-11-20T10:00:00Z")) });
    expect(() => validateConfig("clickup", { list_id: "901" }, {})).toThrow(/CLICKUP_API_TOKEN/);
  });
});
