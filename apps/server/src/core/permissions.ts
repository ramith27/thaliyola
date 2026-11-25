import type { Queryable } from "../db/pool.js";
import { ForbiddenError, NotFoundError, type RequestContext } from "./context.js";
import { can, isAdmin, PERMISSION_LABELS, permissionsIn, PROJECT_KEYS, roleListText, type ProjectPermission } from "./roles.js";

/**
 * Permissions come from roles (see roles.ts): someone's permissions in a scope are those of every project role they
 * hold there, directly, through a team or from a project above; organisation roles (Administrator included) add
 * permissions across all of Thaliyola.
 * Reading: team-visible scopes are open to everyone signed in; members-only projects to people with a role there
 * (and Read every project). Proposing, verifying and commenting: open to everyone in a team-visible scope until
 * someone there holds that permission; then, and always in members-only projects, only those who hold it.
 * Approving needs Review; deleting and restoring entries, Moderate; access, Manage access; settings, Manage settings.
 * Manage every project (Administrators) acts as Project admin everywhere. Service accounts never approve or publish.
 * Personal spaces belong to one person: nobody else reads or writes them, Administrators included, and they can't be
 * shared. effectiveFrom states all of this once, so what the UI shows matches what the server allows.
 */

export { can, isAdmin } from "./roles.js";

/** The caller's most powerful project role in a scope (for display), from all their direct and team roles. */
export async function roleIn(db: Queryable, scopeId: string, userId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ role: string }>(
    "SELECT r.role FROM scope_roles r JOIN roles ro ON ro.key = r.role WHERE r.scope_id = $1 AND r.user_id = $2 ORDER BY ro.position LIMIT 1",
    [scopeId, userId],
  );
  return rows[0]?.role;
}

/** Every project role the caller holds in a scope, most powerful first. */
export async function rolesIn(db: Queryable, scopeId: string, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    "SELECT DISTINCT r.role, ro.position FROM scope_roles r JOIN roles ro ON ro.key = r.role WHERE r.scope_id = $1 AND r.user_id = $2 ORDER BY ro.position",
    [scopeId, userId],
  );
  return rows.map((r) => r.role);
}

const readableCache = new WeakMap<RequestContext, Promise<string[] | null>>();
const restricted = new WeakMap<RequestContext, string[]>();

/**
 * Exactly these scopes are readable for this context, whoever the actor is: for replies posted where other people
 * see them (a pull-request thread reads the repository's project, Team and Library only).
 */
export function restrictReading(ctx: RequestContext, scopeIds: string[]) {
  restricted.set(ctx, [...scopeIds]);
}

/**
 * Scopes the caller may read: every team-visible scope plus members-only
 * projects they belong to (and their own personal space). Admins read every
 * scope except other people's personal spaces.
 */
export function readableScopes(ctx: RequestContext): Promise<string[] | null> {
  const only = restricted.get(ctx);
  if (only) return Promise.resolve(only);
  let cached = readableCache.get(ctx);
  if (!cached) {
    cached = can(ctx, "read_all_projects") || can(ctx, "manage_all_projects")
      ? ctx.db
          .query<{ id: string }>("SELECT id FROM scopes WHERE kind <> 'personal' OR owner_id = $1", [ctx.actor.id])
          .then((r) => r.rows.map((x) => x.id))
      : ctx.db
          .query<{ id: string }>(
            `SELECT id FROM scopes WHERE visibility = 'team'
              OR id IN (SELECT scope_id FROM scope_roles WHERE user_id = $1)`,
            [ctx.actor.id],
          )
          .then((r) => r.rows.map((x) => x.id));
    readableCache.set(ctx, cached);
  }
  return cached;
}

export async function canReadScope(ctx: RequestContext, scopeId: string): Promise<boolean> {
  const only = restricted.get(ctx);
  if (only) return only.includes(scopeId);
  const readable = await readableScopes(ctx);
  if (readable === null || readable.includes(scopeId)) return true;
  // Not in the list read earlier for this request: the scope (or the caller's role in it) may be newer than the list.
  readableCache.delete(ctx);
  const fresh = await readableScopes(ctx);
  return fresh === null || fresh.includes(scopeId);
}

/** Unreadable things are reported as missing, so their existence doesn't leak. */
export async function assertCanRead(ctx: RequestContext, scopeId: string, what: string): Promise<void> {
  if (!(await canReadScope(ctx, scopeId))) throw new NotFoundError(what);
}

/** The owner of a personal space (undefined for every other scope). */
async function personalOwner(db: Queryable, scopeId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ owner_id: string }>("SELECT owner_id FROM scopes WHERE id = $1 AND kind = 'personal'", [scopeId]);
  return rows[0]?.owner_id;
}

/** Only its owner works in a personal space; to anyone else it doesn't exist. */
async function assertOwnPersonal(ctx: RequestContext, scopeId: string): Promise<boolean> {
  const owner = await personalOwner(ctx.db, scopeId);
  if (owner === undefined) return false;
  if (owner !== ctx.actor.id) throw new NotFoundError("scope");
  return true;
}

/** Whether the caller holds a project permission in a scope (their own personal space: everything). */
export async function hasPermission(ctx: RequestContext, scopeId: string, permission: ProjectPermission): Promise<boolean> {
  if (await assertOwnPersonal(ctx, scopeId)) return true;
  if (can(ctx, "manage_all_projects")) return true;
  return (await permissionsIn(ctx.db, scopeId, ctx.actor.id)).has(permission);
}

/** "none of your roles here include Review, so you can't approve here (Reviewer, Moderator and Project admin do)". */
async function missingPermission(ctx: RequestContext, permission: ProjectPermission, what: string): Promise<ForbiddenError> {
  const list = await roleListText(ctx.db, permission);
  const holders = list ? ` (${list} ${list.includes(" and ") ? "do" : "does"})` : "";
  return new ForbiddenError(`none of your roles here include ${PERMISSION_LABELS[permission]}, so you can't ${what} here${holders}`);
}

/**
 * Contributing permissions (propose, verify, comment): needed in members-only projects; in team-visible scopes
 * only once someone there holds the permission (until then anyone may).
 */
async function assertContributes(ctx: RequestContext, scopeId: string, permission: "propose" | "verify" | "comment", what: string) {
  if (await hasPermission(ctx, scopeId, permission)) return;
  const { rows } = await ctx.db.query<{ visibility: string }>("SELECT visibility FROM scopes WHERE id = $1", [scopeId]);
  if (rows[0]?.visibility !== "members") {
    const restricted = await ctx.db.query("SELECT 1 FROM scope_permissions WHERE scope_id = $1 AND permission = $2 LIMIT 1", [scopeId, permission]);
    if (!restricted.rowCount) return;
  }
  throw await missingPermission(ctx, permission, what);
}

export async function assertCanPropose(ctx: RequestContext, scopeId: string): Promise<void> {
  await assertContributes(ctx, scopeId, "propose", "propose");
}

export async function assertCanVerify(ctx: RequestContext, scopeId: string): Promise<void> {
  await assertContributes(ctx, scopeId, "verify", "confirm or flag entries");
}

export async function assertCanComment(ctx: RequestContext, scopeId: string): Promise<void> {
  await assertContributes(ctx, scopeId, "comment", "comment");
}

export async function assertCanApprove(ctx: RequestContext, scopeId: string): Promise<void> {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("service identities cannot approve changes");
  if (!(await hasPermission(ctx, scopeId, "review"))) throw await missingPermission(ctx, "review", "approve");
}

/** Deleting, restoring and re-filing entries: Moderate (Moderators, Project admins, Administrators). */
export async function assertCanModerate(ctx: RequestContext, scopeId: string): Promise<void> {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("service identities cannot delete or restore");
  if (!(await hasPermission(ctx, scopeId, "moderate"))) throw await missingPermission(ctx, "moderate", "delete or restore entries");
}

export async function canModerate(ctx: RequestContext, scopeId: string): Promise<boolean> {
  return ctx.actor.kind === "human" && (await hasPermission(ctx, scopeId, "moderate"));
}

/**
 * Managing a scope: its settings (name, visibility, repositories, sources) or who has access (people and teams).
 * Projects: holders of that permission (Project admins) and Manage every project; team and library: Administrators only.
 */
export async function assertCanManage(
  ctx: RequestContext,
  scope: { id: string; kind: string },
  permission: "manage_settings" | "manage_members" = "manage_settings",
): Promise<void> {
  if (scope.kind === "personal") throw new ForbiddenError("a personal space belongs to one person and can't be shared or changed");
  if (can(ctx, "manage_all_projects")) return;
  if (ctx.actor.kind === "human" && scope.kind === "project" && (await permissionsIn(ctx.db, scope.id, ctx.actor.id)).has(permission)) return;
  throw new ForbiddenError(
    scope.kind === "project"
      ? permission === "manage_members"
        ? "you can't change who has access to this project: that needs Manage access, which its Project admins have (or an Administrator)"
        : "you can't change this project's settings: that needs Manage settings, which its Project admins have (or an Administrator)"
      : "only admins can change this scope's settings",
  );
}

export async function canManage(
  ctx: RequestContext,
  scope: { id: string; kind: string },
  permission: "manage_settings" | "manage_members" = "manage_settings",
): Promise<boolean> {
  try {
    await assertCanManage(ctx, scope, permission);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

export function assertAdmin(ctx: RequestContext): void {
  if (!isAdmin(ctx)) throw new ForbiddenError("admin only");
}

/**
 * Whether the caller's own write publishes at once: a role here with "publish" (Project admins by default) while
 * DIRECT_PUBLISH is on, and not when they asked for review. Admins' blanket rights don't count: being an admin
 * doesn't make every write skip review, holding the role in that project does. Service identities never publish.
 */
export async function canPublishOwn(ctx: RequestContext, scopeId: string): Promise<boolean> {
  if (ctx.actor.kind !== "human" || ctx.requestReview || !ctx.settings.directPublish) return false;
  return (await permissionsIn(ctx.db, scopeId, ctx.actor.id)).has("publish");
}

/** What lets everyone signed in into a scope: reading (team-visible), and contributing until someone there holds it. */
export interface OpenToEveryone {
  read: boolean;
  comment: boolean;
  propose: boolean;
  verify: boolean;
}

/** Everyone signed in reads a team-visible scope, and comments, proposes and verifies there until someone holds that permission. */
export async function openToEveryone(db: Queryable, scope: { id: string; kind: string; visibility: string }): Promise<OpenToEveryone> {
  const read = scope.visibility === "team" && scope.kind !== "personal";
  if (!read) return { read, comment: false, propose: false, verify: false };
  const { rows } = await db.query<{ permission: string }>(
    "SELECT permission FROM scope_permissions WHERE scope_id = $1 AND permission IN ('comment', 'propose', 'verify') GROUP BY permission",
    [scope.id],
  );
  const held = new Set(rows.map((r) => r.permission));
  return { read, comment: !held.has("comment"), propose: !held.has("propose"), verify: !held.has("verify") };
}

export interface EffectiveInputs {
  kind: string;
  /** The caller's own personal space. */
  ownPersonal: boolean;
  readable: boolean;
  /** The caller's permissions there from their roles (scope_permissions). */
  rolePermissions: Iterable<string>;
  /** Team-visible, not personal, and nobody there holds it. */
  open: { comment: boolean; propose: boolean; verify: boolean };
}

/**
 * What the caller can actually do in a scope, with the same rules the server enforces: hasPermission and the open
 * contribution rule (comment, propose, verify), assertCanApprove / assertCanModerate (people only), canPublishOwn and
 * the personal-space rule (publish: never through blanket rights), canSeeVulns (security) and assertCanManage.
 * Pure: uses only the inputs, ctx.actor.kind, can() and ctx.settings.directPublish.
 */
export function effectiveFrom(ctx: RequestContext, i: EffectiveInputs): ProjectPermission[] {
  if (!i.readable || (i.kind === "personal" && !i.ownPersonal)) return [];
  const role = new Set(i.rolePermissions);
  const everywhere = can(ctx, "manage_all_projects");
  const person = ctx.actor.kind === "human";
  const has = (p: ProjectPermission) => i.ownPersonal || everywhere || role.has(p);
  return PROJECT_KEYS.filter((p) => {
    switch (p) {
      case "read":
        return true;
      case "comment":
      case "propose":
      case "verify":
        return has(p) || i.open[p];
      case "review":
      case "moderate":
        return person && has(p);
      case "publish":
        return person && (i.ownPersonal || (ctx.settings.directPublish && role.has("publish")));
      case "security":
        return can(ctx, "security_admin") || everywhere || role.has("security");
      case "manage_members":
      case "manage_settings":
        return i.kind !== "personal" && (everywhere || (person && i.kind === "project" && role.has(p)));
    }
  });
}

/** effectiveFrom for one scope, gathering its inputs. */
export async function effectivePermissions(ctx: RequestContext, scope: { id: string; kind: string; visibility: string }): Promise<ProjectPermission[]> {
  const ownPersonal = scope.kind === "personal" && (await personalOwner(ctx.db, scope.id)) === ctx.actor.id;
  return effectiveFrom(ctx, {
    kind: scope.kind,
    ownPersonal,
    readable: await canReadScope(ctx, scope.id),
    rolePermissions: await permissionsIn(ctx.db, scope.id, ctx.actor.id),
    open: await openToEveryone(ctx.db, scope),
  });
}

export async function canApprove(ctx: RequestContext, scopeId: string): Promise<boolean> {
  try {
    await assertCanApprove(ctx, scopeId);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}
