import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator } from "../src/auth/index.js";
import { adminCreateProject } from "../src/core/admin.js";
import { ensureServiceAccount } from "../src/core/service-accounts.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  const authenticate = chain(apiTokenAuthenticator(db), devAuthenticator("admin=admin@example.com,member=member@example.com"));
  server = createApp({ db, authenticate, settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await ctxFor(db, { email: "member@example.com" });
  await adminCreateProject(await ctxFor(db, { email: "admin@example.com" }), { slug: "atlas", name: "Atlas", visibility: "members" });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function call(auth: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("service accounts from the admin interface", () => {
  it("lets an Administrator create one, give it a token and project roles, and the token works", async () => {
    const created = await call("admin", "POST", "/service-accounts", { name: "AutoCode", display_name: "AutoCode" });
    expect(created).toMatchObject({ status: 200, body: { name: "autocode", identifier: "service:autocode" } });
    expect((await call("admin", "POST", "/service-accounts", { name: "autocode" })).body.error).toMatch(/already exists/);
    expect((await call("admin", "POST", "/service-accounts", { name: "Auto Code!" })).status).toBe(400);

    const id = created.body.id;
    const token = await call("admin", "POST", `/service-accounts/${id}/tokens`, { name: "AutoCode prod", expires_in_days: 365 });
    expect(token.status).toBe(200);
    expect(token.body.token).toMatch(/^thaliyola_pat_/);
    expect(token.body).toMatchObject({ name: "AutoCode prod", identifier: "service:autocode" });

    // Not in any project yet: the members-only project is invisible to it.
    expect((await call(token.body.token, "GET", "/me")).body).toMatchObject({ kind: "service" });
    const sees = async () => JSON.stringify((await call(token.body.token, "GET", "/scopes")).body).includes('"slug":"atlas"');
    expect(await sees()).toBe(false);

    // Project roles by identifier, as in Members and access.
    expect((await call("admin", "PUT", "/scopes/atlas/members", { email: "service:autocode", roles: ["reader"] })).status).toBe(200);
    expect(await sees()).toBe(true);

    const list = await call("admin", "GET", "/service-accounts");
    const row = list.body.service_accounts.find((s: { name: string }) => s.name === "autocode");
    expect(row).toMatchObject({ identifier: "service:autocode", display_name: "AutoCode", disabled: false, created_by: "admin@example.com" });
    expect(row.tokens).toEqual([expect.objectContaining({ name: "AutoCode prod", revoked_at: null })]);
    expect(row.tokens[0].token).toBeUndefined();
    expect(row.projects).toEqual([{ slug: "atlas", name: "Atlas", roles: ["reader"], role_names: ["Viewer"] }]);
  });

  it("stops tokens when the account is disabled or the token revoked", async () => {
    const id = (await call("admin", "POST", "/service-accounts", { name: "ci-docs" })).body.id;
    const { token, id: tokenId } = (await call("admin", "POST", `/service-accounts/${id}/tokens`, { name: "CI" })).body;
    expect((await call(token, "GET", "/me")).status).toBe(200);

    await call("admin", "PATCH", `/service-accounts/${id}`, { disabled: true });
    expect((await call(token, "GET", "/me")).status).toBe(401);
    expect((await call("admin", "POST", `/service-accounts/${id}/tokens`, { name: "another" })).body.error).toMatch(/disabled/);
    await call("admin", "PATCH", `/service-accounts/${id}`, { disabled: false });
    expect((await call(token, "GET", "/me")).status).toBe(200);

    expect((await call("admin", "DELETE", `/service-accounts/${id}/tokens/${tokenId}`)).body).toEqual({ id: tokenId, revoked: true });
    expect((await call(token, "GET", "/me")).status).toBe(401);
  });

  it("is only for people who manage people, and never for a service itself", async () => {
    expect((await call("member", "GET", "/service-accounts")).status).toBe(403);
    expect((await call("member", "POST", "/service-accounts", { name: "sneaky" })).status).toBe(403);

    const id = (await call("admin", "POST", "/service-accounts", { name: "nightly" })).body.id;
    const { token } = (await call("admin", "POST", `/service-accounts/${id}/tokens`, { name: "job" })).body;
    expect((await call(token, "POST", "/service-accounts", { name: "child" })).status).toBe(403);
    expect((await call(token, "POST", `/service-accounts/${id}/tokens`, { name: "self" })).status).toBe(403);
    // People's accounts can't be reached through these routes.
    const person = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'member@example.com'")).rows[0]!.id;
    expect((await call("admin", "POST", `/service-accounts/${person}/tokens`, { name: "x" })).status).toBe(404);
  });

  it("keeps the command-line path working for existing service accounts", async () => {
    const before = await ensureServiceAccount(db, "autocode");
    const again = await ensureServiceAccount(db, "autocode");
    expect(again).toBe(before);
  });
});
