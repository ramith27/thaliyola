import { withTx, type Queryable } from "../db/pool.js";
import { storeFor } from "./assets.js";
import { audit } from "./audit.js";
import { ForbiddenError, ValidationError, type RequestContext } from "./context.js";
import { isAdmin } from "./permissions.js";
import { findItem } from "./writes.js";

/**
 * Permanently deletes an article or finding and everything that holds its
 * content: versions, proposals and their comments, search chunks, links,
 * attachments (and their stored files, unless another item shares them),
 * notifications, watches and favourites. Everything else in Thaliyola is kept
 * as history, so this is for content that must not exist: a leaked secret,
 * personal data, something posted by mistake. Admins only, with a reason
 * that is kept (the content is not).
 */
export async function purgeItem(ctx: RequestContext, id: string, input: { reason: string; confirm_title: string }) {
  if (!isAdmin(ctx)) throw new ForbiddenError("only admins can purge");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ValidationError("give a reason (it is kept in the purge log)");
  const item = await findItem(ctx.db, id);
  if (input.confirm_title.trim() !== item.title.trim()) throw new ValidationError("type the exact title to confirm");

  const result = await withTx(ctx.db, (db) => hardDeleteItem(ctx, db, item, reason));
  await removeStoredFiles(ctx, result.orphaned);
  return { id, kind: item.kind, purged: true, removed: result.removed, other_copies: result.copies };
}

/** Deletes stored files that no asset row uses any more (after the transaction commits). */
export async function removeStoredFiles(ctx: RequestContext, keys: string[]) {
  const store = storeFor(ctx);
  for (const key of keys) await store.delete(key).catch((err) => console.error(`[purge] could not delete stored file ${key}: ${(err as Error).message}`));
}

/**
 * Removes one item and everything holding its content inside a transaction,
 * and logs the reason. Returns stored-file keys to delete once committed.
 */
export async function hardDeleteItem(ctx: RequestContext, db: Queryable, item: { kind: string; id: string }, reason: string) {
  const id = item.id;
  const removed: Record<string, number> = {};
  const del = async (name: string, sql: string, params: unknown[] = [id]) => {
    removed[name] = (await db.query(sql, params)).rowCount ?? 0;
  };
  // Copies elsewhere (published to the library) are separate items; report them rather than delete them silently.
  const copies = (await db.query<{ id: string }>("SELECT to_id AS id FROM relations WHERE from_id = $1 AND kind = 'published_as'", [id])).rows.map((r) => r.id);
  const revisionIds = (await db.query<{ id: string }>("SELECT id FROM revisions WHERE target_id = $1", [id])).rows.map((r) => r.id);
  await del("comments", "DELETE FROM revision_comments WHERE revision_id = ANY($1::uuid[])", [revisionIds]);
  await del("action_links", "DELETE FROM action_tokens WHERE revision_id = ANY($1::uuid[])", [revisionIds]);
  await del("notifications", "DELETE FROM notifications WHERE target_id = $1 OR target_id = ANY($2::uuid[])", [id, revisionIds]);
  await del("proposals", "DELETE FROM revisions WHERE target_id = $1");
  await del("versions", "DELETE FROM item_versions WHERE target_id = $1");
  await del("chunks", "DELETE FROM chunks WHERE parent_id = $1");
  await del("links", "DELETE FROM relations WHERE from_id = $1 OR to_id = $1");
  await del("entity_links", "DELETE FROM entity_links WHERE target_id = $1");
  await del("source_links", "DELETE FROM source_links WHERE target_id = $1");
  await del("impact_notices", "DELETE FROM impact_notices WHERE source_id = $1");
  await del("watches", "DELETE FROM watches WHERE target_id = $1");
  await del("favourites", "DELETE FROM favourites WHERE target_id = $1");
  const assets = await db.query<{ storage_key: string }>("DELETE FROM assets WHERE target_id = $1 RETURNING storage_key", [id]);
  removed.files = assets.rowCount ?? 0;
  await db.query(`DELETE FROM ${item.kind === "article" ? "articles" : "findings"} WHERE id = $1`, [id]);
  // Stored files go only when nothing else (e.g. a library copy) still uses them.
  const orphaned: string[] = [];
  for (const { storage_key } of assets.rows) {
    const still = await db.query("SELECT 1 FROM assets WHERE storage_key = $1 LIMIT 1", [storage_key]);
    if (!still.rowCount) orphaned.push(storage_key);
  }
  await db.query("INSERT INTO purges (target_kind, target_id, reason, actor_id, removed) VALUES ($1, $2, $3, $4, $5)", [item.kind, id, reason, ctx.actor.id, JSON.stringify(removed)]);
  await audit(db, ctx.actor.id, "purge", id);
  return { removed, orphaned, copies };
}

export async function listPurges(ctx: RequestContext) {
  if (!isAdmin(ctx)) throw new ForbiddenError("admins only");
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.target_kind, p.target_id, p.reason, p.removed, p.at, coalesce(u.display_name, u.email) AS by
       FROM purges p JOIN users u ON u.id = p.actor_id ORDER BY p.at DESC LIMIT 100`,
  );
  return rows;
}
