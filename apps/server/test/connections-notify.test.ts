import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { ConnectionSettings, Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { createConnection, updateConnection } from "../src/core/connections/manage.js";
import { announceChanges } from "../src/core/connections/catalog.js";
import { buildDigest, createRoute, dailySlot, deleteRoute, delivery, DIGEST_TRIES, listRoutes, MAX_QUEUED, sendDigestNow, sendRouteDigests, updateRoute } from "../src/core/connections/routes.js";
import type { RequestContext } from "../src/core/context.js";
import { flushDeliveries, notify, onStale, slackOutbox } from "../src/core/notify.js";
import { createOrRequestProject } from "../src/core/project-requests.js";
import { announceAccessRequest } from "../src/core/users.js";
import { proposeFinding } from "../src/core/writes.js";
import { withTx, type Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// ---- A mock of Slack (Web API and incoming webhooks) and Trello ---------------------------------------------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let mock: Server;
let mockBase: string;
const handlers = new Map<string, Handler>();
const hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const key = randomBytes(32);
let db: Db;
const PUBLIC = "https://kb.example.com";
const HOOK = "/services/T000/B000/hookhookhookhook";
const LIST = "5f2b8c9d0e1f2a3b4c5d6e7f";

function connSettings(extra: Partial<ConnectionSettings> = {}, more: Partial<Settings> = {}): Settings {
  return {
    ...TEST_SETTINGS,
    publicUrl: PUBLIC,
    digestHour: 8,
    digestDay: 1,
    ...more,
    connections: {
      enabled: true,
      keys: { key },
      allowPrivate: false,
      queryMaxRows: 200,
      queryTimeoutMs: 5000,
      ownHosts: ["127.0.0.1"],
      allowLocal: true,
      endpoints: { slack: mockBase, slack_hooks: mockBase, trello: mockBase },
      ...extra,
    },
  };
}
const as = async (email: string, settings = connSettings()): Promise<RequestContext> => ({ ...(await ctxFor(db, { email })), settings });
const admin = () => as("admin@example.com");
const owner = () => as("owner@example.com");
const writer = () => as("writer@example.com");
const outsider = () => as("outsider@example.com");

/** What reached Slack's chat.postMessage, per channel. */
const slackPosts = (channel?: string) =>
  hits.filter((h) => h.url === "/api/chat.postMessage").map((h) => JSON.parse(h.body) as { channel: string; text: string }).filter((m) => !channel || m.channel === channel);
const hookPosts = () => hits.filter((h) => h.url === HOOK).map((h) => JSON.parse(h.body) as { text: string });
const cards = () => hits.filter((h) => h.url.startsWith("/1/cards")).map((h) => ({ ...(JSON.parse(h.body) as { idList: string; name: string; desc: string }), url: h.url }));

async function health(id: string) {
  return (await db.query<{ health: string; failures: number; last_error: string | null }>("SELECT health, failures, last_error FROM connections WHERE id = $1", [id])).rows[0]!;
}
async function connectionNotes(email: string) {
  return (await db.query<{ title: string; link: string }>("SELECT n.title, n.link FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 AND n.kind = 'connection' ORDER BY n.created_at", [email])).rows;
}
async function scopeId(slug: string) {
  return (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [slug])).rows[0]!.id;
}

let billingSlack: string;
let billingTrello: string;
let otherSlack: string;
let shopSlack: string;
let teamHook: string;

beforeAll(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body });
      const h = handlers.get(`${req.method} ${(req.url ?? "").split("?")[0]}`);
      if (h) h(req, body, res);
      else json(res, 404, { message: "no route" });
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => mock.once("listening", r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "billing", name: "Billing", visibility: "members" });
  await adminCreateProject(a, { slug: "shop", name: "Shop", visibility: "team" });
  await adminCreateProject(a, { slug: "other", name: "Other", visibility: "members" });
  for (const p of ["billing", "shop"]) {
    await adminSetMember(a, p, "owner@example.com", "owner");
    await adminSetMember(a, p, "writer@example.com", "writer");
  }
  await adminSetMember(a, "other", "owner@example.com", "owner");
  const o = await owner();
  billingSlack = (await createConnection(o, "billing", { kind: "slack", name: "Billing channel", config: { channel: "CBILLING1" }, secret: { bot_token: "xoxb-billing-token-1" } })).id;
  billingTrello = (await createConnection(o, "billing", { kind: "trello", name: "Billing board", config: { list_id: LIST }, secret: { api_key: "tk-key", token: "tk-secret-token" } })).id;
  shopSlack = (await createConnection(o, "shop", { kind: "slack", name: "Shop channel", config: { channel: "CSHOP1111" }, secret: { bot_token: "xoxb-shop-token-1" } })).id;
  otherSlack = (await createConnection(o, "other", { kind: "slack", name: "Other channel", config: { channel: "COTHER111" }, secret: { bot_token: "xoxb-other-token-1" } })).id;
  teamHook = (await createConnection(a, "team", { kind: "slack", name: "Team channel", secret: { webhook_url: `https://hooks.slack.com${HOOK}` } })).id;
  delivery.retryAfterMs = 10;
  delivery.paceMs = { slack: 0, trello: 0 };
});
afterAll(async () => {
  await flushDeliveries();
  if (mock) await new Promise((r) => mock.close(r));
  await db?.end();
});
beforeEach(async () => {
  await flushDeliveries();
  hits.length = 0;
  handlers.clear();
  handlers.set("POST /api/chat.postMessage", (_req, _b, res) => json(res, 200, { ok: true }));
  handlers.set(`POST ${HOOK}`, (_req, _b, res) => res.writeHead(200).end("ok"));
  handlers.set("POST /1/cards", (_req, _b, res) => json(res, 200, { id: "card1" }));
  await db.query("DELETE FROM notification_routes");
  await db.query("DELETE FROM notifications");
  await db.query("UPDATE connections SET health = 'untested', failures = 0, last_error = NULL, state = '{}', enabled = true");
  await db.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool = 'send_digest'");
});

describe("setting up routes", () => {
  it("is for a project's admins, with the project's own Slack and Trello connections; secrets never come back", async () => {
    const o = await owner();
    const r = await createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["review", "connection", "review"] });
    expect(r).toMatchObject({ kinds: ["review", "connection"], digest: "off", destination: { id: billingSlack, name: "Billing channel", kind: "slack", label: "Slack", health: "untested" } });
    const list = await listRoutes(o, "billing");
    expect(list.routes).toHaveLength(1);
    expect(list.destinations.map((d) => d.name)).toEqual(["Billing board", "Billing channel"]);
    expect(list.kinds.map((k) => k.kind)).toEqual(["review", "decided", "comment", "change", "stale", "security", "connection"]);
    expect(list.digests).toEqual({ hour: 8, day: 1 });
    expect(JSON.stringify(list)).not.toMatch(/xoxb|tk-secret|v1\$/);

    // Writers and people outside the project can't see or change them.
    await expect(listRoutes(await writer(), "billing")).rejects.toThrow(/Manage settings/);
    await expect(createRoute(await writer(), { project: "billing", connection_id: billingSlack, kinds: ["review"] })).rejects.toThrow(/Manage settings/);
    await expect(updateRoute(await writer(), r.id, { kinds: ["stale"] })).rejects.toThrow(/Manage settings/);
    await expect(deleteRoute(await writer(), r.id)).rejects.toThrow(/Manage settings/);
    await expect(listRoutes(await outsider(), "billing")).rejects.toThrow(/not found/);
    await expect(deleteRoute(await outsider(), r.id)).rejects.toThrow(/not found/);

    // Only this project's Slack and Trello connections, known kinds, something to send, one route per destination.
    await expect(createRoute(o, { project: "billing", connection_id: otherSlack, kinds: ["review"] })).rejects.toThrow(/connection of Billing/);
    await expect(createRoute(o, { project: "billing", connection_id: teamHook, kinds: ["review"] })).rejects.toThrow(/connection of Billing/);
    await expect(createRoute(o, { project: "billing", connection_id: billingTrello, kinds: ["access"] })).rejects.toThrow(/team-wide/);
    await expect(createRoute(o, { project: "billing", connection_id: billingTrello, kinds: ["watch"] })).rejects.toThrow(/kinds are some of/);
    await expect(createRoute(o, { project: "billing", connection_id: billingTrello, kinds: [] })).rejects.toThrow(/at least one kind/);
    await expect(createRoute(o, { project: "billing", connection_id: billingTrello, kinds: ["review"], digest: "daily" })).rejects.toThrow(/Slack only/);
    await expect(createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["stale"] })).rejects.toThrow(/already has a route/);
    await expect(createRoute(o, { project: "team", connection_id: teamHook, kinds: ["review"] })).rejects.toThrow(/belong to a project/);

    const u = await updateRoute(o, r.id, { kinds: ["stale"], digest: "weekly" });
    expect(u).toMatchObject({ kinds: ["stale"], digest: "weekly" });
    expect(u.digest_sent_at).not.toBeNull();
    await expect(updateRoute(o, r.id, { kinds: [], digest: "off" })).rejects.toThrow(/at least one kind/);
    expect(await deleteRoute(o, r.id)).toEqual({ deleted: r.id });
    expect((await listRoutes(o, "billing")).routes).toEqual([]);
  });

  it("team-wide routes are for Administrators, with the Team space's connections", async () => {
    await expect(listRoutes(await owner(), null)).rejects.toThrow(/Administrators/);
    await expect(createRoute(await owner(), { connection_id: teamHook, kinds: ["review"] })).rejects.toThrow(/Administrators/);
    const a = await admin();
    await expect(createRoute(a, { connection_id: billingSlack, kinds: ["review"] })).rejects.toThrow(/Team space/);
    await expect(createRoute(a, { connection_id: teamHook, kinds: ["review"], digest: "daily" })).rejects.toThrow(/project's settings/);
    const r = await createRoute(a, { connection_id: teamHook, kinds: ["access", "security"] });
    const list = await listRoutes(a, null);
    expect(list).toMatchObject({ scope: null, digests: null, destinations: [{ id: teamHook, name: "Team channel" }] });
    expect(list.kinds.map((k) => k.kind)).toContain("access");
    expect(list.routes.map((x) => x.id)).toEqual([r.id]);
    // A project's admin can't touch a team-wide route.
    await expect(deleteRoute(await owner(), r.id)).rejects.toThrow(/Administrators/);
  });
});

describe("delivering notifications", () => {
  it("posts each event once per route, however many people it notifies, with a link back", async () => {
    const o = await owner();
    await createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["review"] });
    await createRoute(o, { project: "billing", connection_id: billingTrello, kinds: ["review"] });
    const res = await proposeFinding({ ...(await writer()), project: "billing" }, { type: "rca", title: "Refunds retried twice", symptoms: "Two refunds", root_cause: "No idempotency key", force_new: true });
    expect(res.status).toBe("pending_review");
    await flushDeliveries();
    // Two reviewers (the owner and the admin) are told in Thaliyola; the channel and the board get it once each.
    const told = await db.query("SELECT DISTINCT user_id FROM notifications WHERE kind = 'review'");
    expect(told.rowCount).toBeGreaterThanOrEqual(2);
    const posts = slackPosts("CBILLING1");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("*Review: New root cause analysis: Refunds retried twice*");
    expect(posts[0]!.text).toMatch(new RegExp(`<${PUBLIC}/#/review/[\\w-]+\\|Open in Thaliyola>`));
    expect(hits.find((h) => h.url === "/api/chat.postMessage")!.headers.authorization).toBe("Bearer xoxb-billing-token-1");
    const c = cards();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ idList: LIST, name: "Review: New root cause analysis: Refunds retried twice" });
    expect(c[0]!.desc).toMatch(/proposed a change in Billing[\s\S]*Open in Thaliyola: https:\/\/kb\.example\.com\/#\/review\//);
    expect(c[0]!.url).toContain("token=tk-secret-token");
    // Deliveries mark the destinations as working.
    expect(await health(billingSlack)).toMatchObject({ health: "ok", failures: 0 });
  });

  it("matches the kind and the project; team-wide routes only get team-visible projects' events", async () => {
    const o = await owner();
    const a = await admin();
    await createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["connection"] });
    await createRoute(a, { connection_id: teamHook, kinds: ["review", "stale", "access"] });
    const billing = await scopeId("billing");
    const shop = await scopeId("shop");
    const s = connSettings();
    const event = (kind: "review" | "stale" | "connection", scope: string | null, title: string) => notify(db, s, [], { kind, title, body: "", link: "#/", scopeId: scope });
    await event("review", billing, "billing review");
    await event("connection", billing, "billing connection");
    await event("connection", shop, "shop connection");
    await event("review", shop, "shop review");
    await event("stale", shop, "shop stale");
    await event("review", null, "project request");
    // Personal notices are never posted, whatever their kind.
    await notify(db, s, [], { kind: "review", title: "personal", link: "#/", route: false });
    await flushDeliveries();
    expect(slackPosts().map((p) => p.text)).toEqual(["*billing connection*\n<https://kb.example.com/#/|Open in Thaliyola>"]);
    expect(hookPosts().map((p) => p.text)).toEqual(["*shop review*\n<https://kb.example.com/#/|Open in Thaliyola>", expect.stringContaining("shop stale"), expect.stringContaining("project request")]);

    // Access requests use their own kind, so they can go to a team-wide route.
    hits.length = 0;
    const newcomer = await ctxFor(db, { email: "newcomer@example.com" });
    await announceAccessRequest(db, s, newcomer.actor);
    await flushDeliveries();
    expect(hookPosts().map((p) => p.text)).toEqual([expect.stringContaining("newcomer@example.com is waiting for access")]);
    const access = await db.query("SELECT kind FROM notifications WHERE title = 'newcomer@example.com is waiting for access'");
    expect(access.rows.every((r) => r.kind === "access")).toBe(true);
  });

  it("gives team-wide routes a security event's title only, and redacts what it posts", async () => {
    const o = await owner();
    const a = await admin();
    await createRoute(o, { project: "shop", connection_id: shopSlack, kinds: ["security"] });
    await createRoute(a, { connection_id: teamHook, kinds: ["security"] });
    await notify(db, connSettings(), [], { kind: "security", title: "Shop: 1 new vulnerability (1 critical)", body: "lodash 4.17.20: prototype pollution; key AKIAIOSFODNN7EXAMPLE", link: "#/security", scopeId: await scopeId("shop") });
    await flushDeliveries();
    expect(hookPosts()[0]!.text).toBe("*Shop: 1 new vulnerability (1 critical)*\n<https://kb.example.com/#/security|Open in Thaliyola>");
    const project = slackPosts("CSHOP1111")[0]!.text;
    expect(project).toContain("lodash 4.17.20: prototype pollution");
    expect(project).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("keeps the SLACK_WEBHOOK_URL team channel working next to routes", async () => {
    await createRoute(await owner(), { project: "shop", connection_id: shopSlack, kinds: ["review"] });
    slackOutbox.length = 0;
    const withHook = connSettings({}, { slackWebhookUrl: "test" });
    await proposeFinding({ ...(await as("writer@example.com", withHook)), project: "shop" }, { type: "rca", title: "Cart totals off by a cent", symptoms: "Rounding", root_cause: "Floats", force_new: true });
    await flushDeliveries();
    expect(slackOutbox).toEqual([expect.objectContaining({ text: expect.stringContaining("Cart totals off by a cent") })]);
    expect(slackPosts("CSHOP1111").map((p) => p.text)).toEqual([expect.stringContaining("Cart totals off by a cent")]);
  });

  it("marks a destination failing when it doesn't take a delivery, tells the admins once, and once when it works again", async () => {
    const o = await owner();
    await createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["stale", "connection"] });
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => json(res, 200, { ok: false, error: "channel_not_found" }));
    const s = connSettings();
    const billing = await scopeId("billing");
    const stale = (title: string) => notify(db, s, [], { kind: "stale", title, link: "#/", scopeId: billing });
    await stale("first");
    await flushDeliveries();
    expect(await health(billingSlack)).toEqual({ health: "failing", failures: 1, last_error: "Couldn't deliver a notification: Slack said channel_not_found (check the channel ID)" });
    expect(await connectionNotes("owner@example.com")).toEqual([]);
    await stale("second");
    await flushDeliveries();
    expect((await health(billingSlack)).failures).toBe(2);
    const told = await connectionNotes("owner@example.com");
    expect(told).toEqual([{ title: "Notifications aren't reaching Billing channel (Billing)", link: "#/scope/billing/settings?tab=notifications" }]);
    // That notice is a "connection" event, but it's never sent through a route (the destination may be the one failing).
    expect(slackPosts()).toHaveLength(2);
    await stale("third");
    await flushDeliveries();
    expect(await connectionNotes("owner@example.com")).toHaveLength(1);

    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => json(res, 200, { ok: true }));
    await stale("fourth");
    await flushDeliveries();
    expect(await health(billingSlack)).toEqual({ health: "ok", failures: 0, last_error: null });
    expect((await connectionNotes("owner@example.com")).map((n) => n.title)).toEqual([
      "Notifications aren't reaching Billing channel (Billing)",
      "Notifications reach Billing channel again (Billing)",
    ]);
  });

  it("retries a rate-limited delivery after the wait the service asks for, and skips paused destinations and servers with connections off", async () => {
    const o = await owner();
    await createRoute(o, { project: "billing", connection_id: billingTrello, kinds: ["stale"] });
    const times: number[] = [];
    handlers.set("POST /1/cards", (_req, _b, res) => {
      times.push(Date.now());
      if (times.length === 1) res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(JSON.stringify({ message: "slow down" }));
      else json(res, 200, { id: "c" });
    });
    const billing = await scopeId("billing");
    await notify(db, connSettings(), [], { kind: "stale", title: "Needs re-verifying: Payouts runbook", link: "#/", scopeId: billing });
    await flushDeliveries();
    expect(times).toHaveLength(2);
    // Retry-After: 1 (seconds), not the default 10 ms the tests use.
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
    expect(await health(billingTrello)).toMatchObject({ health: "ok" });

    await notify(db, { ...connSettings(), connections: { ...connSettings().connections!, enabled: false } }, [], { kind: "stale", title: "off", link: "#/", scopeId: billing });
    await updateConnection(o, billingTrello, { enabled: false });
    await notify(db, connSettings(), [], { kind: "stale", title: "paused", link: "#/", scopeId: billing });
    await flushDeliveries();
    expect(times).toHaveLength(2);
  });

  it("drops a post that stays rate-limited without marking the destination failing", async () => {
    await createRoute(await owner(), { project: "billing", connection_id: billingSlack, kinds: ["stale"] });
    let calls = 0;
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => {
      calls++;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end(JSON.stringify({ ok: false, error: "ratelimited" }));
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const title of ["one", "two"]) await notify(db, connSettings(), [], { kind: "stale", title, link: "#/", scopeId: await scopeId("billing") });
      await flushDeliveries();
      expect(calls).toBe(2 * delivery.attempts);
      expect(errors.mock.calls.flat().join("\n")).toMatch(/rate-limiting; dropped a notification/);
    } finally {
      errors.mockRestore();
    }
    // Busy is not broken: no failure counted, nobody told.
    expect(await health(billingSlack)).toMatchObject({ health: "untested", failures: 0 });
    expect(await connectionNotes("owner@example.com")).toEqual([]);
  });

  it(`keeps at most ${MAX_QUEUED} posts waiting for one destination, and logs the ones it drops`, async () => {
    await createRoute(await owner(), { project: "billing", connection_id: billingSlack, kinds: ["stale"] });
    // Slack holds the first post until we let go: everything else waits in the queue behind it.
    const held: ServerResponse[] = [];
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => void held.push(res));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const billing = await scopeId("billing");
    try {
      for (let i = 0; i < MAX_QUEUED + 5; i++) await notify(db, connSettings(), [], { kind: "stale", title: `burst ${i}`, link: "#/", scopeId: billing });
      expect(errors.mock.calls.flat().filter((m) => /already wait for connection .*; dropped one/.test(String(m)))).toHaveLength(5);
    } finally {
      errors.mockRestore();
      handlers.set("POST /api/chat.postMessage", (_req, _b, res) => json(res, 200, { ok: true }));
      for (const res of held) json(res, 200, { ok: true });
    }
    await flushDeliveries();
    const posted = slackPosts("CBILLING1").map((p) => p.text);
    expect(posted).toHaveLength(MAX_QUEUED);
    expect(posted[0]).toContain("burst 0");
    expect(posted.at(-1)).toContain(`burst ${MAX_QUEUED - 1}`);
  });

  it("posts nothing for an event whose transaction rolls back, and only after the commit otherwise", async () => {
    await createRoute(await owner(), { project: "shop", connection_id: shopSlack, kinds: ["stale"] });
    const s = connSettings();
    const shop = await scopeId("shop");
    await expect(
      withTx(db, async (tx) => {
        await notify(tx, s, [], { kind: "stale", title: "Rolled back event", link: "#/", scopeId: shop });
        throw new Error("changed my mind");
      }),
    ).rejects.toThrow(/changed my mind/);
    await withTx(db, async (tx) => {
      await notify(tx, s, [], { kind: "stale", title: "Committed event", link: "#/", scopeId: shop });
      await flushDeliveries();
      expect(slackPosts()).toEqual([]);
    });
    await flushDeliveries();
    expect(slackPosts("CSHOP1111").map((p) => p.text)).toEqual([expect.stringContaining("Committed event")]);
  });

  it("gives a project's routes its sub-projects' events too; members-only sub-projects stay off team-wide routes", async () => {
    const a = await admin();
    await adminCreateProject(a, { slug: "shop-api", name: "Shop API", visibility: "team", parent: "shop" });
    await adminCreateProject(a, { slug: "shop-secret", name: "Shop secret", visibility: "members", parent: "shop" });
    await createRoute(await owner(), { project: "shop", connection_id: shopSlack, kinds: ["review"] });
    await createRoute(a, { connection_id: teamHook, kinds: ["review"] });
    const s = connSettings();
    await notify(db, s, [], { kind: "review", title: "Review in Shop API", link: "#/", scopeId: await scopeId("shop-api") });
    await notify(db, s, [], { kind: "review", title: "Review in Shop secret", link: "#/", scopeId: await scopeId("shop-secret") });
    await flushDeliveries();
    expect(slackPosts("CSHOP1111").map((p) => p.text)).toEqual([expect.stringContaining("Review in Shop API"), expect.stringContaining("Review in Shop secret")]);
    expect(hookPosts().map((p) => p.text)).toEqual([expect.stringContaining("Review in Shop API")]);
  });
});

describe("events that come in bursts or concern nobody in particular", () => {
  it("sends a members-only project request to team-wide routes unnamed, and a team project request in full", async () => {
    await createRoute(await admin(), { connection_id: teamHook, kinds: ["review"] });
    const requester = await as("requester@example.com");
    const secret = await createOrRequestProject(requester, { slug: "secret-acquisition", name: "Secret Acquisition", visibility: "members", reason: "confidential M&A target Foo Corp" });
    expect(secret.status).toBe("requested");
    await flushDeliveries();
    const posts = hookPosts().map((p) => p.text);
    expect(posts).toEqual(["*A members-only project was requested*\nOpen the review queue to see it and decide.\n<https://kb.example.com/#/review?tab=projects|Open in Thaliyola>"]);
    expect(posts.join()).not.toMatch(/Secret|secret-acquisition|Foo Corp|requester@/);
    // The people who decide still get the details in Thaliyola.
    const told = await db.query<{ title: string; body: string }>("SELECT n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com' AND n.kind = 'review'");
    expect(told.rows).toEqual([{ title: "New project requested: Secret Acquisition", body: expect.stringContaining("confidential M&A target Foo Corp") }]);

    // No visibility given: the server's default (members-only here) decides.
    hits.length = 0;
    await createOrRequestProject({ ...requester, settings: connSettings({}, { defaultProjectVisibility: "members" }) }, { slug: "quiet-thing", name: "Quiet thing" });
    await createOrRequestProject(requester, { slug: "open-thing", name: "Open thing", visibility: "team", reason: "for everyone" });
    await flushDeliveries();
    expect(hookPosts().map((p) => p.text)).toEqual([
      expect.stringContaining("A members-only project was requested"),
      expect.stringMatching(/^\*New project requested: Open thing\*\nrequester@example\.com asked for a project 'open-thing': for everyone\./),
    ]);
  });

  it("posts one stale summary per project and run, including entries nobody owns; owners are still told one by one", async () => {
    await createRoute(await owner(), { project: "shop", connection_id: shopSlack, kinds: ["stale"] });
    await createRoute(await owner(), { project: "billing", connection_id: billingSlack, kinds: ["stale"] });
    await createRoute(await admin(), { connection_id: teamHook, kinds: ["stale"] });
    const shop = await scopeId("shop");
    const billing = await scopeId("billing");
    const ownerId = (await owner()).actor.id;
    const id = () => crypto.randomUUID();
    await onStale(db, connSettings(), [
      { id: id(), kind: "article", title: "Orphan runbook", owner_id: null, scope_id: shop },
      { id: id(), kind: "article", title: "Owned runbook", owner_id: ownerId, scope_id: shop },
      { id: id(), kind: "finding", title: "Refund gotcha", owner_id: null, scope_id: shop },
      { id: id(), kind: "article", title: "Ledger runbook", owner_id: null, scope_id: billing },
    ]);
    await flushDeliveries();
    const shopPosts = slackPosts("CSHOP1111").map((p) => p.text);
    expect(shopPosts).toHaveLength(1);
    expect(shopPosts[0]).toMatch(/^\*3 entries in Shop need re-verifying\*\n• Orphan runbook\n• Owned runbook\n• Refund gotcha\n/);
    expect(shopPosts[0]).toContain("<https://kb.example.com/#/review?tab=check&scope=shop|Open in Thaliyola>");
    // One entry: its own title and link.
    expect(slackPosts("CBILLING1").map((p) => p.text)).toEqual([expect.stringMatching(/^\*Needs re-verifying: Ledger runbook\*\n.*\n<https:\/\/kb\.example\.com\/#\/article\//)]);
    // Team-wide: Shop's summary, never members-only Billing's.
    expect(hookPosts().map((p) => p.text)).toEqual([expect.stringContaining("3 entries in Shop need re-verifying")]);
    const owned = await db.query("SELECT title FROM notifications WHERE user_id = $1 AND kind = 'stale'", [ownerId]);
    expect(owned.rows).toEqual([{ title: "Needs re-verifying: Owned runbook" }]);
  });

  it("posts one message per schema sync, however many tables changed; people still hear about each table", async () => {
    await createRoute(await owner(), { project: "shop", connection_id: shopSlack, kinds: ["connection"] });
    const shop = await scopeId("shop");
    const conn = { id: shopSlack, scope_id: shop, component_id: null, kind: "postgres" as const, name: "Shop DB", state: {} };
    const table = (key: string, column: string) => ({ objectId: crypto.randomUUID(), key, articleId: null, version: null, changes: [{ change: "column_removed" as const, detail: { column, type: "text" } }] });
    await announceChanges(db, connSettings(), conn, [table("public.orders", "note"), table("public.refunds", "reason"), table("public.carts", "coupon")]);
    await flushDeliveries();
    const posts = slackPosts("CSHOP1111").map((p) => p.text);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^\*Schema changed: 3 tables \(Shop DB, Shop\)\*\npublic\.orders: column note removed\npublic\.refunds: column reason removed\npublic\.carts: column coupon removed\n/);
    expect(posts[0]).toContain("#/project/shop?tab=data|Open in Thaliyola>");
    expect((await connectionNotes("owner@example.com")).map((n) => n.title)).toEqual([
      "Schema changed: public.orders (Shop DB, Shop)",
      "Schema changed: public.refunds (Shop DB, Shop)",
      "Schema changed: public.carts (Shop DB, Shop)",
    ]);

    // One table: its own message.
    hits.length = 0;
    await announceChanges(db, connSettings(), conn, [table("public.orders", "total")]);
    await flushDeliveries();
    expect(slackPosts("CSHOP1111").map((p) => p.text)).toEqual([expect.stringMatching(/^\*Schema changed: public\.orders \(Shop DB, Shop\)\*\npublic\.orders: column total removed/)]);
  });
});

describe("project digests", () => {
  const NOW = new Date("2026-11-11T09:30:00");

  async function seedShop() {
    const shop = await scopeId("shop");
    await db.query("UPDATE revisions SET state = 'rejected' WHERE scope_id = $1 AND state = 'pending'", [shop]);
    const w = await writer();
    const pending = await proposeFinding({ ...w, project: "shop" }, { type: "rca", title: "Checkout times out under load", symptoms: "504s", root_cause: "Pool too small", force_new: true });
    await db.query("UPDATE revisions SET created_at = $2 WHERE id = $1", [(pending as { revision_id: string }).revision_id, new Date(NOW.getTime() - 3 * 86_400_000 - 3600_000)]);
    const published = await proposeFinding({ ...(await owner()), project: "shop" }, { type: "rca", title: "Coupons applied twice", symptoms: "Double discount", root_cause: "Race", force_new: true });
    expect(published.status).toBe("published");
    await db.query("UPDATE revisions SET decided_at = $2 WHERE id = $1", [(published as { revision_id: string }).revision_id, new Date(NOW.getTime() - 2 * 3600_000)]);
    await db.query(
      "INSERT INTO articles (scope_id, type, title, body_md, status, last_verified_at) VALUES ($1, 'runbook', 'Refund runbook', 'Steps', 'possibly_stale', $2)",
      [shop, new Date(NOW.getTime() - 200 * 86_400_000)],
    );
    return shop;
  }

  it("summarises what was published, what waits for review (and how long) and what is stale", async () => {
    const shop = await seedShop();
    const d = (await buildDigest(db, connSettings(), { id: shop, slug: "shop", name: "Shop" }, "daily", NOW))!;
    expect(d.totals).toEqual({ published: 1, waiting: 1, stale: 1 });
    expect(d.text).toContain("*Shop: daily digest*");
    expect(d.text).toMatch(/\*Published in the last day \(1\)\*\n• <https:\/\/kb\.example\.com\/#\/finding\/[\w-]+\|.*Coupons applied twice>/);
    expect(d.text).toMatch(/\*Waiting for review \(1\)\*\n• <https:\/\/kb\.example\.com\/#\/review\/[\w-]+\|.*Checkout times out under load>: waiting 3 days/);
    expect(d.text).toMatch(/\*Needs re-verifying \(1\)\*\n• <https:\/\/kb\.example\.com\/#\/article\/[\w-]+\|Refund runbook>: last verified 200 days ago/);
    expect(d.text).toContain("<https://kb.example.com/#/project/shop|Open Shop in Thaliyola>");
    // Nothing to say: no digest.
    expect(await buildDigest(db, connSettings(), { id: await scopeId("other"), slug: "other", name: "Other" }, "weekly", NOW)).toBeNull();
  });

  it("posts each route's digest once per slot to its Slack channel", async () => {
    const o = await owner();
    const r = await createRoute(o, { project: "shop", connection_id: shopSlack, kinds: [], digest: "daily" });
    // Set up just now: the first digest waits for the next slot.
    await db.query("UPDATE notification_routes SET digest_sent_at = $2 WHERE id = $1", [r.id, new Date(NOW.getTime() - 3600_000)]);
    const s = connSettings();
    expect(await sendRouteDigests(db, s, NOW)).toEqual({ sent: 0, empty: 0, failed: 0 });
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    expect(await sendRouteDigests(db, s, tomorrow)).toEqual({ sent: 1, empty: 0, failed: 0 });
    expect(await sendRouteDigests(db, s, new Date(tomorrow.getTime() + 3600_000))).toEqual({ sent: 0, empty: 0, failed: 0 });
    const posts = slackPosts("CSHOP1111");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("*Shop: daily digest*");
    expect(posts[0]!.text).toContain("Checkout times out under load");

    // A project with nothing to report gets nothing (and isn't asked again until the next slot).
    const otherRoute = await createRoute(o, { project: "other", connection_id: otherSlack, kinds: [], digest: "weekly" });
    await db.query("UPDATE notification_routes SET digest_sent_at = NULL WHERE id = $1", [otherRoute.id]);
    expect(await sendRouteDigests(db, s, new Date(tomorrow.getTime() + 7200_000))).toEqual({ sent: 0, empty: 1, failed: 0 });

    // Send now: a preview, for the project's admins.
    hits.length = 0;
    await expect(sendDigestNow(await writer(), r.id)).rejects.toThrow(/Manage settings/);
    expect(await sendDigestNow(o, r.id)).toEqual({ ok: true, sent: true, detail: "Posted the daily digest to Shop channel." });
    expect(slackPosts("CSHOP1111")).toHaveLength(1);
    expect(await sendDigestNow(o, otherRoute.id)).toMatchObject({ ok: true, sent: false, detail: expect.stringMatching(/^Nothing to report/) });
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => json(res, 200, { ok: false, error: "not_in_channel" }));
    expect(await sendDigestNow(o, r.id)).toEqual({ ok: false, error: "Slack said not_in_channel (invite the bot to the channel)" });
    expect(await health(shopSlack)).toMatchObject({ health: "failing" });
    await expect(sendDigestNow(o, (await createRoute(o, { project: "billing", connection_id: billingSlack, kinds: ["review"] })).id)).rejects.toThrow(/no digest/);
  });

  it("tries a digest that didn't go out again on the next ticks, a few times, then waits for the next slot", async () => {
    const o = await owner();
    await seedShop();
    const r = await createRoute(o, { project: "shop", connection_id: shopSlack, kinds: [], digest: "daily" });
    const before = new Date(NOW.getTime() - 86_400_000);
    await db.query("UPDATE notification_routes SET digest_sent_at = $2 WHERE id = $1", [r.id, before]);
    let calls = 0;
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => {
      calls++;
      json(res, 200, { ok: false, error: "not_in_channel" });
    });
    const s = connSettings();
    const tick = (minutes: number) => sendRouteDigests(db, s, new Date(NOW.getTime() + minutes * 60_000));
    expect(await tick(0)).toEqual({ sent: 0, empty: 0, failed: 1 });
    // The slot is given back: the next tick tries again.
    const row = async () => (await db.query<{ digest_sent_at: Date; digest_failures: number }>("SELECT digest_sent_at, digest_failures FROM notification_routes WHERE id = $1", [r.id])).rows[0]!;
    expect(await row()).toEqual({ digest_sent_at: before, digest_failures: 1 });
    // It works on the second try: posted once, the count starts again.
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => {
      calls++;
      json(res, 200, { ok: true });
    });
    expect(await tick(1)).toEqual({ sent: 1, empty: 0, failed: 0 });
    expect((await row()).digest_failures).toBe(0);
    expect(await tick(2)).toEqual({ sent: 0, empty: 0, failed: 0 });
    expect(calls).toBe(2);

    // Failing every time: DIGEST_TRIES tries, then nothing more until the next slot.
    await db.query("UPDATE notification_routes SET digest_sent_at = $2 WHERE id = $1", [r.id, before]);
    handlers.set("POST /api/chat.postMessage", (_req, _b, res) => {
      calls++;
      json(res, 500, { ok: false });
    });
    calls = 0;
    for (let i = 0; i < DIGEST_TRIES + 2; i++) await tick(10 + i);
    expect(calls).toBe(DIGEST_TRIES);
    expect(await row()).toMatchObject({ digest_failures: 0 });
    expect((await row()).digest_sent_at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await tick(24 * 60 + 10)).toEqual({ sent: 0, empty: 0, failed: 1 });
  });

  it("finds the slot: daily at DIGEST_HOUR, weekly on DIGEST_DAY", () => {
    expect(dailySlot(new Date("2026-11-11T09:30:00"), 8)).toEqual(new Date("2026-11-11T08:00:00"));
    expect(dailySlot(new Date("2026-11-11T07:59:00"), 8)).toEqual(new Date("2026-11-10T08:00:00"));
  });
});

describe("email preferences", () => {
  it("starts the access email preference off for people who had turned off review emails (migration 046)", async () => {
    const sql = readFileSync(new URL("../migrations/046_notification_fixes.sql", import.meta.url), "utf8");
    const update = sql.slice(sql.indexOf("UPDATE users"));
    const set = async (email: string, prefs: unknown) => {
      await ctxFor(db, { email });
      await db.query("UPDATE users SET prefs = $2 WHERE email = $1", [email, JSON.stringify(prefs)]);
    };
    await set("noreview@example.com", { email: { review: false, comment: true } });
    await set("reviewfine@example.com", { email: { review: true } });
    await set("chose@example.com", { email: { review: false, access: true } });
    await set("noprefs@example.com", {});
    await db.query(update);
    const prefs = async (email: string) => (await db.query<{ prefs: unknown }>("SELECT prefs FROM users WHERE email = $1", [email])).rows[0]!.prefs;
    expect(await prefs("noreview@example.com")).toEqual({ email: { review: false, comment: true, access: false } });
    expect(await prefs("reviewfine@example.com")).toEqual({ email: { review: true } });
    expect(await prefs("chose@example.com")).toEqual({ email: { review: false, access: true } });
    expect(await prefs("noprefs@example.com")).toEqual({});
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
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  it("lists, creates, updates and removes routes, per project and team-wide", async () => {
    const created = await call("own", "POST", "/api/notification-routes", { project: "billing", connection_id: billingTrello, kinds: ["review", "stale"] });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect((await call("own", "GET", "/api/projects/billing/notification-routes")).body.routes).toHaveLength(1);
    expect((await call("wri", "GET", "/api/projects/billing/notification-routes")).status).toBe(403);
    expect((await call("own", "PATCH", `/api/notification-routes/${id}`, { kinds: ["comment"] })).body.kinds).toEqual(["comment"]);
    expect((await call("own", "PATCH", `/api/notification-routes/${id}`, { digest: "hourly" })).status).toBe(400);
    expect((await call("own", "GET", "/api/notification-routes")).status).toBe(403);
    expect((await call("adm", "GET", "/api/notification-routes")).status).toBe(200);
    expect((await call("own", "DELETE", `/api/notification-routes/${id}`)).status).toBe(200);
    expect((await call("own", "POST", "/api/notification-routes", { project: "billing", connection_id: "nope" })).status).toBe(400);
  });
});
