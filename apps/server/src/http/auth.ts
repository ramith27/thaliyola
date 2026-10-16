import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sessionToken } from "../auth/index.js";
import {
  changePassword,
  createApiToken,
  createLocalUser,
  listApiTokens,
  listLocalUsers,
  login,
  logout,
  resetPassword,
  revokeApiToken,
  SESSION_COOKIE,
  sessionHash,
  updateLocalUser,
} from "../auth/local.js";
import { acceptInvitation, createInvitation, describeInvitation, listInvitations, revokeInvitation } from "../auth/invitations.js";
import { listConnections, revokeConnection } from "../auth/oauth.js";
import type { Settings } from "../config.js";
import { audit } from "../core/audit.js";
import { ValidationError, type Actor } from "../core/context.js";
import type { Db } from "../db/pool.js";

/** Failed-login throttle: per email+IP and per IP, in memory (one instance) — enough to stop online guessing. */
class LoginThrottle {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  blocked(key: string) {
    const h = this.hits.get(key);
    return !!h && h.reset > Date.now() && h.count >= this.limit;
  }
  fail(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else h.count++;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
  clear(key: string) {
    this.hits.delete(key);
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
  const perAccount = new LoginThrottle(10, 15 * 60_000);
  const perIp = new LoginThrottle(50, 15 * 60_000);

  router.get("/config", (_req, res) => {
    res.json({ mode: settings.authMode });
  });

  router.post("/login", async (req, res, next) => {
    try {
      if (settings.authMode !== "local") return void res.status(404).json({ error: "local sign-in is not enabled" });
      const body = z.object({ email: z.string().min(3).max(320), password: z.string().min(1).max(200) }).safeParse(req.body);
      if (!body.success) return void res.status(400).json({ error: "email and password are required" });
      const ip = req.ip ?? "unknown";
      const accountKey = `${body.data.email.trim().toLowerCase()}|${ip}`;
      if (perAccount.blocked(accountKey) || perIp.blocked(ip)) {
        return void res.status(429).json({ error: "too many failed attempts; try again in 15 minutes" });
      }
      const session = await login(db, body.data.email, body.data.password, { ttlHours: settings.sessionTtlHours, userAgent: req.header("user-agent") });
      if (!session) {
        perAccount.fail(accountKey);
        perIp.fail(ip);
        return void res.status(401).json({ error: "wrong email or password" });
      }
      perAccount.clear(accountKey);
      await audit(db, session.userId, "login", null);
      setSessionCookie(req, res, settings, session.token);
      res.json({ ok: true, must_change_password: session.mustChangePassword });
    } catch (err) {
      next(err);
    }
  });

  // Invitation links: show who invited whom, then create the account with the invitee's own password and sign them in.
  const invites = new LoginThrottle(30, 15 * 60_000);
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
      if (invites.blocked(ip)) return void res.status(429).json({ error: "too many attempts; try again in 15 minutes" });
      const body = z.object({ password: z.string().min(1).max(200), name: z.string().max(200).optional() }).safeParse(req.body);
      if (!body.success) return void res.status(400).json({ error: "choose a password" });
      const accepted = await acceptInvitation(db, String(req.params.token), body.data);
      if (!accepted) {
        invites.fail(ip);
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
export function accountRouter(db: Db, settings: Settings, isAdmin: (actor: Actor) => boolean) {
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
  const requireAdmin = (res: Response) => {
    if (!isAdmin(actorOf(res))) {
      res.status(403).json({ error: "admin only" });
      return false;
    }
    return true;
  };

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
      await audit(db, actorOf(res).id, "create_api_token", null);
      return created;
    }),
  );
  router.delete(
    "/account/tokens/:id",
    wrap(async (req, res) => {
      const result = await revokeApiToken(db, actorOf(res).id, z.string().uuid().parse(req.params.id));
      await audit(db, actorOf(res).id, "revoke_api_token", null);
      return result;
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

  // ---- Admin: local users ----
  router.get(
    "/users",
    wrap(async (_req, res) => (requireAdmin(res) ? { users: await listLocalUsers(db) } : undefined)),
  );
  router.post(
    "/users",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const body = z.object({ email: z.string(), name: z.string().max(200).optional(), is_admin: z.boolean().optional() }).parse(req.body);
      const created = await createLocalUser(db, { email: body.email, name: body.name, isAdmin: body.is_admin });
      await audit(db, actorOf(res).id, "create_user", created.user.id);
      return { user: created.user, temporary_password: created.temporaryPassword };
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
        .object({ email: z.string().max(320), name: z.string().max(200).optional(), scope: z.string().optional(), role: z.enum(["reader", "writer", "owner"]).optional() })
        .parse(req.body);
      const inv = await createInvitation(db, settings, actorOf(res).id, body);
      await audit(db, actorOf(res).id, "invite_user", inv.id);
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
      const id = z.string().uuid().parse(req.params.id);
      const temporary = await resetPassword(db, id);
      await audit(db, actorOf(res).id, "reset_password", id);
      return { temporary_password: temporary };
    }),
  );
  router.patch(
    "/users/:id",
    wrap(async (req, res) => {
      if (!requireAdmin(res)) return undefined;
      const id = z.string().uuid().parse(req.params.id);
      const body = z.object({ is_admin: z.boolean().optional(), disabled: z.boolean().optional(), name: z.string().max(200).optional() }).parse(req.body);
      const user = await updateLocalUser(db, actorOf(res).id, id, { isAdmin: body.is_admin, disabled: body.disabled, name: body.name });
      await audit(db, actorOf(res).id, "update_user", id);
      return { user };
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
