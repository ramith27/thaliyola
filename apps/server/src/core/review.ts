import pg from "pg";
import { withTx, type Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { reindexArticle, reindexFinding, replaceSection } from "./chunking.js";
import { ConflictError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { getArticle, getFinding } from "./items.js";
import { onDecision, onImpactNotices, track } from "./notify.js";
import { assertCanApprove, assertCanRead, canApprove, readableScopes } from "./permissions.js";
import { getReadableScope } from "./scopes.js";
import { findItem } from "./writes.js";

interface RevisionRow {
  id: string;
  target_kind: "article" | "finding";
  target_id: string;
  scope_id: string;
  op: "create" | "update" | "promote" | "verify" | "share";
  base_version: number | null;
  payload: Record<string, any>;
  author_id: string;
  state: string;
  summary: string;
}

export async function listReviewQueue(ctx: RequestContext, opts: { scope?: string; state?: string; mine?: boolean; limit?: number } = {}) {
  const scopeId = opts.scope ? (await getReadableScope(ctx, opts.scope)).id : null;
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.op, r.state, r.summary, r.redactions, r.base_version, r.created_at, r.decided_at, r.reason,
            r.target_kind, r.target_id, coalesce(a.title, f.title) AS target_title, coalesce(a.type, f.type) AS target_type,
            s.slug AS scope, coalesce(u.email, u.subject) AS author, coalesce(rv.email, rv.subject) AS reviewer
       FROM revisions r
       JOIN scopes s ON s.id = r.scope_id
       JOIN users u ON u.id = r.author_id
       LEFT JOIN users rv ON rv.id = r.reviewer_id
       LEFT JOIN articles a ON r.target_kind = 'article' AND a.id = r.target_id
       LEFT JOIN findings f ON r.target_kind = 'finding' AND f.id = r.target_id
      WHERE r.state = $1 AND ($2::uuid IS NULL OR r.scope_id = $2) AND (NOT $3 OR r.author_id = $4)
        AND ($6::uuid[] IS NULL OR (r.scope_id = ANY($6) AND (r.op = 'share' OR coalesce(a.scope_id, f.scope_id) = ANY($6))))
      ORDER BY r.created_at ${opts.state && opts.state !== "pending" ? "DESC" : "ASC"}
      LIMIT $5`,
    [opts.state ?? "pending", scopeId, !!opts.mine, ctx.actor.id, Math.min(opts.limit ?? 50, 200), readable],
  );
  return rows;
}

/** A revision with the item's current state and, for article edits, the body it would produce. */
export async function getRevision(ctx: RequestContext, id: string) {
  const r = await loadRevision(ctx.db, id);
  // Library owners review what a members-only project proposes to publish, so they may see that item.
  const skipReadCheck = r.op === "share" && (await canApprove(ctx, r.scope_id));
  if (!skipReadCheck) await assertCanRead(ctx, r.scope_id, `revision ${id}`);
  const current =
    r.target_kind === "article" ? await getArticle(ctx, r.target_id, undefined, { skipReadCheck }) : await getFinding(ctx, r.target_id, { skipReadCheck });
  let proposed: unknown = r.payload;
  if (r.target_kind === "article" && (r.op === "update" || r.op === "promote")) {
    const body = (current as { body_md: string }).body_md;
    proposed = { ...r.payload, body_md: nextArticleBody(body, r.payload) };
  }
  return {
    ...r,
    stale: r.base_version !== null && r.op !== "create" && r.base_version !== (current as { version: number }).version,
    current,
    proposed,
  };
}

async function loadRevision(db: Queryable, id: string, lock = false): Promise<RevisionRow> {
  const { rows } = await db.query<RevisionRow>(
    `SELECT id, target_kind, target_id, scope_id, op, base_version, payload, author_id, state, summary
       FROM revisions WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`revision ${id}`);
  return rows[0];
}

function nextArticleBody(body: string, payload: Record<string, any>): string {
  if (!payload.section) return payload.text;
  return replaceSection(body, payload.section, payload.text, payload.mode === "append" ? "append" : "replace");
}

export async function approveRevision(ctx: RequestContext, id: string): Promise<{ revision_id: string; state: string } & Record<string, unknown>> {
  const result = await approveInTx(ctx, id);
  ctx.onWrite?.();
  track(afterDecision(ctx, id, result));
  return result;
}

async function approveInTx(ctx: RequestContext, id: string): Promise<{ revision_id: string; state: string } & Record<string, unknown>> {
  return withTx(ctx.db, async (db) => {
    const r = await loadRevision(db, id, true);
    if (r.state !== "pending") throw new ValidationError(`revision is already ${r.state}`);
    await assertCanApprove(ctx, r.scope_id);
    const item = await findItem(db, r.target_id, true);
    if (r.op !== "create" && r.base_version !== item.version) {
      throw new ConflictError(
        `the ${item.kind} changed since this was proposed (now version ${item.version}, proposal based on ${r.base_version}); reject it and re-propose`,
        { version: item.version },
      );
    }

    let result: Record<string, unknown>;
    switch (r.op) {
      case "create":
        result = await applyCreate(db, item);
        break;
      case "update":
      case "promote":
        result = item.kind === "article" ? await applyArticleEdit(db, ctx, item, r) : await applyFindingPatch(db, item, r);
        break;
      case "verify":
        result = await applySupersede(db, item);
        break;
      case "share":
        result = await applyShare(db, ctx, item, r);
        break;
      default:
        throw new ValidationError(`cannot apply '${r.op}' revisions yet`);
    }

    await db.query("UPDATE revisions SET state = 'approved', reviewer_id = $2, decided_at = now() WHERE id = $1", [id, ctx.actor.id]);
    await audit(db, ctx.actor.id, "approve_revision", r.target_id);
    return { revision_id: id, state: "approved", ...result };
  });
}

/** Notifications after a decision; failures are logged, never surfaced to the reviewer. */
async function afterDecision(ctx: RequestContext, id: string, result: Record<string, unknown>) {
  try {
    await onDecision(ctx.db, ctx.settings, id, ctx.actor.id);
    if (typeof result.impact_notices === "number" && result.impact_notices > 0) {
      const r = (await ctx.db.query<{ target_id: string }>("SELECT target_id FROM revisions WHERE id = $1", [id])).rows[0]!;
      await onImpactNotices(ctx.db, ctx.settings, r.target_id, result.version as number);
    }
  } catch (err) {
    console.error(`[notify] ${(err as Error).message}`);
  }
}

export async function rejectRevision(ctx: RequestContext, id: string, reason: string) {
  const result = await rejectInTx(ctx, id, reason);
  track(afterDecision(ctx, id, result));
  return result;
}

async function rejectInTx(ctx: RequestContext, id: string, reason: string) {
  if (!reason.trim()) throw new ValidationError("a reason is required to reject");
  return withTx(ctx.db, async (db) => {
    const r = await loadRevision(db, id, true);
    if (r.state !== "pending") throw new ValidationError(`revision is already ${r.state}`);
    await assertCanApprove(ctx, r.scope_id);
    if (r.op === "create") {
      const table = r.target_kind === "article" ? "articles" : "findings";
      await db.query(`UPDATE ${table} SET status = 'rejected', updated_at = now() WHERE id = $1 AND status = 'draft'`, [r.target_id]);
    }
    await db.query("UPDATE revisions SET state = 'rejected', reviewer_id = $2, reason = $3, decided_at = now() WHERE id = $1", [
      id,
      ctx.actor.id,
      reason.trim(),
    ]);
    await audit(db, ctx.actor.id, "reject_revision", r.target_id);
    return { revision_id: id, state: "rejected" };
  });
}

// ---------------------------------------------------------------------------

type Tx = pg.PoolClient;

async function applyCreate(db: Tx, item: { kind: string; id: string; status: string }) {
  if (item.status !== "draft") throw new ValidationError(`${item.kind} is ${item.status}, not a draft`);
  const table = item.kind === "article" ? "articles" : "findings";
  await db.query(`UPDATE ${table} SET status = 'published', last_verified_at = now(), updated_at = now() WHERE id = $1`, [item.id]);
  return { item_status: "published" };
}

async function applyFindingPatch(db: Tx, item: { id: string; scope_id: string }, r: RevisionRow) {
  const patch = r.payload.patch as Record<string, unknown>;
  const allowed = ["title", "symptoms", "root_cause", "fix", "tags"];
  const sets: string[] = [];
  const params: unknown[] = [item.id];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${key} = $${params.length}`);
  }
  const { rows } = await db.query(
    `UPDATE findings SET ${sets.join(", ")}, version = version + 1, updated_at = now(), last_verified_at = now()
      WHERE id = $1 RETURNING id, scope_id, title, symptoms, root_cause, fix, version`,
    params,
  );
  await reindexFinding(db, rows[0]);
  return { version: rows[0].version };
}

async function applyArticleEdit(db: Tx, ctx: RequestContext, item: { id: string; status: string }, r: RevisionRow) {
  const current = (await db.query("SELECT body_md FROM articles WHERE id = $1", [item.id])).rows[0];
  const body = nextArticleBody(current.body_md, r.payload);
  const { rows } = await db.query(
    `UPDATE articles SET body_md = $2, title = coalesce($3, title), version = version + 1, updated_at = now(), last_verified_at = now(),
            status = CASE WHEN status = 'possibly_stale' THEN 'published' ELSE status END
      WHERE id = $1 RETURNING id, scope_id, title, body_md, version, status`,
    [item.id, body, r.payload.title ?? null],
  );
  const updated = rows[0];
  await reindexArticle(db, updated);
  if (r.op === "promote" && r.payload.finding_id) {
    await db.query(
      `INSERT INTO relations (from_kind, from_id, kind, to_kind, to_id, created_by)
       VALUES ('finding', $1, 'promoted_into', 'article', $2, $3) ON CONFLICT DO NOTHING`,
      [r.payload.finding_id, item.id, ctx.actor.id],
    );
  }
  const notices = updated.status === "published" ? await raiseImpactNotices(db, updated, r.summary) : 0;
  return { version: updated.version, impact_notices: notices };
}

/** Copies an item into the Library, with its links, entities and assets, and links the source to the copy. */
async function applyShare(db: Tx, ctx: RequestContext, item: { kind: string; id: string; scope_id: string; status: string }, r: RevisionRow) {
  if (item.status === "draft") throw new ValidationError("approve the item itself first; it is still a draft");
  let copyId: string;
  if (item.kind === "article") {
    const { rows } = await db.query(
      `INSERT INTO articles (scope_id, type, title, path, body_md, tags, status, owner_id, created_by, last_verified_at)
       SELECT $2, type, title, coalesce($3, path), body_md, tags, 'published', owner_id, $4, now() FROM articles WHERE id = $1
       RETURNING id, scope_id, title, body_md`,
      [item.id, r.scope_id, r.payload.path ?? null, r.author_id],
    );
    copyId = rows[0].id;
    await reindexArticle(db, rows[0]);
  } else {
    const { rows } = await db.query(
      `INSERT INTO findings (scope_id, type, title, symptoms, root_cause, fix, tags, status, author_id, last_verified_at)
       SELECT $2, type, title, symptoms, root_cause, fix, tags, 'published', author_id, now() FROM findings WHERE id = $1
       RETURNING id, scope_id, title, symptoms, root_cause, fix`,
      [item.id, r.scope_id],
    );
    copyId = rows[0].id;
    await reindexFinding(db, rows[0]);
  }
  await db.query(
    `INSERT INTO source_links (target_kind, target_id, system, url, label)
     SELECT target_kind, $2, system, url, label FROM source_links WHERE target_id = $1`,
    [item.id, copyId],
  );
  await db.query(
    `INSERT INTO entity_links (entity_id, target_kind, target_id)
     SELECT entity_id, target_kind, $2 FROM entity_links WHERE target_id = $1 ON CONFLICT DO NOTHING`,
    [item.id, copyId],
  );
  await db.query(
    `INSERT INTO assets (scope_id, target_kind, target_id, mime, sha256, size_bytes, storage_key, alt_text, filename, created_by)
     SELECT $3, target_kind, $2, mime, sha256, size_bytes, storage_key, alt_text, filename, created_by
       FROM assets WHERE target_id = $1 AND deleted_at IS NULL`,
    [item.id, copyId, r.scope_id],
  );
  await db.query(
    `INSERT INTO relations (from_kind, from_id, kind, to_kind, to_id, created_by) VALUES ($1, $2, 'published_as', $1, $3, $4)`,
    [item.kind, item.id, copyId, ctx.actor.id],
  );
  const source = (await db.query<{ kind: string }>("SELECT kind FROM scopes WHERE id = $1", [item.scope_id])).rows[0]!;
  if (source.kind === "project") {
    await db.query(
      `INSERT INTO relations (from_kind, from_id, kind, to_kind, to_id, created_by) VALUES ('scope', $1, 'uses', $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [item.scope_id, item.kind, copyId, ctx.actor.id],
    );
  }
  return { library_copy_id: copyId };
}

async function applySupersede(db: Tx, item: { kind: string; id: string }) {
  const table = item.kind === "article" ? "articles" : "findings";
  await db.query(`UPDATE ${table} SET status = 'superseded', version = version + 1, updated_at = now() WHERE id = $1`, [item.id]);
  return { item_status: "superseded" };
}

/**
 * Tells downstream consumers that a published article changed:
 * components that consume it (contracts), and other projects that use it
 * (shared library designs, patterns, contracts).
 */
async function raiseImpactNotices(db: Tx, article: { id: string; scope_id: string; version: number }, summary: string): Promise<number> {
  const consumers = await db.query(
    `INSERT INTO impact_notices (source_kind, source_id, source_version, component_id, summary)
     SELECT 'article', $1, $2, r.to_id, $3
       FROM relations r WHERE r.from_id = $1 AND r.kind = 'consumed_by' AND r.to_kind = 'component'`,
    [article.id, article.version, summary],
  );
  const users = await db.query(
    `INSERT INTO impact_notices (source_kind, source_id, source_version, scope_id, summary)
     SELECT DISTINCT 'article', $1::uuid, $2::int, s.id, $4
       FROM relations r
       LEFT JOIN articles a ON r.from_kind = 'article' AND a.id = r.from_id
       LEFT JOIN findings f ON r.from_kind = 'finding' AND f.id = r.from_id
       JOIN scopes s ON s.id = CASE WHEN r.from_kind = 'scope' THEN r.from_id ELSE coalesce(a.scope_id, f.scope_id) END
      WHERE r.to_id = $1 AND r.kind = 'uses' AND s.kind = 'project' AND s.id <> $3`,
    [article.id, article.version, article.scope_id, summary],
  );
  return (consumers.rowCount ?? 0) + (users.rowCount ?? 0);
}
