import { repoKey } from "./bootstrap.js";
import type { Queryable } from "../db/pool.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { canReadScope, readableScopes } from "./permissions.js";
import { relatedProjectIds } from "./hierarchy.js";

export interface Scope {
  id: string;
  kind: "team" | "project" | "library" | "personal";
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
  /** What a project git connection last read about the repository (listComponents only). */
  repo_info?: Record<string, unknown> | null;
  repo_synced_at?: string | null;
}

export async function getScopeBySlug(db: Queryable, slug: string): Promise<Scope> {
  const { rows } = await db.query<Scope>("SELECT id, kind, slug, name, description, status, visibility FROM scopes WHERE slug = $1", [slug]);
  if (!rows[0]) throw scopeNotFound(slug);
  return rows[0];
}

/** The same answer for a scope that doesn't exist and one the caller can't read, with where to look. */
export const scopeNotFound = (slug: string) => new NotFoundError(`scope '${slug}'`, `scope '${slug}' not found; list_projects shows the projects you can see`);

/** What tools and the API accept as a scope name for the caller's own personal space. */
export const PERSONAL_ALIAS = "me";

/**
 * The caller's personal space: their own notes and context, readable only by them and searched from every project.
 * Made on first use. Only people have one (service accounts have nobody to approve their writes).
 */
export async function personalScope(ctx: RequestContext, create = true): Promise<Scope | undefined> {
  const select = "SELECT id, kind, slug, name, description, status, visibility FROM scopes WHERE kind = 'personal' AND owner_id = $1";
  const found = (await ctx.db.query<Scope>(select, [ctx.actor.id])).rows[0];
  if (found || !create) return found;
  if (ctx.actor.kind !== "human") throw new ValidationError("only people have a personal space; service accounts write to projects");
  await ctx.db.query(
    `WITH s AS (
       INSERT INTO scopes (kind, slug, name, description, visibility, owner_id)
       VALUES ('personal', 'personal-' || $1::text, 'Personal', 'Your own notes and context. Only you can see them; Claude finds them from every project.', 'members', $1::uuid)
       ON CONFLICT DO NOTHING RETURNING id)
     INSERT INTO scope_members (scope_id, user_id, role) SELECT id, $1::uuid, 'owner' FROM s`,
    [ctx.actor.id],
  );
  return (await ctx.db.query<Scope>(select, [ctx.actor.id])).rows[0]!;
}

/** A scope by slug for managing it, where "me" is the caller's personal space (permission checks are the caller's job). */
export async function getScopeFor(ctx: RequestContext, slug: string): Promise<Scope> {
  return slug === PERSONAL_ALIAS ? (await personalScope(ctx))! : getScopeBySlug(ctx.db, slug);
}

/** A scope the caller may read (members-only projects and other people's personal spaces look missing). "me" is the caller's personal space. */
export async function getReadableScope(ctx: RequestContext, slug: string): Promise<Scope> {
  if (slug === PERSONAL_ALIAS) return (await personalScope(ctx))!;
  const scope = await getScopeBySlug(ctx.db, slug);
  // A project in the trash is gone for everyday use; the trash restores it by slug.
  if (scope.status === "deleted") throw new NotFoundError(`scope '${slug}' (it's in the trash)`);
  if (!(await canReadScope(ctx, scope.id))) throw scopeNotFound(slug);
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
    "SELECT id, scope_id, slug, kind, repo_url, description, repo_info, repo_synced_at FROM components WHERE scope_id = $1 ORDER BY slug",
    [projectId],
  );
  return rows;
}

/** The project and component a repository belongs to, from its git remote URL. */
export async function resolveRepo(db: Queryable, url: string): Promise<{ project: string; component: string } | null> {
  const key = repoKey(url);
  if (!key) return null;
  const { rows } = await db.query<{ project: string; component: string }>(
    "SELECT s.slug AS project, c.slug AS component FROM components c JOIN scopes s ON s.id = c.scope_id WHERE c.repo_key = $1 AND s.status = 'active' LIMIT 1",
    [key],
  );
  return rows[0] ?? null;
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
    project_admin_list: { email: string; name: string | null }[];
  }>(
    `SELECT s.slug, s.name, s.description, s.status, (SELECT p.slug FROM scopes p WHERE p.id = s.parent_id) AS parent,
            coalesce((SELECT json_agg(json_build_object('slug', c.slug, 'kind', c.kind, 'repo_url', c.repo_url) ORDER BY c.slug)
                        FROM components c WHERE c.scope_id = s.id), '[]') AS components,
            coalesce((SELECT array_agg(coalesce(u.email, u.subject) ORDER BY u.email)
                        FROM scope_permissions m JOIN users u ON u.id = m.user_id
                       WHERE m.scope_id = s.id AND m.permission = 'manage_members' AND u.kind = 'human' AND u.disabled_at IS NULL), '{}') AS owners,
            coalesce((SELECT json_agg(json_build_object('email', o.email, 'name', o.name) ORDER BY o.email)
                        FROM (SELECT DISTINCT coalesce(u.email, u.subject) AS email, u.display_name AS name FROM scope_permissions m JOIN users u ON u.id = m.user_id
                               WHERE m.scope_id = s.id AND m.permission = 'manage_members' AND u.kind = 'human' AND u.disabled_at IS NULL) o), '[]') AS project_admin_list
       FROM scopes s
      WHERE s.kind = 'project' AND ($1 OR s.status = 'active') AND ($2::uuid[] IS NULL OR s.id = ANY($2))
      ORDER BY s.name`,
    [includeArchived, readable],
  );
  // project_admins: the people who can manage access there (`owners` is the older name for the same list);
  // project_admin_list: the same people with their names.
  return rows.map((r) => ({ ...r, project_admins: r.owners }));
}

export type ScopeFilter =
  | { mode: "all" }
  | { mode: "ids"; scopeIds: string[]; currentProjectId?: string };

/**
 * Turns a search `scope` argument into a filter.
 * Default: the current project (if any) + Team + Library + the caller's personal space; "all": everything they can read;
 * otherwise one scope slug ("me" for the personal space).
 */
export async function resolveScopeFilter(ctx: RequestContext, scope?: string, project?: string): Promise<ScopeFilter> {
  if (scope === "all") {
    const readable = await readableScopes(ctx);
    return readable === null ? { mode: "all" } : { mode: "ids", scopeIds: readable };
  }
  if (scope && scope !== "default") {
    const s = await getReadableScope(ctx, scope);
    // A project includes its sub-projects.
    const below = s.kind === "project" ? await relatedProjectIds(ctx, s.id, { down: true }) : [];
    return { mode: "ids", scopeIds: [s.id, ...below], currentProjectId: s.kind === "project" ? s.id : undefined };
  }
  const current = await resolveProject(ctx, project);
  const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE kind IN ('team', 'library')");
  const ids = rows.map((r) => r.id);
  // The current project, and the projects above and below it (the rest of the product).
  if (current) ids.push(current.id, ...(await relatedProjectIds(ctx, current.id)));
  const personal = await personalScope(ctx, false);
  if (personal) ids.push(personal.id);
  return { mode: "ids", scopeIds: ids, currentProjectId: current?.id };
}
