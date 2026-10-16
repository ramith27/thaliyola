import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator, sessionAuthenticator } from "../src/auth/index.js";
import { createApiToken, createLocalUser } from "../src/auth/local.js";
import { checkPasswordStrength, hashPassword, verifyPassword } from "../src/auth/passwords.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const settings = { ...TEST_SETTINGS, authMode: "local" as const, adminEmails: [] };

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: chain(apiTokenAuthenticator(db), sessionAuthenticator(db)), settings }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await createLocalUser(db, { email: "admin@example.com", password: "correct horse battery", isAdmin: true });
  await createLocalUser(db, { email: "member@example.com", password: "member password 1" });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

/** A tiny cookie-jar client. */
function browser() {
  let cookie = "";
  return {
    async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), origin: base, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
    },
    get cookie() {
      return cookie;
    },
  };
}

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("a long enough secret");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("a long enough secret", h)).toBe(true);
    expect(await verifyPassword("a long enough secreT", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(checkPasswordStrength("short")).toMatch(/at least 10/);
    expect(checkPasswordStrength("aaaaaaaaaaaa")).toMatch(/repetitive/);
  });
});

describe("local sign-in", () => {
  it("reports the auth mode publicly", async () => {
    expect(await (await fetch(`${base}/auth/config`)).json()).toEqual({ mode: "local" });
  });

  it("signs in with an HttpOnly session cookie and signs out", async () => {
    const b = browser();
    expect((await b.req("GET", "/api/me")).status).toBe(401);
    const login = await b.req("POST", "/auth/login", { email: "Admin@Example.com", password: "correct horse battery" });
    expect(login.status).toBe(200);
    expect(login.setCookie).toMatch(/cairn_session=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400/);
    const me = await b.req("GET", "/api/me");
    expect(me.body).toMatchObject({ email: "admin@example.com", admin: true, local_account: true, must_change_password: false, auth_mode: "local" });
    await b.req("POST", "/auth/logout");
    expect((await b.req("GET", "/api/me")).status).toBe(401);
  });

  it("rejects wrong passwords and throttles guessing", async () => {
    const b = browser();
    expect((await b.req("POST", "/auth/login", { email: "member@example.com", password: "nope" })).status).toBe(401);
    expect((await b.req("POST", "/auth/login", { email: "nobody@example.com", password: "nope" })).status).toBe(401);
    for (let i = 0; i < 9; i++) await b.req("POST", "/auth/login", { email: "member@example.com", password: "nope" });
    const blocked = await b.req("POST", "/auth/login", { email: "member@example.com", password: "member password 1" });
    expect(blocked.status).toBe(429);
  });

  it("refuses cross-site writes made with the session cookie", async () => {
    const b = browser();
    await b.req("POST", "/auth/login", { email: "admin@example.com", password: "correct horse battery" });
    const evil = await b.req("POST", "/api/projects", { slug: "evil", name: "Evil" }, { origin: "https://evil.example" });
    expect(evil).toMatchObject({ status: 403, body: { error: "cross-site request refused" } });
    const crossSite = await b.req("POST", "/api/projects", { slug: "evil", name: "Evil" }, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    const ok = await b.req("POST", "/api/projects", { slug: "same-origin", name: "Same origin" });
    expect(ok.status).toBe(200);
  });
});

describe("temporary passwords and user management", () => {
  it("lets an admin create a user who must change the temporary password first", async () => {
    const admin = browser();
    await admin.req("POST", "/auth/login", { email: "admin@example.com", password: "correct horse battery" });
    const created = await admin.req("POST", "/api/users", { email: "new@example.com", name: "New Person" });
    const temp = created.body.temporary_password as string;
    expect(temp).toMatch(/^\w{5}-\w{5}-\w{5}-\w{5}$/);

    const user = browser();
    expect((await user.req("POST", "/auth/login", { email: "new@example.com", password: temp })).body).toEqual({ ok: true, must_change_password: true });
    expect((await user.req("GET", "/api/scopes")).body).toMatchObject({ code: "must_change_password" });
    expect((await user.req("POST", "/api/account/password", { current: temp, next: "short" })).status).toBe(400);
    expect((await user.req("POST", "/api/account/password", { current: temp, next: "my own new password" })).status).toBe(200);
    expect((await user.req("GET", "/api/scopes")).status).toBe(200);

    const other = browser();
    expect((await other.req("POST", "/auth/login", { email: "new@example.com", password: "my own new password" })).status).toBe(200);
  });

  it("resets passwords, disables accounts and protects admins from locking themselves out", async () => {
    const admin = browser();
    await admin.req("POST", "/auth/login", { email: "admin@example.com", password: "correct horse battery" });
    await createLocalUser(db, { email: "leaver@example.com", password: "leaver password 1" });
    const users = (await admin.req("GET", "/api/users")).body.users as { id: string; email: string }[];
    const member = users.find((u) => u.email === "leaver@example.com")!;
    const self = users.find((u) => u.email === "admin@example.com")!;

    const memberToken = await createApiToken(db, member.id, "laptop");
    const reset = await admin.req("POST", `/api/users/${member.id}/reset-password`);
    expect(reset.body.temporary_password).toBeTruthy();

    expect((await admin.req("PATCH", `/api/users/${member.id}`, { disabled: true })).body.user.disabled_at).toBeTruthy();
    const login = await browser().req("POST", "/auth/login", { email: "leaver@example.com", password: reset.body.temporary_password });
    expect(login.status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${memberToken.token}` } })).status).toBe(401);

    expect((await admin.req("PATCH", `/api/users/${self.id}`, { disabled: true })).status).toBe(403);
    expect((await admin.req("PATCH", `/api/users/${self.id}`, { is_admin: false })).status).toBe(403);
  });

  it("keeps user management for admins", async () => {
    const b = browser();
    await b.req("POST", "/auth/login", { email: "new@example.com", password: "my own new password" });
    expect((await b.req("GET", "/api/users")).status).toBe(403);
    expect((await b.req("POST", "/api/users", { email: "x@example.com" })).status).toBe(403);
  });
});

describe("personal API tokens", () => {
  it("are shown once, work for MCP clients, and stop working when revoked", async () => {
    const b = browser();
    await b.req("POST", "/auth/login", { email: "new@example.com", password: "my own new password" });
    const created = await b.req("POST", "/api/account/tokens", { name: "Claude Code on laptop", expires_in_days: 30 });
    const token = created.body.token as string;
    expect(token).toMatch(/^cairn_pat_[\w-]{40}$/);
    const listed = (await b.req("GET", "/api/account/tokens")).body.tokens;
    expect(listed[0]).toMatchObject({ name: "Claude Code on laptop", prefix: token.slice(0, 16) });
    expect(JSON.stringify(listed)).not.toContain(token);

    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(10);
    await client.close();

    await b.req("DELETE", `/api/account/tokens/${created.body.id}`);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("rejects expired tokens and are not subject to the cookie CSRF check", async () => {
    const { rows } = await db.query("SELECT id FROM users WHERE subject = 'local:admin@example.com'");
    const t = await createApiToken(db, rows[0].id, "ci");
    const write = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", origin: "https://elsewhere.example" },
      body: JSON.stringify({ slug: "from-token", name: "From token" }),
    });
    expect(write.status).toBe(200);
    await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [t.id]);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(401);
  });

  it("also work alongside another sign-in mode", async () => {
    const auth = chain(apiTokenAuthenticator(db), devAuthenticator("dev=dev@example.com"));
    const { rows } = await db.query("SELECT id FROM users WHERE subject = 'local:admin@example.com'");
    const t = await createApiToken(db, rows[0].id, "job");
    const req = (h: Record<string, string>) => ({ header: (n: string) => h[n.toLowerCase()] }) as never;
    expect(await auth(req({ authorization: `Bearer ${t.token}` }))).toMatchObject({ subject: "local:admin@example.com" });
    expect(await auth(req({ authorization: "Bearer dev" }))).toMatchObject({ subject: "dev:dev@example.com" });
  });
});
