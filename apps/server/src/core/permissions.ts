import type { Queryable } from "../db/pool.js";
import { ForbiddenError, type RequestContext } from "./context.js";

/**
 * Reading is open to every authenticated user.
 * Proposing: open to everyone until a scope lists writers/owners; then only they (and admins) may.
 * Approving: scope owners and admins only. Service identities never approve.
 */

export function isAdmin(ctx: RequestContext): boolean {
  return ctx.actor.kind === "human" && !!ctx.actor.email && ctx.settings.adminEmails.includes(ctx.actor.email.toLowerCase());
}

async function roleIn(db: Queryable, scopeId: string, userId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ role: string }>("SELECT role FROM scope_members WHERE scope_id = $1 AND user_id = $2", [scopeId, userId]);
  return rows[0]?.role;
}

export async function assertCanPropose(ctx: RequestContext, scopeId: string): Promise<void> {
  if (isAdmin(ctx)) return;
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
