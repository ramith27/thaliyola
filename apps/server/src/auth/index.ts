import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config } from "../config.js";
import type { Actor } from "../core/context.js";
import { upsertUser } from "../core/users.js";
import { SESSION_COOKIE, userForApiToken, userForSession } from "./local.js";
import { OAUTH_ACCESS_PREFIX, userForOAuthToken } from "./oauth.js";
import type { Db } from "../db/pool.js";

export interface Identity {
  subject: string;
  email: string | null;
  kind: Actor["kind"];
  /** "cookie" for browser sessions; writes over cookies get a same-origin check. */
  via?: "cookie" | "header";
}

export type Authenticator = (req: Request) => Promise<Identity | null>;

/** Dev mode: `Authorization: Bearer <token>` where DEV_TOKENS holds "token=email" pairs. */
export function devAuthenticator(devTokens: string): Authenticator {
  const tokens = new Map(
    devTokens
      .split(",")
      .map((pair) => pair.trim().split("="))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1]),
  );
  return async (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    const email = m ? tokens.get(m[1]!.trim()) : undefined;
    if (!email) return null;
    return { subject: `dev:${email}`, email, kind: email.startsWith("svc-") ? "service" : "human" };
  };
}

/**
 * Cloudflare Access: every request reaching the origin carries a signed
 * `Cf-Access-Jwt-Assertion`. We verify it ourselves (defence in depth, in case
 * the origin is reached without passing Access) against the team's JWKS and
 * the Access application's AUD tag. Users carry `email`; service tokens carry
 * `common_name` (the client id) instead.
 */
export function cloudflareAuthenticator(teamDomain: string, aud: string): Authenticator {
  const issuer = teamDomain.replace(/\/+$/, "");
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (req) => {
    const token = req.header("cf-access-jwt-assertion");
    if (!token) return null;
    let payload: JWTPayload & { email?: string; common_name?: string };
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: aud }));
    } catch {
      return null;
    }
    if (payload.email) return { subject: `cf:${payload.email.toLowerCase()}`, email: payload.email.toLowerCase(), kind: "human" };
    if (payload.common_name) return { subject: `cf-svc:${payload.common_name}`, email: null, kind: "service" };
    return null;
  };
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Local mode: the browser session cookie. */
export function sessionAuthenticator(db: Db): Authenticator {
  return async (req) => {
    const token = cookie(req, SESSION_COOKIE);
    const user = token ? await userForSession(db, token) : null;
    return user ? { ...user, via: "cookie" } : null;
  };
}

export function sessionToken(req: Request): string | undefined {
  return cookie(req, SESSION_COOKIE);
}

/**
 * Personal API tokens (`Bearer thaliyola_pat_…`), accepted in every mode, and
 * OAuth access tokens (`Bearer thaliyola_oat_…`) issued by the local OAuth server.
 */
export function apiTokenAuthenticator(db: Db, oauthResource?: URL): Authenticator {
  return async (req) => {
    const m = /^Bearer\s+(thaliyola_(?:pat|oat)_\S+)$/i.exec(req.header("authorization") ?? "");
    if (!m) return null;
    const token = m[1]!;
    const user = token.startsWith(OAUTH_ACCESS_PREFIX) ? await userForOAuthToken(db, token, oauthResource) : await userForApiToken(db, token);
    return user ? { subject: user.subject, email: user.email, kind: user.kind, via: "header" } : null;
  };
}

/** First authenticator that recognises the request wins. */
export function chain(...authenticators: Authenticator[]): Authenticator {
  return async (req) => {
    for (const authenticate of authenticators) {
      const identity = await authenticate(req);
      if (identity) return identity;
    }
    return null;
  };
}

export function authenticatorFor(config: Config, db: Db): Authenticator {
  const oauthResource = config.AUTH_MODE === "local" && config.PUBLIC_URL ? new URL("/mcp", config.PUBLIC_URL) : undefined;
  const primary =
    config.AUTH_MODE === "cloudflare"
      ? cloudflareAuthenticator(config.CF_ACCESS_TEAM_DOMAIN!, config.CF_ACCESS_AUD!)
      : config.AUTH_MODE === "local"
        ? sessionAuthenticator(db)
        : devAuthenticator(config.DEV_TOKENS);
  return chain(apiTokenAuthenticator(db, oauthResource), primary);
}

/**
 * Cookies ride along on cross-site requests, so state-changing requests
 * authenticated by cookie must come from this origin (CSRF protection on top
 * of SameSite=Lax).
 */
export function sameOrigin(req: Request, publicOrigin?: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const site = req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.header("origin");
  if (!origin) return !!site; // browsers send at least one of the two on cross-origin writes
  try {
    const host = new URL(origin).host;
    // A proxy in front may rewrite Host; the configured public origin is always ours.
    return host === req.header("host") || (!!publicOrigin && new URL(origin).origin === publicOrigin);
  } catch {
    return false;
  }
}

/**
 * Rejects unauthenticated requests; attaches the user (created on first sight) as `res.locals.actor`.
 * With `resourceMetadataUrl`, 401s point OAuth clients at the protected-resource metadata (RFC 9728).
 */
export function requireAuth(db: Db, authenticate: Authenticator, resourceMetadataUrl?: URL, publicOrigin?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = await authenticate(req);
      if (!identity) {
        if (resourceMetadataUrl) res.set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl.href}"`);
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      if (identity.via === "cookie" && !sameOrigin(req, publicOrigin)) {
        res.status(403).json({ error: "cross-site request refused" });
        return;
      }
      const actor = await upsertUser(db, identity);
      if (actor.disabled) {
        res.status(403).json({ error: "account disabled" });
        return;
      }
      res.locals.actor = actor;
      res.locals.via = identity.via ?? "header";
      next();
    } catch (err) {
      next(err);
    }
  };
}
