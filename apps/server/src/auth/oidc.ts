import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { OidcProvider, Settings } from "../config.js";
import { audit } from "../core/audit.js";
import { approvalRequired, upsertUser } from "../core/users.js";
import type { Db } from "../db/pool.js";
import { startSession } from "./local.js";

/**
 * Sign-in with OpenID Connect providers (Google, Okta, Microsoft Entra, any OIDC issuer) next to local passwords:
 * authorization code with PKCE, state and nonce (kept in oidc_states for ten minutes, used once), the ID token verified
 * against the provider's keys, a verified email required (or trusted per provider), optional allowed domains. The person
 * is the account with that provider subject, or the local account with the same email (one account per person); the
 * usual approval rules apply. The result is the same session cookie a password sign-in gives.
 */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveries = new Map<string, { at: number; doc: Discovery }>();
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const b64url = (b: Buffer) => b.toString("base64url");

async function discover(p: OidcProvider, f: typeof fetch): Promise<Discovery> {
  const cached = discoveries.get(p.issuer);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
  const res = await f(`${p.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${p.label}'s OpenID configuration couldn't be read (HTTP ${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error(`${p.label}'s OpenID configuration is incomplete`);
  discoveries.set(p.issuer, { at: Date.now(), doc });
  return doc;
}

/** Only paths in this app (a relative URL), so a sign-in can never redirect somewhere else. */
function safeReturn(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return /^\/(?!\/)[\w\-./?=&#%:+@~]*$/.test(s) ? s : "/";
}

function errorPage(res: Response, message: string) {
  res
    .status(400)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in failed · Thaliyola</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.3rem">Couldn't sign you in</h1><p>${message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="/">Back to Thaliyola</a></p></body>`);
}

export function oidcRouter(db: Db, settings: Settings, setCookie: (req: Request, res: Response, token: string) => void) {
  const router = Router();
  const cfg = settings.oidc;
  const f = () => cfg?.fetch ?? fetch;
  const provider = (name: string) => cfg?.providers.find((p) => p.name === name);
  const redirectUri = (p: OidcProvider) => `${settings.publicUrl?.replace(/\/+$/, "")}/auth/oidc/${p.name}/callback`;

  router.get("/:provider/start", async (req, res) => {
    const p = provider(String(req.params.provider));
    if (!p || settings.authMode !== "local" || !settings.publicUrl) return errorPage(res, "That sign-in option isn't set up on this server.");
    try {
      const d = await discover(p, f());
      const state = b64url(randomBytes(24));
      const nonce = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(32));
      await db.query("DELETE FROM oidc_states WHERE expires_at < now()");
      await db.query("INSERT INTO oidc_states (state, provider, nonce, verifier, return_to, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')", [state, p.name, nonce, verifier, safeReturn(req.query.return)]);
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: p.clientId,
        redirect_uri: redirectUri(p),
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        ...(cfg!.allowedDomains.length === 1 && p.name === "google" ? { hd: cfg!.allowedDomains[0]! } : {}),
      }).toString();
      res.redirect(302, url.href);
    } catch (err) {
      errorPage(res, (err as Error).message);
    }
  });

  router.get("/:provider/callback", async (req, res) => {
    const p = provider(String(req.params.provider));
    if (!p || !cfg) return errorPage(res, "That sign-in option isn't set up on this server.");
    if (req.query.error) return errorPage(res, `${p.label} said: ${String(req.query.error_description ?? req.query.error).slice(0, 200)}`);
    const st = (
      await db.query<{ nonce: string; verifier: string; return_to: string; provider: string }>("DELETE FROM oidc_states WHERE state = $1 AND expires_at > now() RETURNING nonce, verifier, return_to, provider", [String(req.query.state ?? "")])
    ).rows[0];
    if (!st || st.provider !== p.name) return errorPage(res, "This sign-in link has expired or was already used. Start again.");
    try {
      const d = await discover(p, f());
      const tokenRes = await f()(d.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: String(req.query.code ?? ""), redirect_uri: redirectUri(p), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: st.verifier }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string };
      if (!tokenRes.ok || !tokens.id_token) throw new Error(`${p.label} didn't give a sign-in token${tokens.error ? ` (${tokens.error})` : ""}`);
      if (!jwks.has(d.jwks_uri)) jwks.set(d.jwks_uri, createRemoteJWKSet(new URL(d.jwks_uri)));
      const { payload } = await jwtVerify(tokens.id_token, jwks.get(d.jwks_uri)!, { issuer: d.issuer ?? p.issuer, audience: p.clientId });
      const claims = payload as JWTPayload & { nonce?: string; email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string };
      if (claims.nonce !== st.nonce) throw new Error("the sign-in token doesn't match this sign-in");
      const email = (claims.email ?? (p.trustEmail ? claims.preferred_username : undefined))?.trim().toLowerCase();
      const verified = claims.email_verified === true || claims.email_verified === "true" || p.trustEmail;
      if (!email || !email.includes("@") || !verified) throw new Error(`${p.label} didn't confirm your email address, so Thaliyola can't tell who you are`);
      if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(email.split("@")[1]!)) throw new Error(`${email} isn't in a domain allowed to sign in here`);
      const user = await upsertUser(db, { subject: `oidc:${p.name}:${claims.sub}`, email, kind: "human", name: claims.name ?? null }, { approval: approvalRequired({ email }, settings) });
      if (user.disabled) throw new Error("this account is disabled");
      const token = await startSession(db, user.id, { ttlHours: settings.sessionTtlHours, userAgent: req.header("user-agent") });
      await audit(db, user.id, "sign_in_oidc", user.id, { targetKind: "person", details: { provider: p.name } });
      setCookie(req, res, token);
      res.redirect(302, st.return_to || "/");
    } catch (err) {
      errorPage(res, (err as Error).message);
    }
  });
  return router;
}

/** What the sign-in page offers: provider buttons, and whether passwords are allowed. */
export function signInOptions(settings: Settings) {
  return {
    providers: (settings.oidc?.providers ?? []).map((p) => ({ name: p.name, label: p.label })),
    password: !(settings.oidc?.only && settings.oidc.providers.length),
  };
}
