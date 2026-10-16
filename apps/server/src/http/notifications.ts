import { Router, type Request, type Response } from "express";
import express from "express";
import { z } from "zod";
import { sameOrigin } from "../auth/index.js";
import type { Settings } from "../config.js";
import { audit } from "../core/audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "../core/context.js";
import { consumeActionToken, NOTIFICATION_KINDS, peekActionToken } from "../core/notify.js";
import { readableScopes } from "../core/permissions.js";
import { approveRevision } from "../core/review.js";
import { findItemFor } from "../core/writes.js";
import type { Db } from "../db/pool.js";

const uuid = z.string().uuid();

/** Authenticated: notifications, preferences and watches (mounted under /api). */
export function notificationsRouter(db: Db, settings: Settings) {
  const router = Router();
  const actor = (res: Response) => res.locals.actor as Actor;
  const ctxOf = (res: Response): RequestContext => ({ db, settings, actor: actor(res) });
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      next(err);
    }
  };

  router.get(
    "/notifications",
    wrap(async (req, res) => {
      const unreadOnly = req.query.unread === "1";
      const { rows } = await db.query(
        `SELECT id, kind, title, body, link, target_id, created_at, read_at FROM notifications
          WHERE user_id = $1 AND ($2 = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT 50`,
        [actor(res).id, unreadOnly],
      );
      const unread = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [actor(res).id])).rows[0]!.n;
      return { notifications: rows, unread };
    }),
  );
  router.post(
    "/notifications/read",
    wrap(async (req, res) => {
      const ids = z.object({ ids: z.array(uuid).optional() }).parse(req.body ?? {}).ids;
      await db.query(
        "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))",
        [actor(res).id, ids ?? null],
      );
      return { ok: true };
    }),
  );

  router.get(
    "/account/prefs",
    wrap(async (_req, res) => {
      const { rows } = await db.query<{ prefs: Record<string, unknown> }>("SELECT prefs FROM users WHERE id = $1", [actor(res).id]);
      return { prefs: rows[0]?.prefs ?? {}, kinds: NOTIFICATION_KINDS, email_enabled: settings.mailTransport !== "off" };
    }),
  );
  router.put(
    "/account/prefs",
    wrap(async (req, res) => {
      const prefs = z
        .object({
          email: z.record(z.string(), z.boolean()).optional(),
          digest: z.boolean().optional(),
          onboarding_dismissed: z.boolean().optional(),
        })
        .parse(req.body);
      const { rows } = await db.query<{ prefs: unknown }>("UPDATE users SET prefs = prefs || $2::jsonb WHERE id = $1 RETURNING prefs", [actor(res).id, JSON.stringify(prefs)]);
      return { prefs: rows[0]!.prefs };
    }),
  );

  /** Watch target: an article or finding id, or a scope id (projects, library, team). */
  async function target(ctx: RequestContext, id: string): Promise<{ kind: "article" | "finding" | "scope"; id: string }> {
    const scope = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE id = $1", [id])).rows[0];
    if (scope) {
      const readable = await readableScopes(ctx);
      if (readable && !readable.includes(scope.id)) throw new NotFoundError(`scope ${id}`);
      return { kind: "scope", id };
    }
    const item = await findItemFor(ctx, id);
    return { kind: item.kind, id: item.id };
  }
  router.get(
    "/watches/:id",
    wrap(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const { rowCount } = await db.query("SELECT 1 FROM watches WHERE user_id = $1 AND target_id = $2", [actor(res).id, id]);
      return { watching: !!rowCount };
    }),
  );
  router.put(
    "/watches/:id",
    wrap(async (req, res) => {
      const t = await target(ctxOf(res), uuid.parse(req.params.id));
      await db.query("INSERT INTO watches (user_id, target_kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [actor(res).id, t.kind, t.id]);
      return { watching: true };
    }),
  );
  router.delete(
    "/watches/:id",
    wrap(async (req, res) => {
      await db.query("DELETE FROM watches WHERE user_id = $1 AND target_id = $2", [actor(res).id, uuid.parse(req.params.id)]);
      return { watching: false };
    }),
  );
  return router;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(res: Response, title: string, body: string) {
  res
    .status(200)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Thaliyola</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 system-ui,sans-serif;background:#f6f7f9;color:#0f172a;padding:16px}
@media (prefers-color-scheme:dark){body{background:#0b0f17;color:#e6eaf2}main{background:#121826!important;border-color:#232c3d!important}}
main{width:min(460px,100%);background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:26px}h1{font-size:1.25rem;margin:0 0 10px}
button,a.btn{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
a.secondary{background:transparent;color:inherit;border:1px solid #d6dae1;margin-left:6px}.muted{opacity:.7;font-size:.9rem}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
}

/**
 * One-click actions from email. GET only shows a confirmation (mail scanners and link
 * prefetchers follow links); the POST from that page performs the action as the
 * person the single-use token was issued to.
 */
export function actionsRouter(db: Db, settings: Settings) {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: "4kb" }));
  const publicOrigin = settings.publicUrl ? new URL(settings.publicUrl).origin : undefined;

  router.get("/:token", async (req, res, next) => {
    try {
      const t = await peekActionToken(db, String(req.params.token));
      if (!t) return page(res, "Link expired", `<p>This link has expired or was already used. Open the review queue in Thaliyola instead.</p><a class="btn" href="/#/review">Open review queue</a>`);
      const { rows } = await db.query(
        `SELECT r.summary, r.state, s.name AS scope, coalesce(u.display_name, u.email) AS author FROM revisions r
           JOIN scopes s ON s.id = r.scope_id JOIN users u ON u.id = r.author_id WHERE r.id = $1`,
        [t.revision_id],
      );
      const r = rows[0];
      if (!r || r.state !== "pending") return page(res, "Already decided", `<p>This proposal is no longer waiting for review.</p><a class="btn" href="/#/review/${t.revision_id}">Open it</a>`);
      page(
        res,
        "Approve this change?",
        `<p><strong>${escapeHtml(r.summary)}</strong></p><p class="muted">Proposed by ${escapeHtml(r.author)} in ${escapeHtml(r.scope)}.</p>
         <form method="post"><button type="submit">Approve</button><a class="btn secondary" href="/#/review/${t.revision_id}">Review the diff first</a></form>`,
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/:token", async (req, res, next) => {
    try {
      if (!sameOrigin(req, publicOrigin)) return void res.status(403).send("cross-site request refused");
      const t = await consumeActionToken(db, String(req.params.token));
      if (!t) return page(res, "Link expired", `<p>This link has expired or was already used.</p><a class="btn" href="/#/review">Open review queue</a>`);
      const actor = (await db.query<Actor>(`SELECT id, subject, email, kind, is_admin AS "isAdmin", disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1`, [t.user_id])).rows[0];
      if (!actor || actor.disabled) return page(res, "Not allowed", "<p>This account can't approve changes.</p>");
      try {
        await approveRevision({ db, settings, actor }, t.revision_id);
        await audit(db, actor.id, "email_approve", t.revision_id);
        page(res, "Approved", `<p>The change is published.</p><a class="btn" href="/#/review/${t.revision_id}">Open it in Thaliyola</a>`);
      } catch (err) {
        if (err instanceof ForbiddenError || err instanceof ValidationError || err instanceof NotFoundError) {
          return page(res, "Couldn't approve", `<p>${escapeHtml(err.message)}</p><a class="btn" href="/#/review/${t.revision_id}">Open it in Thaliyola</a>`);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });
  return router;
}
