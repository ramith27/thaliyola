import type { Queryable } from "../db/pool.js";
import { ForbiddenError, NotFoundError, type RequestContext } from "./context.js";

/**
 * Reading is open to every authenticated user.
 * Proposing: open to everyone until a scope lists writers/owners; then only they (and admins) may.
 * Approving: scope owners and admins only. Service identities never approve.
 */

export function isAdmin(ctx: RequestContext): boolean {
  if (ctx.actor.kind !== "human") return false;
  return !!ctx.actor.isAdmin || (!!ctx.actor.email && ctx.settings.adminEmails.includes(ctx.actor.email.toLowerCase()));
}

async function roleIn(db: Queryable, scopeId: string, userId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ role: string }>("SELECT role FROM scope_members WHERE scope_id = $1 AND user_id = $2", [scopeId, userId]);
  return rows[0]?.role;
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
              OR id IN (SELECT scope_id FROM scope_members WHERE user_id = $1)`,
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
  const restricted = await ctx.db.query("SELECT 1 FROM scope_members WHERE scope_id = $1 AND role IN ('writer', 'owner') LIMIT 1", [scopeId]);
  if (!restricted.rowCount) return;
  const role = await roleIn(ctx.db, scopeId, ctx.actor.id);
  if (role !== "writer" && role !== "owner") throw new ForbiddenError("you are not a writer in this scope");
}

export async function assertCanApprove(ctx: RequestContext, scopeId: string): Promise<void> {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("service identities cannot approve changes");
  if (isAdmin(ctx)) return;
  if ((await roleIn(ctx.db, scopeId, ctx.actor.id)) !== "owner") throw new ForbiddenError("only scope owners and admins can approve");
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
