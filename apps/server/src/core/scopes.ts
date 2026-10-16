import type { Queryable } from "../db/pool.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { assertCanRead, readableScopes } from "./permissions.js";

export interface Scope {
  id: string;
  kind: "team" | "project" | "library";
  slug: string;
  name: string;
  description: string;
  status: string;
  visibility: "team" | "members";
}

export interface Component {
  id: string;
  scope_id: string;
  slug: string;
  kind: string;
  repo_url: string | null;
  description: string;
}

export async function getScopeBySlug(db: Queryable, slug: string): Promise<Scope> {
  const { rows } = await db.query<Scope>("SELECT id, kind, slug, name, description, status, visibility FROM scopes WHERE slug = $1", [slug]);
  if (!rows[0]) throw new NotFoundError(`scope '${slug}'`);
  return rows[0];
}

/** The project a call is about: explicit argument first, then the client's header. */
/** A scope the caller may read (members-only projects look missing to non-members). */
export async function getReadableScope(ctx: RequestContext, slug: string): Promise<Scope> {
  const scope = await getScopeBySlug(ctx.db, slug);
  await assertCanRead(ctx, scope.id, `scope '${slug}'`);
  return scope;
}

export async function resolveProject(ctx: RequestContext, explicit?: string): Promise<Scope | undefined> {
  const slug = explicit ?? ctx.project;
  if (!slug) return undefined;
  const scope = await getReadableScope(ctx, slug);
  if (scope.kind !== "project") throw new ValidationError(`'${slug}' is a ${scope.kind} scope, not a project`);
  return scope;
}

export async function getComponent(db: Queryable, projectId: string, slug: string): Promise<Component> {
  const { rows } = await db.query<Component>(
    "SELECT id, scope_id, slug, kind, repo_url, description FROM components WHERE scope_id = $1 AND slug = $2",
    [projectId, slug],
  );
  if (!rows[0]) throw new NotFoundError(`component '${slug}'`);
  return rows[0];
}

export async function listComponents(db: Queryable, projectId: string): Promise<Component[]> {
  const { rows } = await db.query<Component>(
    "SELECT id, scope_id, slug, kind, repo_url, description FROM components WHERE scope_id = $1 ORDER BY slug",
    [projectId],
  );
  return rows;
}

export async function listProjects(ctx: RequestContext, includeArchived = false) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query<{
    slug: string;
    name: string;
    description: string;
    status: string;
    components: { slug: string; kind: string }[];
    owners: string[];
  }>(
    `SELECT s.slug, s.name, s.description, s.status,
            coalesce((SELECT json_agg(json_build_object('slug', c.slug, 'kind', c.kind) ORDER BY c.slug)
                        FROM components c WHERE c.scope_id = s.id), '[]') AS components,
            coalesce((SELECT array_agg(coalesce(u.email, u.subject) ORDER BY u.email)
                        FROM scope_members m JOIN users u ON u.id = m.user_id
                       WHERE m.scope_id = s.id AND m.role = 'owner'), '{}') AS owners
       FROM scopes s
      WHERE s.kind = 'project' AND ($1 OR s.status = 'active') AND ($2::uuid[] IS NULL OR s.id = ANY($2))
      ORDER BY s.name`,
    [includeArchived, readable],
  );
  return rows;
}

export type ScopeFilter =
  | { mode: "all" }
  | { mode: "ids"; scopeIds: string[]; currentProjectId?: string };

/**
 * Turns a search `scope` argument into a filter.
 * Default: the current project (if any) + Team + Library; "all": everything; otherwise one scope slug.
 */
export async function resolveScopeFilter(ctx: RequestContext, scope?: string, project?: string): Promise<ScopeFilter> {
  if (scope === "all") {
    const readable = await readableScopes(ctx);
    return readable === null ? { mode: "all" } : { mode: "ids", scopeIds: readable };
  }
  if (scope && scope !== "default") {
    const s = await getReadableScope(ctx, scope);
    return { mode: "ids", scopeIds: [s.id], currentProjectId: s.kind === "project" ? s.id : undefined };
  }
  const current = await resolveProject(ctx, project);
  const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE kind IN ('team', 'library')");
  const ids = rows.map((r) => r.id);
  if (current) ids.push(current.id);
  return { mode: "ids", scopeIds: ids, currentProjectId: current?.id };
}
