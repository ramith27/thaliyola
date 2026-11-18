import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Settings } from "../config.js";
import {
  adminAddComponent,
  adminCreateProject,
  adminUpdateScope,
  changeMemberRoles,
  listManagedProjects,
  listMembers,
  removeComponent,
  setProjectsVisibility,
  updateComponent,
} from "../core/admin.js";
import { personAccess, roleHolders } from "../core/access.js";
import { moveItems } from "../core/move.js";
import { resolveRepo } from "../core/scopes.js";
import { changeTeamRoles, createTeam, createTeamProject, deleteTeam, getTeam, listAccess, listTeams, setTeamMember, updateTeam } from "../core/teams.js";
import { ASSET_MIME_TYPES, deleteAsset, getAsset, uploadAsset } from "../core/assets.js";
import { audit, inAuditRequest } from "../core/audit.js";
import { auditCsv, listAudit, type AuditFilters } from "../core/audit-log.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "../core/context.js";
import { editArticle, editFinding, newArticle, newFinding } from "../core/direct.js";
import { ask, getEntity, listFavourites, searchEntities, setFavourite } from "../core/discover.js";
import { needsAttention } from "../core/freshness.js";
import { exportMarkdown, exportSite } from "../core/exporter.js";
import { importDocs } from "../core/importer.js";
import { dismissGap, knowledgeGaps, successMetrics } from "../core/metrics.js";
import { onboarding } from "../core/onboarding.js";
import { taskSummary } from "../core/tasks.js";
import { eventStream } from "../core/events.js";
import { agentsMdBlock, claimsFor, docsStatus, resolveClaims, updateDocSettings } from "../core/docs.js";
import { approveProjectRequest, createOrRequestProject, declineProjectRequest, listProjectRequests } from "../core/project-requests.js";
import { approveUser, declineUser, findPeople, listAccessRequests, NAME_MAX, setMyName } from "../core/users.js";
import { SOURCE_KINDS } from "../core/connectors.js";
import { designVersions, exportTokens, getDesignSystem, listDesignSystems, recordDesignDecision, restoreDesignVersion, updateDesignSystem } from "../core/design.js";
import { answerQuestion, askSession, cancelQuestion, declineQuestion, endSession, getAnswer, handoffSession, hookCheck, listQuestions, listSessions, registerSession, saveAnswer, setListening } from "../core/sessions.js";
import { checkPath, claimWork, listClaims, releaseWork, touchPath } from "../core/coordination.js";
import { checkDesignDrift, latestDrift } from "../core/design-drift.js";
import { exportSbom, licenceReport } from "../core/sbom.js";
import { guideProgress } from "../core/guide.js";
import { getReadableScope, personalScope } from "../core/scopes.js";
import { hideAdvisory, latestAdvisories, publishAdvisory, setAdvisoryResponse, setProjectTechnologies, stackOf, TECHNOLOGIES } from "../core/advisories.js";
import { beginDependencyScan, detectProjectStack, getVulnerability, listVulnerabilities, recordSecurityReview, reportVulnerability, securityOverview, updateVulnerability, uploadWithAuth } from "../core/security.js";
import { connectionKinds, createConnection, deleteConnection, getConnection, listConnections, syncConnection, testConnection, testDraft, updateConnection } from "../core/connections/manage.js";
import { describeColumns, getApi, getTable, listCalls, listChanges, projectData } from "../core/connections/data.js";
import { createRoute, deleteRoute, listRoutes, sendDigestNow, updateRoute } from "../core/connections/routes.js";
import { createTicket, linkTicket, listTickets } from "../core/connections/tickets.js";
import { canSeal } from "../core/secrets.js";
import { createSource, deleteSource, getInboxItem, listInbox, listSources, previewSource, reopenInboxItem, resolveInboxItem, rotateWebhook, runSourceNow, updateSource } from "../core/sources.js";
import { deleteItem, deleteProject, emptyItem, emptyProject, listTrash, restoreItem, restoreProject } from "../core/trash.js";
import { listPurges, purgeItem } from "../core/purge.js";
import { insights, knowledgeGraph } from "../core/insights.js";
import { listSuggestions } from "../core/suggestions.js";
import { browseKb, getArticle, getFinding } from "../core/items.js";
import { ackNotice, listImpactNotices } from "../core/notices.js";
import { can, effectiveFrom, isAdmin, readableScopes } from "../core/permissions.js";
import { applySystemPreset, getSystemSettings, PRESET_NAMES, updateSystemSettings } from "../core/system.js";
import { setProjectParent } from "../core/hierarchy.js";
import { canSeeAccess, createRole, deleteRole, inRoleOrder, listRoles, namesOf, ORG_PERMISSIONS, orgRolesOf, roleChangeFrom, rolesCatalog, updateRole } from "../core/roles.js";
import { getProjectContext, projectPages } from "../core/projects.js";
import { approveRevision, getRevision, listReviewQueue, rejectRevision, REVIEW_CATEGORIES, reviewFacets } from "../core/review.js";
import { searchKnowledge } from "../core/search.js";
import { addSourceLinkTo, LINEAGE_KINDS, LINK_KINDS, linkEntries, promoteFinding, shareToLibrary, unlinkEntries, verifyEntry } from "../core/writes.js";
import { ARTICLE_TEMPLATES, templateFor, writingGuide } from "../core/templates.js";
import { createView, deleteView, listViews, saveViews, updateView, VIEW_AREA_NAMES } from "../core/views.js";
import { addComment, bulkApprove, bulkReject, getVersion, listComments, listReviewers, listVersions, restoreVersion, setAssignee } from "../core/workflow.js";
import type { Embedder } from "../core/embeddings.js";
import type { Db } from "../db/pool.js";
import { createServiceAccount, createServiceToken, listServiceAccounts, revokeServiceToken, rotateServiceToken, setServiceAccountDisabled } from "../core/service-accounts.js";
import { mcpCatalog } from "../mcp/catalog.js";
import {
  addFeature,
  AREA_KEYS,
  AUDIENCE_KEYS,
  AUDIENCES,
  canManageReleases,
  createRelease,
  deleteFeature,
  deleteRelease,
  FEATURE_AREAS,
  FEATURE_KINDS,
  getRelease,
  KIND_KEYS,
  listFeatures,
  listReleases,
  markReleasesSeen,
  publishRelease,
  readFeature,
  reorderFeatures,
  unpublishRelease,
  updateFeature,
  updateRelease,
  whatsNewStatus,
} from "../core/releases.js";
import { buildInfo } from "../core/version.js";
import { skillRoutes } from "./skills.js";
import { deliveryState } from "../core/skills/delivery.js";
import { syncDirOf } from "../core/skills/types.js";

const ARTICLE_TYPES = Object.keys(ARTICLE_TEMPLATES) as [string, ...string[]];
const FINDING_TYPES = ["incident", "rca", "known_issue", "data_gotcha", "query_recipe"] as const;
const STATUSES = ["draft", "published", "possibly_stale", "superseded", "rejected"] as const;
const uuid = z.string().uuid();
/** Role inputs: keys, names or aliases ("writer", "Contributor", "project admins"). */
const roleList = z.array(z.string().max(100)).max(20);
/** "organisation" and "organization" are accepted for org roles. */
const roleKind = z.enum(["org", "project", "organisation", "organization"]).transform((k) => (k === "project" ? "project" : "org") as "project" | "org");
const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined));

const entities = z.array(z.object({ kind: z.enum(["system", "table", "metric", "service", "advertiser", "publisher", "offer", "other"]), name: z.string().min(1) })).optional();
const sourceLinks = z
  .array(
    z.object({
      system: z.enum(["slack", "sentry", "trello", "pr", "figma", "dashboard", "repo", "jira", "linear", "other"]),
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
/** A git remote: https URL, SSH form (git@host:org/repo.git) or host/path; empty clears it. */
const repoUrl = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^([a-z+]+:\/\/)?([^@\s/]+@)?[\w.-]+(:\d+)?[/:][\w./~-]+$/i.test(v.trim()), "not a repository URL");

export const reportSchema = z.object({
  project: z.string().optional(),
  component: z.string().optional(),
  repo: z.string().optional(),
  title: z.string().min(1).max(300),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]).optional(),
  cvss_vector: z.string().max(200).optional(),
  details: z.string().min(1).max(20_000),
  location: z.string().max(500).optional(),
  cwe: z.string().max(100).optional(),
  package: z.string().max(300).optional(),
  version: z.string().max(100).optional(),
  fixed_versions: z.array(z.string().max(100)).max(20).optional(),
  advisory_id: z.string().max(100).optional(),
  references: z.array(z.string().url()).max(20).optional(),
});

export const publishSchema = z.object({
  name: z.string().max(80).optional(),
  title: z.string().min(1).max(300),
  summary: z.string().max(8000).default(""),
  cve_ids: z.array(z.string().max(30)).max(30).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]).optional(),
  cvss_score: z.number().min(0).max(10).optional(),
  technologies: z.array(z.string().max(40)).max(20).optional(),
  packages: z.array(z.object({ ecosystem: z.string().max(30), name: z.string().max(200) })).max(30).optional(),
  url: z.string().url().optional(),
});

export function apiRouter({ db, settings, embedder, onWrite, viewerDir = "" }: { db: Db; settings: Settings; embedder?: Embedder; onWrite?: () => void; viewerDir?: string }) {
  const router = Router();
  const ctxOf = (req: Request, res: Response): RequestContext => ({
    db,
    settings,
    embedder,
    onWrite,
    actor: res.locals.actor as Actor,
    project: req.header("x-thaliyola-project") || undefined,
    ...(res.locals.apiToken === true ? { viaToken: true } : {}),
  });

  /** Wraps a route: builds the context, audits the call, returns JSON. */
  const handle =
    (name: string, fn: (ctx: RequestContext, req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = ctxOf(req, res);
        // One audit request: a change the core function records hides this wrapper row on the Audit log page.
        const result = await inAuditRequest("api", async () => {
          const out = await fn(ctx, req);
          const target = typeof req.params.id === "string" && uuid.safeParse(req.params.id).success ? req.params.id : null;
          await audit(db, ctx.actor.id, `api:${name}`, target, { wrapper: true });
          return out;
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    };

  /** Audit log filters from the query string (the same for the page and the CSV). */
  const auditFilters = (req: Request): AuditFilters => {
    const q = z
      .object({
        person: z.string().max(320).optional(),
        action: z.string().max(80).optional(),
        target: uuid.optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        reads: z.enum(["true", "false", "1", "0"]).optional(),
        cursor: z.string().max(20).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query);
    return { ...q, reads: q.reads === "true" || q.reads === "1" };
  };

  router.get(
    "/me",
    handle("me", async (ctx) => {
      const admin = isAdmin(ctx);
      const roles = await orgRolesOf(ctx.db, settings, ctx.actor.id);
      const byConfig = !!ctx.actor.email && settings.adminEmails.includes(ctx.actor.email.toLowerCase());
      return {
        id: ctx.actor.id,
        email: ctx.actor.email,
        name: ctx.actor.name ?? null,
        kind: ctx.actor.kind,
        admin,
        // Organisation permissions (Administrators: all of them) and the organisation roles that grant them ("admin" first).
        permissions: admin ? Object.keys(ORG_PERMISSIONS) : (ctx.actor.permissions ?? []),
        roles,
        role_names: namesOf(await listRoles(ctx.db, "org"), roles),
        administrator_source: admin ? (byConfig ? "ADMIN_EMAILS" : "account") : null,
        can_see_access: canSeeAccess(ctx),
        local_account: ctx.actor.subject.startsWith("local:"),
        must_change_password: !!ctx.actor.mustChangePassword,
        auth_mode: settings.authMode,
        default_project_visibility: settings.defaultProjectVisibility,
        // Thaliyola's version, and the newest published release against the last one this person saw.
        build: buildInfo(),
        whats_new: await whatsNewStatus(ctx.db, ctx.actor.id),
        skills: await (async () => {
          const d = await deliveryState(ctx);
          return { delivery: d.mode, send_to_claude: d.send_to_claude, state: d.state };
        })(),
      };
    }),
  );
  router.get("/version", handle("get_version", async () => buildInfo()));
  // Skills for Claude (http/skills.ts).
  skillRoutes(router, { db, handle, ctxOf });
  // Your own account: the display name others see (null or "" clears it).
  router.patch(
    "/account",
    handle("update_account", (ctx, req) =>
      setMyName(ctx, z.object({ display_name: z.string().max(NAME_MAX * 2).nullable() }).parse(req.body).display_name),
    ),
  );
  // Everything one person can reach and why: yourself, or (Manage people, Manage roles, Read every project) anyone.
  router.get("/account/access", handle("my_access", (ctx) => personAccess(ctx, ctx.actor.id)));
  router.get("/users/:id/access", handle("person_access", (ctx, req) => personAccess(ctx, uuid.parse(req.params.id))));

  // Service accounts and their tokens, for other systems (AutoCode, CI): people with Manage people create them here.
  // Project roles are given in each project's Members and access with the identifier service:<name>.
  router.get("/service-accounts", handle("list_service_accounts", (ctx) => listServiceAccounts(ctx)));
  router.post(
    "/service-accounts",
    handle("create_service_account", (ctx, req) =>
      createServiceAccount(ctx, z.object({ name: z.string().min(1).max(60), display_name: z.string().max(100).optional() }).parse(req.body)),
    ),
  );
  router.patch(
    "/service-accounts/:id",
    handle("update_service_account", (ctx, req) => setServiceAccountDisabled(ctx, uuid.parse(req.params.id), z.object({ disabled: z.boolean() }).parse(req.body).disabled)),
  );
  router.post(
    "/service-accounts/:id/tokens",
    handle("create_service_token", (ctx, req) =>
      createServiceToken(
        ctx,
        uuid.parse(req.params.id),
        z.object({ name: z.string().min(1).max(100), expires_in_days: z.number().int().min(1).max(3650).optional() }).parse(req.body),
      ),
    ),
  );
  router.post(
    "/service-accounts/:id/tokens/:tokenId/rotate",
    handle("rotate_service_token", (ctx, req) =>
      rotateServiceToken(ctx, uuid.parse(req.params.id), uuid.parse(req.params.tokenId), z.object({ grace: z.enum(["none", "1d", "7d"]) }).parse(req.body).grace),
    ),
  );
  router.delete(
    "/service-accounts/:id/tokens/:tokenId",
    handle("revoke_service_token", (ctx, req) => revokeServiceToken(ctx, uuid.parse(req.params.id), uuid.parse(req.params.tokenId))),
  );

  // Admin › Audit log (Administrators and Auditors: Read every project and See usage). Filters: person, action,
  // target, from / to (dates or times), reads (include page views and searches); cursor pagination; CSV download.
  router.get("/audit", handle("audit", (ctx, req) => listAudit(ctx, auditFilters(req))));
  router.get("/audit.csv", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = ctxOf(req, res);
      const filters = auditFilters(req);
      const lines = auditCsv(ctx, filters);
      // The permission check runs on the first line, before anything is sent.
      const first = await lines.next();
      await audit(db, ctx.actor.id, "api:export_audit", null, { details: { filters: { ...filters, cursor: undefined, limit: undefined } } });
      res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="thaliyola-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      });
      if (!first.done) res.write(first.value);
      for await (const chunk of lines) res.write(chunk);
      res.end();
    } catch (err) {
      if (res.headersSent) {
        console.error(`[audit] CSV export failed: ${(err as Error).message}`);
        res.end();
        return;
      }
      next(err);
    }
  });

  // Everything a newly signed-in person needs to connect their tools.
  router.get(
    "/connect-info",
    handle("connect_info", async (ctx, req) => {
      const origin = settings.publicUrl ?? `${req.protocol}://${req.header("host")}`;
      const readable = await readableScopes(ctx);
      const memberships = await ctx.db.query<{ roles: string[] }>(
        `SELECT s.slug, s.name, s.kind,
                (array_agg(m.role ORDER BY ro.position))[1] AS role, array_agg(DISTINCT m.role) AS roles
           FROM scope_roles m JOIN scopes s ON s.id = m.scope_id JOIN roles ro ON ro.key = m.role
          WHERE m.user_id = $1 AND s.kind <> 'personal' AND s.status <> 'deleted' GROUP BY s.id ORDER BY s.kind, s.name`,
        [ctx.actor.id],
      );
      const projectRoles = await listRoles(ctx.db, "project");
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
        account: { email: ctx.actor.email, name: ctx.actor.name ?? null, admin: isAdmin(ctx), kind: ctx.actor.kind },
        memberships: memberships.rows.map((m) => {
          const roles = inRoleOrder(projectRoles, m.roles);
          return { ...m, roles, role_names: namesOf(projectRoles, roles) };
        }),
        projects: projects.rows,
        has_connected: tokens.rows[0]!.n > 0 || connections.rows[0]!.n > 0,
        catalog: await mcpCatalog(ctx),
        skills: await (async () => {
          const d = await deliveryState(ctx);
          const seen = (await ctx.db.query<{ at: string }>("SELECT at FROM skill_sync_seen WHERE user_id = $1", [ctx.actor.id])).rows[0];
          const base = origin.replace(/\/+$/, "");
          return {
            delivery: d.mode,
            state: d.state,
            message: d.message,
            send_to_claude: d.send_to_claude,
            script_url: `${base}/skills-sync.py`,
            sync_command: `curl -fsSL ${base}/connect.sh | sh -s -- --skills`,
            run_command: 'python3 -I "$HOME/.config/thaliyola/skills-sync.py"',
            hook_snippet: {
              hooks: {
                SessionStart: [
                  { matcher: "startup", hooks: [{ type: "command", command: 'python3 -I "$HOME/.config/thaliyola/skills-sync.py" --quiet --max-age 300 --budget 20', timeout: 30 }] },
                ],
              },
            },
            folder_example: syncDirOf("example-skill"),
            last_sync_at: seen?.at ?? null,
          };
        })(),
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
      // Everyone has a personal space from their first visit, so it's there to open.
      if (ctx.actor.kind === "human") await personalScope(ctx);
      const readable = await readableScopes(ctx);
      // One query for every scope; what the caller can actually do there (effective_permissions) is worked out from it
      // with the same rules the server enforces (effectiveFrom).
      const { rows } = await ctx.db.query<{
        kind: string;
        my_roles: string[];
        my_permissions: string[];
        own_personal: boolean;
        open_comment: boolean;
        open_propose: boolean;
        open_verify: boolean;
      }>(
        `SELECT s.id, s.kind, s.slug, s.name, s.description, s.status, s.visibility, (SELECT p.slug FROM scopes p WHERE p.id = s.parent_id) AS parent,
                coalesce((SELECT json_agg(json_build_object('slug', c.slug, 'kind', c.kind, 'repo_url', c.repo_url, 'description', c.description,
                                                   -- What a project git connection last read about it (no connection id).
                                                   'git', CASE WHEN c.repo_info IS NOT NULL THEN (c.repo_info - 'connection' - 'languages') || jsonb_build_object('synced_at', c.repo_synced_at) END) ORDER BY c.slug)
                            FROM components c WHERE c.scope_id = s.id), '[]') AS components,
                (SELECT r.role FROM scope_roles r JOIN roles ro ON ro.key = r.role WHERE r.scope_id = s.id AND r.user_id = $2 ORDER BY ro.position LIMIT 1) AS my_role,
                ARRAY(SELECT r.role FROM scope_roles r JOIN roles ro ON ro.key = r.role WHERE r.scope_id = s.id AND r.user_id = $2
                       GROUP BY r.role, ro.position ORDER BY ro.position) AS my_roles,
                ARRAY(SELECT p.permission FROM scope_permissions p WHERE p.scope_id = s.id AND p.user_id = $2 ORDER BY 1) AS my_permissions,
                (s.kind <> 'personal' AND ($3 OR (s.kind = 'project' AND EXISTS (SELECT 1 FROM scope_permissions p WHERE p.scope_id = s.id AND p.user_id = $2 AND p.permission IN ('manage_settings', 'manage_members'))))) AS can_manage,
                (s.kind = 'personal' AND s.owner_id = $2) AS own_personal,
                (s.visibility = 'team' AND s.kind <> 'personal' AND NOT EXISTS (SELECT 1 FROM scope_permissions q WHERE q.scope_id = s.id AND q.permission = 'comment')) AS open_comment,
                (s.visibility = 'team' AND s.kind <> 'personal' AND NOT EXISTS (SELECT 1 FROM scope_permissions q WHERE q.scope_id = s.id AND q.permission = 'propose')) AS open_propose,
                (s.visibility = 'team' AND s.kind <> 'personal' AND NOT EXISTS (SELECT 1 FROM scope_permissions q WHERE q.scope_id = s.id AND q.permission = 'verify')) AS open_verify
           FROM scopes s WHERE s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1))
          ORDER BY CASE s.kind WHEN 'team' THEN 0 WHEN 'library' THEN 1 WHEN 'personal' THEN 2 ELSE 3 END, s.name`,
        [readable, ctx.actor.id, can(ctx, "manage_all_projects")],
      );
      const projectRoles = await listRoles(ctx.db, "project");
      const scopes = rows.map(({ own_personal, open_comment, open_propose, open_verify, ...s }) => {
        const effective = effectiveFrom(ctx, {
          kind: s.kind,
          ownPersonal: own_personal,
          readable: true,
          rolePermissions: s.my_permissions,
          open: { comment: open_comment, propose: open_propose, verify: open_verify },
        });
        return {
          ...s,
          my_role_names: namesOf(projectRoles, s.my_roles),
          effective_permissions: effective,
          can_manage_members: effective.includes("manage_members"),
          can_manage_settings: effective.includes("manage_settings"),
        };
      });
      return { scopes, article_types: ARTICLE_TYPES, finding_types: FINDING_TYPES };
    }),
  );
  router.get(
    "/scopes/:slug/tree",
    handle("browse", (ctx, req) => browseKb(ctx, String(req.params.slug), z.string().optional().parse(req.query.path))),
  );
  router.get(
    "/ask",
    handle("ask", (ctx, req) => {
      const q = z.object({ q: z.string().min(1).max(500), project: z.string().optional() }).parse(req.query);
      return ask(ctx, q.q, { project: q.project });
    }),
  );
  router.get(
    "/entities",
    handle("search_entities", async (ctx, req) => {
      const q = z.object({ q: z.string().max(200).default(""), limit: z.coerce.number().int().min(1).max(50).optional() }).parse(req.query);
      return { entities: await searchEntities(ctx, q.q, q.limit) };
    }),
  );
  router.get("/entities/:kind/:name", handle("get_entity", (ctx, req) => getEntity(ctx, String(req.params.kind), String(req.params.name))));
  router.post(
    "/import",
    handle("import_docs", (ctx, req) => {
      const q = z
        .object({
          scope: z.string(),
          type: z.enum(ARTICLE_TYPES).default("design_doc"),
          filename: z.string().min(1).max(300),
          folder: z.string().max(200).optional(),
          dry_run: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError("send the file as the request body");
      return importDocs(ctx, { filename: q.filename, data: new Uint8Array(req.body), scope: q.scope, type: q.type, folder: q.folder, dryRun: q.dry_run === "true" });
    }),
  );
  router.get("/export/site", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = ctxOf(req, res);
      const scope = z.string().optional().parse(req.query.scope);
      const out = await exportSite(ctx, { scope, viewerDir });
      await audit(ctx.db, ctx.actor.id, "api:export_site", null);
      res
        .set({
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="thaliyola-site-${scope ?? "all"}-${new Date().toISOString().slice(0, 10)}.zip"`,
          "Cache-Control": "no-store",
        })
        .send(Buffer.from(out.zip));
    } catch (err) {
      next(err);
    }
  });
  router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = ctxOf(req, res);
      const scope = z.string().optional().parse(req.query.scope);
      const out = await exportMarkdown(ctx, { scope });
      await audit(ctx.db, ctx.actor.id, "api:export", null);
      res
        .set({
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="thaliyola-${scope ?? "export"}-${new Date().toISOString().slice(0, 10)}.zip"`,
          "Cache-Control": "no-store",
        })
        .send(Buffer.from(out.zip));
    } catch (err) {
      next(err);
    }
  });
  router.get("/success", handle("success_metrics", (ctx, req) => successMetrics(ctx, { days: z.coerce.number().int().optional().parse(req.query.days) })));
  router.get("/gaps", handle("knowledge_gaps", (ctx, req) => knowledgeGaps(ctx, { days: z.coerce.number().int().optional().parse(req.query.days) })));
  router.post("/gaps/dismiss", handle("dismiss_gap", (ctx, req) => dismissGap(ctx, z.object({ query: z.string().min(1).max(300) }).parse(req.body).query)));
  router.post(
    "/purge/:id",
    handle("purge", (ctx, req) =>
      purgeItem(ctx, uuid.parse(req.params.id), z.object({ reason: z.string().max(1000), confirm_title: z.string().max(300) }).parse(req.body)),
    ),
  );
  router.get("/purges", handle("list_purges", async (ctx) => ({ purges: await listPurges(ctx) })));
  // Design systems.
  router.get("/design-systems", handle("list_design_systems", (ctx) => listDesignSystems(ctx)));
  router.get("/scopes/:slug/design", handle("get_design_system", (ctx, req) => getDesignSystem(ctx, String(req.params.slug))));
  router.put(
    "/scopes/:slug/design",
    handle("update_design_system", (ctx, req) =>
      updateDesignSystem(
        ctx,
        String(req.params.slug),
        z
          .object({
            tokens: z.unknown().optional(),
            replace: z.boolean().optional(),
            remove: z.record(z.string(), z.array(z.string())).optional(),
            principles: z.string().max(20_000).optional(),
            based_on: z.string().nullable().optional(),
            source: z.string().max(300).optional(),
            note: z.string().max(300).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  // Design drift: CI or an agent reports what the code uses; the latest report shows on the Design page.
  router.post("/scopes/:slug/design/drift", handle("check_design_drift", (ctx, req) => checkDesignDrift(ctx, String(req.params.slug), req.body)));
  router.get("/scopes/:slug/design/drift", handle("design_drift", async (ctx, req) => ({ drift: await latestDrift(ctx, String(req.params.slug)) })));
  router.get("/scopes/:slug/design/versions", handle("design_versions", (ctx, req) => designVersions(ctx, String(req.params.slug))));
  router.post(
    "/scopes/:slug/design/restore",
    handle("restore_design_version", (ctx, req) => restoreDesignVersion(ctx, String(req.params.slug), z.object({ version: z.number().int().min(1) }).parse(req.body).version)),
  );
  router.post(
    "/scopes/:slug/design/decisions",
    handle("record_design_decision", (ctx, req) =>
      recordDesignDecision(ctx, {
        project: String(req.params.slug),
        ...z
          .object({ title: z.string().min(1).max(200), context: z.string().min(1).max(8000), options: z.string().max(8000).optional(), choice: z.string().min(1).max(8000), consequences: z.string().max(8000).optional() })
          .parse(req.body),
      }),
    ),
  );
  router.get("/scopes/:slug/design/export", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      const format = z.enum(["css", "tailwind", "json", "w3c"]).parse(req.query.format ?? "css");
      const d = await getDesignSystem(ctx, String(req.params.slug));
      const out = exportTokens(d.tokens, format);
      res.set("Content-Type", `${out.mime}; charset=utf-8`).set("Content-Disposition", `attachment; filename="${d.scope}-design.${out.ext}"`).send(out.text);
    } catch (err) {
      next(err);
    }
  });

  // Sessions asking each other. Hooks address their session by the client's own id; long-polls stop when the client goes away.
  const sessionRef = z.object({ session: z.string().optional(), client: z.string().max(40).optional(), client_session_id: z.string().max(200).optional() });
  const abortOnClose = (req: Request) => {
    const ac = new AbortController();
    req.res?.on("close", () => ac.abort());
    return ac.signal;
  };
  router.get(
    "/agent-sessions",
    handle("list_sessions", (ctx, req) =>
      listSessions(ctx, z.object({ project: z.string().optional(), include_offline: z.enum(["true", "false"]).transform((v) => v === "true").optional() }).parse(req.query)),
    ),
  );
  router.post(
    "/agent-sessions",
    handle("register_session", (ctx, req) =>
      registerSession(
        ctx,
        z
          .object({
            session: z.string().max(120).optional(),
            name: z.string().max(60).optional(),
            repo: z.string().max(500).optional(),
            project: z.string().optional(),
            component: z.string().optional(),
            description: z.string().max(500).optional(),
            visibility: z.enum(["project", "private"]).optional(),
            listening: z.boolean().optional(),
            client: z.string().max(40).optional(),
            client_session_id: z.string().max(200).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.post("/agent-sessions/listening", handle("set_listening", (ctx, req) => {
    const b = sessionRef.extend({ listening: z.boolean() }).parse(req.body);
    return setListening(ctx, b, b.listening);
  }));
  router.post("/agent-sessions/end", handle("end_session", (ctx, req) => endSession(ctx, sessionRef.parse(req.body))));
  router.get(
    "/agent-sessions/check",
    handle("session_check", (ctx, req) =>
      hookCheck(
        ctx,
        sessionRef
          .extend({
            wait_seconds: z.coerce.number().int().min(0).max(100).optional(),
            claim: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
            answers: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          })
          .parse(req.query),
        abortOnClose(req),
      ),
    ),
  );
  router.get(
    "/questions",
    handle("list_questions", (ctx, req) =>
      listQuestions(ctx, z.object({ status: z.enum(["open", "closed", "all"]).optional(), limit: z.coerce.number().int().optional() }).parse(req.query)),
    ),
  );
  router.post(
    "/questions",
    handle("ask_session", (ctx, req) =>
      askSession(
        ctx,
        z
          .object({
            session: z.string().optional(),
            to: z.string().min(1).max(200),
            question: z.string().min(1).max(8000),
            context: z.string().max(8000).optional(),
            wait_seconds: z.number().int().min(0).max(45).optional(),
            expires_minutes: z.number().int().min(1).max(240).optional(),
            everyone: z.boolean().optional(),
          })
          .parse(req.body),
        { signal: abortOnClose(req) },
      ),
    ),
  );
  router.get(
    "/questions/:id/answer",
    handle("get_answer", (ctx, req) =>
      getAnswer(ctx, { id: uuid.parse(req.params.id), ...z.object({ session: z.string().optional(), wait_seconds: z.coerce.number().int().min(0).max(45).optional() }).parse(req.query) }, { signal: abortOnClose(req) }),
    ),
  );
  router.post(
    "/questions/:id/answer",
    handle("answer_question", (ctx, req) =>
      answerQuestion(ctx, {
        id: uuid.parse(req.params.id),
        ...z
          .object({
            session: z.string().optional(),
            answer: z.string().min(1).max(8000),
            save_as: z.enum(["known_issue", "rca", "data_gotcha", "query_recipe", "incident"]).optional(),
            save_to: z.string().optional(),
          })
          .parse(req.body),
      }),
    ),
  );
  router.post(
    "/questions/:id/decline",
    handle("decline_question", (ctx, req) => declineQuestion(ctx, { id: uuid.parse(req.params.id), ...z.object({ session: z.string().optional(), reason: z.string().min(1).max(1000) }).parse(req.body) })),
  );
  // Work claims and handoffs (core/coordination.ts). The two path routes are for the Claude Code plugin's edit hooks.
  const pathRef = z.object({ session: z.string().optional(), client: z.string().max(40).optional(), client_session_id: z.string().max(200).optional(), path: z.string().min(1).max(1000) });
  router.get("/work-claims", handle("list_claims", (ctx, req) => listClaims(ctx, z.object({ project: z.string().optional(), repo: z.string().optional() }).parse(req.query))));
  router.post(
    "/work-claims",
    handle("claim_work", (ctx, req) =>
      claimWork(ctx, z.object({ session: z.string(), paths: z.array(z.string()).min(1).max(50), note: z.string().max(300).optional(), minutes: z.number().int().min(5).max(480).optional() }).parse(req.body)),
    ),
  );
  router.post(
    "/questions/:id/save",
    handle("save_answer", (ctx, req) =>
      saveAnswer(ctx, { id: uuid.parse(req.params.id), ...z.object({ type: z.enum(["known_issue", "rca", "data_gotcha", "query_recipe", "incident"]), scope: z.string().optional() }).parse(req.body) }),
    ),
  );
  router.post("/sources/:id/webhook", handle("rotate_source_webhook", (ctx, req) => rotateWebhook(ctx, uuid.parse(req.params.id))));
  router.post("/work-claims/release", handle("release_work", (ctx, req) => releaseWork(ctx, z.object({ session: z.string(), paths: z.array(z.string()).max(50).optional() }).parse(req.body))));
  router.get("/agent-sessions/check-path", handle("check_path", (ctx, req) => checkPath(ctx, pathRef.parse(req.query))));
  router.post("/agent-sessions/touch", handle("touch_path", (ctx, req) => touchPath(ctx, pathRef.parse(req.body))));
  router.post(
    "/handoffs",
    handle("handoff_session", (ctx, req) =>
      handoffSession(
        ctx,
        z.object({ session: z.string(), to: z.string().min(1).max(200), summary: z.string().min(1).max(8000), next_steps: z.string().max(8000).optional(), files: z.array(z.string()).max(50).optional() }).parse(req.body),
      ),
    ),
  );
  router.post("/questions/:id/cancel", handle("cancel_question", (ctx, req) => cancelQuestion(ctx, uuid.parse(req.params.id))));

  // Vulnerabilities (details for the project's Contributors and Project admins, Security leads and Administrators).
  const SEVERITY = ["critical", "high", "medium", "low", "unknown"] as const;
  const STATUS = ["open", "acknowledged", "fixed", "accepted", "false_positive"] as const;
  const statusEnum = z.enum(STATUS);
  const csvOf = <const T extends readonly [string, ...string[]]>(values: T) =>
    z.string().transform((v, c) => {
      const parts = v.split(",").filter(Boolean);
      const bad = parts.find((p) => !values.includes(p));
      if (bad) c.addIssue({ code: "custom", message: `unknown value ${bad}` });
      return parts as T[number][];
    });
  router.get("/security", handle("security_overview", (ctx, req) => securityOverview(ctx, z.object({ project: z.string().optional() }).parse(req.query))));
  router.get(
    "/vulnerabilities",
    handle("list_vulnerabilities", (ctx, req) => {
      const q = z
        .object({
          project: z.string().optional(),
          repository: z.string().optional(),
          severity: csvOf(SEVERITY).optional(),
          status: z.union([z.enum(["open", "resolved", "all"]), csvOf(STATUS)]).optional(),
          kev: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          fixable: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.query);
      return listVulnerabilities(ctx, q);
    }),
  );
  router.get("/vulnerabilities/:id", handle("get_vulnerability", (ctx, req) => getVulnerability(ctx, uuid.parse(req.params.id))));
  router.post(
    "/vulnerabilities",
    handle("report_vulnerability", (ctx, req) => reportVulnerability(ctx, reportSchema.parse(req.body))),
  );
  router.post(
    "/vulnerabilities/:id/status",
    handle("update_vulnerability", (ctx, req) =>
      updateVulnerability(ctx, { id: uuid.parse(req.params.id), ...z.object({ status: statusEnum, note: z.string().max(1000).optional() }).parse(req.body) }),
    ),
  );
  router.get(
    "/advisories",
    handle("latest_advisories", (ctx, req) =>
      latestAdvisories(
        ctx,
        z
          .object({
            days: z.coerce.number().int().optional(),
            project: z.string().optional(),
            technology: z.string().optional(),
            affecting: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
            view: z.enum(["major", "affecting", "all"]).optional(),
            limit: z.coerce.number().int().optional(),
            include_hidden: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          })
          .parse(req.query),
      ),
    ),
  );
  router.post("/advisories", handle("publish_advisory", (ctx, req) => publishAdvisory(ctx, publishSchema.parse(req.body))));
  router.post("/advisories/:id/hide", handle("hide_advisory", (ctx, req) => hideAdvisory(ctx, uuid.parse(req.params.id), z.object({ hidden: z.boolean().default(true) }).parse(req.body ?? {}).hidden)));
  router.post(
    "/advisories/:id/responses",
    handle("advisory_response", (ctx, req) =>
      setAdvisoryResponse(ctx, {
        advisory_id: uuid.parse(req.params.id),
        ...z.object({ project: z.string(), status: z.enum(["investigating", "affected", "not_affected", "patched"]), note: z.string().max(1000).optional() }).parse(req.body),
      }),
    ),
  );
  router.get(
    "/projects/:slug/technologies",
    handle("project_technologies", async (ctx, req) => {
      const scope = await getReadableScope(ctx, String(req.params.slug));
      return { project: scope.slug, ...(await stackOf(ctx, scope.id)), known: TECHNOLOGIES };
    }),
  );
  router.post("/projects/:slug/technologies/detect", handle("detect_project_stack", (ctx, req) => detectProjectStack(ctx, String(req.params.slug))));
  router.put(
    "/projects/:slug/technologies",
    handle("set_project_technologies", (ctx, req) => setProjectTechnologies(ctx, String(req.params.slug), z.object({ technologies: z.array(z.string().max(40)).max(40) }).parse(req.body).technologies)),
  );
  router.post(
    "/security/reviews",
    handle("record_security_review", (ctx, req) =>
      recordSecurityReview(
        ctx,
        z
          .object({
            project: z.string().optional(),
            component: z.string().optional(),
            repo: z.string().optional(),
            head_sha: z.string().max(64).optional(),
            summary: z.string().min(1).max(4000),
            areas: z.array(z.string().max(100)).max(30).optional(),
            tools: z.array(z.string().max(60)).max(20).optional(),
            vulnerability_ids: z.array(z.string().uuid()).max(200).optional(),
            technologies: z.array(z.string().max(40)).max(40).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  // SBOM (CycloneDX 1.5) and the licence check, for those who see the project's vulnerability details.
  router.get("/scopes/:slug/sbom", async (req, res, next) => {
    try {
      const ctx = ctxOf(req, res);
      const q = z.object({ component: z.string().optional(), licenses: z.enum(["true", "false"]).optional() }).parse(req.query);
      const bom = await exportSbom(ctx, String(req.params.slug), { component: q.component, licenses: q.licenses === "true" });
      await audit(db, ctx.actor.id, "api:export_sbom", null, { wrapper: true });
      res
        .set("Content-Type", "application/vnd.cyclonedx+json; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="${String(req.params.slug).replace(/[^\w-]/g, "")}${q.component ? `-${q.component.replace(/[^\w-]/g, "")}` : ""}-sbom.cdx.json"`)
        .send(JSON.stringify(bom, null, 2));
    } catch (err) {
      next(err);
    }
  });
  router.get("/scopes/:slug/licenses", handle("check_licenses", (ctx, req) => licenceReport(ctx, String(req.params.slug), z.object({ component: z.string().optional() }).parse(req.query))));
  router.post(
    "/dependencies/upload-link",
    handle("scan_dependencies", (ctx, req) =>
      beginDependencyScan(ctx, z.object({ project: z.string().optional(), component: z.string().optional(), repo: z.string().optional(), head_sha: z.string().optional() }).parse(req.body)),
    ),
  );
  router.post(
    "/dependencies",
    handle("upload_dependencies", (ctx, req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError("send a tar.gz of the repository's lockfiles as the request body");
      const q = z.object({ project: z.string().optional(), component: z.string().optional(), repo: z.string().optional(), sha: z.string().max(64).optional() }).parse(req.query);
      return uploadWithAuth(ctx, q, req.body);
    }),
  );

  // Connections: a project's databases, APIs, git hosts, Slack and Trello. Secrets go in, never out.
  const connectionFields = {
    name: z.string().max(80).optional(),
    config: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.null()])).optional(),
    secret: z.record(z.string(), z.union([z.string().max(20_000), z.null()])).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    interval_minutes: z.number().int().optional(),
    enabled: z.boolean().optional(),
    component: z.string().max(100).nullable().optional(),
    spec: z.string().max(1_000_000).nullable().optional(),
  };
  const newConnection = z.object({ kind: z.string().max(40), ...connectionFields });
  router.get(
    "/connection-kinds",
    handle("connection_kinds", async (ctx) => ({ kinds: connectionKinds(ctx.settings), enabled: ctx.settings.connections?.enabled ?? false, key_set: canSeal(ctx.settings.connections?.keys) })),
  );
  router.get("/projects/:slug/connections", handle("list_connections", (ctx, req) => listConnections(ctx, String(req.params.slug))));
  router.post("/projects/:slug/connections", handle("create_connection", (ctx, req) => createConnection(ctx, String(req.params.slug), newConnection.parse(req.body))));
  router.post(
    "/projects/:slug/connections/test",
    handle("test_connection_draft", (ctx, req) => testDraft(ctx, String(req.params.slug), newConnection.extend({ id: uuid.optional() }).parse(req.body))),
  );
  router.get("/connections/:id", handle("get_connection", (ctx, req) => getConnection(ctx, uuid.parse(req.params.id))));
  router.patch("/connections/:id", handle("update_connection", (ctx, req) => updateConnection(ctx, uuid.parse(req.params.id), z.object(connectionFields).parse(req.body))));
  router.delete("/connections/:id", handle("delete_connection", (ctx, req) => deleteConnection(ctx, uuid.parse(req.params.id))));
  router.post("/connections/:id/test", handle("test_connection", (ctx, req) => testConnection(ctx, uuid.parse(req.params.id))));
  router.post("/connections/:id/sync", handle("sync_connection", (ctx, req) => syncConnection(ctx, uuid.parse(req.params.id))));
  const limitQ = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
  router.get("/connections/:id/changes", handle("connection_changes", (ctx, req) => listChanges(ctx, uuid.parse(req.params.id), limitQ.parse(req.query).limit)));
  router.get("/connections/:id/calls", handle("connection_calls", (ctx, req) => listCalls(ctx, uuid.parse(req.params.id), limitQ.parse(req.query).limit)));
  // Notification routes: which kinds of notifications also go to a Slack or Trello connection, team-wide or per project.
  const routeKinds = z.array(z.string().max(40)).max(20);
  const digest = z.enum(["off", "daily", "weekly"]);
  router.get("/notification-routes", handle("list_notification_routes", (ctx) => listRoutes(ctx, null)));
  router.get("/projects/:slug/notification-routes", handle("list_notification_routes", (ctx, req) => listRoutes(ctx, String(req.params.slug))));
  router.post(
    "/notification-routes",
    handle("create_notification_route", (ctx, req) =>
      createRoute(ctx, z.object({ project: z.string().max(100).nullable().optional(), connection_id: uuid, kinds: routeKinds.optional(), digest: digest.optional() }).parse(req.body)),
    ),
  );
  router.patch(
    "/notification-routes/:id",
    handle("update_notification_route", (ctx, req) => updateRoute(ctx, uuid.parse(req.params.id), z.object({ kinds: routeKinds.optional(), digest: digest.optional() }).parse(req.body))),
  );
  router.delete("/notification-routes/:id", handle("delete_notification_route", (ctx, req) => deleteRoute(ctx, uuid.parse(req.params.id))));
  router.post("/notification-routes/:id/digest", handle("send_digest", (ctx, req) => sendDigestNow(ctx, uuid.parse(req.params.id))));
  // The project's Data view: synced tables, the data dictionary and schema history.
  router.get("/projects/:slug/data", handle("project_data", (ctx, req) => projectData(ctx, String(req.params.slug))));
  router.get("/tables/:id", handle("get_table", (ctx, req) => getTable(ctx, uuid.parse(req.params.id), { choices: true })));
  // One API: its endpoints from the synced OpenAPI spec, their history and its article.
  router.get("/apis/:id", handle("get_api", (ctx, req) => getApi(ctx, uuid.parse(req.params.id))));
  router.put(
    "/tables/:id/notes",
    handle("describe_columns", (ctx, req) =>
      describeColumns(ctx, {
        table_id: uuid.parse(req.params.id),
        notes: z
          .object({ notes: z.array(z.object({ column: z.string().min(1).max(300), description: z.string().max(1000).optional(), pii: z.boolean().optional() })).min(1).max(200) })
          .parse(req.body).notes,
      }),
    ),
  );

  // Team sources and the inbox.
  const sourceKind = z.enum(SOURCE_KINDS);
  const sourceConfig = z.record(z.string(), z.union([z.string(), z.number()])).default({});
  router.get("/sources", handle("list_sources", (ctx) => listSources(ctx)));
  router.post(
    "/sources",
    handle("create_source", (ctx, req) => {
      const b = z
        .object({ kind: sourceKind, name: z.string().max(120).default(""), scope: z.string(), config: sourceConfig, interval_minutes: z.number().int().optional(), enabled: z.boolean().optional() })
        .parse(req.body);
      return createSource(ctx, b);
    }),
  );
  router.post(
    "/sources/preview",
    handle("preview_source", (ctx, req) => previewSource(ctx, z.object({ kind: sourceKind, scope: z.string(), config: sourceConfig }).parse(req.body))),
  );
  router.patch(
    "/sources/:id",
    handle("update_source", (ctx, req) =>
      updateSource(
        ctx,
        uuid.parse(req.params.id),
        z.object({ name: z.string().max(120).optional(), scope: z.string().optional(), config: sourceConfig.optional(), interval_minutes: z.number().int().optional(), enabled: z.boolean().optional() }).parse(req.body),
      ),
    ),
  );
  router.delete("/sources/:id", handle("delete_source", (ctx, req) => deleteSource(ctx, uuid.parse(req.params.id))));
  router.post("/sources/:id/run", handle("run_source", (ctx, req) => runSourceNow(ctx, uuid.parse(req.params.id))));
  router.get(
    "/inbox",
    handle("list_inbox", (ctx, req) =>
      listInbox(
        ctx,
        z
          .object({
            scope: z.string().optional(),
            status: z.enum(["new", "filed", "dismissed", "all"]).optional(),
            source: z.string().uuid().optional(),
            limit: z.coerce.number().int().optional(),
            offset: z.coerce.number().int().min(0).optional(),
          })
          .parse(req.query),
      ),
    ),
  );
  router.get("/inbox/:id", handle("get_inbox_item", (ctx, req) => getInboxItem(ctx, uuid.parse(req.params.id))));
  router.post(
    "/inbox/:id/resolve",
    handle("resolve_inbox_item", (ctx, req) =>
      resolveInboxItem(ctx, {
        id: uuid.parse(req.params.id),
        ...z.object({ outcome: z.enum(["filed", "dismissed"]), item_id: z.string().uuid().optional(), revision_id: z.string().uuid().optional(), note: z.string().max(1000).optional() }).parse(req.body),
      }),
    ),
  );
  router.post("/inbox/:id/reopen", handle("reopen_inbox_item", (ctx, req) => reopenInboxItem(ctx, uuid.parse(req.params.id))));
  router.get("/tasks", handle("task_summary", (ctx, req) => taskSummary(ctx, { project: z.string().optional().parse(req.query.project) })));
  router.post("/items/:id/delete", handle("delete_item", (ctx, req) => deleteItem(ctx, uuid.parse(req.params.id))));
  router.get("/trash", handle("list_trash", (ctx) => listTrash(ctx)));
  router.post("/trash/items/:id/restore", handle("restore_item", (ctx, req) => restoreItem(ctx, uuid.parse(req.params.id))));
  router.post("/trash/items/:id/purge", handle("empty_item", (ctx, req) => emptyItem(ctx, uuid.parse(req.params.id))));
  router.post(
    "/projects/:slug/delete",
    handle("delete_project", (ctx, req) => deleteProject(ctx, String(req.params.slug), z.object({ confirm: z.string().max(200) }).parse(req.body).confirm)),
  );
  router.post("/trash/projects/:slug/restore", handle("restore_project", (ctx, req) => restoreProject(ctx, String(req.params.slug))));
  router.post(
    "/trash/projects/:slug/purge",
    handle("empty_project", (ctx, req) => emptyProject(ctx, String(req.params.slug), z.object({ confirm: z.string().max(200) }).parse(req.body).confirm)),
  );
  router.get(
    "/project-requests",
    handle("list_project_requests", async (ctx, req) => ({
      requests: await listProjectRequests(ctx, z.enum(["pending", "approved", "declined"]).optional().parse(req.query.state)),
    })),
  );
  router.post(
    "/project-requests",
    handle("request_project", (ctx, req) =>
      createOrRequestProject(
        ctx,
        z
          .object({
            slug: z.string(),
            name: z.string().max(200),
            description: z.string().max(2000).optional(),
            repos: z.array(z.object({ slug: z.string(), kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]), repo_url: repoUrl.optional(), description: z.string().max(500).optional() })).max(30).optional(),
            reason: z.string().max(1000).optional(),
            visibility: z.enum(["team", "members"]).optional(),
            parent: z.string().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.post(
    "/project-requests/:id/approve",
    handle("approve_project_request", (ctx, req) =>
      approveProjectRequest(ctx, uuid.parse(req.params.id), z.object({ slug: z.string().optional(), name: z.string().max(200).optional() }).parse(req.body ?? {})),
    ),
  );
  router.post(
    "/project-requests/:id/decline",
    handle("decline_project_request", (ctx, req) => declineProjectRequest(ctx, uuid.parse(req.params.id), z.object({ note: z.string().max(1000) }).parse(req.body).note)),
  );
  // People who signed in on their own and wait for an admin (any one admin decides).
  router.get("/access-requests", handle("list_access_requests", async (ctx) => ({ requests: await listAccessRequests(ctx) })));
  router.post("/access-requests/:id/approve", handle("approve_access", (ctx, req) => approveUser(ctx, uuid.parse(req.params.id))));
  router.post("/access-requests/:id/decline", handle("decline_access", (ctx, req) => declineUser(ctx, uuid.parse(req.params.id))));
  router.get("/projects/:slug/docs", handle("docs_status", (ctx, req) => docsStatus(ctx, String(req.params.slug))));
  router.put(
    "/projects/:slug/docs-settings",
    handle("update_doc_settings", (ctx, req) =>
      updateDocSettings(ctx, String(req.params.slug), z.object({ instructions: z.string().max(20000).optional(), ignore: z.string().max(20000).optional() }).parse(req.body)),
    ),
  );
  router.get(
    "/projects/:slug/agents-md",
    handle("agents_md", async (ctx, req) => ({ block: await agentsMdBlock(ctx, String(req.params.slug), z.string().optional().parse(req.query.component)) })),
  );
  router.get("/items/:id/claims", handle("claims", (ctx, req) => claimsFor(ctx, uuid.parse(req.params.id))));
  router.post(
    "/items/:id/claims/resolve",
    handle("resolve_claims", (ctx, req) =>
      resolveClaims(ctx, {
        article_id: uuid.parse(req.params.id),
        ...z.object({ confirm: z.array(z.object({ id: uuid })).optional(), retire: z.array(z.object({ id: uuid, reason: z.string().max(500).optional() })).optional() }).parse(req.body),
      }),
    ),
  );
  router.get("/events", (req, res) => eventStream(req, res));
  router.get("/onboarding", handle("onboarding", (ctx) => onboarding(ctx)));
  router.get("/favourites", handle("list_favourites", async (ctx) => ({ favourites: await listFavourites(ctx) })));
  router.put("/favourites/:id", handle("add_favourite", (ctx, req) => setFavourite(ctx, uuid.parse(req.params.id), true)));
  router.delete("/favourites/:id", handle("remove_favourite", (ctx, req) => setFavourite(ctx, uuid.parse(req.params.id), false)));
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
          prefix: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      return searchKnowledge(ctx, {
        query: q.q,
        scope: q.scope,
        project: q.project,
        types: q.types,
        statuses: q.statuses,
        limit: q.limit ?? 20,
        prefix: q.prefix === "true",
        source: "web",
      });
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
      return { type, sections: ARTICLE_TEMPLATES[type], body_md: templateFor(type, { hints: req.query.hints === "true" }) };
    }),
  );
  // What to write in each section of an article or finding type, and a short checklist (the editor's writing guide).
  router.get(
    "/writing-guide/:kind/:type",
    handle("get_writing_guide", async (_ctx, req) => {
      const kind = z.enum(["article", "finding"]).parse(req.params.kind);
      const type = kind === "article" ? z.enum(ARTICLE_TYPES).parse(req.params.type) : z.enum(FINDING_TYPES).parse(req.params.type);
      return writingGuide(kind, type);
    }),
  );
  router.get("/projects/:slug/pages", handle("project_pages", (ctx, req) => projectPages(ctx, String(req.params.slug))));
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
  // Lineage links (a repository reads or writes a table) can be removed again; other links can't.
  router.delete(
    "/links",
    handle("unlink_entries", (ctx, req) => unlinkEntries(ctx, z.object({ from: z.string(), to: z.string(), relation: z.enum(LINEAGE_KINDS) }).parse(req.body))),
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
        .object({
          version: z.number().int().min(1),
          summary: z.string().min(1).max(300),
          body_md: z.string().optional(),
          title: z.string().max(200).optional(),
          tags: z.array(z.string().max(60)).max(30).optional(),
          add_tags: z.array(z.string().max(60)).max(30).optional(),
          remove_tags: z.array(z.string().max(60)).max(30).optional(),
        })
        .parse(req.body);
      return editArticle(ctx, {
        id: uuid.parse(req.params.id),
        version: body.version,
        summary: body.summary,
        text: body.body_md,
        title: body.title,
        tags: body.tags,
        add_tags: body.add_tags,
        remove_tags: body.remove_tags,
      });
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
        .object({ system: z.enum(["slack", "sentry", "trello", "pr", "figma", "dashboard", "repo", "jira", "linear", "other"]), url: z.string().url(), label: z.string().max(200).optional() })
        .parse(req.body);
      return addSourceLinkTo(ctx, uuid.parse(req.params.id), body);
    }),
  );
  // Jira and Linear tickets of a finding or article: cached status (refreshed when old), create one, link one.
  router.get(
    "/items/:id/tickets",
    handle("list_tickets", (ctx, req) => listTickets(ctx, uuid.parse(req.params.id), { refresh: req.query.refresh !== "0" })),
  );
  router.post(
    "/items/:id/tickets",
    handle("create_ticket", (ctx, req) => {
      const body = z
        .object({ connection: z.string().max(200).optional(), title: z.string().max(250).optional(), description: z.string().max(8000).optional() })
        .parse(req.body ?? {});
      return createTicket(ctx, { item: uuid.parse(req.params.id), ...body });
    }),
  );
  router.post(
    "/items/:id/tickets/link",
    handle("link_ticket", (ctx, req) => {
      const body = z.object({ url: z.string().min(1).max(2000), connection: z.string().max(200).optional() }).parse(req.body);
      return linkTicket(ctx, { item: uuid.parse(req.params.id), ...body });
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

  const reviewQuery = z.object({
    scope: z.string().optional(),
    state: z.enum(["pending", "approved", "rejected"]).optional(),
    category: z.enum(Object.keys(REVIEW_CATEGORIES) as [keyof typeof REVIEW_CATEGORIES]).optional(),
    kind: z.enum(["article", "finding"]).optional(),
    type: z.string().max(40).optional(),
    author: z.enum(["people", "agents", "me"]).optional(),
    q: z.string().max(200).optional(),
    sort: z.enum(["oldest", "newest"]).optional(),
    mine: z.enum(["true", "false"]).optional(),
    assigned: z.enum(["true", "false", "to_review", "me", "none"]).optional(),
    facets: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  router.get(
    "/revisions",
    handle("list_revisions", async (ctx, req) => {
      const q = reviewQuery.parse(req.query);
      const filters = { ...q, mine: q.mine === "true", assigned: q.assigned === "true" ? ("me" as const) : q.assigned === "false" ? undefined : q.assigned };
      return { revisions: await listReviewQueue(ctx, filters), ...(q.facets === "true" ? { facets: await reviewFacets(ctx, filters) } : {}) };
    }),
  );
  router.get("/revisions/:id", handle("get_revision", (ctx, req) => getRevision(ctx, uuid.parse(req.params.id))));
  router.post(
    "/revisions/bulk-reject",
    handle("bulk_reject", (ctx, req) => {
      const body = z.object({ ids: z.array(uuid).min(1).max(100), reason: z.string().min(1).max(2000) }).parse(req.body);
      return bulkReject(ctx, body.ids, body.reason);
    }),
  );
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

  router.get("/system/settings", handle("get_system_settings", (ctx) => getSystemSettings(ctx)));
  router.patch(
    "/system/settings",
    handle("update_system_settings", (ctx, req) => updateSystemSettings(ctx, z.record(z.string(), z.unknown()).parse(req.body))),
  );
  router.post("/system/presets/:name", handle("apply_system_preset", (ctx, req) => applySystemPreset(ctx, z.enum(PRESET_NAMES).parse(req.params.name))));

  // ---- Saved views (each person's own) ----------------------------------------

  const viewFilters = z.record(z.string().max(40), z.string().max(300).nullable()).refine((f) => Object.keys(f).length <= 20, "at most 20 filters");
  router.get("/views", handle("list_views", (ctx, req) => listViews(ctx, z.enum(VIEW_AREA_NAMES).parse(req.query.area))));
  router.post(
    "/views",
    handle("create_view", (ctx, req) =>
      createView(ctx, z.object({ area: z.enum(VIEW_AREA_NAMES), name: z.string().max(200), filters: viewFilters, is_default: z.boolean().optional() }).parse(req.body)),
    ),
  );
  router.patch(
    "/views/:id",
    handle("update_view", (ctx, req) =>
      updateView(ctx, uuid.parse(req.params.id), z.object({ name: z.string().max(200).optional(), filters: viewFilters.optional(), is_default: z.boolean().optional() }).parse(req.body)),
    ),
  );
  router.delete("/views/:id", handle("delete_view", (ctx, req) => deleteView(ctx, uuid.parse(req.params.id))));
  // Manage views: renames, deletes and the default in one transaction.
  router.post(
    "/views/manage",
    handle("save_views", (ctx, req) => {
      const body = z
        .object({
          area: z.enum(VIEW_AREA_NAMES),
          rename: z.array(z.object({ id: uuid, name: z.string().max(200) })).max(100).optional(),
          delete: z.array(uuid).max(100).optional(),
          default: uuid.nullable().optional(),
        })
        .parse(req.body);
      const { area, ...changes } = body;
      return saveViews(ctx, area, changes);
    }),
  );

  // ---- Guide: what's switched on here (booleans only, never secrets) and every command ----------------
  router.get(
    "/guide",
    handle("guide", async (ctx) => {
      const sec = settings.security;
      const src = settings.sources;
      return {
        status: {
          auth_mode: settings.authMode,
          oauth: settings.authMode === "local" && !!settings.publicUrl,
          public_url: !!settings.publicUrl,
          semantic_search: !!embedder,
          email: settings.mailTransport === "smtp",
          slack_channel: !!settings.slackWebhookUrl,
          file_store: settings.s3 ? "s3" : "local",
          sources: !!src?.enabled,
          slack_source: !!src?.slackToken,
          notion_source: !!src?.notionToken,
          web_search_source: !!src?.tavilyKey,
          dependency_scan: !!sec?.enabled,
          advisory_feed: !!sec?.feed,
          nvd_key: !!sec?.nvdKey,
          github_token: !!sec?.githubToken,
          gitlab_token: !!sec?.gitlabToken,
        },
        admin: isAdmin(ctx),
        progress: await guideProgress(ctx),
        catalog: await mcpCatalog(ctx),
      };
    }),
  );

  // ---- Releases and the feature catalog (What's new) -------------------------------

  const versionParam = z.string().max(20);
  const releaseBody = z.object({
    version: z.string().max(20),
    title: z.string().max(400).optional(),
    summary: z.string().max(16_000).optional(),
    released_on: z.string().max(20).nullable().optional(),
  });
  const featureBody = z.object({
    title: z.string().max(400),
    area: z.enum(AREA_KEYS),
    kind: z.enum(KIND_KEYS).optional(),
    description: z.string().max(40_000).optional(),
    how_to: z.string().max(40_000).optional(),
    app_route: z.string().max(600).nullable().optional(),
    docs_url: z.string().max(1000).nullable().optional(),
    audience: z.enum(AUDIENCE_KEYS).optional(),
    tags: z.array(z.string().max(80)).max(40).optional(),
  });
  const vocabulary = () => ({ areas: FEATURE_AREAS, kinds: FEATURE_KINDS, audiences: AUDIENCES });
  router.get(
    "/releases",
    handle("list_releases", async (ctx, req) => ({
      ...(await listReleases(ctx, { features: z.enum(["true", "false"]).optional().parse(req.query.features) === "true" })),
      ...vocabulary(),
    })),
  );
  router.post("/releases", handle("create_release", (ctx, req) => createRelease(ctx, releaseBody.parse(req.body))));
  // A page view, not a change: "list_releases" is a read on the Audit log (hidden unless asked for).
  router.post("/releases/seen", handle("list_releases:seen", (ctx, req) => markReleasesSeen(ctx, z.object({ version: versionParam.optional() }).parse(req.body ?? {}).version)));
  router.get("/releases/:version", handle("get_release", async (ctx, req) => ({ ...(await getRelease(ctx, versionParam.parse(req.params.version))), can_manage: canManageReleases(ctx) })));
  router.patch("/releases/:version", handle("update_release", (ctx, req) => updateRelease(ctx, versionParam.parse(req.params.version), releaseBody.partial().parse(req.body))));
  router.delete("/releases/:version", handle("delete_release", (ctx, req) => deleteRelease(ctx, versionParam.parse(req.params.version))));
  router.post("/releases/:version/publish", handle("publish_release", (ctx, req) => publishRelease(ctx, versionParam.parse(req.params.version))));
  router.post("/releases/:version/unpublish", handle("unpublish_release", (ctx, req) => unpublishRelease(ctx, versionParam.parse(req.params.version))));
  router.post("/releases/:version/features", handle("create_feature", (ctx, req) => addFeature(ctx, versionParam.parse(req.params.version), featureBody.parse(req.body))));
  router.put(
    "/releases/:version/features/order",
    handle("reorder_features", (ctx, req) => reorderFeatures(ctx, versionParam.parse(req.params.version), z.object({ ids: z.array(uuid).max(500) }).parse(req.body).ids)),
  );
  router.get(
    "/features",
    handle("list_features", async (ctx, req) => {
      const q = z
        .object({
          area: z.enum(AREA_KEYS).optional(),
          kind: z.enum(KIND_KEYS).optional(),
          q: z.string().max(200).optional(),
          drafts: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      return { ...(await listFeatures(ctx, { area: q.area, kind: q.kind, query: q.q, drafts: q.drafts === "true" })), can_manage: canManageReleases(ctx), ...vocabulary() };
    }),
  );
  router.get("/features/:id", handle("get_feature", (ctx, req) => readFeature(ctx, uuid.parse(req.params.id))));
  router.patch(
    "/features/:id",
    handle("update_feature", (ctx, req) => updateFeature(ctx, uuid.parse(req.params.id), featureBody.partial().extend({ release: versionParam.optional() }).parse(req.body))),
  );
  router.delete("/features/:id", handle("delete_feature", (ctx, req) => deleteFeature(ctx, uuid.parse(req.params.id))));

  router.put(
    "/projects/:slug/parent",
    handle("set_project_parent", (ctx, req) =>
      setProjectParent(ctx, String(req.params.slug), z.object({ parent: z.string().nullable() }).parse(req.body).parent),
    ),
  );
  router.get("/projects/manage", handle("list_managed_projects", (ctx) => listManagedProjects(ctx)));
  router.post(
    "/projects/visibility",
    handle("set_projects_visibility", (ctx, req) => {
      const body = z.object({ projects: z.array(z.string()).min(1).max(200), visibility: z.enum(["team", "members"]) }).parse(req.body);
      return setProjectsVisibility(ctx, body.projects, body.visibility);
    }),
  );
  router.post(
    "/projects",
    handle("admin_create_project", (ctx, req) =>
      adminCreateProject(
        ctx,
        z
          .object({
            slug: z.string(),
            name: z.string().min(1).max(200),
            description: z.string().max(2000).optional(),
            components: z
              .array(z.object({ slug: z.string(), kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]), repo_url: repoUrl.optional() }))
              .max(30)
              .optional(),
            starter: z.boolean().optional(),
            visibility: z.enum(["team", "members"]).optional(),
            parent: z.string().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.post(
    "/projects/:slug/components",
    handle("admin_add_component", (ctx, req) =>
      adminAddComponent(
        ctx,
        String(req.params.slug),
        z
          .object({
            slug: z.string(),
            kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]),
            repo_url: repoUrl.optional(),
            description: z.string().max(500).optional(),
          })
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
  // Someone's direct roles in a project: `roles` replaces them all ([] removes them), `add` / `remove` change only those;
  // `role` (one role, or null to remove) is the older form. `email` may also be the identifier shown for an account without one.
  const roleChangeBody = { roles: roleList.optional(), add: roleList.optional(), remove: roleList.optional(), role: z.string().max(100).nullable().optional() };
  router.put(
    "/scopes/:slug/members",
    handle("admin_set_member", async (ctx, req) => {
      const body = z.object({ email: z.string().max(320), ...roleChangeBody }).parse(req.body);
      const res = await changeMemberRoles(ctx, String(req.params.slug), body.email, roleChangeFrom(body));
      return body.roles === undefined && body.role !== undefined ? { ...res, role: body.role } : res;
    }),
  );

  // ---- Project access, teams, repositories, moving ---------------------------

  router.get("/scopes/:slug/access", handle("list_access", (ctx, req) => listAccess(ctx, String(req.params.slug))));
  router.put(
    "/scopes/:slug/teams",
    handle("set_team_role", async (ctx, req) => {
      const body = z.object({ team: z.string().max(100), ...roleChangeBody }).parse(req.body);
      const res = await changeTeamRoles(ctx, String(req.params.slug), body.team, roleChangeFrom(body));
      return body.roles === undefined && body.role !== undefined ? { ...res, role: body.role } : res;
    }),
  );

  // ---- Roles ----------------------------------------------------------------

  // `:key` is a role's key or name ("Contributor"); kind accepts "organisation" / "organization" for org roles.
  router.get("/roles", handle("list_roles", (ctx) => rolesCatalog(ctx)));
  router.get("/roles/:key/holders", handle("role_holders", (ctx, req) => roleHolders(ctx, String(req.params.key))));
  const roleBody = z.object({
    key: z.string().max(40).optional(),
    kind: roleKind,
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string().max(60)).max(30),
  });
  router.post("/roles", handle("create_role", (ctx, req) => createRole(ctx, roleBody.parse(req.body))));
  router.patch(
    "/roles/:key",
    handle("update_role", (ctx, req) =>
      updateRole(
        ctx,
        String(req.params.key),
        z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(500).optional(), permissions: z.array(z.string().max(60)).max(30).optional() }).parse(req.body),
      ),
    ),
  );
  router.delete("/roles/:key", handle("delete_role", (ctx, req) => deleteRole(ctx, String(req.params.key))));
  router.patch(
    "/projects/:slug/components/:component",
    handle("update_component", (ctx, req) =>
      updateComponent(
        ctx,
        String(req.params.slug),
        String(req.params.component),
        z
          .object({
            slug: z.string().optional(),
            kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]).optional(),
            repo_url: repoUrl.nullable().optional(),
            description: z.string().max(500).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.delete("/projects/:slug/components/:component", handle("remove_component", (ctx, req) => removeComponent(ctx, String(req.params.slug), String(req.params.component))));
  // People to pick when adding someone to a project or team (names and emails of active accounts).
  router.get(
    "/people",
    handle("find_people", async (ctx, req) => ({
      people: await findPeople(ctx, typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "", Number(req.query.limit) || 20),
    })),
  );
  router.get("/teams", handle("list_teams", async (ctx) => ({ teams: await listTeams(ctx) })));
  router.post(
    "/teams",
    handle("create_team", (ctx, req) => createTeam(ctx, z.object({ slug: z.string(), name: z.string().max(200), description: z.string().max(1000).optional() }).parse(req.body))),
  );
  router.get("/teams/:slug", handle("get_team", (ctx, req) => getTeam(ctx, String(req.params.slug))));
  router.patch(
    "/teams/:slug",
    handle("update_team", (ctx, req) => updateTeam(ctx, String(req.params.slug), z.object({ name: z.string().max(200).optional(), description: z.string().max(1000).optional() }).parse(req.body))),
  );
  router.delete("/teams/:slug", handle("delete_team", (ctx, req) => deleteTeam(ctx, String(req.params.slug))));
  router.put(
    "/teams/:slug/members",
    handle("set_team_member", (ctx, req) => {
      // An omitted role keeps their current one (a new member joins as a member).
      const body = z.object({ email: z.string().max(320), member: z.boolean(), role: z.enum(["member", "lead"]).optional() }).parse(req.body);
      return setTeamMember(ctx, String(req.params.slug), body.email, body.member, body.role);
    }),
  );
  router.post(
    "/teams/:slug/projects",
    handle("create_team_project", (ctx, req) =>
      createTeamProject(
        ctx,
        String(req.params.slug),
        z
          .object({
            slug: z.string(),
            name: z.string().min(1).max(200),
            description: z.string().max(2000).optional(),
            components: z
              .array(z.object({ slug: z.string(), kind: z.enum(["backend", "frontend", "mobile", "data", "infra", "other"]), repo_url: repoUrl.optional() }))
              .max(30)
              .optional(),
            starter: z.boolean().optional(),
            visibility: z.enum(["team", "members"]).optional(),
            team_roles: roleList.optional(),
            // Deprecated: one role; use team_roles.
            team_role: z.string().max(100).optional(),
            owners: z.array(z.string().max(320)).max(50).optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.post(
    "/move",
    handle("move_items", (ctx, req) =>
      moveItems(
        ctx,
        z
          .object({
            from: z.string(),
            to: z.string(),
            folder: z.string().max(500).optional(),
            ids: z.array(uuid).max(500).optional(),
            strip_folder: z.boolean().optional(),
            repo_folders: z.array(z.string().max(200)).max(50).optional(),
            into_folder: z.string().max(500).optional(),
            component: z.string().max(100).optional(),
            dry_run: z.boolean().optional(),
            new_project: z.boolean().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  router.get(
    "/repos/resolve",
    handle("resolve_repo", async (ctx, req) => {
      const found = await resolveRepo(ctx.db, z.string().min(3).max(500).parse(req.query.url));
      return { match: found };
    }),
  );

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  return router;
}
