import { createHash } from "node:crypto";
import { DEMO_PEOPLE, demoAccount, lastReset, nextReset } from "../core/demo.js";
import { startSession } from "../auth/local.js";
import { oidcRouter, signInOptions } from "../auth/oidc.js";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sessionToken } from "../auth/index.js";
import { changePassword, createApiToken, listApiTokens, login, logout, revokeApiToken, ROTATION_GRACE_DAYS, rotateApiToken, SESSION_COOKIE, sessionHash } from "../auth/local.js";
import { acceptInvitation, createInvitation, describeInvitation, listInvitations, revokeInvitation } from "../auth/invitations.js";
import { listConnections, revokeConnection } from "../auth/oauth.js";
import type { Settings } from "../config.js";
import { audit } from "../core/audit.js";
import { ForbiddenError, ValidationError, type Actor } from "../core/context.js";
import { assertMayGrant, can, resolveRoles } from "../core/roles.js";
import { assertCanManage } from "../core/permissions.js";
import { getReadableScope } from "../core/scopes.js";
import { addPerson, createAccount, listPeople, resetAccountPassword, updatePerson } from "../core/users.js";
import type { Db } from "../db/pool.js";

/**
 * Failed-attempt throttle (sign-in per email+address and per address, invitation links per address), counted in
 * Postgres so every replica shares one count and a deploy doesn't reset it. Keys are stored as unsalted SHA-256
 * hashes: not the values in plain sight, but not anonymous either (an IPv4 address can be recovered by trying them all).
 */
export class LoginThrottle {
  constructor(
    private readonly db: Db,
    private readonly bucket: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  private key(key: string) {
    return createHash("sha256").update(`${this.bucket}\0${key}`).digest("hex");
  }
  async blocked(key: string) {
    const { rows } = await this.db.query<{ failures: number }>("SELECT failures FROM auth_throttle WHERE key = $1 AND reset_at > now()", [this.key(key)]);
    return (rows[0]?.failures ?? 0) >= this.limit;
  }
  async fail(key: string) {
    await this.db.query(
      `INSERT INTO auth_throttle (key, failures, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN auth_throttle.reset_at <= now() THEN 1 ELSE auth_throttle.failures + 1 END,
         reset_at = CASE WHEN auth_throttle.reset_at <= now() THEN EXCLUDED.reset_at ELSE auth_throttle.reset_at END`,
      [this.key(key), this.windowMs / 1000],
    );
  }
  async clear(key: string) {
    await this.db.query("DELETE FROM auth_throttle WHERE key = $1", [this.key(key)]);
  }
}

function setSessionCookie(req: Request, res: Response, settings: Settings, token: string | null) {
  const secure = settings.cookieSecure === "true" || (settings.cookieSecure === "auto" && req.secure);
  const parts = [
    `${SESSION_COOKIE}=${token ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token ? settings.sessionTtlHours * 3600 : 0}`,
    ...(secure ? ["Secure"] : []),
  ];
  res.append("Set-Cookie", parts.join("; "));
}

/** Unauthenticated endpoints: which sign-in the UI should show, and local login/logout. */
export function publicAuthRouter(db: Db, settings: Settings) {
  const router = Router();
  const perAccount = new LoginThrottle(db, "login", 10, 15 * 60_000);
  const perIp = new LoginThrottle(db, "login-ip", 50, 15 * 60_000);

  router.get("/config", async (_req, res, next) => {
    try {
      const demo = settings.demo && settings.authMode === "local" ? { accounts: DEMO_PEOPLE.map(({ key, name, role }) => ({ key, name, role })), resets_at: nextReset(settings, await lastReset(db)).toISOString() } : undefined;
      res.json({ mode: settings.authMode, ...(settings.authMode === "local" ? signInOptions(settings) : {}), ...(demo ? { demo } : {}) });
    } catch (err) {
      next(err);
    }
  });
  // The public demo: sign in as one of the demo people with one click (only with DEMO_MODE=true).
  router.post("/demo", express.json({ limit: "1kb" }), async (req, res, next) => {
    try {
      if (!settings.demo || settings.authMode !== "local") return void res.status(404).json({ error: "not a demo server" });
      const id = await demoAccount(db, String((req.body as { as?: unknown })?.as ?? ""));
      if (!id) return void res.status(404).json({ error: "no such demo account" });
      setSessionCookie(req, res, settings, await startSession(db, id, { ttlHours: Math.min(settings.sessionTtlHours, 12), userAgent: req.header("user-agent") }));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  // Sign-in with OpenID Connect providers (Google, Okta, Entra…), next to passwords.
  if (settings.authMode === "local" && settings.oidc?.providers.length) router.use("/oidc", oidcRouter(db, settings, (req, res, token) => setSessionCookie(req, res, settings, token)));

  router.post("/login", async (req, res, next) => {
    try {
      if (settings.authMode !== "local") return void res.status(404).json({ error: "local sign-in is not enabled" });
      if (!signInOptions(settings).password) return void res.status(403).json({ error: "passwords are switched off here: sign in with your organisation's account" });
      const body = z.object({ email: z.string().min(3).max(320), password: z.string().min(1).max(200) }).safeParse(req.body);
      if (!body.success) return void res.status(400).json({ error: "email and password are required" });
      const ip = req.ip ?? "unknown";
      const accountKey = `${body.data.email.trim().toLowerCase()}|${ip}`;
      if ((await perAccount.blocked(accountKey)) || (await perIp.blocked(ip))) {
        return void res.status(429).json({ error: "too many failed attempts; try again in 15 minutes" });
      }
      const session = await login(db, body.data.email, body.data.password, { ttlHours: settings.sessionTtlHours, userAgent: req.header("user-agent") });
      if (!session) {
        await perAccount.fail(accountKey);
        await perIp.fail(ip);
        return void res.status(401).json({ error: "wrong email or password" });
      }
      await perAccount.clear(accountKey);
      await audit(db, session.userId, "login", null);
      setSessionCookie(req, res, settings, session.token);
      res.json({ ok: true, must_change_password: session.mustChangePassword });
    } catch (err) {
      next(err);
    }
  });

  // Invitation links: show who invited whom, then create the account with the invitee's own password and sign them in.
  const invites = new LoginThrottle(db, "invite-ip", 30, 15 * 60_000);
  router.get("/invite/:token", async (req, res, next) => {
    try {
      const inv = await describeInvitation(db, String(req.params.token));
      if (!inv) return void res.status(404).json({ error: "this invitation link has expired or was already used" });
      res.json(inv);
    } catch (err) {
      next(err);
    }
  });
  router.post("/invite/:token", async (req, res, next) => {
    try {
      const ip = req.ip ?? "unknown";
      if (await invites.blocked(ip)) return void res.status(429).json({ error: "too many attempts; try again in 15 minutes" });
      const body = z.object({ password: z.string().min(1).max(200), name: z.string().max(200).optional() }).safeParse(req.body);
      if (!body.success) return void res.status(400).json({ error: "choose a password" });
      const accepted = await acceptInvitation(db, String(req.params.token), body.data);
      if (!accepted) {
        await invites.fail(ip);
        return void res.status(404).json({ error: "this invitation link has expired or was already used" });
      }
      await audit(db, accepted.userId, "accept_invitation", null);
      const session = await login(db, accepted.email, body.data.password, { ttlHours: settings.sessionTtlHours, userAgent: req.header("user-agent") });
      if (session) setSessionCookie(req, res, settings, session.token);
      res.json({ ok: true, email: accepted.email });
    } catch (err) {
      if (err instanceof ValidationError) return void res.status(400).json({ error: err.message });
      next(err);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) await logout(db, token);
      setSessionCookie(req, res, settings, null);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const isLocal = (actor: Actor) => actor.subject.startsWith("local:");

/** Authenticated account and user-management endpoints, mounted under /api. */
export function accountRouter(db: Db, settings: Settings, _isAdmin?: (actor: Actor) => boolean) {
  const router = Router();
  const actorOf = (res: Response) => res.locals.actor as Actor;
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      next(err);
    }
  };
  // People are managed by Administrators and anyone with Manage people (User managers); who may change which
  // account (no escalation, Administrators only for Administrators) is decided in core/users.ts.
  const ctxOf = (res: Response) => ({ db, settings, actor: actorOf(res) });
  const requireAdmin = (res: Response) => {
    if (!can(ctxOf(res), "manage_users")) {
      res.status(403).json({ error: "you need Manage people (User managers and Administrators)" });
      return false;
    }
    return true;
  };
  const roleInputs = z.array(z.string().max(100)).max(20);

  router.post(
    "/account/password",
    wrap(async (req, res) => {
      const actor = actorOf(res);
      if (!isLocal(actor)) throw new ValidationError("password sign-in is not used for this account");
      const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
      const token = sessionToken(req);
      await changePassword(db, actor.id, body.current, body.next, token ? sessionHash(token) : undefined);
      await audit(db, actor.id, "change_password", null);
      return { ok: true };
    }),
  );

  router.get("/account/tokens", wrap(async (_req, res) => ({ tokens: await listApiTokens(db, actorOf(res).id) })));
  router.post(
    "/account/tokens",
    wrap(async (req, res) => {
      const body = z.object({ name: z.string().min(1).max(100), expires_in_days: z.number().int().min(1).max(3650).optional() }).parse(req.body);
      const created = await createApiToken(db, actorOf(res).id, body.name, body.expires_in_days);
      await audit(db, actorOf(res).id, "create_api_token", created.id, {
        targetKind: "token",
        targetLabel: created.name,
        details: { token_name: created.name, expires_at: created.expires_at },
      });
      return created;
    }),
  );
  router.delete(
    "/account/tokens/:id",
    wrap(async (req, res) => {
      const result = await revokeApiToken(db, actorOf(res).id, z.string().uuid().parse(req.params.id));
      await audit(db, actorOf(res).id, "revoke_api_token", result.id, { targetKind: "token", targetLabel: result.name, details: { token_name: result.name } });
      return result;
    }),
  );
  // Rotation: a new token with the same name and lifetime (shown once); the old one works for the grace period.
  // People rotate their own tokens; service-account tokens are rotated in Admin › Service accounts.
  router.post(
    "/account/tokens/:id/rotate",
    wrap(async (req, res) => {
      const actor = actorOf(res);
      if (actor.kind !== "human") throw new ForbiddenError("service-account tokens are rotated by people who manage people, in Admin › Service accounts");
      const id = z.string().uuid().parse(req.params.id);
      const { grace } = z.object({ grace: z.enum(Object.keys(ROTATION_GRACE_DAYS) as [keyof typeof ROTATION_GRACE_DAYS]) }).parse(req.body);
      const rotated = await rotateApiToken(db, actor.id, id, grace);
      await audit(db, actor.id, "rotate_api_token", rotated.id, {
        targetKind: "token",
        targetLabel: rotated.name,
        details: {
          token_name: rotated.name,
          old_token_id: rotated.replaced.id,
          new_token_id: rotated.id,
          grace,
          old_works_until: rotated.replaced.works_until,
          expires_at: rotated.expires_at,
        },
      });
      return rotated;
    }),
  );

  router.get("/account/connections", wrap(async (_req, res) => ({ connections: await listConnections(db, actorOf(res).id) })));
  router.delete(
    "/account/connections/:clientId",
    wrap(async (req, res) => {
      const result = await revokeConnection(db, actorOf(res).id, z.string().min(1).max(100).parse(req.params.clientId));
      await audit(db, actorOf(res).id, "revoke_oauth_connection", null);
      return result;
    }),
  );

  // ---- Admin: people (every sign-in), plus local accounts and invitations ----
  router.get(
    "/users",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const query = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
      return { users: await listPeople(ctxOf(res), { query }) };
    }),
  );
  router.post(
    "/users",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const body = z
        .object({
          email: z.string().max(320),
          name: z.string().max(200).optional(),
          // Organisation roles ("Administrator" included) and a project with roles there (Contributor by default).
          roles: roleInputs.optional(),
          project: z.string().optional(),
          project_roles: roleInputs.optional(),
          // Deprecated: one project role; use project_roles.
          role: z.string().max(100).optional(),
          // Deprecated: use roles: ["Administrator"].
          is_admin: z.boolean().optional(),
        })
        .parse(req.body);
      const input = { email: body.email, name: body.name, roles: body.roles, isAdmin: body.is_admin, project: body.project, projectRoles: body.project_roles, role: body.role };
      // Without built-in passwords, people sign in elsewhere (Cloudflare Access): add them by email, approved in advance.
      // With them, an account with a temporary password. Either way everything is checked first and written at once.
      return settings.authMode !== "local" ? addPerson(ctxOf(res), input) : createAccount(ctxOf(res), input);
    }),
  );
  router.get(
    "/invitations",
    wrap(async (_req, res) => (requireAdmin(res) ? { invitations: await listInvitations(db) } : undefined)),
  );
  router.post(
    "/invitations",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const body = z
        .object({
          email: z.string().max(320),
          name: z.string().max(200).optional(),
          scope: z.string().optional(),
          roles: roleInputs.optional(),
          // Deprecated: one project role; use roles.
          role: z.string().max(100).optional(),
        })
        .parse(req.body);
      if (body.scope) {
        // Inviting into a project gives roles there: the same rules as giving them directly.
        const ctx = ctxOf(res);
        const scope = await getReadableScope(ctx, body.scope);
        await assertCanManage(ctx, scope, "manage_members");
        if (body.roles && !body.roles.some((r) => r.trim())) throw new ValidationError("give them at least one role in the project, e.g. roles: ['Contributor']");
        await assertMayGrant(ctx, await resolveRoles(db, "project", body.roles ?? (body.role ? [body.role] : ["writer"])), scope.id);
      }
      const inv = await createInvitation(db, settings, actorOf(res).id, body);
      // Never the invitation link (it signs the invitee in).
      await audit(db, actorOf(res).id, "invite_user", null, {
        targetKind: "person",
        targetLabel: body.email.trim().toLowerCase(),
        details: { invitation_id: inv.id, email: body.email.trim().toLowerCase(), project: body.scope ?? null, roles: body.roles ?? (body.role ? [body.role] : []) },
      });
      return inv;
    }),
  );
  router.delete(
    "/invitations/:id",
    wrap(async (req, res) => (requireAdmin(res) ? revokeInvitation(db, z.string().uuid().parse(req.params.id)) : undefined)),
  );
  router.post(
    "/users/:id/reset-password",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      return resetAccountPassword(ctxOf(res), z.string().uuid().parse(req.params.id));
    }),
  );
  router.patch(
    "/users/:id",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const id = z.string().uuid().parse(req.params.id);
      // Organisation roles: `roles` replaces them (never removing Administrator), or `add` / `remove` ("Administrator"
      // included). `is_admin` is the older form and is merged into them.
      const body = z
        .object({
          roles: roleInputs.optional(),
          add: roleInputs.optional(),
          remove: roleInputs.optional(),
          is_admin: z.boolean().optional(),
          disabled: z.boolean().optional(),
          // A display name; null or "" clears it.
          name: z.string().max(200).nullable().optional(),
        })
        .parse(req.body);
      return updatePerson(ctxOf(res), id, { roles: body.roles, add: body.add, remove: body.remove, isAdmin: body.is_admin, disabled: body.disabled, name: body.name });
    }),
  );

  return router;
}

/** Until a temporary password is changed, a browser session may only see who it is, change the password or sign out. */
export function requirePasswordChanged(req: Request, res: Response, next: () => void) {
  const actor = res.locals.actor as Actor;
  if (actor.mustChangePassword && res.locals.via === "cookie" && !["/me", "/account/password"].includes(req.path)) {
    res.status(403).json({ error: "password change required", code: "must_change_password" });
    return;
  }
  next();
}
