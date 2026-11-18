import { audit } from "./audit.js";
import { nameOf, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { editArticle, editFinding } from "./direct.js";
import { notify, reviewersFor, track } from "./notify.js";
import { assertCanApprove, assertCanComment, assertCanRead, canApprove } from "./permissions.js";
import { redact } from "./redaction.js";
import { approveRevision, getRevision, rejectRevision } from "./review.js";
import { findItem } from "./writes.js";

/**
 * The review conversation (comments, assignee, bulk approve) and item history
 * (published versions and restore).
 */

const revisionHeader = async (ctx: RequestContext, id: string) => {
  const { rows } = await ctx.db.query<{ id: string; scope_id: string; author_id: string; assignee_id: string | null; summary: string; state: string }>(
    "SELECT id, scope_id, author_id, assignee_id, summary, state FROM revisions WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`revision ${id}`);
  return rows[0];
};

/** Comments with their author: `author` as shown before (name, else email), and `author_name` and `author_email` apart. */
export async function listComments(ctx: RequestContext, revisionId: string) {
  await getRevision(ctx, revisionId); // read check
  const { rows } = await ctx.db.query(
    `SELECT c.id, c.body, c.created_at, coalesce(u.display_name, u.email, u.subject) AS author, u.display_name AS author_name,
            coalesce(u.email, u.subject) AS author_email, c.author_id = $2 AS mine
       FROM revision_comments c JOIN users u ON u.id = c.author_id
      WHERE c.revision_id = $1 ORDER BY c.created_at`,
    [revisionId, ctx.actor.id],
  );
  return rows;
}

/** Adds a comment and tells the author, the assignee and earlier commenters. */
export async function addComment(ctx: RequestContext, revisionId: string, body: string) {
  await getRevision(ctx, revisionId);
  const text = redact(body.trim()).text;
  if (!text) throw new ValidationError("comment is empty");
  if (text.length > 5000) throw new ValidationError("comment is too long (5000 characters at most)");
  const r = await revisionHeader(ctx, revisionId);
  await assertCanComment(ctx, r.scope_id);
  const { rows } = await ctx.db.query(
    "INSERT INTO revision_comments (revision_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at",
    [revisionId, ctx.actor.id, text],
  );
  await audit(ctx.db, ctx.actor.id, "comment_revision", revisionId);
  const commenters = (await ctx.db.query<{ author_id: string }>("SELECT DISTINCT author_id FROM revision_comments WHERE revision_id = $1", [revisionId])).rows;
  const who = nameOf(ctx.actor);
  track(
    notify(
      ctx.db,
      ctx.settings,
      [r.author_id, r.assignee_id ?? "", ...commenters.map((c) => c.author_id)],
      { kind: "comment", title: `Comment on: ${r.summary}`, body: `${who}: ${text.slice(0, 500)}`, link: `#/review/${revisionId}`, targetId: revisionId, scopeId: r.scope_id },
      { exclude: ctx.actor.id },
    ).catch((err) => console.error(`[notify] ${(err as Error).message}`)),
  );
  return rows[0];
}

/** People who may approve this revision: the candidates for assignment. */
export async function listReviewers(ctx: RequestContext, revisionId: string) {
  const r = await revisionHeader(ctx, revisionId);
  await assertCanRead(ctx, r.scope_id, `revision ${revisionId}`);
  const ids = await reviewersFor(ctx.db, ctx.settings, r.scope_id);
  const { rows } = await ctx.db.query(
    "SELECT id, email, coalesce(display_name, email) AS name FROM users WHERE id = ANY($1::uuid[]) ORDER BY lower(coalesce(display_name, email))",
    [ids],
  );
  return rows;
}

/** Assigns a pending revision to a reviewer (or clears it with null). Reviewers may assign; anyone may take it if they can approve. */
export async function setAssignee(ctx: RequestContext, revisionId: string, userId: string | null) {
  const r = await revisionHeader(ctx, revisionId);
  if (r.state !== "pending") throw new ValidationError(`revision is already ${r.state}`);
  await assertCanApprove(ctx, r.scope_id);
  if (userId) {
    const reviewers = await reviewersFor(ctx.db, ctx.settings, r.scope_id);
    if (!reviewers.includes(userId)) throw new ValidationError("that person can't approve changes in this scope");
  }
  await ctx.db.query("UPDATE revisions SET assignee_id = $2 WHERE id = $1", [revisionId, userId]);
  await audit(ctx.db, ctx.actor.id, "assign_revision", revisionId);
  if (userId && userId !== ctx.actor.id) {
    track(
      notify(ctx.db, ctx.settings, [userId], {
        kind: "assigned",
        title: `Assigned to you: ${r.summary}`,
        body: `${nameOf(ctx.actor)} asked you to review this.`,
        link: `#/review/${revisionId}`,
        targetId: revisionId,
      }).catch((err) => console.error(`[notify] ${(err as Error).message}`)),
    );
  }
  return { revision_id: revisionId, assignee_id: userId };
}

/** Approves several revisions one by one; each succeeds or fails on its own. */
export async function bulkApprove(ctx: RequestContext, ids: string[]) {
  if (ids.length > 100) throw new ValidationError("approve at most 100 at once");
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      await approveRevision(ctx, id);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: (err as Error).message });
    }
  }
  return { approved: results.filter((r) => r.ok).length, results };
}

/** Rejects several proposals with one reason; each is checked on its own, like bulkApprove. */
export async function bulkReject(ctx: RequestContext, ids: string[], reason: string) {
  if (ids.length > 100) throw new ValidationError("reject at most 100 at once");
  if (!reason.trim()) throw new ValidationError("give a reason; the authors see it");
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      await rejectRevision(ctx, id, reason.trim());
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: (err as Error).message });
    }
  }
  return { rejected: results.filter((r) => r.ok).length, results };
}

// ---- History ----------------------------------------------------------------

async function readableItem(ctx: RequestContext, id: string) {
  const item = await findItem(ctx.db, id);
  await assertCanRead(ctx, item.scope_id, `${item.kind} ${id}`);
  return item;
}

export async function listVersions(ctx: RequestContext, id: string) {
  const item = await readableItem(ctx, id);
  const { rows } = await ctx.db.query(
    `SELECT v.version, v.title, v.summary, v.created_at, coalesce(a.display_name, a.email, a.subject) AS author, coalesce(p.display_name, p.email) AS approver,
            v.content->'tags' AS tags
       FROM item_versions v LEFT JOIN users a ON a.id = v.author_id LEFT JOIN users p ON p.id = v.approver_id
      WHERE v.target_id = $1 ORDER BY v.version DESC`,
    [id],
  );
  // Each version's tags, and which it added or removed against the version before it (older snapshots have none).
  for (let i = 0; i < rows.length; i++) {
    const tags = Array.isArray(rows[i].tags) ? (rows[i].tags as string[]) : null;
    const prev = rows[i + 1] && Array.isArray(rows[i + 1].tags) ? (rows[i + 1].tags as string[]) : null;
    rows[i].tags = tags;
    rows[i].tags_added = tags && prev ? tags.filter((t) => !prev.includes(t)) : [];
    rows[i].tags_removed = tags && prev ? prev.filter((t) => !tags.includes(t)) : [];
  }
  return { kind: item.kind, id, title: item.title, current_version: item.version, can_restore: await canApprove(ctx, item.scope_id), versions: rows };
}

export async function getVersion(ctx: RequestContext, id: string, version: number) {
  await readableItem(ctx, id);
  const { rows } = await ctx.db.query(
    `SELECT v.target_kind AS kind, v.version, v.title, v.content, v.summary, v.created_at, coalesce(a.display_name, a.email, a.subject) AS author
       FROM item_versions v LEFT JOIN users a ON a.id = v.author_id WHERE v.target_id = $1 AND v.version = $2`,
    [id, version],
  );
  if (!rows[0]) throw new NotFoundError(`version ${version} of ${id}`);
  return rows[0];
}

/**
 * Restores an older version as a new version (history is never rewritten).
 * Owners publish directly; everyone else creates a proposal for review.
 */
export async function restoreVersion(ctx: RequestContext, id: string, version: number) {
  const item = await readableItem(ctx, id);
  const old = await getVersion(ctx, id, version);
  if (version === item.version) throw new ValidationError(`version ${version} is already the current one`);
  const summary = `Restore version ${version} of ${item.title}`;
  if (item.kind === "article") {
    return editArticle(ctx, { id, version: item.version, summary, text: old.content.body_md, title: old.title, ...(Array.isArray(old.content.tags) ? { tags: old.content.tags } : {}) });
  }
  const { symptoms, root_cause, fix, tags } = old.content;
  return editFinding(ctx, { id, version: item.version, summary, patch: { title: old.title, symptoms, root_cause, fix: fix ?? undefined, tags } });
}
