import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalUser, sessionHash } from "../src/auth/local.js";
import { oidcRouter, signInOptions } from "../src/auth/oidc.js";
import { oidcProvidersFrom, type Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let idp: Server;
let app: Server;
let issuer: string;
let appBase: string;
let key: CryptoKey;
const challenges = new Map<string, string>();
/** What the next ID token says (tests change it). */
let claims: Record<string, unknown> = {};
let nonceOverride: string | null = null;

beforeAll(async () => {
  ({ db } = await freshDb());
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  // The identity provider: discovery, keys, and a token endpoint that checks the PKCE verifier.
  idp = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const json = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (req.url === "/.well-known/openid-configuration") return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (req.url === "/jwks") return json(200, { keys: [jwk] });
      if (req.url === "/token") {
        const p = new URLSearchParams(body);
        const want = challenges.get(p.get("code") ?? "");
        if (!want || createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== want.split("|")[0]) return json(400, { error: "invalid_grant" });
        const idToken = await new SignJWT({ nonce: nonceOverride ?? want.split("|")[1], ...claims })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience("client-1")
          .setSubject(String(claims.sub ?? "user-1"))
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(key);
        return json(200, { id_token: idToken, access_token: "x" });
      }
      json(404, {});
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => idp.once("listening", r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  const settings: Settings = {
    ...TEST_SETTINGS,
    authMode: "local",
    publicUrl: "https://kb.example.com",
    oidc: { providers: [{ name: "acme", label: "Acme SSO", issuer, clientId: "client-1", clientSecret: "s", trustEmail: false }], allowedDomains: ["example.com"], only: false },
  };
  const a = express();
  a.use("/auth/oidc", oidcRouter(db, settings, (_req, res, token) => res.append("Set-Cookie", `thaliyola_session=${token}`)));
  app = a.listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => idp.close(r));
  await new Promise((r) => app.close(r));
  await db.end();
});

/** Start a sign-in, let the provider "approve" it, and come back to the callback. */
async function signIn(returnTo = "/#/sessions") {
  const start = await fetch(`${appBase}/auth/oidc/acme/start?return=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  expect(to.origin + to.pathname).toBe(`${issuer}/authorize`);
  expect(to.searchParams.get("redirect_uri")).toBe("https://kb.example.com/auth/oidc/acme/callback");
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  const code = `code-${Math.random()}`;
  challenges.set(code, `${to.searchParams.get("code_challenge")}|${to.searchParams.get("nonce")}`);
  const state = to.searchParams.get("state")!;
  const back = await fetch(`${appBase}/auth/oidc/acme/callback?code=${encodeURIComponent(code)}&state=${state}`, { redirect: "manual" });
  return { back, state, code };
}

describe("OIDC sign-in", () => {
  it("signs in with a verified email, links to the local account with that email, and returns where you were", async () => {
    const local = await createLocalUser(db, { email: "ana@example.com" });
    claims = { sub: "acme-1", email: "Ana@Example.com", email_verified: true, name: "Ana" };
    const { back } = await signIn("/#/sessions");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/#/sessions");
    const token = /thaliyola_session=([^;]+)/.exec(back.headers.get("set-cookie") ?? "")![1]!;
    const s = (await db.query("SELECT user_id FROM sessions WHERE token_hash = $1", [sessionHash(token)])).rows[0];
    expect(s.user_id).toBe(local.user.id);
  });

  it("refuses unverified emails, other domains, replayed or forged sign-ins, and redirects off the site", async () => {
    claims = { sub: "acme-2", email: "bo@example.com", email_verified: false };
    expect(await (await signIn()).back.text()).toMatch(/didn't confirm your email/);
    claims = { sub: "acme-3", email: "eve@evil.test", email_verified: true };
    expect(await (await signIn()).back.text()).toMatch(/isn't in a domain allowed/);
    claims = { sub: "acme-4", email: "cy@example.com", email_verified: true };
    const ok = await signIn();
    expect(ok.back.status).toBe(302);
    const replay = await fetch(`${appBase}/auth/oidc/acme/callback?code=${ok.code}&state=${ok.state}`, { redirect: "manual" });
    expect(await replay.text()).toMatch(/expired or was already used/);
    nonceOverride = "forged";
    expect(await (await signIn()).back.text()).toMatch(/doesn't match this sign-in/);
    nonceOverride = null;
    claims = { sub: "acme-5", email: "di@example.com", email_verified: true };
    expect((await signIn("https://evil.test/steal")).back.headers.get("location")).toBe("/");
    expect((await db.query("SELECT subject FROM users WHERE email = 'di@example.com'")).rows[0].subject).toBe("oidc:acme:acme-5");
  });
});

describe("configuration", () => {
  it("reads providers from the environment and says what the sign-in page offers", () => {
    const p = oidcProvidersFrom({ OIDC_PROVIDERS: "google, okta", OIDC_GOOGLE_ISSUER: "https://accounts.google.com", OIDC_GOOGLE_CLIENT_ID: "g", OIDC_GOOGLE_CLIENT_SECRET: "gs", OIDC_OKTA_ISSUER: "https://acme.okta.com/", OIDC_OKTA_CLIENT_ID: "o", OIDC_OKTA_CLIENT_SECRET: "os", OIDC_OKTA_LABEL: "Acme" });
    expect(p.map((x) => [x.name, x.label, x.issuer])).toEqual([
      ["google", "Google", "https://accounts.google.com"],
      ["okta", "Acme", "https://acme.okta.com"],
    ]);
    expect(() => oidcProvidersFrom({ OIDC_PROVIDERS: "entra", OIDC_ENTRA_ISSUER: "http://insecure" })).toThrow(/ISSUER/);
    expect(signInOptions({ ...TEST_SETTINGS, oidc: { providers: p, allowedDomains: [], only: true } })).toEqual({ providers: [{ name: "google", label: "Google" }, { name: "okta", label: "Acme" }], password: false });
  });
});
