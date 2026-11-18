import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { audit, inAuditRequest } from "../core/audit.js";
import { NotFoundError, ValidationError, type RequestContext } from "../core/context.js";
import type { Db } from "../db/pool.js";
import { assertSkillRight } from "../core/skills/access.js";
import { convertArticlesToSkills } from "../core/skills/articles.js";
import { addAssignment, AUDIENCES, listAssignments, mapCollection, removeAssignment } from "../core/skills/assignments.js";
import {
  adoptSkill,
  createSkill,
  detachSkill,
  getSkillDetail,
  getSkillFileForViewer,
  getSkillVersion,
  listAllSkills,
  listCollections,
  proposeSkillVersion,
  retireSkills,
  updateCollection,
  updateSkill,
} from "../core/skills/catalog.js";
import { mySkills, setSkillPreference, skillZip, syncBundle, syncManifest, zipOf } from "../core/skills/delivery.js";
import { listSkillFeedback, reportSkillProblem, resolveSkillFeedback } from "../core/skills/feedback.js";
import { runImport } from "../core/skills/importer.js";
import { versionFiles } from "../core/skills/prepare.js";
import {
  approveGuidanceGroup,
  approveSkillVersion,
  decideAudienceChange,
  listSkillReview,
  rejectSkillVersion,
  releaseHold,
  rollbackSkill,
  skillReviewCounts,
  approveImportVersions,
  decideCollectionChange,
} from "../core/skills/review.js";
import {
  clearWebhookSecret,
  createSkillSource,
  deleteSkillSource,
  getSkillImport,
  listSkillImports,
  listSkillSources,
  setWebhookSecret,
  syncSkillSource,
  updateSkillSource,
} from "../core/skills/sources.js";
import { sha256 } from "../core/skills/types.js";
import { skillUsage, usageOverview } from "../core/skills/usage.js";

/**
 * Skills for Claude over REST (mounted from api.ts with its handle()). Static paths come before /skills/:id, and
 * every :id must be a uuid (anything else is "not found"). Binary answers (files, zips) and the sync endpoints are
 * written here directly, with their own audit rows.
 */

type Handle = (name: string, fn: (ctx: RequestContext, req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise<void>;

const uuid = z.string().uuid();
const id = (req: Request) => {
  const r = uuid.safeParse(req.params.id);
  if (!r.success) throw new NotFoundError("skill");
  return r.data;
};
const versionNo = (req: Request) => {
  const n = Number(req.params.version);
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError("version");
  return n;
};
const bool = z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1");
const globs = z.array(z.string().max(200)).max(50);
const editorFiles = z.array(z.object({ path: z.string().min(1).max(300), text: z.string().max(2 * 1024 * 1024) })).max(300);
const assignment = z.object({
  audience: z.enum(AUDIENCES as [string, ...string[]]),
  role: z.string().max(100).nullish(),
  team: z.string().max(100).nullish(),
  project: z.string().max(200).nullish(),
});
const sourceInput = z.object({
  name: z.string().max(80).optional(),
  kind: z.enum(["git", "upload"]).optional(),
  provider: z.enum(["gitlab", "github"]).optional(),
  repository: z.string().max(300).optional(),
  ref: z.string().max(200).nullish(),
  path: z.string().max(300).optional(),
  exclude: globs.optional(),
  no_deliver: globs.optional(),
  project: z.string().max(200).nullish(),
  connection: z.string().max(200).nullish(),
  api_url: z.string().max(500).nullish(),
  token: z.string().max(2000).nullish(),
  interval_minutes: z.number().int().nullish(),
  publish_directly: z.boolean().optional(),
  enabled: z.boolean().optional(),
  owner: z.literal("me").optional(),
});

export interface SkillRouteDeps {
  db: Db;
  handle: Handle;
  ctxOf: (req: Request, res: Response) => RequestContext;
}

/** Wraps a route that writes its own answer (files, zips, 304s), with the same audit request as handle(). */
function custom(deps: SkillRouteDeps, name: string, fn: (ctx: RequestContext, req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = deps.ctxOf(req, res);
      await inAuditRequest("api", async () => {
        await fn(ctx, req, res);
        const target = typeof req.params.id === "string" && uuid.safeParse(req.params.id).success ? req.params.id : null;
        await audit(deps.db, ctx.actor.id, `api:${name}`, target, { wrapper: true });
      });
    } catch (err) {
      next(err);
    }
  };
}

const attachment = (name: string) => `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`;

export function skillRoutes(router: Router, deps: SkillRouteDeps) {
  const { handle } = deps;

  // ---- everyone signed in ------------------------------------------------------------------------------------
  router.get("/skills/mine", handle("list_my_skills", (ctx) => mySkills(ctx)));
  router.put("/account/skills", handle("set_skill_preference", (ctx, req) => setSkillPreference(ctx, z.object({ send_to_claude: z.boolean() }).parse(req.body).send_to_claude)));

  // The Claude Code sync script: a manifest (ETag / If-None-Match), then one bundle per new or changed skill.
  router.get(
    "/skills/sync",
    custom(deps, "get_skills_sync", async (ctx, req, res) => {
      const manifest = await syncManifest(ctx, req.header("x-thaliyola-sync") ?? undefined);
      const etag = `"${sha256(JSON.stringify(manifest)).slice(0, 32)}"`;
      res.set({ ETag: etag, "Cache-Control": "no-store" });
      if (req.header("if-none-match") === etag) return void res.status(304).end();
      res.json(manifest);
    }),
  );
  router.get("/skills/sync/:name", handle("get_skill_bundle", (ctx, req) => syncBundle(ctx, String(req.params.name))));

  // ---- review (static paths before /skills/:id) ---------------------------------------------------------------
  router.get("/skills/review", handle("list_skill_review", (ctx) => listSkillReview(ctx)));
  router.get("/skills/review/counts", handle("get_skill_review_counts", (ctx) => skillReviewCounts(ctx)));
  router.post(
    "/skills/review/guidance/:hash/approve",
    handle("publish_skill_versions_guidance", (ctx, req) =>
      approveGuidanceGroup(ctx, String(req.params.hash), z.object({ note: z.string().max(2000).optional(), checked_tools: z.boolean().optional(), checked_flags: z.boolean().optional() }).parse(req.body ?? {})),
    ),
  );
  router.get("/skills/usage", handle("get_skills_usage", (ctx, req) => usageOverview(ctx, z.coerce.number().int().min(1).max(365).optional().parse(req.query.days))));
  router.get("/skills/feedback", handle("list_skill_feedback", (ctx, req) => listSkillFeedback(ctx, z.object({ state: z.enum(["open", "resolved", "dismissed"]).optional(), skill: uuid.optional() }).parse(req.query))));
  router.patch(
    "/skill-feedback/:fid",
    handle("resolve_skill_feedback", (ctx, req) =>
      resolveSkillFeedback(ctx, uuid.parse(req.params.fid), z.object({ state: z.enum(["open", "resolved", "dismissed"]), resolution: z.string().max(2000).optional() }).parse(req.body)),
    ),
  );
  router.post(
    "/skills/import/upload",
    handle("import_skills", async (ctx, req) => {
      const q = z
        .object({
          filename: z.string().max(200).optional(),
          collection: z.string().max(64).optional(),
          project: z.string().max(200).optional(),
          dry_run: bool,
          exclude: z.string().max(4000).optional(),
          no_deliver: z.string().max(4000).optional(),
        })
        .parse(req.query);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError("send the .zip or .tar.gz as the request body");
      const split = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
      return runImport(ctx, { kind: "upload", data: new Uint8Array(req.body), filename: q.filename ?? null, collection: q.collection ?? null, project: q.project ?? null, dryRun: q.dry_run, exclude: split(q.exclude), noDeliver: split(q.no_deliver) });
    }),
  );
  router.post("/skills/retire", handle("retire_skills", (ctx, req) => retireSkills(ctx, z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body).ids)));

  // ---- the catalogue ------------------------------------------------------------------------------------------
  router.get(
    "/skills",
    handle("list_all_skills", (ctx, req) =>
      listAllSkills(ctx, z.object({ status: z.enum(["active", "disabled", "retired", "archived"]).optional(), collection: z.string().max(64).optional(), q: z.string().max(200).optional(), pending: bool, project: z.string().max(200).optional() }).parse(req.query)),
    ),
  );
  router.post(
    "/skills",
    handle("create_skill", (ctx, req) =>
      createSkill(
        ctx,
        z
          .object({
            name: z.string().max(64).optional(),
            collection: z.string().max(64).nullish(),
            project: z.string().max(200).nullish(),
            skill_md: z.string().min(1).max(200 * 1024),
            files: editorFiles.optional(),
            summary: z.string().max(2000).optional(),
            request_review: z.boolean().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.get("/skills/:id", handle("get_skill_detail", (ctx, req) => getSkillDetail(ctx, id(req))));
  router.patch(
    "/skills/:id",
    handle("update_skill", (ctx, req) =>
      updateSkill(ctx, id(req), z.object({ status: z.enum(["active", "disabled", "retired", "archived"]).optional(), collection: z.string().max(64).nullish(), as_prompt: z.boolean().optional() }).parse(req.body)),
    ),
  );
  router.get(
    "/skills/:id/file",
    custom(deps, "get_skill_detail_file", async (ctx, req, res) => {
      const q = z.object({ path: z.string().min(1).max(300), version: z.coerce.number().int().min(1).optional() }).parse(req.query);
      const f = await getSkillFileForViewer(ctx, id(req), q.path, q.version);
      res.set("Cache-Control", "no-store");
      if (f.kind === "text" && req.query.raw !== "1") return void res.json({ path: f.path, size: f.size, kind: f.kind, text: f.text });
      res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": attachment(f.path.split("/").pop() ?? "file"), "X-Content-Type-Options": "nosniff" }).send(f.data);
    }),
  );
  router.get(
    "/skills/:id/download",
    custom(deps, "download_skill", async (ctx, req, res) => {
      const z_ = await skillZip(ctx, id(req));
      res.set({ "Content-Type": "application/zip", "Content-Disposition": attachment(`${z_.name}.zip`), "Cache-Control": "no-store" }).send(Buffer.from(z_.zip));
    }),
  );
  router.post("/skills/:id/feedback", handle("report_skill_problem", (ctx, req) => reportSkillProblem(ctx, { id: id(req) }, z.object({ body: z.string().min(1).max(4000), version: z.number().int().min(1).optional() }).parse(req.body), "web")));
  router.post(
    "/skills/:id/versions",
    handle("propose_skill_version", (ctx, req) =>
      proposeSkillVersion(ctx, id(req), z.object({ skill_md: z.string().max(200 * 1024).optional(), files: editorFiles.optional(), remove_files: z.array(z.string().max(300)).max(300).optional(), summary: z.string().min(1).max(2000), request_review: z.boolean().optional() }).parse(req.body)),
    ),
  );
  router.get("/skills/:id/versions/:version", handle("get_skill_version", (ctx, req) => getSkillVersion(ctx, id(req), versionNo(req))));
  router.get(
    "/skills/:id/versions/:version/archive",
    custom(deps, "get_skill_version_archive", async (ctx, req, res) => {
      const { skill } = await assertSkillRight(ctx, id(req), "see");
      const v = (await ctx.db.query<{ id: string }>("SELECT id FROM skill_versions WHERE skill_id = $1 AND version = $2", [skill.id, versionNo(req)])).rows[0];
      if (!v) throw new NotFoundError("version");
      const files = await versionFiles(ctx.db, v.id);
      res.set({ "Content-Type": "application/zip", "Content-Disposition": attachment(`${skill.name}-v${versionNo(req)}-review.zip`), "Cache-Control": "no-store" }).send(Buffer.from(zipOf(skill.name, files)));
    }),
  );
  const approveBody = z.object({ note: z.string().max(2000).optional(), checked_tools: z.boolean().optional(), checked_flags: z.boolean().optional() });
  router.post("/skills/:id/versions/:version/approve", handle("publish_skill_version", (ctx, req) => approveSkillVersion(ctx, id(req), versionNo(req), approveBody.parse(req.body ?? {}))));
  router.post("/skills/:id/versions/:version/reject", handle("reject_skill_version", (ctx, req) => rejectSkillVersion(ctx, id(req), versionNo(req), z.object({ reason: z.string().min(1).max(2000) }).parse(req.body).reason)));
  router.post("/skills/:id/rollback", handle("rollback_skill", (ctx, req) => rollbackSkill(ctx, id(req), z.object({ version: z.number().int().min(1) }).parse(req.body).version)));
  router.post("/skills/:id/release-hold", handle("release_skill_hold", (ctx, req) => releaseHold(ctx, id(req))));
  router.post("/skills/:id/audience-change", handle("decide_skill_audience_change", (ctx, req) => decideAudienceChange(ctx, id(req), z.object({ decision: z.enum(["confirm", "decline"]) }).parse(req.body).decision)));
  router.post("/skills/:id/detach", handle("detach_skill", (ctx, req) => detachSkill(ctx, id(req), true)));
  router.post("/skills/:id/reattach", handle("reattach_skill", (ctx, req) => detachSkill(ctx, id(req), false)));
  router.post("/skills/:id/adopt", handle("adopt_skill", (ctx, req) => adoptSkill(ctx, id(req), z.object({ source: z.string().min(1).max(200), path: z.string().min(1).max(300) }).parse(req.body))));
  router.get("/skills/:id/assignments", handle("list_skill_assignments", (ctx, req) => listAssignments(ctx, id(req))));
  router.post("/skills/:id/assignments", handle("assign_skill", (ctx, req) => addAssignment(ctx, id(req), assignment.parse(req.body) as never)));
  router.delete("/skill-assignments/:aid", handle("unassign_skill", (ctx, req) => removeAssignment(ctx, uuid.parse(req.params.aid))));
  router.get("/skills/:id/usage", handle("get_skill_usage", (ctx, req) => skillUsage(ctx, id(req), z.coerce.number().int().min(1).max(365).optional().parse(req.query.days))));

  // ---- collections ----------------------------------------------------------------------------------------------
  router.get("/skill-collections", handle("list_skill_collections", (ctx) => listCollections(ctx)));
  router.patch("/skill-collections/:slug", handle("update_skill_collection", (ctx, req) => updateCollection(ctx, String(req.params.slug), z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() }).parse(req.body))));
  router.post(
    "/skill-collections/:slug/change",
    handle("decide_skill_collection_change", (ctx, req) => decideCollectionChange(ctx, String(req.params.slug), z.object({ decision: z.enum(["approve", "decline"]) }).parse(req.body).decision)),
  );
  router.post(
    "/skill-collections/:slug/assignments",
    handle("map_skill_collection", (ctx, req) => mapCollection(ctx, String(req.params.slug), assignment.extend({ dry_run: z.boolean().optional() }).parse(req.body) as never)),
  );

  // ---- sources and imports ----------------------------------------------------------------------------------------
  router.get("/skill-sources", handle("list_skill_sources", (ctx) => listSkillSources(ctx)));
  router.post("/skill-sources", handle("create_skill_source", (ctx, req) => createSkillSource(ctx, sourceInput.parse(req.body))));
  router.patch("/skill-sources/:id", handle("update_skill_source", (ctx, req) => updateSkillSource(ctx, uuid.parse(req.params.id), sourceInput.parse(req.body))));
  router.delete("/skill-sources/:id", handle("delete_skill_source", (ctx, req) => deleteSkillSource(ctx, uuid.parse(req.params.id))));
  router.post("/skill-sources/:id/sync", handle("sync_skill_source", (ctx, req) => syncSkillSource(ctx, uuid.parse(req.params.id), z.object({ force: z.boolean().optional(), dry_run: z.boolean().optional() }).parse(req.body ?? {}))));
  router.post("/skill-sources/:id/webhook-secret", handle("set_skill_source_webhook", (ctx, req) => setWebhookSecret(ctx, uuid.parse(req.params.id))));
  router.delete("/skill-sources/:id/webhook-secret", handle("remove_skill_source_webhook", (ctx, req) => clearWebhookSecret(ctx, uuid.parse(req.params.id))));
  router.get("/skill-imports", handle("list_skill_imports", (ctx, req) => listSkillImports(ctx, uuid.optional().parse(req.query.source))));
  router.get("/skill-imports/:id", handle("get_skill_import", (ctx, req) => getSkillImport(ctx, uuid.parse(req.params.id))));
  router.post("/skill-imports/:id/approve", handle("publish_skill_versions_import", (ctx, req) => approveImportVersions(ctx, uuid.parse(req.params.id), z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {}))));
  router.post("/projects/:slug/skills/convert-articles", handle("convert_articles_to_skills", (ctx, req) => convertArticlesToSkills(ctx, String(req.params.slug), z.object({ dry_run: z.boolean().optional() }).parse(req.body ?? {}))));
}
