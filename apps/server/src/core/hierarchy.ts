import { withTx, type Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, ValidationError, type RequestContext } from "./context.js";
import { assertCanManage, can, canManage, canReadScope, isAdmin, readableScopes } from "./permissions.js";
import { keepingProjectAdmins } from "./project-admins.js";
import { assertMayGrant, listRoles } from "./roles.js";
import { getReadableScope, getScopeBySlug, scopeNotFound, type Scope } from "./scopes.js";

/**
 * Sub-projects: a project can sit under another, to any depth up to MAX_DEPTH levels. Roles flow down (the
 * scope_roles view): whoever holds a role in a project holds it in every project below it, and a sub-project can add
 * people of its own. Search and project context inside a project also cover the projects above and below it.
 */

export const MAX_DEPTH = 6;

/** Projects above this one, nearest first. */
export async function ancestorsOf(db: Queryable, scopeId: string): Promise<{ id: string; slug: string; name: string }[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE up (id, depth) AS (
       SELECT parent_id, 1 FROM scopes WHERE id = $1 AND parent_id IS NOT NULL
       UNION ALL SELECT s.parent_id, u.depth + 1 FROM up u JOIN scopes s ON s.id = u.id WHERE s.parent_id IS NOT NULL AND u.depth < $2)
     SELECT s.id, s.slug, s.name FROM up JOIN scopes s ON s.id = up.id ORDER BY up.depth`,
    [scopeId, MAX_DEPTH],
  );
  return rows;
}

/** Projects below this one (all levels), with their depth below it. */
export async function descendantsOf(db: Queryable, scopeId: string): Promise<{ id: string; slug: string; name: string; parent_id: string; depth: number; status: string }[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE down (id, depth) AS (
       SELECT id, 1 FROM scopes WHERE parent_id = $1
       UNION ALL SELECT s.id, d.depth + 1 FROM down d JOIN scopes s ON s.parent_id = d.id WHERE d.depth < $2)
     SELECT s.id, s.slug, s.name, s.parent_id, d.depth, s.status FROM down d JOIN scopes s ON s.id = d.id ORDER BY d.depth, s.name`,
    [scopeId, MAX_DEPTH],
  );
  return rows;
}

/** Projects above and below one, that the caller can read (for search and context across a product's projects). */
export async function relatedProjectIds(ctx: RequestContext, scopeId: string, opts: { up?: boolean; down?: boolean } = { up: true, down: true }) {
  const ids = [
    ...(opts.up ? (await ancestorsOf(ctx.db, scopeId)).map((a) => a.id) : []),
    ...(opts.down ? (await descendantsOf(ctx.db, scopeId)).filter((d) => d.status === "active").map((d) => d.id) : []),
  ];
  const readable = await readableScopes(ctx);
  return readable === null ? ids : ids.filter((id) => readable.includes(id));
}

/**
 * The parent a new project may go under: an active project the caller manages (or anyone, with manage_all_projects).
 * A project the caller can't read answers exactly like one that doesn't exist, so neither its name nor its slug leaks.
 */
export async function checkNewParent(ctx: RequestContext, parentSlug: string, child?: Scope): Promise<Scope> {
  const parent = await getScopeBySlug(ctx.db, parentSlug);
  if (!(await canReadScope(ctx, parent.id))) throw scopeNotFound(parentSlug);
  if (parent.kind !== "project") throw new ValidationError("only projects can have sub-projects");
  if (parent.status !== "active") throw new ValidationError(`${parentSlug} is ${parent.status}; choose an active project`);
  if (!(await canManage(ctx, parent))) throw new ValidationError(`you can only put projects under ones you manage, and you don't manage ${parent.name}`);
  const depth = (await ancestorsOf(ctx.db, parent.id)).length + 1; // levels down to the parent, counting it
  let height = 1;
  if (child) {
    if (child.id === parent.id) throw new ValidationError("a project can't be its own parent");
    const below = await descendantsOf(ctx.db, child.id);
    if (below.some((d) => d.id === parent.id)) throw new ValidationError(`${parent.name} is inside ${child.name}; a project can't go under its own sub-project`);
    height = 1 + Math.max(0, ...below.map((d) => d.depth));
  }
  if (depth + height > MAX_DEPTH) throw new ValidationError(`projects nest at most ${MAX_DEPTH} levels deep`);
  return parent;
}

/**
 * Moves a project under another (or to the top with null). Moving changes who has access to it and to everything
 * under it (roles flow down), so it needs Manage settings and Manage access on the project, Manage settings on the new
 * parent and on the old one when leaving it, and nobody may gain or lose a role there that the mover couldn't give
 * (Administrators and Manage every project excepted). It can't leave a project without a Project admin.
 */
export async function setProjectParent(ctx: RequestContext, slug: string, parentSlug: string | null) {
  const scope = await getReadableScope(ctx, slug);
  if (scope.kind !== "project") throw new ValidationError("only projects can be sub-projects");
  await assertCanManage(ctx, scope);
  await assertCanManage(ctx, scope, "manage_members");
  const current = (await ctx.db.query<{ parent_id: string | null }>("SELECT parent_id FROM scopes WHERE id = $1", [scope.id])).rows[0]!.parent_id;
  const parent = parentSlug ? await checkNewParent(ctx, parentSlug, scope) : null;
  if ((parent?.id ?? null) === current) return { project: slug, parent: parentSlug, changed: false };
  const everywhere = isAdmin(ctx) || can(ctx, "manage_all_projects");
  if (current && !everywhere) {
    const old = (await ctx.db.query<Scope>("SELECT id, kind, slug, name FROM scopes WHERE id = $1", [current])).rows[0]!;
    if (!(await canManage(ctx, old))) {
      const named = (await canReadScope(ctx, old.id)) ? old.name : "a project you can't see";
      throw new ForbiddenError(`only people with Manage settings in ${named} (its Project admins) can take a project out of it`);
    }
  }
  if (!everywhere) {
    // Roles that start or stop applying to someone in the project: what the new parent's people hold there, against the old's.
    const { rows } = await ctx.db.query<{ role: string }>(
      `SELECT DISTINCT role FROM (
         (SELECT user_id, role FROM scope_roles WHERE scope_id = $1 EXCEPT SELECT user_id, role FROM scope_roles WHERE scope_id = $2)
         UNION ALL
         (SELECT user_id, role FROM scope_roles WHERE scope_id = $2 EXCEPT SELECT user_id, role FROM scope_roles WHERE scope_id = $1)) x`,
      [parent?.id ?? null, current],
    );
    const changing = new Set(rows.map((r) => r.role));
    await assertMayGrant(
      ctx,
      (await listRoles(ctx.db, "project")).filter((r) => changing.has(r.key)),
      scope.id,
      (r, labels) => `you can't move ${scope.name} there: people would gain or lose ${r.name} in it, which includes permissions you don't have there (${labels.join(", ")})`,
    );
  }
  const readable = await readableScopes(ctx);
  await withTx(ctx.db, (tx) =>
    keepingProjectAdmins(tx, [scope.id], () => tx.query("UPDATE scopes SET parent_id = $2 WHERE id = $1", [scope.id, parent?.id ?? null]), {
      refuse: !can(ctx, "manage_all_projects"),
      readable,
    }),
  );
  await audit(ctx.db, ctx.actor.id, "set_project_parent", scope.id);
  return { project: slug, parent: parent?.slug ?? null, changed: true };
}

/** Where a project sits: the projects above it (top first) and its direct sub-projects the caller can read. */
export async function projectHierarchy(ctx: RequestContext, scopeId: string) {
  const readable = await readableScopes(ctx);
  const canRead = (id: string) => readable === null || readable.includes(id);
  const path = (await ancestorsOf(ctx.db, scopeId)).reverse().map((a) => ({ slug: a.slug, name: a.name, readable: canRead(a.id) }));
  const below = await descendantsOf(ctx.db, scopeId);
  const children = below
    .filter((d) => d.depth === 1 && d.status === "active" && canRead(d.id))
    .map((d) => ({ slug: d.slug, name: d.name, sub_projects: below.filter((x) => x.parent_id === d.id && x.status === "active").length }));
  return { path, sub_projects: children };
}
