import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { notify, reviewersFor } from "./notify.js";
import { canApprove, readableScopes } from "./permissions.js";
import { relate } from "./bootstrap.js";

/**
 * Decisions that get revisited and checked against each other. Every new decision gets a revisit date (six months,
 * migration 080); when any article's review date passes, its owner (else the project's reviewers) is told once.
 * Decisions whose "Choice" sections say nearly the same thing about the same subject are suggested as possible
 * conflicts, so someone marks one superseded or says they don't conflict. Similarity only finds candidates; people decide.
 */

/** Tells owners about articles whose review (revisit) date has passed, once per date. */
export async function notifyReviewsDue(db: Db, settings: Settings) {
  const { rows } = await db.query<{ id: string; title: string; type: string; owner_id: string | null; scope_id: string; review_due: string }>(
    `UPDATE articles SET review_notified_at = now()
      WHERE status IN ('published', 'possibly_stale') AND review_due IS NOT NULL AND review_due < current_date
        AND (review_notified_at IS NULL OR review_notified_at::date < review_due)
      RETURNING id, title, type, owner_id, scope_id, review_due::text`,
  );
  for (const a of rows) {
    const to = a.owner_id ? [a.owner_id] : await reviewersFor(db, settings, a.scope_id);
    await notify(db, settings, to, {
      kind: "stale",
      title: `Time to revisit${a.type === "decision" ? " the decision" : ""}: ${a.title}`,
      body: `Its review date (${a.review_due}) has passed. Confirm it still holds, update it, or mark it superseded.`,
      link: `#/article/${a.id}`,
      targetId: a.id,
      scopeId: a.scope_id,
    });
  }
  return rows.length;
}

/** Sets an article's revisit date (a date, or months from today). Its owner, or someone who reviews in its project. */
export async function setRevisitDate(ctx: RequestContext, input: { id: string; date?: string; months?: number }) {
  const a = (await ctx.db.query<{ id: string; scope_id: string; owner_id: string | null; title: string }>("SELECT id, scope_id, owner_id, title FROM articles WHERE id = $1 AND status <> 'deleted'", [input.id])).rows[0];
  const readable = await readableScopes(ctx);
  if (!a || (readable !== null && !readable.includes(a.scope_id))) throw new NotFoundError(`article ${input.id}`);
  if (a.owner_id !== ctx.actor.id && !(await canApprove(ctx, a.scope_id))) throw new ForbiddenError("its owner, or someone who reviews in its project, sets when it's revisited");
  let date: string;
  if (input.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new ValidationError("date is YYYY-MM-DD");
    date = input.date;
  } else {
    const m = Math.round(input.months ?? 6);
    if (m < 1 || m > 36) throw new ValidationError("months is 1 to 36");
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + m);
    date = d.toISOString().slice(0, 10);
  }
  await ctx.db.query("UPDATE articles SET review_due = $2::date, review_notified_at = NULL WHERE id = $1", [a.id, date]);
  await audit(ctx.db, ctx.actor.id, "set_revisit_date", a.id, { targetKind: "article", targetLabel: a.title, details: { review_due: date } });
  emitChanged();
  return { id: a.id, review_due: date };
}

/** Decisions in the same project (or the Library) whose Choice reads like this text: shown before recording a new one. */
export async function similarDecisions(ctx: RequestContext, scopeId: string, text: string, limit = 3) {
  if (!ctx.embedder || !text.trim()) return [];
  const v = await ctx.embedder.embedQuery(text.slice(0, 2000));
  const { rows } = await ctx.db.query<{ id: string; title: string; similarity: number }>(
    `SELECT a.id, a.title, round((1 - (c.embedding <=> $1::vector))::numeric, 3)::float AS similarity
       FROM chunks c JOIN articles a ON a.id = c.parent_id
      WHERE c.parent_kind = 'article' AND c.heading = 'Choice' AND c.embedding_model = $2 AND a.type = 'decision' AND a.status IN ('published', 'possibly_stale')
        AND (a.scope_id = $3 OR a.scope_id IN (SELECT id FROM scopes WHERE kind = 'library'))
        AND 1 - (c.embedding <=> $1::vector) >= $4
      ORDER BY similarity DESC LIMIT $5`,
    [`[${v.join(",")}]`, ctx.embedder.model, scopeId, Math.max(ctx.settings.duplicateSimilarity - 0.1, 0.5), limit],
  );
  return rows;
}

/** Possible conflicts: pairs of decisions whose choices are about the same thing, not linked and not dismissed. */
export async function decisionConflicts(ctx: RequestContext, scopeIds: string[] | null, limit = 20) {
  if (!ctx.embedder) return [];
  const { rows } = await ctx.db.query(
    `SELECT a.parent_id AS a_id, da.title AS a_title, sa.slug AS a_scope, b.parent_id AS b_id, db.title AS b_title, sb.slug AS b_scope,
            round((1 - (a.embedding <=> b.embedding))::numeric, 3)::float AS similarity
       FROM chunks a
       JOIN chunks b ON b.parent_kind = 'article' AND b.heading = 'Choice' AND a.parent_id < b.parent_id AND b.embedding_model = a.embedding_model
       JOIN articles da ON da.id = a.parent_id JOIN scopes sa ON sa.id = da.scope_id
       JOIN articles db ON db.id = b.parent_id JOIN scopes sb ON sb.id = db.scope_id
      WHERE a.parent_kind = 'article' AND a.heading = 'Choice' AND a.embedding_model = $3
        AND da.type = 'decision' AND db.type = 'decision' AND da.status IN ('published', 'possibly_stale') AND db.status IN ('published', 'possibly_stale')
        AND (da.scope_id = db.scope_id OR sa.kind = 'library' OR sb.kind = 'library')
        AND ($1::uuid[] IS NULL OR (da.scope_id = ANY($1) AND db.scope_id = ANY($1)))
        AND 1 - (a.embedding <=> b.embedding) >= $4
        AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.kind IN ('supersedes', 'related') AND ((r.from_id = da.id AND r.to_id = db.id) OR (r.from_id = db.id AND r.to_id = da.id)))
        AND NOT EXISTS (SELECT 1 FROM decision_conflict_dismissals d WHERE d.a = least(da.id, db.id) AND d.b = greatest(da.id, db.id))
      ORDER BY similarity DESC LIMIT $2`,
    [scopeIds, limit, ctx.embedder.model, Math.max(ctx.settings.duplicateSimilarity - 0.1, 0.5)],
  );
  return rows.map((r) => ({ similarity: r.similarity, a: { id: r.a_id, title: r.a_title, scope: r.a_scope }, b: { id: r.b_id, title: r.b_title, scope: r.b_scope } }));
}

/** A reviewer's answer to a possible conflict: one supersedes the other, or they don't conflict. */
export async function resolveConflict(ctx: RequestContext, input: { a: string; b: string; outcome: "supersedes" | "not_a_conflict" }) {
  const rows = (await ctx.db.query<{ id: string; scope_id: string }>("SELECT id, scope_id FROM articles WHERE id = ANY($1) AND type = 'decision'", [[input.a, input.b]])).rows;
  if (rows.length !== 2) throw new NotFoundError("those two decisions");
  for (const r of rows) if (!(await canApprove(ctx, r.scope_id))) throw new ForbiddenError("people who review in both projects resolve a conflict");
  if (input.outcome === "supersedes") {
    // a supersedes b: the newer choice wins; b is marked superseded.
    await relate(ctx.db, { kind: "article", id: input.a }, "supersedes", { kind: "article", id: input.b });
    await ctx.db.query("UPDATE articles SET status = 'superseded' WHERE id = $1 AND status IN ('published', 'possibly_stale')", [input.b]);
  } else {
    await ctx.db.query("INSERT INTO decision_conflict_dismissals (a, b, dismissed_by) VALUES (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), $3) ON CONFLICT DO NOTHING", [input.a, input.b, ctx.actor.id]);
  }
  await audit(ctx.db, ctx.actor.id, "resolve_decision_conflict", input.a, { targetKind: "article", details: { other: input.b, outcome: input.outcome } });
  emitChanged();
  return { a: input.a, b: input.b, outcome: input.outcome };
}
