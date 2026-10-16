import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Settings } from "../config.js";
import { adminAddComponent, adminCreateProject, adminSetMember, adminUpdateScope, listMembers } from "../core/admin.js";
import { ASSET_MIME_TYPES, deleteAsset, getAsset, uploadAsset } from "../core/assets.js";
import { audit } from "../core/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "../core/context.js";
import { editArticle, editFinding, newArticle, newFinding } from "../core/direct.js";
import { needsAttention } from "../core/freshness.js";
import { insights, knowledgeGraph } from "../core/insights.js";
import { listSuggestions } from "../core/suggestions.js";
import { browseKb, getArticle, getFinding } from "../core/items.js";
import { ackNotice, listImpactNotices } from "../core/notices.js";
import { isAdmin, readableScopes } from "../core/permissions.js";
import { getProjectContext } from "../core/projects.js";
import { approveRevision, getRevision, listReviewQueue, rejectRevision } from "../core/review.js";
import { searchKnowledge } from "../core/search.js";
import { addSourceLinkTo, LINK_KINDS, linkEntries, promoteFinding, shareToLibrary, verifyEntry } from "../core/writes.js";
import { ARTICLE_TEMPLATES, templateFor } from "../core/templates.js";
import { addComment, bulkApprove, getVersion, listComments, listReviewers, listVersions, restoreVersion, setAssignee } from "../core/workflow.js";
import type { Embedder } from "../core/embeddings.js";
import type { Db } from "../db/pool.js";
import { mcpCatalog } from "../mcp/catalog.js";

const ARTICLE_TYPES = Object.keys(ARTICLE_TEMPLATES) as [string, ...string[]];
const FINDING_TYPES = ["incident", "rca", "known_issue", "data_gotcha", "query_recipe"] as const;
const STATUSES = ["draft", "published", "possibly_stale", "superseded", "rejected"] as const;
const uuid = z.string().uuid();
const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined));

const entities = z.array(z.object({ kind: z.enum(["system", "table", "metric", "service", "advertiser", "publisher", "offer", "other"]), name: z.string().min(1) })).optional();
const sourceLinks = z
  .array(
    z.object({
      system: z.enum(["slack", "sentry", "trello", "pr", "figma", "dashboard", "repo", "other"]),
      url: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be http(s)"),
      label: z.string().optional(),
    }),
  )
  .optional();

/** Maps domain errors to HTTP statuses for everything under /api. */
export function apiErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError) return void res.status(400).json({ error: "invalid request", issues: err.issues });
  if (err instanceof ValidationError) return void res.status(400).json({ error: err.message });
  if (err instanceof ForbiddenError) return void res.status(403).json({ error: err.message });
  if (err instanceof NotFoundError) return void res.status(404).json({ error: err.message });
  if (err instanceof ConflictError) return void res.status(409).json({ error: err.message, current: err.current });
  next(err);
}

/**
 * JSON API for the web UI and for reviewers. Approval is deliberately not an
 * MCP tool: agents propose, people approve here.
 */
export function apiRouter({ db, settings, embedder, onWrite }: { db: Db; settings: Settings; embedder?: Embedder; onWrite?: () => void }) {
  const router = Router();
  const ctxOf = (req: Request, res: Response): RequestContext => ({
    db,
    settings,
    embedder,
    onWrite,
    actor: res.locals.actor as Actor,
    project: req.header("x-cairn-project") || undefined,
  });

  /** Wraps a route: builds the context, audits the call, returns JSON. */
  const handle =
    (name: string, fn: (ctx: RequestContext, req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = ctxOf(req, res);
        const result = await fn(ctx, req);
        const target = typeof req.params.id === "string" && uuid.safeParse(req.params.id).success ? req.params.id : null;
        await audit(db, ctx.actor.id, `api:${name}`, target);
        res.json(result);
      } catch (err) {
        next(err);
      }
    };

  router.get(
    "/me",
    handle("me", async (ctx) => ({
      id: ctx.actor.id,
      email: ctx.actor.email,
      kind: ctx.actor.kind,
      admin: isAdmin(ctx),
      local_account: ctx.actor.subject.startsWith("local:"),
      must_change_password: !!ctx.actor.mustChangePassword,
      auth_mode: settings.authMode,
    })),
  );

  // Everything a newly signed-in person needs to connect their tools.
  router.get(
    "/connect-info",
    handle("connect_info", async (ctx, req) => {
      const origin = settings.publicUrl ?? `${req.protocol}://${req.header("host")}`;
      const readable = await readableScopes(ctx);
      const memberships = await ctx.db.query(
        `SELECT s.slug, s.name, s.kind, m.role FROM scope_members m JOIN scopes s ON s.id = m.scope_id
          WHERE m.user_id = $1 ORDER BY s.kind, s.name`,
        [ctx.actor.id],
      );
      const projects = await ctx.db.query(
        `SELECT s.slug, s.name, s.visibility,
                coalesce((SELECT json_agg(c.slug ORDER BY c.slug) FROM components c WHERE c.scope_id = s.id), '[]') AS components
           FROM scopes s WHERE s.kind = 'project' AND s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1))
          ORDER BY s.name`,
        [readable],
      );
      const tokens = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL", [ctx.actor.id]);
      const connections = await ctx.db.query<{ n: number }>(
        "SELECT count(DISTINCT client_id)::int AS n FROM oauth_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()",
        [ctx.actor.id],
      );
      return {
        mcp_url: `${origin}/mcp`,
        origin,
        auth_mode: settings.authMode,
        oauth_enabled: settings.authMode === "local" && !!settings.publicUrl,
        account: { email: ctx.actor.email, admin: isAdmin(ctx), kind: ctx.actor.kind },
        memberships: memberships.rows,
        projects: projects.rows,
        has_connected: tokens.rows[0]!.n > 0 || connections.rows[0]!.n > 0,
        catalog: await mcpCatalog(ctx),
      };
    }),
  );

  router.get("/insights", handle("insights", (ctx) => insights(ctx)));
  router.get(
    "/graph",
    handle("graph", (ctx, req) =>
      knowledgeGraph(ctx, {
        scope: z.string().optional().parse(req.query.scope) || undefined,
        focus: uuid.optional().parse(req.query.focus || undefined),
        depth: z.coerce.number().int().min(1).max(3).optional().parse(req.query.depth || undefined),
      }),
    ),
  );

  // ---- Reading -------------------------------------------------------------

  router.get(
    "/scopes",
    handle("list_scopes", async (ctx) => {
      const readable = await readableScopes(ctx);
      const { rows } = await ctx.db.query(
        `SELECT s.id, s.kind, s.slug, s.name, s.description, s.status, s.visibility,
                coalesce((SELECT json_agg(json_build_object('slug', c.slug, 'kind', c.kind, 'repo_url', c.repo_url) ORDER BY c.slug)
                            FROM components c WHERE c.scope_id = s.id), '[]') AS components
           FROM scopes s WHERE s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1))
          ORDER BY CASE s.kind WHEN 'team' THEN 0 WHEN 'library' THEN 1 ELSE 2 END, s.name`,
        [readable],
      );
      return { scopes: rows, article_types: ARTICLE_TYPES, finding_types: FINDING_TYPES };
    }),
  );
  router.get(
    "/scopes/:slug/tree",
    handle("browse", (ctx, req) => browseKb(ctx, String(req.params.slug), z.string().optional().parse(req.query.path))),
  );
  router.get(
    "/search",
    handle("search", (ctx, req) => {
      const q = z
        .object({
          q: z.string().min(1),
          scope: z.string().optional(),
          project: z.string().optional(),
          types: list,
          statuses: list.pipe(z.array(z.enum(STATUSES)).optional()),
          limit: z.coerce.number().int().min(1).max(25).optional(),
        })
        .parse(req.query);
      return searchKnowledge(ctx, { query: q.q, scope: q.scope, project: q.project, types: q.types, statuses: q.statuses, limit: q.limit ?? 20 });
    }),
  );
  router.get(
    "/articles/:id",
    handle("get_article", (ctx, req) => getArticle(ctx, uuid.parse(req.params.id), z.string().optional().parse(req.query.section))),
  );
  router.get("/findings/:id", handle("get_finding", (ctx, req) => getFinding(ctx, uuid.parse(req.params.id))));
  router.get(
    "/templates/:type",
    handle("get_template", async (_ctx, req) => {
      const type = z.enum(ARTICLE_TYPES).parse(req.params.type);
      return { type, sections: ARTICLE_TEMPLATES[type], body_md: templateFor(type) };
    }),
  );
  router.get(
    "/projects/:slug/context",
    handle("project_context", (ctx, req) => getProjectContext(ctx, String(req.params.slug), z.string().optional().parse(req.query.component))),
  );
  router.get(
    "/projects/:slug/notices",
    handle("list_notices", (ctx, req) =>
      listImpactNotices(ctx, {
        project: String(req.params.slug),
        component: z.string().optional().parse(req.query.component),
        include_acked: req.query.include_acked === "true",
      }),
    ),
  );
  router.get(
    "/suggestions",
    handle("list_suggestions", (ctx, req) => listSuggestions(ctx, { scope: z.string().optional().parse(req.query.scope) })),
  );
  router.post(
    "/links",
    handle("link_entries", (ctx, req) => linkEntries(ctx, z.object({ from: z.string(), to: z.string(), relation: z.enum(LINK_KINDS) }).parse(req.body))),
  );
  router.post(
    "/promote",
    handle("promote_finding", (ctx, req) =>
      promoteFinding(
        ctx,
        z.object({ finding_id: uuid, article_id: uuid, version: z.number().int().min(1), section: z.string().max(200).optional() }).parse(req.body),
      ),
    ),
  );
  router.get(
    "/attention",
    handle("needs_attention", (ctx, req) =>
      needsAttention(ctx, { scope: z.string().optional().parse(req.query.scope), limit: z.coerce.number().int().min(1).max(200).optional().parse(req.query.limit) }),
    ),
  );
  router.post(
    "/verify/:id",
    handle("verify_entry", (ctx, req) => {
      const body = z.object({ still_valid: z.boolean(), note: z.string().optional() }).parse(req.body);
      return verifyEntry(ctx, { id: uuid.parse(req.params.id), ...body });
    }),
  );
  router.post("/notices/:id/ack", handle("ack_notice", (ctx, req) => ackNotice(ctx, uuid.parse(req.params.id))));

  // ---- Editing (published directly for scope owners/admins, else proposed) --

  router.post(
    "/articles",
    handle("create_article", (ctx, req) => {
      const body = z
        .object({
          scope: z.string(),
          type: z.enum(ARTICLE_TYPES),
          title: z.string().min(1).max(200),
          body_md: z.string(),
          path: z.string().optional(),
          tags: z.array(z.string()).optional(),
          components: z.array(z.string()).optional(),
          entities,
          source_links: sourceLinks,
        })
        .parse(req.body);
      return newArticle(ctx, body);
    }),
  );
  router.put(
    "/articles/:id",
    handle("edit_article", (ctx, req) => {
      const body = z
        .object({ version: z.number().int().min(1), summary: z.string().min(1).max(300), body_md: z.string(), title: z.string().max(200).optional() })
        .parse(req.body);
      return editArticle(ctx, { id: uuid.parse(req.params.id), version: body.version, summary: body.summary, text: body.body_md, title: body.title });
    }),
  );
  router.post(
    "/findings",
    handle("create_finding", (ctx, req) => {
      const body = z
        .object({
          scope: z.string(),
          type: z.enum(FINDING_TYPES),
          title: z.string().min(1).max(200),
          symptoms: z.string().min(1),
          root_cause: z.string().min(1),
          fix: z.string().optional(),
          tags: z.array(z.string()).optional(),
          components: z.array(z.string()).optional(),
          entities,
          source_links: sourceLinks,
          force_new: z.boolean().optional(),
        })
        .parse(req.body);
      return newFinding(ctx, body);
    }),
  );
  router.put(
    "/findings/:id",
    handle("edit_finding", (ctx, req) => {
      const body = z
        .object({
          version: z.number().int().min(1),
          summary: z.string().min(1).max(300),
          patch: z.object({
            title: z.string().max(200).optional(),
            symptoms: z.string().optional(),
            root_cause: z.string().optional(),
            fix: z.string().optional(),
            tags: z.array(z.string()).optional(),
          }),
        })
        .parse(req.body);
      return editFinding(ctx, { id: uuid.parse(req.params.id), ...body });
    }),
  );

  // ---- Assets and sharing ----------------------------------------------------

  router.post(
    "/assets",
    handle("upload_asset", (ctx, req) => {
      const body = z
        .object({
          target_id: uuid,
          filename: z.string().min(1).max(200),
          mime: z.enum(ASSET_MIME_TYPES),
          data_base64: z.string().min(1),
          alt_text: z.string().max(500).optional(),
        })
        .parse(req.body);
      return uploadAsset(ctx, { ...body, data: Buffer.from(body.data_base64, "base64") });
    }),
  );
  // Raw file. Sandboxed so an uploaded file can never run script in the app's origin.
  router.get("/assets/:id", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      const { meta, data } = await getAsset(ctx, uuid.parse(req.params.id));
      await audit(db, ctx.actor.id, "api:get_asset", meta.target_id);
      const disposition = meta.mime.startsWith("image/") ? "inline" : "attachment";
      res
        .set({
          "Content-Type": meta.mime,
          "Content-Length": String(data.length),
          "Content-Disposition": `${disposition}; filename="${meta.filename.replace(/["\\]/g, "_")}"`,
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          "Cache-Control": "private, max-age=3600",
        })
        .send(data);
    } catch (err) {
      next(err);
    }
  });
  router.delete("/assets/:id", handle("delete_asset", (ctx, req) => deleteAsset(ctx, uuid.parse(req.params.id))));
  router.post(
    "/items/:id/links",
    handle("add_source_link", (ctx, req) => {
      const body = z
        .object({ system: z.enum(["slack", "sentry", "trello", "pr", "figma", "dashboard", "repo", "other"]), url: z.string().url(), label: z.string().max(200).optional() })
        .parse(req.body);
      return addSourceLinkTo(ctx, uuid.parse(req.params.id), body);
    }),
  );
  router.post(
    "/share/:id",
    handle("share_to_library", (ctx, req) => {
      const body = z.object({ summary: z.string().min(1).max(300), path: z.string().optional() }).parse(req.body);
      return shareToLibrary(ctx, { id: uuid.parse(req.params.id), ...body });
    }),
  );

  // ---- Review --------------------------------------------------------------

  router.get(
    "/revisions",
    handle("list_revisions", async (ctx, req) => {
      const q = z
        .object({
          scope: z.string().optional(),
          state: z.enum(["pending", "approved", "rejected"]).optional(),
          mine: z.enum(["true", "false"]).optional(),
          assigned: z.enum(["true", "false"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query);
      return { revisions: await listReviewQueue(ctx, { ...q, mine: q.mine === "true", assigned: q.assigned === "true" }) };
    }),
  );
  router.get("/revisions/:id", handle("get_revision", (ctx, req) => getRevision(ctx, uuid.parse(req.params.id))));
  router.post(
    "/revisions/bulk-approve",
    handle("bulk_approve", (ctx, req) => bulkApprove(ctx, z.object({ ids: z.array(uuid).min(1).max(100) }).parse(req.body).ids)),
  );
  router.post(
    "/revisions/:id/approve",
    handle("approve", (ctx, req) => {
      // Optional reviewer edits (edit-then-approve).
      const text = z.string().max(200_000).optional();
      const edits = z
        .object({
          title: z.string().max(300).optional(),
          body_md: text,
          patch: z.object({ title: z.string().max(300).optional(), symptoms: text, root_cause: text, fix: text }).optional(),
        })
        .optional()
        .parse(req.body && Object.keys(req.body).length ? req.body.edits : undefined);
      return approveRevision(ctx, uuid.parse(req.params.id), edits);
    }),
  );
  router.get("/revisions/:id/comments", handle("list_comments", async (ctx, req) => ({ comments: await listComments(ctx, uuid.parse(req.params.id)) })));
  router.post(
    "/revisions/:id/comments",
    handle("add_comment", (ctx, req) => addComment(ctx, uuid.parse(req.params.id), z.object({ body: z.string().max(5000) }).parse(req.body).body)),
  );
  router.get("/revisions/:id/reviewers", handle("list_reviewers", async (ctx, req) => ({ reviewers: await listReviewers(ctx, uuid.parse(req.params.id)) })));
  router.put(
    "/revisions/:id/assignee",
    handle("assign_revision", (ctx, req) => setAssignee(ctx, uuid.parse(req.params.id), z.object({ user_id: uuid.nullable() }).parse(req.body).user_id)),
  );
  router.get("/items/:id/versions", handle("list_versions", (ctx, req) => listVersions(ctx, uuid.parse(req.params.id))));
  router.get(
    "/items/:id/versions/:v",
    handle("get_version", (ctx, req) => getVersion(ctx, uuid.parse(req.params.id), z.coerce.number().int().min(1).parse(req.params.v))),
  );
  router.post(
    "/items/:id/restore",
    handle("restore_version", (ctx, req) => restoreVersion(ctx, uuid.parse(req.params.id), z.object({ version: z.number().int().min(1) }).parse(req.body).version)),
  );
  router.post(
    "/revisions/:id/reject",
    handle("reject", (ctx, req) => rejectRevision(ctx, uuid.parse(req.params.id), z.object({ reason: z.string() }).parse(req.body).reason)),
  );

  // ---- Admin ---------------------------------------------------------------

  router.post(
    "/projects",
    handle("admin_create_project", (ctx, req) =>
      adminCreateProject(ctx, z.object({ slug: z.string(), name: z.string().min(1), description: z.string().optional() }).parse(req.body)),
    ),
  );
  router.post(
    "/projects/:slug/components",
    handle("admin_add_component", (ctx, req) =>
      adminAddComponent(
        ctx,
        String(req.params.slug),
        z
          .object({ slug: z.string(), kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]), repo_url: z.string().url().optional() })
          .parse(req.body),
      ),
    ),
  );
  router.patch(
    "/scopes/:slug",
    handle("admin_update_scope", (ctx, req) =>
      adminUpdateScope(
        ctx,
        String(req.params.slug),
        z.object({ visibility: z.enum(["team", "members"]).optional(), name: z.string().max(200).optional(), description: z.string().max(2000).optional() }).parse(req.body),
      ),
    ),
  );
  router.get("/scopes/:slug/members", handle("list_members", (ctx, req) => listMembers(ctx, String(req.params.slug))));
  router.put(
    "/scopes/:slug/members",
    handle("admin_set_member", (ctx, req) => {
      const body = z.object({ email: z.string(), role: z.enum(["reader", "writer", "owner"]).nullable() }).parse(req.body);
      return adminSetMember(ctx, String(req.params.slug), body.email, body.role);
    }),
  );

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  return router;
}
