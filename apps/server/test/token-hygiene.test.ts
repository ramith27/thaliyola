import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator } from "../src/auth/index.js";
import { createApiToken, UNUSED_AFTER_DAYS } from "../src/auth/local.js";
import { setUserRoles } from "../src/core/roles.js";
import { ensureServiceAccount } from "../src/core/service-accounts.js";
import { EXPIRY_NOTICE_DAYS, notifyExpiringTokens, startTokenJobs } from "../src/core/token-hygiene.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const DAY = 86_400_000;

beforeAll(async () => {
  ({ db } = await freshDb());
  const authenticate = chain(apiTokenAuthenticator(db), devAuthenticator("admin=admin@example.com,member=member@example.com,erin=erin@example.com,svc=svc-bot@example.com"));
  server = createApp({ db, authenticate, settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of ["admin", "member", "erin"]) await ctxFor(db, { email: `${p}@example.com` });
  await ctxFor(db, { email: "svc-bot@example.com", service: true });
  // erin is a User manager (Manage people): she hears about service-account tokens; member doesn't.
  await setUserRoles(await ctxFor(db, { email: "admin@example.com" }), await idOf("erin"), ["user_manager"]);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [`${p}@example.com`])).rows[0].id as string;

async function call(auth: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const works = async (token: string) => (await call(token, "GET", "/me")).status === 200;
const tokenRow = async (id: string) => (await db.query("SELECT * FROM api_tokens WHERE id = $1", [id])).rows[0];
const near = (actual: Date | string, expectedMs: number, slackMs = 60_000) => Math.abs(new Date(actual).getTime() - expectedMs) < slackMs;

describe("rotating personal tokens", () => {
  it("makes a new token with the same name and lifetime, shown once, and keeps the old one for the grace period", async () => {
    const made = await call("member", "POST", "/account/tokens", { name: "Laptop", expires_in_days: 90 });
    expect(await works(made.body.token)).toBe(true);
    const rotated = await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "1d" });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ name: "Laptop", lifetime_days: 90, replaced: { id: made.body.id, name: "Laptop", grace: "1d" } });
    expect(rotated.body.token).toMatch(/^thaliyola_pat_/);
    expect(rotated.body.token).not.toBe(made.body.token);
    expect(near(rotated.body.expires_at, Date.now() + 90 * DAY)).toBe(true);
    expect(near(rotated.body.replaced.works_until, Date.now() + DAY)).toBe(true);
    // Both work during the grace period.
    expect(await works(rotated.body.token)).toBe(true);
    expect(await works(made.body.token)).toBe(true);
    // The list marks the old one as replaced and never shows a token or its hash.
    const list = await call("member", "GET", "/account/tokens");
    const old = list.body.tokens.find((t: { id: string }) => t.id === made.body.id);
    expect(old).toMatchObject({ replaced_by: rotated.body.id, unused: false });
    expect(old.rotated_at).toBeTruthy();
    const listed = JSON.stringify(list.body);
    for (const secret of [made.body.token, rotated.body.token, "token_hash"]) expect(listed).not.toContain(secret);
    // After the grace period it stops.
    await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [made.body.id]);
    expect(await works(made.body.token)).toBe(false);
    expect(await works(rotated.body.token)).toBe(true);
  });

  it("stops the old token at once with no grace period", async () => {
    const made = await call("member", "POST", "/account/tokens", { name: "CI", expires_in_days: 30 });
    const rotated = await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "none" });
    expect(rotated.body.replaced.works_until).toBeNull();
    expect(await works(made.body.token)).toBe(false);
    expect(await works(rotated.body.token)).toBe(true);
  });

  it("never lets the grace period outlast the old token, and keeps no-expiry tokens without expiry", async () => {
    const made = await call("member", "POST", "/account/tokens", { name: "Short", expires_in_days: 30 });
    await db.query("UPDATE api_tokens SET expires_at = now() + interval '2 days' WHERE id = $1", [made.body.id]);
    const rotated = await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "7d" });
    expect(near(rotated.body.replaced.works_until, Date.now() + 2 * DAY)).toBe(true);

    const forever = await call("member", "POST", "/account/tokens", { name: "Forever" });
    const next = await call("member", "POST", `/account/tokens/${forever.body.id}/rotate`, { grace: "7d" });
    expect(next.body).toMatchObject({ expires_at: null, lifetime_days: null });
    expect(near(next.body.replaced.works_until, Date.now() + 7 * DAY)).toBe(true);
  });

  it("refuses revoked, expired, already rotated, other people's and unknown tokens, and bad grace periods", async () => {
    const made = await call("member", "POST", "/account/tokens", { name: "Desk", expires_in_days: 30 });
    expect((await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "30d" })).status).toBe(400);
    expect((await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, {})).status).toBe(400);
    expect((await call("admin", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "1d" })).status).toBe(404);
    expect((await call("member", "POST", `/account/tokens/00000000-0000-0000-0000-000000000000/rotate`, { grace: "1d" })).status).toBe(404);
    expect((await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "1d" })).status).toBe(200);
    expect((await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "1d" })).body.error).toMatch(/already rotated/);

    const revoked = await call("member", "POST", "/account/tokens", { name: "Gone" });
    await call("member", "DELETE", `/account/tokens/${revoked.body.id}`);
    expect((await call("member", "POST", `/account/tokens/${revoked.body.id}/rotate`, { grace: "1d" })).body.error).toMatch(/revoked/);

    const expired = await call("member", "POST", "/account/tokens", { name: "Old", expires_in_days: 1 });
    await db.query("UPDATE api_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1", [expired.body.id]);
    expect((await call("member", "POST", `/account/tokens/${expired.body.id}/rotate`, { grace: "1d" })).body.error).toMatch(/expired/);
  });

  it("doesn't let a service account rotate its own tokens through the personal route", async () => {
    const svc = await idOf("svc-bot");
    const created = await createApiToken(db, svc, "self", 30);
    const res = await call(created.token, "POST", `/account/tokens/${created.id}/rotate`, { grace: "1d" });
    expect(res.status).toBe(403);
    expect((await tokenRow(created.id)).rotated_at).toBeNull();
  });

  it("records each rotation in the audit log without the token", async () => {
    const made = await call("member", "POST", "/account/tokens", { name: "Audited", expires_in_days: 30 });
    const rotated = await call("member", "POST", `/account/tokens/${made.body.id}/rotate`, { grace: "7d" });
    const page = await call("admin", "GET", `/audit?action=rotate_api_token&person=${await idOf("member")}`);
    expect(page.body.entries[0]).toMatchObject({
      action: "rotate_api_token",
      label: "Rotated a personal API token",
      target: { id: rotated.body.id, kind: "token", label: "Audited" },
      details: { token_name: "Audited", grace: "7d", old_token_id: made.body.id, new_token_id: rotated.body.id, old_works_until: rotated.body.replaced.works_until, expires_at: rotated.body.expires_at },
    });
    const everything = JSON.stringify((await db.query("SELECT details FROM audit_log")).rows);
    expect(everything).not.toContain(rotated.body.token);
    expect(everything).not.toContain(made.body.token);
  });
});

describe("rotating service-account tokens", () => {
  it("lets people who manage people rotate them, with the same rules and an audit entry", async () => {
    const sa = await call("admin", "POST", "/service-accounts", { name: "autocode" });
    const other = await call("admin", "POST", "/service-accounts", { name: "other-bot" });
    const made = await call("admin", "POST", `/service-accounts/${sa.body.id}/tokens`, { name: "AutoCode prod", expires_in_days: 365 });

    expect((await call("member", "POST", `/service-accounts/${sa.body.id}/tokens/${made.body.id}/rotate`, { grace: "1d" })).status).toBe(403);
    expect((await call("admin", "POST", `/service-accounts/${other.body.id}/tokens/${made.body.id}/rotate`, { grace: "1d" })).status).toBe(404);
    expect((await call(made.body.token, "POST", `/service-accounts/${sa.body.id}/tokens/${made.body.id}/rotate`, { grace: "1d" })).status).toBe(403);

    const rotated = await call("erin", "POST", `/service-accounts/${sa.body.id}/tokens/${made.body.id}/rotate`, { grace: "7d" });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ name: "AutoCode prod", lifetime_days: 365, identifier: "service:autocode", replaced: { id: made.body.id, grace: "7d" } });
    expect(await works(made.body.token)).toBe(true);
    expect(await works(rotated.body.token)).toBe(true);
    expect((await call(rotated.body.token, "GET", "/me")).body).toMatchObject({ kind: "service" });

    const list = await call("admin", "GET", "/service-accounts");
    const tokens = list.body.service_accounts.find((s: { id: string }) => s.id === sa.body.id).tokens;
    expect(tokens.find((t: { id: string }) => t.id === made.body.id)).toMatchObject({ replaced_by: rotated.body.id });

    const page = await call("admin", "GET", `/audit?action=rotate_service_token`);
    expect(page.body.entries[0]).toMatchObject({
      label: "Rotated a service account token",
      actor: { email: "erin@example.com" },
      target: { id: sa.body.id, kind: "service_account", label: "autocode" },
      details: { token_name: "AutoCode prod", grace: "7d", new_token_id: rotated.body.id },
    });

    // A disabled account's tokens can't be rotated (enable it first).
    await call("admin", "PATCH", `/service-accounts/${sa.body.id}`, { disabled: true });
    expect((await call("admin", "POST", `/service-accounts/${sa.body.id}/tokens/${rotated.body.id}/rotate`, { grace: "1d" })).body.error).toMatch(/disabled/);
  });
});

describe("unused tokens", () => {
  it(`flags working tokens unused for ${UNUSED_AFTER_DAYS} days, or never used and that old`, async () => {
    const mk = async (name: string) => (await call("member", "POST", "/account/tokens", { name })).body.id as string;
    const stale = await mk("Stale");
    const neverOld = await mk("Never used, old");
    const neverNew = await mk("Never used, new");
    const recent = await mk("Recent");
    const revokedOld = await mk("Revoked, old");
    await db.query("UPDATE api_tokens SET created_at = now() - interval '200 days', last_used_at = now() - interval '91 days' WHERE id = $1", [stale]);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '91 days' WHERE id = $1", [neverOld]);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '200 days', last_used_at = now() - interval '3 days' WHERE id = $1", [recent]);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '200 days', revoked_at = now() WHERE id = $1", [revokedOld]);
    const { body } = await call("member", "GET", "/account/tokens");
    const flag = (id: string) => body.tokens.find((t: { id: string }) => t.id === id).unused;
    expect([flag(stale), flag(neverOld), flag(neverNew), flag(recent), flag(revokedOld)]).toEqual([true, true, false, false, false]);
  });

  it("flags service-account tokens too", async () => {
    const sa = await call("admin", "POST", "/service-accounts", { name: "dusty" });
    const made = await call("admin", "POST", `/service-accounts/${sa.body.id}/tokens`, { name: "Dusty" });
    await db.query("UPDATE api_tokens SET created_at = now() - interval '120 days' WHERE id = $1", [made.body.id]);
    const list = await call("admin", "GET", "/service-accounts");
    const t = list.body.service_accounts.find((s: { id: string }) => s.id === sa.body.id).tokens[0];
    expect(t).toMatchObject({ id: made.body.id, unused: true });
  });
});

describe("expiry notices", () => {
  const notes = async (who: string) =>
    (await db.query("SELECT title, link, target_id FROM notifications WHERE user_id = $1 AND kind = 'token' ORDER BY created_at", [await idOf(who)])).rows;

  it(`tells the owner ${EXPIRY_NOTICE_DAYS} days ahead, once per token`, async () => {
    await db.query("UPDATE api_tokens SET expiry_notified_at = now()"); // earlier tests' tokens are not part of this
    const member = await idOf("member");
    const soon = await createApiToken(db, member, "Expiring laptop", 30);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '25 days', expires_at = now() + interval '5 days' WHERE id = $1", [soon.id]);
    const later = await createApiToken(db, member, "Later", 30);
    await db.query("UPDATE api_tokens SET expires_at = now() + interval '10 days', created_at = now() - interval '20 days' WHERE id = $1", [later.id]);
    const shortLived = await createApiToken(db, member, "Three-day token", 3);

    expect(await notifyExpiringTokens(db, TEST_SETTINGS)).toEqual({ personal: 1, service: 0 });
    const got = await notes("member");
    expect(got).toEqual([{ title: expect.stringMatching(/^Your API token "Expiring laptop" expires on /), link: "#/account?section=tokens", target_id: soon.id }]);
    // Once per token.
    expect(await notifyExpiringTokens(db, TEST_SETTINGS)).toEqual({ personal: 0, service: 0 });
    expect(await notes("member")).toHaveLength(1);
    expect((await tokenRow(shortLived.id)).expiry_notified_at).toBeNull();
    expect((await tokenRow(later.id)).expiry_notified_at).toBeNull();

    // Recorded in the audit log as Thaliyola's own event.
    const page = await call("admin", "GET", `/audit?target=${soon.id}`);
    expect(page.body.entries[0]).toMatchObject({ action: "notify_token_expiry", actor: null, target: { kind: "token", label: "Expiring laptop" } });
  });

  it("tells people who manage people about service-account tokens, and skips rotated and revoked tokens", async () => {
    const svc = await ensureServiceAccount(db, "deployer");
    const t = await createApiToken(db, svc, "Deployer prod", 365);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '360 days', expires_at = now() + interval '5 days' WHERE id = $1", [t.id]);
    const member = await idOf("member");
    const rotated = await createApiToken(db, member, "Rotated", 30);
    const revoked = await createApiToken(db, member, "Revoked", 30);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '25 days', expires_at = now() + interval '2 days' WHERE id = ANY($1::uuid[])", [[rotated.id, revoked.id]]);
    await db.query("UPDATE api_tokens SET rotated_at = now() WHERE id = $1", [rotated.id]);
    await db.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [revoked.id]);

    expect(await notifyExpiringTokens(db, TEST_SETTINGS)).toEqual({ personal: 0, service: 1 });
    for (const who of ["admin", "erin"]) {
      expect((await notes(who)).map((n) => n.title), who).toEqual([expect.stringMatching(/^deployer's token "Deployer prod" expires on /)]);
    }
    expect((await notes("member")).map((n) => n.title)).not.toContain(expect.stringMatching(/Deployer/));
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [svc])).rows[0].n).toBe(0);
  });

  it("runs as a daily job", async () => {
    await db.query("DELETE FROM job_runs WHERE name = 'token_expiry'");
    const member = await idOf("member");
    const a = await createApiToken(db, member, "Job A", 30);
    await db.query("UPDATE api_tokens SET created_at = now() - interval '25 days', expires_at = now() + interval '5 days' WHERE id = $1", [a.id]);
    const jobs = startTokenJobs(db, TEST_SETTINGS, () => undefined);
    try {
      await jobs.tick();
      expect((await tokenRow(a.id)).expiry_notified_at).not.toBeNull();
      // Ran less than a day ago: the next tick does nothing.
      const b = await createApiToken(db, member, "Job B", 30);
      await db.query("UPDATE api_tokens SET created_at = now() - interval '25 days', expires_at = now() + interval '5 days' WHERE id = $1", [b.id]);
      await jobs.tick();
      expect((await tokenRow(b.id)).expiry_notified_at).toBeNull();
      await db.query("UPDATE job_runs SET last_run = now() - interval '1 day' WHERE name = 'token_expiry'");
      await jobs.tick();
      expect((await tokenRow(b.id)).expiry_notified_at).not.toBeNull();
    } finally {
      jobs.stop();
    }
  });
});
