import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Settings } from "../config.js";
import { adminAddComponent, adminCreateProject, adminSetMember, listMembers } from "../core/admin.js";
import { audit } from "../core/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "../core/context.js";
import { isAdmin } from "../core/permissions.js";
import { approveRevision, getRevision, listReviewQueue, rejectRevision } from "../core/review.js";
import type { Db } from "../db/pool.js";

/** JSON API for the web UI and for reviewers (approval is deliberately not an MCP tool: agents propose, people approve). */
export function apiRouter(db: Db, settings: Settings) {
  const router = Router();
  const ctxOf = (req: Request, res: Response): RequestContext => ({
    db,
    settings,
    actor: res.locals.actor as Actor,
    project: req.header("x-cairn-project") || undefined,
  });
  const handle =
    (fn: (ctx: RequestContext, req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await fn(ctxOf(req, res), req));
      } catch (err) {
        next(err);
      }
    };

  router.get(
    "/me",
    handle(async (ctx) => ({ ...ctx.actor, admin: isAdmin(ctx) })),
  );

  router.get(
    "/revisions",
    handle(async (ctx, req) => {
      const q = z
        .object({
          scope: z.string().optional(),
          state: z.enum(["pending", "approved", "rejected"]).optional(),
          mine: z.enum(["true", "false"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query);
      return { revisions: await listReviewQueue(ctx, { ...q, mine: q.mine === "true" }) };
    }),
  );
  router.get(
    "/revisions/:id",
    handle((ctx, req) => getRevision(ctx, z.string().uuid().parse(req.params.id))),
  );
  router.post(
    "/revisions/:id/approve",
    handle((ctx, req) => approveRevision(ctx, z.string().uuid().parse(req.params.id))),
  );
  router.post(
    "/revisions/:id/reject",
    handle((ctx, req) => rejectRevision(ctx, z.string().uuid().parse(req.params.id), z.object({ reason: z.string() }).parse(req.body).reason)),
  );

  router.post(
    "/projects",
    handle(async (ctx, req) => {
      const body = z.object({ slug: z.string(), name: z.string().min(1), description: z.string().optional() }).parse(req.body);
      const result = await adminCreateProject(ctx, body);
      await audit(db, ctx.actor.id, "admin_create_project", result.id);
      return result;
    }),
  );
  router.post(
    "/projects/:slug/components",
    handle(async (ctx, req) => {
      const body = z
        .object({
          slug: z.string(),
          kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]),
          repo_url: z.string().url().optional(),
        })
        .parse(req.body);
      const result = await adminAddComponent(ctx, String(req.params.slug), body);
      await audit(db, ctx.actor.id, "admin_add_component", result.id);
      return result;
    }),
  );
  router.get(
    "/scopes/:slug/members",
    handle((ctx, req) => listMembers(ctx, String(req.params.slug))),
  );
  router.put(
    "/scopes/:slug/members",
    handle(async (ctx, req) => {
      const body = z.object({ email: z.string(), role: z.enum(["reader", "writer", "owner"]).nullable() }).parse(req.body);
      const result = await adminSetMember(ctx, String(req.params.slug), body.email, body.role);
      await audit(db, ctx.actor.id, "admin_set_member", null);
      return result;
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: "invalid request", issues: err.issues });
    if (err instanceof ValidationError) return void res.status(400).json({ error: err.message });
    if (err instanceof ForbiddenError) return void res.status(403).json({ error: err.message });
    if (err instanceof NotFoundError) return void res.status(404).json({ error: err.message });
    if (err instanceof ConflictError) return void res.status(409).json({ error: err.message, current: err.current });
    next(err);
  });

  return router;
}
