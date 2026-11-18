import pg from "pg";
import { withTx, type Queryable } from "../db/pool.js";
import { assertClaudeMayDecide, assertNotFreshOwnWork, decidedVia, reviewSelfApprovalOn, viaDetails } from "./approvals.js";
import { audit } from "./audit.js";
import { reindexArticle, reindexFinding, replaceSection } from "./chunking.js";
import { redact } from "./redaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { getArticle, getFinding } from "./items.js";
import { onDecision, onImpactNotices, track } from "./notify.js";
import { assertCanApprove, assertCanRead, can, canApprove, canPublishOwn, readableScopes } from "./permissions.js";
import { getReadableScope } from "./scopes.js";
import { moveItems } from "./move.js";
import { findItem } from "./writes.js";

interface RevisionRow {
  id: string;
  target_kind: "article" | "finding";
  target_id: string;
  scope_id: string;
  op: "create" | "update" | "promote" | "verify" | "share" | "move";
  base_version: number | null;
  payload: Record<string, any>;
  author_id: string;
  assignee_id: string | null;
  state: string;
  summary: string;
  created_via: string | null;
  created_at: Date;
  decided_via: string | null;
}

/** Review categories, as people think of them, and the kinds of proposal (op) in each. */
export const REVIEW_CATEGORIES = {
  new: ["create"],
  edit: ["update", "promote"],
  move: ["move"],
  share: ["share"],
  retire: ["verify"],
} as const;
export type ReviewCategory = keyof typeof REVIEW_CATEGORIES;

export interface ReviewFilters {
  /** Project (or team/library) slug the proposal is reviewed in. */
  scope?: string;
  state?: "pending" | "approved" | "rejected";
  category?: ReviewCategory;
  kind?: "article" | "finding";
  /** Article or finding type, e.g. runbook, rca. */
  type?: string;
  /** Whose proposals: people, agents (service accounts), or the caller's own. */
  author?: "people" | "agents" | "me";
  /** to_review: pending ones the caller may approve and didn't write; me: assigned to the caller; none: unassigned. */
  assigned?: "to_review" | "me" | "none" | boolean;
  /** Words in the summary or the item's title. */
  q?: string;
  sort?: "oldest" | "newest";
  limit?: number;
  /** Older options, kept for callers that pass them. */
  mine?: boolean;
}

/**
 * The review queue the caller can see, filtered. Each row says whether the caller may decide it (can_review) and
 * whether the item changed since it was proposed (outdated: approving it would conflict).
 */
export async function listReviewQueue(ctx: RequestContext, opts: ReviewFilters = {}) {
  const { where, params } = await reviewWhere(ctx, opts);
  params.push(Math.min(opts.limit ?? 50, 200));
  const newest = opts.sort ? opts.sort === "newest" : !!opts.state && opts.state !== "pending";
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.op, r.state, r.summary, r.redactions, r.base_version, r.created_at, r.decided_at, r.reason, r.created_via, r.decided_via, (r.author_id = $1) AS own,
            r.target_kind, r.target_id, coalesce(a.title, f.title) AS target_title, coalesce(a.type, f.type) AS target_type,
            s.slug AS scope, s.name AS scope_name, s.kind AS scope_kind,
            coalesce(u.email, u.subject) AS author, u.display_name AS author_name, u.kind AS author_kind,
            coalesce(rv.email, rv.subject) AS reviewer, rv.display_name AS reviewer_name,
            r.assignee_id, coalesce(asg.display_name, asg.email) AS assignee, asg.email AS assignee_email, asg.display_name AS assignee_name,
            (SELECT count(*) FROM revision_comments c WHERE c.revision_id = r.id)::int AS comments,
            ${CAN_REVIEW} AS can_review,
            (r.base_version IS NOT NULL AND r.op IN ('update', 'promote') AND coalesce(a.version, f.version) > r.base_version) AS outdated
       ${FROM}
      WHERE ${where}
      ORDER BY r.created_at ${newest ? "DESC" : "ASC"}
      LIMIT $${params.length}`,
    params,
  );
  // With "Reviewers may approve their own proposals" off, nobody decides their own.
  const selfOk = await reviewSelfApprovalOn(ctx);
  return rows.map(({ own, ...r }) => (own && !selfOk ? { ...r, can_review: false } : r));
}

/**
 * Counts for the filter bar: per state, and within the chosen state per category, project, type and author.
 * Each facet counts with the other filters applied but not its own, so choosing one shows what else is there.
 */
export async function reviewFacets(ctx: RequestContext, opts: ReviewFilters = {}) {
  const count = async (sql: string, without: Partial<Record<keyof ReviewFilters, undefined>>) => {
    const { where, params } = await reviewWhere(ctx, { ...opts, ...without });
    return (await ctx.db.query(`SELECT ${sql} ${FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
  };
  const toMap = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  const opCategory = `CASE ${Object.entries(REVIEW_CATEGORIES)
    .map(([c, ops]) => `WHEN r.op IN (${ops.map((o) => `'${o}'`).join(", ")}) THEN '${c}'`)
    .join(" ")} END`;
  const [states, categories, projects, types, authors, toReview] = await Promise.all([
    count("r.state AS k, count(*)::int AS n", { state: undefined }),
    count(`${opCategory} AS k, count(*)::int AS n`, { category: undefined }),
    count("s.slug AS k, count(*)::int AS n, min(s.name) AS name, min(s.kind) AS kind", { scope: undefined }),
    count("coalesce(a.type, f.type) AS k, count(*)::int AS n", { type: undefined, kind: undefined }),
    count("CASE WHEN u.kind = 'service' THEN 'agents' ELSE 'people' END AS k, count(*)::int AS n", { author: undefined }),
    reviewWhere(ctx, { ...opts, state: "pending", assigned: "to_review" }).then(async ({ where, params }) => (await ctx.db.query(`SELECT count(*)::int AS n ${FROM} WHERE ${where}`, params)).rows[0].n as number),
  ]);
  return {
    states: toMap(states),
    categories: toMap(categories),
    projects: projects.map((p) => ({ slug: p.k, name: p.name, kind: p.kind, count: p.n })),
    types: toMap(types),
    authors: toMap(authors),
    to_review: toReview,
  };
}

const FROM = `FROM revisions r
       JOIN scopes s ON s.id = r.scope_id
       JOIN users u ON u.id = r.author_id
       LEFT JOIN users rv ON rv.id = r.reviewer_id
       LEFT JOIN users asg ON asg.id = r.assignee_id
       LEFT JOIN articles a ON r.target_kind = 'article' AND a.id = r.target_id
       LEFT JOIN findings f ON r.target_kind = 'finding' AND f.id = r.target_id`;

/** Whether the caller ($1 actor id, $2 sees-all flag) may decide a revision: the review permission where it is reviewed. */
const CAN_REVIEW = `($2 OR EXISTS (SELECT 1 FROM scope_permissions p WHERE p.scope_id = r.scope_id AND p.user_id = $1 AND p.permission = 'review'))`;

async function reviewWhere(ctx: RequestContext, opts: ReviewFilters) {
  const scopeId = opts.scope ? (await getReadableScope(ctx, opts.scope)).id : null;
  const readable = await readableScopes(ctx);
  const human = ctx.actor.kind === "human";
  const params: unknown[] = [ctx.actor.id, human && can(ctx, "manage_all_projects"), opts.state ?? "pending", readable];
  const where = [
    // $1 (the caller) and $2 (sees everything) are used only by some filters; typed here so every query can be prepared.
    "$1::uuid IS NOT NULL AND $2::boolean IS NOT NULL",
    "r.state = $3",
    // What the caller can read; library shares are reviewed in the library even when the item's project is private.
    "($4::uuid[] IS NULL OR (r.scope_id = ANY($4) AND (r.op = 'share' OR coalesce(a.scope_id, f.scope_id) = ANY($4))))",
  ];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (scopeId) add("r.scope_id = $?", scopeId);
  if (opts.category) {
    if (!(opts.category in REVIEW_CATEGORIES)) throw new ValidationError(`category is one of ${Object.keys(REVIEW_CATEGORIES).join(", ")}`);
    add("r.op = ANY($?::text[])", [...REVIEW_CATEGORIES[opts.category]]);
  }
  if (opts.kind) add("r.target_kind = $?", opts.kind);
  if (opts.type) add("coalesce(a.type, f.type) = $?", opts.type);
  const author = opts.author ?? (opts.mine ? "me" : undefined);
  if (author === "me") where.push("r.author_id = $1");
  if (author === "people") where.push("u.kind = 'human'");
  if (author === "agents") where.push("u.kind = 'service'");
  const assigned = opts.assigned === true ? "me" : opts.assigned || undefined;
  if (assigned === "me") where.push("r.assignee_id = $1");
  if (assigned === "none") where.push("r.assignee_id IS NULL");
  if (assigned === "to_review") where.push(`r.author_id <> $1 AND ${CAN_REVIEW}`);
  if (opts.q?.trim()) add("(r.summary ILIKE $? OR coalesce(a.title, f.title) ILIKE $?)", `%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return { where: where.join(" AND "), params };
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
    proposed = { ...r.payload, body_md: nextArticleBody(body, r.payload), ...(Array.isArray(r.payload.tags) ? { tags: r.payload.tags } : { tags: (current as { tags?: string[] }).tags ?? [] }) };
  }
  return {
    ...r,
    stale: r.base_version !== null && r.op !== "create" && r.base_version !== (current as { version: number }).version,
    current,
    proposed,
  };
}

/**
 * A proposal shaped for deciding it from Claude (get_proposal): who wrote it where, whether the caller may decide it,
 * the item now and what it would become.
 */
export async function proposalForReview(ctx: RequestContext, id: string) {
  const rev = await getRevision(ctx, id);
  const meta = (
    await ctx.db.query<{ scope: string; scope_name: string; author: string | null; reviewer: string | null; decided_at: string | null; reason: string | null }>(
      `SELECT s.slug AS scope, s.name AS scope_name, coalesce(nullif(u.display_name, ''), u.email) AS author,
              coalesce(nullif(rv.display_name, ''), rv.email) AS reviewer, r.decided_at, r.reason
         FROM revisions r JOIN scopes s ON s.id = r.scope_id JOIN users u ON u.id = r.author_id LEFT JOIN users rv ON rv.id = r.reviewer_id WHERE r.id = $1`,
      [id],
    )
  ).rows[0]!;
  const mine = rev.author_id === ctx.actor.id;
  const canReview = rev.state === "pending" && (await canApprove(ctx, rev.scope_id)) && (!mine || (await reviewSelfApprovalOn(ctx)));
  return {
    id: rev.id,
    op: rev.op,
    state: rev.state,
    summary: rev.summary,
    target_kind: rev.target_kind,
    target_id: rev.target_id,
    scope: meta.scope,
    scope_name: meta.scope_name,
    author: meta.author,
    mine,
    proposed_through_claude: rev.created_via === "mcp",
    created_at: rev.created_at,
    reviewer: meta.reviewer,
    decided_at: meta.decided_at,
    decided_via: rev.decided_via,
    reason: meta.reason,
    stale: rev.stale,
    can_review: canReview,
    current: rev.current,
    proposed: rev.proposed,
  };
}

async function loadRevision(db: Queryable, id: string, lock = false): Promise<RevisionRow> {
  const { rows } = await db.query<RevisionRow>(
    `SELECT id, target_kind, target_id, scope_id, op, base_version, payload, author_id, assignee_id, state, summary, created_via, created_at, decided_via
       FROM revisions WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`revision ${id}`);
  return rows[0];
}

function nextArticleBody(body: string, payload: Record<string, any>): string {
  // A tags-only (or title-only) edit leaves the body as it is.
  if (payload.text === undefined || payload.text === null) return body;
  if (!payload.section) return payload.text;
  return replaceSection(body, payload.section, payload.text, payload.mode === "append" ? "append" : "replace");
}

/** What a reviewer may change before approving (edit-then-approve). */
export interface ReviewerEdits {
  title?: string;
  /** New-article body, or the new text of an edit (section or whole body). */
  body_md?: string;
  /** Finding fields (new findings and finding updates). */
  patch?: { title?: string; symptoms?: string; root_cause?: string; fix?: string };
}

export async function approveRevision(
  ctx: RequestContext,
  id: string,
  edits?: ReviewerEdits,
  opts: {
    ownWrite?: boolean;
    /** The user said yes to approving their own work written through Claude minutes ago (core/approvals.ts). */
    confirmed?: boolean;
    /** The author's own write published as it's made (a personal space, a web edit by a reviewer): not a review decision. */
    settle?: boolean;
  } = {},
): Promise<{ revision_id: string; state: string } & Record<string, unknown>> {
  // Publishing one's own write (ownWrite, settle) isn't a review decision: only a reviewer's approval is.
  const review = !opts.ownWrite && !opts.settle;
  if (review) await assertClaudeMayDecide(ctx, "approving a proposal");
  const peek = await loadRevision(ctx.db, id);
  if (opts.ownWrite && (peek.op === "move" || peek.op === "share")) throw new ValidationError(`a '${peek.op}' proposal always goes through review`);
  const check = review ? { confirmed: opts.confirmed } : null;
  const result = peek.op === "move" ? await approveMove(ctx, peek, edits, check) : await approveInTx(ctx, id, edits, opts.ownWrite, check);
  ctx.onWrite?.();
  track(afterDecision(ctx, id, result));
  return result;
}

/**
 * The checks on a reviewer: Review in the scope and, for a review decision (`check`; not an author's own write
 * published as it's made), the self-approval setting and Claude's own fresh work.
 */
async function assertReviewerMay(ctx: RequestContext, r: RevisionRow, check: { confirmed?: boolean } | null) {
  await assertCanApprove(ctx, r.scope_id);
  if (!check) return;
  const confirmed = check.confirmed;
  if (r.author_id === ctx.actor.id && !(await reviewSelfApprovalOn(ctx))) {
    throw new ForbiddenError("someone else must approve this proposal: you wrote it (an Administrator turned off \"Reviewers may approve their own proposals\" in Admin › System)");
  }
  assertNotFreshOwnWork(ctx, r, confirmed, "proposal");
}

async function approveInTx(
  ctx: RequestContext,
  id: string,
  edits?: ReviewerEdits,
  ownWrite = false,
  check: { confirmed?: boolean } | null = null,
): Promise<{ revision_id: string; state: string } & Record<string, unknown>> {
  return withTx(ctx.db, async (db) => {
    const r = await loadRevision(db, id, true);
    if (r.state !== "pending") throw new ValidationError(`revision is already ${r.state}`);
    // Publishing one's own write needs "publish" there (not "review"); anyone else's needs "review".
    if (ownWrite) {
      if (r.author_id !== ctx.actor.id || !(await canPublishOwn(ctx, r.scope_id))) throw new ForbiddenError("you can't publish here without review");
    } else await assertReviewerMay(ctx, r, check);
    const item = await findItem(db, r.target_id, true);
    if (r.op !== "create" && r.base_version !== item.version) {
      throw new ConflictError(
        `the ${item.kind} changed since this was proposed (now version ${item.version}, proposal based on ${r.base_version}); reject it and re-propose`,
        { version: item.version },
      );
    }

    if (edits && Object.values(edits).some((v) => v !== undefined)) await applyReviewerEdits(db, r, item, edits);

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

    // Every published version is kept in full for history and restore.
    if (r.op === "create" || r.op === "update" || r.op === "promote") await snapshot(db, item.kind, item.id, r.author_id, ctx.actor.id, r.summary);
    if (r.op === "share" && typeof result.library_copy_id === "string") await snapshot(db, item.kind, result.library_copy_id, r.author_id, ctx.actor.id, r.summary);

    await db.query("UPDATE revisions SET state = 'approved', reviewer_id = $2, decided_at = now(), decided_via = $3 WHERE id = $1", [id, ctx.actor.id, check ? decidedVia(ctx) : null]);
    // An author's own write published as it's made (a personal space among them) records no title or summary, so a
    // private note's never reaches the audit log.
    await audit(
      db,
      ctx.actor.id,
      "approve_revision",
      r.target_id,
      check
        ? {
            targetKind: item.kind === "article" ? "article" : "finding",
            targetLabel: item.title,
            details: { revision_id: id, op: r.op, summary: r.summary, ...viaDetails(ctx), ...(edits && Object.values(edits).some((v) => v !== undefined) ? { edited: true } : {}) },
          }
        : {},
    );
    return { revision_id: id, state: "approved", ...result };
  });
}

/**
 * A move runs the same path as a person's move (approval rights in both scopes,
 * search index, open proposals and files follow the item), then closes the proposal.
 */
async function approveMove(ctx: RequestContext, r: RevisionRow, edits?: ReviewerEdits, check: { confirmed?: boolean } | null = null) {
  if (r.state !== "pending") throw new ValidationError(`revision is already ${r.state}`);
  if (edits && Object.values(edits).some((v) => v !== undefined)) throw new ValidationError("a move can't be edited; reject it and move the item yourself");
  await assertReviewerMay(ctx, r, check);
  const item = await findItem(ctx.db, r.target_id);
  const from = (await ctx.db.query<{ slug: string }>("SELECT slug FROM scopes WHERE id = $1", [item.scope_id])).rows[0]!.slug;
  const p = r.payload as { to: string; folder: string | null; repo: string | null };
  const moved = await moveItems(ctx, {
    from,
    to: p.to,
    ids: [item.id],
    ...(item.kind === "article" ? { into_folder: p.folder ?? (from === p.to ? undefined : "") } : {}),
    ...(p.repo ? { component: p.repo } : from !== p.to ? { component: "" } : {}),
  });
  const { rowCount } = await ctx.db.query("UPDATE revisions SET state = 'approved', reviewer_id = $2, decided_at = now(), decided_via = $3 WHERE id = $1 AND state = 'pending'", [r.id, ctx.actor.id, check ? decidedVia(ctx) : null]);
  if (!rowCount) throw new ValidationError("revision was decided while moving");
  await audit(
    ctx.db,
    ctx.actor.id,
    "approve_revision",
    r.target_id,
    check ? { targetKind: item.kind === "article" ? "article" : "finding", targetLabel: item.title, details: { revision_id: r.id, op: r.op, summary: r.summary, moved_to: p.to, ...viaDetails(ctx) } } : {},
  );
  return { revision_id: r.id, state: "approved", moved_to: p.to, moved: moved.moved };
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
  await assertClaudeMayDecide(ctx, "rejecting a proposal");
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
    await db.query("UPDATE revisions SET state = 'rejected', reviewer_id = $2, reason = $3, decided_at = now(), decided_via = $4 WHERE id = $1", [
      id,
      ctx.actor.id,
      reason.trim(),
      decidedVia(ctx),
    ]);
    const item = await findItem(db, r.target_id);
    // Never a personal space's title or summary (see approveInTx).
    const personal = (await db.query<{ kind: string }>("SELECT kind FROM scopes WHERE id = $1", [r.scope_id])).rows[0]?.kind === "personal";
    await audit(
      db,
      ctx.actor.id,
      "reject_revision",
      r.target_id,
      personal
        ? {}
        : {
            targetKind: item.kind === "article" ? "article" : "finding",
            targetLabel: item.title,
            details: { revision_id: id, op: r.op, summary: r.summary, reason: reason.trim().slice(0, 300), ...viaDetails(ctx) },
          },
    );
    return { revision_id: id, state: "rejected" };
  });
}

// ---------------------------------------------------------------------------

type Tx = pg.PoolClient;

/** Applies a reviewer's corrections to the proposal (redacted like any write) before it is approved. */
async function applyReviewerEdits(db: Tx, r: RevisionRow, item: { kind: string; id: string; scope_id: string }, edits: ReviewerEdits) {
  const clean = (v?: string) => (v === undefined ? undefined : redact(v).text);
  if (r.op === "create" && item.kind === "article") {
    const { rows } = await db.query(
      "UPDATE articles SET title = coalesce($2, title), body_md = coalesce($3, body_md) WHERE id = $1 RETURNING id, scope_id, title, body_md",
      [item.id, clean(edits.title?.trim()) || null, clean(edits.body_md) ?? null],
    );
    await reindexArticle(db, rows[0]);
  } else if (r.op === "create" && item.kind === "finding") {
    const p = edits.patch ?? {};
    const { rows } = await db.query(
      `UPDATE findings SET title = coalesce($2, title), symptoms = coalesce($3, symptoms), root_cause = coalesce($4, root_cause), fix = coalesce($5, fix)
        WHERE id = $1 RETURNING id, scope_id, title, symptoms, root_cause, fix`,
      [item.id, clean(p.title?.trim()) || null, clean(p.symptoms) ?? null, clean(p.root_cause) ?? null, clean(p.fix) ?? null],
    );
    await reindexFinding(db, rows[0]);
  } else if ((r.op === "update" || r.op === "promote") && item.kind === "article") {
    if (edits.body_md !== undefined) r.payload.text = clean(edits.body_md);
    if (edits.title !== undefined) r.payload.title = clean(edits.title.trim());
  } else if (r.op === "update" && item.kind === "finding") {
    const p = Object.fromEntries(Object.entries(edits.patch ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v)]));
    r.payload.patch = { ...r.payload.patch, ...p };
  } else {
    throw new ValidationError(`a '${r.op}' proposal can't be edited before approval`);
  }
  r.payload.reviewer_edited = true;
  await db.query("UPDATE revisions SET payload = $2 WHERE id = $1", [r.id, JSON.stringify(r.payload)]);
}

/** Stores the item's current content as a version snapshot. */
export async function snapshot(db: Queryable, kind: string, id: string, authorId: string | null, approverId: string | null, summary: string) {
  const sql =
    kind === "article"
      ? `INSERT INTO item_versions (target_kind, target_id, version, title, content, summary, author_id, approver_id)
         SELECT 'article', id, version, title, jsonb_build_object('body_md', body_md, 'tags', tags), $2, $3, $4 FROM articles WHERE id = $1
         ON CONFLICT (target_id, version) DO NOTHING`
      : `INSERT INTO item_versions (target_kind, target_id, version, title, content, summary, author_id, approver_id)
         SELECT 'finding', id, version, title, jsonb_build_object('symptoms', symptoms, 'root_cause', root_cause, 'fix', fix, 'tags', tags), $2, $3, $4 FROM findings WHERE id = $1
         ON CONFLICT (target_id, version) DO NOTHING`;
  await db.query(sql, [id, summary, authorId, approverId]);
}

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
  // Tags the proposal set (replaced, or with some added and removed): normalised when it was proposed.
  const tags = Array.isArray(r.payload.tags) ? (r.payload.tags as string[]) : null;
  const { rows } = await db.query(
    `UPDATE articles SET body_md = $2, title = coalesce($3, title), tags = coalesce($4::text[], tags), version = version + 1, updated_at = now(), last_verified_at = now(),
            status = CASE WHEN status = 'possibly_stale' THEN 'published' ELSE status END
      WHERE id = $1 RETURNING id, scope_id, title, body_md, version, status`,
    [item.id, body, r.payload.title ?? null, tags],
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
