import { withTx, type Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, ValidationError, type RequestContext } from "./context.js";
import { assertCanApprove, assertCanManage, canApprove, isAdmin } from "./permissions.js";
import { hardDeleteItem, removeStoredFiles } from "./purge.js";
import { getScopeBySlug } from "./scopes.js";
import { findItem } from "./writes.js";

/**
 * The trash. Deleting an article, finding or project hides it everywhere
 * (search, browsing, the graph, agents) but keeps it, so whoever may approve
 * there can restore it. Admins empty the trash for good; only the reason is
 * kept (in the purge log).
 */

const table = (kind: string) => (kind === "article" ? "articles" : "findings");

/** Open proposals on deleted items can't be applied; close them with a reason. */
async function closeProposals(db: Queryable, ids: string[], reviewerId: string, reason: string) {
  await db.query("UPDATE revisions SET state = 'rejected', reviewer_id = $2, decided_at = now(), reason = $3 WHERE target_id = ANY($1::uuid[]) AND state = 'pending'", [ids, reviewerId, reason]);
}

export async function deleteItem(ctx: RequestContext, id: string) {
  const item = await findItem(ctx.db, id);
  await assertCanApprove(ctx, item.scope_id);
  if (item.status === "deleted") throw new ValidationError(`${item.kind} is already in the trash`);
  await withTx(ctx.db, async (db) => {
    await db.query(`UPDATE ${table(item.kind)} SET status_before_delete = status, status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, ctx.actor.id]);
    await closeProposals(db, [id], ctx.actor.id, "the item was deleted");
    await audit(db, ctx.actor.id, "delete_item", id);
  });
  ctx.onWrite?.();
  return { id, kind: item.kind, status: "deleted" };
}

export async function restoreItem(ctx: RequestContext, id: string) {
  const item = await findItem(ctx.db, id);
  await assertCanApprove(ctx, item.scope_id);
  if (item.status !== "deleted") throw new ValidationError(`${item.kind} isn't in the trash`);
  const scope = (await ctx.db.query<{ status: string; slug: string }>("SELECT status, slug FROM scopes WHERE id = $1", [item.scope_id])).rows[0]!;
  if (scope.status === "deleted") throw new ValidationError(`its project ${scope.slug} is in the trash; restore the project instead`);
  const { rows } = await ctx.db.query<{ status: string }>(
    `UPDATE ${table(item.kind)} SET status = coalesce(status_before_delete, 'published'), status_before_delete = NULL, deleted_at = NULL, deleted_by = NULL
      WHERE id = $1 RETURNING status`,
    [id],
  );
  await audit(ctx.db, ctx.actor.id, "restore_item", id);
  ctx.onWrite?.();
  return { id, kind: item.kind, status: rows[0]!.status };
}

/** Deletes a project and puts everything in it in the trash with it. Its owners and admins; type the name to confirm. */
export async function deleteProject(ctx: RequestContext, slug: string, confirm: string) {
  const scope = await getScopeBySlug(ctx.db, slug);
  if (scope.kind !== "project") throw new ValidationError("only projects can be deleted; the team space and library always exist");
  await assertCanManage(ctx, scope);
  if (scope.status === "deleted") throw new ValidationError("the project is already in the trash");
  if (confirm.trim() !== scope.name.trim() && confirm.trim() !== scope.slug) throw new ValidationError(`type the project's name (${scope.name}) to confirm`);
  const counts = await withTx(ctx.db, async (db) => {
    const a = await db.query<{ id: string }>(
      "UPDATE articles SET status_before_delete = status, status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE scope_id = $1 AND status <> 'deleted' RETURNING id",
      [scope.id, ctx.actor.id],
    );
    const f = await db.query<{ id: string }>(
      "UPDATE findings SET status_before_delete = status, status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE scope_id = $1 AND status <> 'deleted' RETURNING id",
      [scope.id, ctx.actor.id],
    );
    await closeProposals(db, [...a.rows, ...f.rows].map((r) => r.id), ctx.actor.id, "the project was deleted");
    await db.query("UPDATE scopes SET status = 'deleted', deleted_at = now(), deleted_by = $2 WHERE id = $1", [scope.id, ctx.actor.id]);
    await audit(db, ctx.actor.id, "delete_project", scope.id);
    return { articles: a.rowCount ?? 0, findings: f.rowCount ?? 0 };
  });
  ctx.onWrite?.();
  return { project: slug, status: "deleted", ...counts };
}

/** Brings a project back with everything that was deleted along with it. */
export async function restoreProject(ctx: RequestContext, slug: string) {
  const scope = await getScopeBySlug(ctx.db, slug);
  await assertCanManage(ctx, scope);
  if (scope.status !== "deleted") throw new ValidationError("the project isn't in the trash");
  const deletedAt = (await ctx.db.query<{ deleted_at: string }>("SELECT deleted_at FROM scopes WHERE id = $1", [scope.id])).rows[0]!.deleted_at;
  const counts = await withTx(ctx.db, async (db) => {
    // Items deleted on their own before the project stay in the trash.
    const restore = (t: string) =>
      db.query(
        `UPDATE ${t} SET status = coalesce(status_before_delete, 'published'), status_before_delete = NULL, deleted_at = NULL, deleted_by = NULL
          WHERE scope_id = $1 AND status = 'deleted' AND deleted_at >= $2`,
        [scope.id, deletedAt],
      );
    const a = await restore("articles");
    const f = await restore("findings");
    await db.query("UPDATE scopes SET status = 'active', deleted_at = NULL, deleted_by = NULL WHERE id = $1", [scope.id]);
    await audit(db, ctx.actor.id, "restore_project", scope.id);
    return { articles: a.rowCount ?? 0, findings: f.rowCount ?? 0 };
  });
  ctx.onWrite?.();
  return { project: slug, status: "active", ...counts };
}

/** Admins: delete one trashed item for good. */
export async function emptyItem(ctx: RequestContext, id: string) {
  if (!isAdmin(ctx)) throw new ForbiddenError("only admins can delete permanently");
  const item = await findItem(ctx.db, id);
  if (item.status !== "deleted") throw new ValidationError("move it to the trash first");
  const res = await withTx(ctx.db, (db) => hardDeleteItem(ctx, db, item, "Deleted permanently from the trash"));
  await removeStoredFiles(ctx, res.orphaned);
  return { id, deleted: true };
}

/** Admins: delete a trashed project and everything in it for good. Type the name to confirm. */
export async function emptyProject(ctx: RequestContext, slug: string, confirm: string) {
  if (!isAdmin(ctx)) throw new ForbiddenError("only admins can delete permanently");
  const scope = await getScopeBySlug(ctx.db, slug);
  if (scope.kind !== "project") throw new ValidationError("only projects can be deleted");
  if (scope.status !== "deleted") throw new ValidationError("move the project to the trash first");
  if (confirm.trim() !== scope.name.trim() && confirm.trim() !== scope.slug) throw new ValidationError(`type the project's name (${scope.name}) to confirm`);
  const orphaned = await withTx(ctx.db, async (db) => {
    const files: string[] = [];
    const items = await db.query<{ kind: string; id: string }>(
      "SELECT 'article' AS kind, id FROM articles WHERE scope_id = $1 UNION ALL SELECT 'finding', id FROM findings WHERE scope_id = $1",
      [scope.id],
    );
    for (const item of items.rows) files.push(...(await hardDeleteItem(ctx, db, item, `Project ${scope.slug} deleted permanently`)).orphaned);
    const components = (await db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1", [scope.id])).rows.map((r) => r.id);
    const ids = [scope.id, ...components];
    await db.query("DELETE FROM relations WHERE from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[])", [ids]);
    await db.query("DELETE FROM impact_notices WHERE scope_id = $1 OR component_id = ANY($2::uuid[])", [scope.id, components]);
    await db.query("DELETE FROM components WHERE scope_id = $1", [scope.id]);
    await db.query("DELETE FROM scope_members WHERE scope_id = $1", [scope.id]);
    await db.query("DELETE FROM scope_team_roles WHERE scope_id = $1", [scope.id]);
    await db.query("DELETE FROM watches WHERE target_id = $1", [scope.id]);
    await db.query("DELETE FROM favourites WHERE target_id = $1", [scope.id]);
    await db.query("DELETE FROM notifications WHERE target_id = $1", [scope.id]);
    await db.query("UPDATE invitations SET scope_id = NULL, scope_role = NULL WHERE scope_id = $1", [scope.id]);
    // Proposals raised here about items elsewhere (e.g. shares) lose their scope with it.
    const rev = (await db.query<{ id: string }>("SELECT id FROM revisions WHERE scope_id = $1", [scope.id])).rows.map((r) => r.id);
    await db.query("DELETE FROM revision_comments WHERE revision_id = ANY($1::uuid[])", [rev]);
    await db.query("DELETE FROM action_tokens WHERE revision_id = ANY($1::uuid[])", [rev]);
    await db.query("DELETE FROM revisions WHERE id = ANY($1::uuid[])", [rev]);
    await db.query("DELETE FROM chunks WHERE scope_id = $1", [scope.id]);
    await db.query("DELETE FROM assets WHERE scope_id = $1", [scope.id]);
    await db.query("DELETE FROM scopes WHERE id = $1", [scope.id]);
    await db.query("INSERT INTO purges (target_kind, target_id, reason, actor_id, removed) VALUES ('project', $1, $2, $3, $4)", [
      scope.id,
      `Project ${scope.slug} deleted permanently`,
      ctx.actor.id,
      JSON.stringify({ items: items.rowCount ?? 0, repositories: components.length }),
    ]);
    await audit(db, ctx.actor.id, "purge_project", null);
    return files;
  });
  await removeStoredFiles(ctx, orphaned);
  return { project: slug, deleted: true };
}

/** What's in the trash that the caller may restore (projects they manage, items where they may approve). */
export async function listTrash(ctx: RequestContext) {
  const projects = await ctx.db.query<{ id: string; slug: string; name: string; kind: string; deleted_at: string; deleted_by: string | null; items: number }>(
    `SELECT s.id, s.slug, s.name, s.kind, s.deleted_at, coalesce(u.display_name, u.email) AS deleted_by,
            ((SELECT count(*) FROM articles a WHERE a.scope_id = s.id) + (SELECT count(*) FROM findings f WHERE f.scope_id = s.id))::int AS items
       FROM scopes s LEFT JOIN users u ON u.id = s.deleted_by WHERE s.status = 'deleted' ORDER BY s.deleted_at DESC`,
  );
  const visibleProjects = [];
  for (const p of projects.rows) {
    try {
      await assertCanManage(ctx, p);
      visibleProjects.push(p);
    } catch {
      /* not theirs */
    }
  }
  const items = await ctx.db.query<{ kind: string; id: string; title: string; type: string; scope_id: string; scope: string; deleted_at: string; deleted_by: string | null }>(
    `SELECT x.kind, x.id, x.title, x.type, x.scope_id, s.slug AS scope, x.deleted_at, coalesce(u.display_name, u.email) AS deleted_by
       FROM (SELECT 'article' AS kind, id, title, type, scope_id, deleted_at, deleted_by, status FROM articles
             UNION ALL SELECT 'finding', id, title, type, scope_id, deleted_at, deleted_by, status FROM findings) x
       JOIN scopes s ON s.id = x.scope_id LEFT JOIN users u ON u.id = x.deleted_by
      WHERE x.status = 'deleted' AND s.status <> 'deleted' ORDER BY x.deleted_at DESC LIMIT 300`,
  );
  const visibleItems = [];
  for (const it of items.rows) if (await canApprove(ctx, it.scope_id)) visibleItems.push({ ...it, scope_id: undefined });
  return { projects: visibleProjects.map(({ id: _id, ...p }) => p), items: visibleItems, can_empty: isAdmin(ctx) };
}
