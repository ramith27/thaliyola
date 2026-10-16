import type { Queryable } from "../db/pool.js";
import { ForbiddenError, NotFoundError, type RequestContext } from "./context.js";

/**
 * Reading: team-visible scopes are open to every authenticated user; members-only projects to their members.
 * Proposing: open to everyone until a scope lists writers/owners; then only they (and admins) may.
 * Approving and managing a project (members, teams, repositories, settings): its owners and admins.
 * Service identities never approve. A person's role in a scope is the highest of their direct role
 * and the roles of the teams they belong to (the scope_roles view).
 */

export function isAdmin(ctx: RequestContext): boolean {
  if (ctx.actor.kind !== "human") return false;
  return !!ctx.actor.isAdmin || (!!ctx.actor.email && ctx.settings.adminEmails.includes(ctx.actor.email.toLowerCase()));
}

const RANK: Record<string, number> = { reader: 1, writer: 2, owner: 3 };

/** The caller's effective role in a scope: the highest of their direct and team roles. */
export async function roleIn(db: Queryable, scopeId: string, userId: string): Promise<"reader" | "writer" | "owner" | undefined> {
  const { rows } = await db.query<{ role: "reader" | "writer" | "owner" }>("SELECT role FROM scope_roles WHERE scope_id = $1 AND user_id = $2", [scopeId, userId]);
  return rows.reduce<"reader" | "writer" | "owner" | undefined>((best, r) => (!best || RANK[r.role]! > RANK[best]! ? r.role : best), undefined);
}

const readableCache = new WeakMap<RequestContext, Promise<string[] | null>>();

/**
 * Scopes the caller may read: every team-visible scope plus members-only
 * projects they belong to. `null` means everything (admins).
 */
export function readableScopes(ctx: RequestContext): Promise<string[] | null> {
  let cached = readableCache.get(ctx);
  if (!cached) {
    cached = isAdmin(ctx)
      ? Promise.resolve(null)
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
  const readable = await readableScopes(ctx);
  return readable === null || readable.includes(scopeId);
}

/** Unreadable things are reported as missing, so their existence doesn't leak. */
export async function assertCanRead(ctx: RequestContext, scopeId: string, what: string): Promise<void> {
  if (!(await canReadScope(ctx, scopeId))) throw new NotFoundError(what);
}

export async function assertCanPropose(ctx: RequestContext, scopeId: string): Promise<void> {
  if (isAdmin(ctx)) return;
  const { rows } = await ctx.db.query<{ visibility: string }>("SELECT visibility FROM scopes WHERE id = $1", [scopeId]);
  if (rows[0]?.visibility === "members") {
    // Members-only projects: only writers and owners may propose (readers can just read).
    const role = await roleIn(ctx.db, scopeId, ctx.actor.id);
    if (role !== "writer" && role !== "owner") throw new ForbiddenError("you are not a writer in this scope");
    return;
  }
  const restricted = await ctx.db.query("SELECT 1 FROM scope_roles WHERE scope_id = $1 AND role IN ('writer', 'owner') LIMIT 1", [scopeId]);
  if (!restricted.rowCount) return;
  const role = await roleIn(ctx.db, scopeId, ctx.actor.id);
  if (role !== "writer" && role !== "owner") throw new ForbiddenError("you are not a writer in this scope");
}

export async function assertCanApprove(ctx: RequestContext, scopeId: string): Promise<void> {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("service identities cannot approve changes");
  if (isAdmin(ctx)) return;
  if ((await roleIn(ctx.db, scopeId, ctx.actor.id)) !== "owner") throw new ForbiddenError("only scope owners and admins can approve");
}

/** Managing a scope (members, teams, repositories, name and visibility): admins, and owners of a project. */
export async function assertCanManage(ctx: RequestContext, scope: { id: string; kind: string }): Promise<void> {
  if (isAdmin(ctx)) return;
  if (ctx.actor.kind === "human" && scope.kind === "project" && (await roleIn(ctx.db, scope.id, ctx.actor.id)) === "owner") return;
  throw new ForbiddenError(scope.kind === "project" ? "only this project's owners and admins can change its settings" : "only admins can change this scope's settings");
}

export async function canManage(ctx: RequestContext, scope: { id: string; kind: string }): Promise<boolean> {
  try {
    await assertCanManage(ctx, scope);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

export function assertAdmin(ctx: RequestContext): void {
  if (!isAdmin(ctx)) throw new ForbiddenError("admin only");
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
