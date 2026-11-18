import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator } from "../src/auth/index.js";
import { createLocalUser } from "../src/auth/local.js";
import { flushDeliveries } from "../src/core/notify.js";
import { upsertUser } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const settings = { ...TEST_SETTINGS, requireApproval: true, adminEmails: ["boss@example.com"] };
const TOKENS = "added=added@example.com,waiting=waiting@example.com,boss=boss@example.com,member=member@example.com,new=new@example.com,other=other@example.com,svc=svc-bot@example.com,linked=linked@example.com";

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: chain(apiTokenAuthenticator(db), devAuthenticator(TOKENS)), settings }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Someone who was already here before approval was turned on.
  await upsertUser(db, { subject: "dev:member@example.com", email: "member@example.com", kind: "human" });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const idOf = async (email: string) => (await db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
const notes = async (email: string) =>
  (await db.query("SELECT n.kind, n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 ORDER BY n.created_at", [email])).rows;

describe("approval of new people", () => {
  it("lets admins (ADMIN_EMAILS) and existing accounts straight in", async () => {
    expect((await call("boss", "GET", "/api/me")).status).toBe(200);
    expect((await call("member", "GET", "/api/me")).status).toBe(200);
  });

  it("keeps someone new out of the API and MCP until approved, and tells the admins once", async () => {
    const first = await call("new", "GET", "/api/me");
    expect(first).toEqual({ status: 403, body: { error: "waiting for an admin to approve your access", code: "approval_required", email: "new@example.com" } });
    expect((await call("new", "GET", "/api/scopes")).status).toBe(403);
    expect((await call("new", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    await flushDeliveries();
    expect(await notes("boss@example.com")).toEqual([{ kind: "access", title: "new@example.com is waiting for access" }]);
    expect(await notes("member@example.com")).toEqual([]);
  });

  it("lets only admins see and decide requests", async () => {
    expect((await call("member", "GET", "/api/access-requests")).status).toBe(403);
    expect((await call("member", "POST", `/api/access-requests/${await idOf("new@example.com")}/approve`)).status).toBe(403);
    const list = await call("boss", "GET", "/api/access-requests");
    expect(list.body.requests.map((r: { email: string }) => r.email)).toEqual(["new@example.com"]);
  });

  it("approves: the person gets in and is told", async () => {
    const id = await idOf("new@example.com");
    expect((await call("boss", "POST", `/api/access-requests/${id}/approve`)).body).toMatchObject({ approved: true });
    expect((await call("new", "GET", "/api/me")).status).toBe(200);
    expect(await notes("new@example.com")).toEqual([{ kind: "decided", title: "You now have access to Thaliyola" }]);
    expect((await call("boss", "POST", `/api/access-requests/${id}/approve`)).status).toBe(404);
    expect((await call("boss", "GET", "/api/access-requests")).body.requests).toEqual([]);
  });

  it("declines: the account is disabled but can still be approved later", async () => {
    await call("other", "GET", "/api/me");
    const id = await idOf("other@example.com");
    await call("boss", "POST", `/api/access-requests/${id}/decline`);
    expect((await call("other", "GET", "/api/me")).body).toEqual({ error: "account disabled", code: "account_disabled" });
    expect((await call("boss", "GET", "/api/access-requests")).body.requests).toMatchObject([{ email: "other@example.com", declined: true }]);
    await call("boss", "POST", `/api/access-requests/${id}/approve`);
    expect((await call("other", "GET", "/api/me")).status).toBe(200);
  });

  it("lets people still waiting in once approval is turned off", async () => {
    await call("svc", "GET", "/api/me");
    const identity = { subject: "dev:svc-bot@example.com", email: "svc-bot@example.com", kind: "service" as const };
    expect(await upsertUser(db, identity, { approval: true })).toMatchObject({ approved: false });
    expect(await upsertUser(db, identity)).toMatchObject({ approved: true });
    await db.query("UPDATE users SET approved_at = NULL WHERE subject = $1", [identity.subject]);
  });
});

describe("managing people", () => {
  it("lists every approved account, whatever the sign-in, but not people still waiting", async () => {
    await call("svc", "GET", "/api/me"); // waits for approval
    const people = (await call("boss", "GET", "/api/users")).body.users.map((u: { email: string }) => u.email);
    expect(people).toEqual(expect.arrayContaining(["boss@example.com", "member@example.com", "new@example.com"]));
    expect(people).not.toContain("svc-bot@example.com");
    expect((await call("member", "GET", "/api/users")).status).toBe(403);
  });

  it("makes someone an admin, and disables and re-enables an account", async () => {
    const id = await idOf("member@example.com");
    expect((await call("boss", "PATCH", `/api/users/${id}`, { is_admin: true })).body.user).toMatchObject({ is_admin: true });
    expect((await call("member", "GET", "/api/me")).body).toMatchObject({ admin: true });
    await call("boss", "PATCH", `/api/users/${id}`, { is_admin: false, disabled: true });
    expect((await call("member", "GET", "/api/me")).body).toEqual({ error: "account disabled", code: "account_disabled" });
    await call("boss", "PATCH", `/api/users/${id}`, { disabled: false });
    expect((await call("member", "GET", "/api/me")).body).toMatchObject({ admin: false });
    expect((await call("boss", "PATCH", `/api/users/${await idOf("boss@example.com")}`, { disabled: true })).status).toBe(403);
  });
});

describe("adding people by email", () => {
  it("lets someone added by an admin in at their first sign-in, with the rights they were given", async () => {
    expect((await call("member", "POST", "/api/users", { email: "added@example.com" })).status).toBe(403);
    const res = await call("boss", "POST", "/api/users", { email: " Added@Example.com ", name: "Ada", is_admin: true, project: "order-service", role: "owner" });
    expect(res.body).toMatchObject({ email: "added@example.com", status: "added" });
    const before = (await call("boss", "GET", "/api/users")).body.users.find((u: { email: string }) => u.email === "added@example.com");
    expect(before).toMatchObject({ pending: true, is_admin: true, display_name: "Ada" });

    expect((await call("added", "GET", "/api/me")).body).toMatchObject({ email: "added@example.com", admin: true });
    const roles = await db.query(
      "SELECT m.role FROM scope_members m JOIN scopes s ON s.id = m.scope_id JOIN users u ON u.id = m.user_id WHERE u.email = 'added@example.com' AND s.slug = 'order-service'",
    );
    expect(roles.rows).toEqual([{ role: "owner" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE email = 'added@example.com'")).rows[0].n).toBe(1);
    const after = (await call("boss", "GET", "/api/users")).body.users.find((u: { email: string }) => u.email === "added@example.com");
    expect(after).toMatchObject({ pending: false });
    const waiting = (await call("boss", "GET", "/api/access-requests")).body.requests.map((r: { email: string }) => r.email);
    expect(waiting).not.toContain("added@example.com");
    expect((await call("boss", "POST", "/api/users", { email: "added@example.com" })).body.error).toMatch(/already has access/);
  });

  it("approves someone who is already waiting", async () => {
    expect((await call("waiting", "GET", "/api/me")).status).toBe(403);
    expect((await call("boss", "POST", "/api/users", { email: "waiting@example.com" })).body).toMatchObject({ status: "approved" });
    expect((await call("waiting", "GET", "/api/me")).status).toBe(200);
  });

  it("keeps someone added and then disabled out", async () => {
    await call("boss", "POST", "/api/users", { email: "later@example.com" });
    await call("boss", "PATCH", `/api/users/${await idOf("later@example.com")}`, { disabled: true });
    const later = await upsertUser(db, { subject: "cf:later", email: "later@example.com", kind: "human" }, { approval: true });
    expect(later).toMatchObject({ disabled: true, approved: true });
  });
});

describe("one account per person", () => {
  it("uses someone's built-in account when they sign in another way, instead of creating a second one", async () => {
    const { user } = await createLocalUser(db, { email: "linked@example.com", password: "linked password 1", isAdmin: true });
    expect((await call("linked", "GET", "/api/me")).body).toMatchObject({ id: user.id, admin: true });
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE email = 'linked@example.com'")).rows[0].n).toBe(1);
    expect((await db.query("SELECT last_seen_at FROM users WHERE id = $1", [user.id])).rows[0].last_seen_at).not.toBeNull();
  });

  it("merges second accounts created before into the original (migration 026)", async () => {
    const team = (await db.query("SELECT id FROM scopes WHERE slug = 'team'")).rows[0].id;
    const project = (await db.query("SELECT id FROM scopes WHERE kind = 'project' LIMIT 1")).rows[0].id;
    const { user: keep } = await createLocalUser(db, { email: "twice@example.com", password: "twice password 1", isAdmin: true });
    const dup = (await db.query("INSERT INTO users (subject, email) VALUES ('cf:twice@example.com', 'twice@example.com') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'reader'), ($4, $3, 'writer')", [team, keep.id, dup, project]);
    await db.query("UPDATE users SET approved_by = $1 WHERE email = 'new@example.com'", [dup]);
    await db.query("INSERT INTO audit_log (actor_id, tool) VALUES ($1, 'test')", [dup]);

    const sql = readFileSync(new URL("../migrations/026_one_account_per_person.sql", import.meta.url), "utf8");
    await db.query(sql.slice(sql.indexOf("DO $$")));

    expect((await db.query("SELECT id, is_admin FROM users WHERE email = 'twice@example.com'")).rows).toEqual([{ id: keep.id, is_admin: true }]);
    const roles = (await db.query("SELECT scope_id, role FROM scope_members WHERE user_id = $1 ORDER BY role", [keep.id])).rows;
    // People can hold several roles in a scope (migration 029), so both accounts' roles are kept.
    expect(roles).toEqual([
      { scope_id: team, role: "owner" },
      { scope_id: team, role: "reader" },
      { scope_id: project, role: "writer" },
    ]);
    expect((await db.query("SELECT approved_by FROM users WHERE email = 'new@example.com'")).rows[0].approved_by).toBe(keep.id);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND tool = 'test'", [keep.id])).rows[0].n).toBe(1);
  });

  it("shows ADMIN_EMAILS admins as admins that can't be changed on the page", async () => {
    const boss = (await call("boss", "GET", "/api/users")).body.users.find((u: { email: string }) => u.email === "boss@example.com");
    expect(boss).toMatchObject({ is_admin: true, admin_by_config: true });
  });
});
