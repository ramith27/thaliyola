import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, sessionAuthenticator } from "../src/auth/index.js";
import { createLocalUser } from "../src/auth/local.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const REDIRECT = "https://client.example/callback";

beforeAll(async () => {
  ({ db } = await freshDb());
  server = await new Promise<Server>((resolve) => {
    const s = createApp({ db, authenticate: async () => null, settings: TEST_SETTINGS }).listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise((r) => server.close(r));
  // Restart on the same port with the issuer URL known up front.
  base = `http://127.0.0.1:${port}`;
  const settings = { ...TEST_SETTINGS, authMode: "local" as const, publicUrl: base };
  server = createApp({ db, authenticate: chain(apiTokenAuthenticator(db, new URL("/mcp", base)), sessionAuthenticator(db)), settings }).listen(port);
  await new Promise((r) => server.once("listening", r));
  await createLocalUser(db, { email: "alice@example.com", password: "alice password 1" });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(name = "Test Connector") {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id as string;
}

/** Walks the browser part: authorize → sign in → consent. Returns the redirect back to the client. */
async function authorizeInBrowser(clientId: string, challenge: string, decision = "allow") {
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${base}/mcp`,
  }))
    authorize.searchParams.set(k, v);
  const start = await fetch(authorize, { redirect: "manual" });
  expect(start.status).toBe(302);
  const consentUrl = new URL(start.headers.get("location")!, base);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const requestId = consentUrl.searchParams.get("request")!;

  const loginPage = await (await fetch(consentUrl)).text();
  expect(loginPage).toContain("wants to connect to Thaliyola");
  expect(loginPage).toContain("Sign in");

  const login = await fetch(`${base}/oauth/consent/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ request: requestId, email: "alice@example.com", password: "alice password 1" }),
  });
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const consent = await fetch(consentUrl, { headers: { cookie } });
  const html = await consent.text();
  expect(html).toContain("Allow access?");
  expect(html).toContain("client.example");
  expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' https://client.example");
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;

  const decide = await fetch(`${base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie },
    body: new URLSearchParams({ request: requestId, csrf, decision }),
  });
  expect(decide.status).toBe(302);
  return { back: new URL(decide.headers.get("location")!), cookie, requestId, csrf };
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  return { status: res.status, body: await res.json() };
}

const mcpList = (accessToken: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("OAuth for MCP clients (local mode)", () => {
  it("advertises discovery metadata and points 401s at it", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/`] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("runs the full flow: register, consent, code exchange, MCP call, refresh rotation", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { back } = await authorizeInBrowser(clientId, challenge);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;

    expect((await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", redirect_uri: REDIRECT })).status).toBe(400);
    const issued = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    // A failed PKCE check doesn't burn the code, but a successful exchange does.
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ token_type: "bearer", expires_in: 3600 });
    expect(issued.body.access_token).toMatch(/^thaliyola_oat_/);

    const tools = await mcpList(issued.body.access_token);
    expect(tools.status).toBe(200);
    expect((await tools.json()).result.tools.length).toBeGreaterThan(10);

    // Codes are single-use.
    expect((await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })).status).toBe(400);

    // Refresh rotates; reusing the old refresh token revokes the whole family.
    const refreshed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: issued.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(issued.body.refresh_token);
    expect((await mcpList(refreshed.body.access_token)).status).toBe(200);
    const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: issued.body.refresh_token });
    expect(reuse.status).toBe(400);
    expect((await mcpList(refreshed.body.access_token)).status).toBe(401);
  });

  it("lets the person see and revoke connected apps", async () => {
    const clientId = await register("Revocable App");
    const { verifier, challenge } = pkce();
    const { back, cookie } = await authorizeInBrowser(clientId, challenge);
    const issued = await token({ grant_type: "authorization_code", client_id: clientId, code: back.searchParams.get("code")!, code_verifier: verifier, redirect_uri: REDIRECT });
    const list = await (await fetch(`${base}/api/account/connections`, { headers: { cookie } })).json();
    expect(list.connections.map((c: { name: string }) => c.name)).toContain("Revocable App");
    const del = await fetch(`${base}/api/account/connections/${clientId}`, { method: "DELETE", headers: { cookie, origin: base } });
    expect(del.status).toBe(200);
    expect((await mcpList(issued.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: issued.body.refresh_token })).status).toBe(400);
  });

  it("sends access_denied when the person declines", async () => {
    const clientId = await register();
    const { back } = await authorizeInBrowser(clientId, pkce().challenge, "deny");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("refuses consent submitted from another site or without the CSRF token", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const authorize = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" }))
      authorize.searchParams.set(k, v);
    const requestId = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!, base).searchParams.get("request")!;
    const login = await fetch(`${base}/oauth/consent/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ request: requestId, email: "alice@example.com", password: "alice password 1" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const evil = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams({ request: requestId, decision: "allow", csrf: "x" }),
    });
    expect(evil.status).toBe(403);
    const noCsrf = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie },
      body: new URLSearchParams({ request: requestId, decision: "allow" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("rejects unregistered redirect URIs and tokens minted for another resource", async () => {
    const clientId = await register();
    const bad = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: "https://attacker.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }))
      bad.searchParams.set(k, v);
    expect((await fetch(bad, { redirect: "manual" })).status).toBe(400);

    const { verifier, challenge } = pkce();
    const { back } = await authorizeInBrowser(clientId, challenge);
    const issued = await token({ grant_type: "authorization_code", client_id: clientId, code: back.searchParams.get("code")!, code_verifier: verifier, redirect_uri: REDIRECT });
    await db.query("UPDATE oauth_tokens SET resource = 'https://other.example/mcp' WHERE kind = 'access'");
    expect((await mcpList(issued.body.access_token)).status).toBe(401);
  });
});
