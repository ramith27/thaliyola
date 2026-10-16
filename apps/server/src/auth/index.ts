import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config } from "../config.js";
import type { Actor } from "../core/context.js";
import { upsertUser } from "../core/users.js";
import type { Db } from "../db/pool.js";

export interface Identity {
  subject: string;
  email: string | null;
  kind: Actor["kind"];
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

export function authenticatorFor(config: Config): Authenticator {
  return config.AUTH_MODE === "cloudflare"
    ? cloudflareAuthenticator(config.CF_ACCESS_TEAM_DOMAIN!, config.CF_ACCESS_AUD!)
    : devAuthenticator(config.DEV_TOKENS);
}

/** Rejects unauthenticated requests; attaches the user (created on first sight) as `res.locals.actor`. */
export function requireAuth(db: Db, authenticate: Authenticator) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = await authenticate(req);
      if (!identity) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      res.locals.actor = await upsertUser(db, identity);
      next();
    } catch (err) {
      next(err);
    }
  };
}
