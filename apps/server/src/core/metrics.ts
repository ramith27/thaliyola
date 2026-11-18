import type { RequestContext } from "./context.js";
import { ForbiddenError } from "./context.js";
import { can, readableScopes } from "./permissions.js";

/**
 * Is the knowledge base working? Numbers for the Metrics page: whether
 * agents and people find answers, reuse what exists instead of re-solving
 * it, how fast reviews go, which problems keep coming back, and what needs
 * an owner or a re-check. Knowledge gaps (searches that found nothing) are
 * admins-only because they show what people searched for.
 */

const VERIFY_TOOLS = ["verify_entry", "api:verify_entry"];
const PROPOSE_TOOLS = ["propose_finding", "create_article", "api:create_finding", "api:create_article"];
const READ_TOOLS = ["get_article", "get_finding", "get_project_context", "get_component_context", "get_contract", "get_design"];

export async function successMetrics(ctx: RequestContext, opts: { days?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 90, 7), 365);
  const readable = await readableScopes(ctx);
  const db = ctx.db;

  const reuse = (
    await db.query(
      `SELECT count(*) FILTER (WHERE tool = ANY($2))::int AS verifications,
              count(*) FILTER (WHERE tool = ANY($3))::int AS proposals,
              count(*) FILTER (WHERE tool = ANY($4))::int AS agent_reads,
              count(*) FILTER (WHERE tool = 'search_knowledge')::int AS agent_searches
         FROM audit_log WHERE at > now() - make_interval(days => $1)`,
      [days, VERIFY_TOOLS, PROPOSE_TOOLS, READ_TOOLS],
    )
  ).rows[0];

  const search = (
    await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE results > 0)::int AS answered,
              count(*) FILTER (WHERE keyword_hits > 0)::int AS keyword_answered,
              count(*) FILTER (WHERE source = 'mcp')::int AS from_agents,
              count(*) FILTER (WHERE source = 'mcp' AND results > 0)::int AS agents_answered
         FROM search_log WHERE at > now() - make_interval(days => $1)`,
      [days],
    )
  ).rows[0];

  // Weekly trend (12 weeks): searches answered, reuse and new knowledge.
  const weekly = await db.query(
    `WITH weeks AS (SELECT generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS week)
     SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
            (SELECT count(*) FROM search_log s WHERE date_trunc('week', s.at) = w.week)::int AS searches,
            (SELECT count(*) FROM search_log s WHERE date_trunc('week', s.at) = w.week AND s.results > 0)::int AS answered,
            (SELECT count(*) FROM audit_log l WHERE date_trunc('week', l.at) = w.week AND l.tool = ANY($1))::int AS verifications,
            (SELECT count(*) FROM audit_log l WHERE date_trunc('week', l.at) = w.week AND l.tool = ANY($2))::int AS proposals
       FROM weeks w ORDER BY w.week`,
    [VERIFY_TOOLS, PROPOSE_TOOLS],
  );

  const review = (
    await db.query(
      `SELECT round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY decided_at - created_at)) / 3600)::numeric, 1)::float AS median_hours,
              round((extract(epoch FROM percentile_cont(0.9) WITHIN GROUP (ORDER BY decided_at - created_at)) / 3600)::numeric, 1)::float AS p90_hours,
              count(*)::int AS decided,
              (SELECT count(*) FROM revisions WHERE state = 'pending' AND ($2::uuid[] IS NULL OR scope_id = ANY($2)))::int AS pending,
              (SELECT round((extract(epoch FROM now() - min(created_at)) / 86400)::numeric, 1) FROM revisions WHERE state = 'pending' AND ($2::uuid[] IS NULL OR scope_id = ANY($2)))::float AS oldest_pending_days
         FROM revisions
        WHERE decided_at > now() - make_interval(days => $1) AND ($2::uuid[] IS NULL OR scope_id = ANY($2))`,
      [days, readable],
    )
  ).rows[0];

  // Problems that keep coming back: findings with the most "same root cause" links, counted both ways.
  const repeats = await db.query(
    `SELECT f.id, f.title, f.type, s.slug AS scope, count(*)::int AS occurrences, max(o.created_at) AS last_seen
       FROM findings f
       JOIN scopes s ON s.id = f.scope_id
       JOIN relations r ON r.kind = 'same_root_cause' AND (r.from_id = f.id OR r.to_id = f.id)
       JOIN findings o ON o.id = CASE WHEN r.from_id = f.id THEN r.to_id ELSE r.from_id END
      WHERE f.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1))
      GROUP BY f.id, s.slug ORDER BY occurrences DESC, last_seen DESC LIMIT 8`,
    [readable],
  );

  const hygiene = (
    await db.query(
      `SELECT (SELECT count(*) FROM articles WHERE owner_id IS NULL AND status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1)))::int AS unowned_articles,
              (SELECT count(*) FROM (SELECT id FROM articles WHERE status = 'possibly_stale' AND ($1::uuid[] IS NULL OR scope_id = ANY($1))
                                     UNION ALL SELECT id FROM findings WHERE status = 'possibly_stale' AND ($1::uuid[] IS NULL OR scope_id = ANY($1))) x)::int AS stale,
              (SELECT count(*) FROM articles WHERE status = 'published' AND review_due < current_date AND ($1::uuid[] IS NULL OR scope_id = ANY($1)))::int AS overdue_reviews,
              (SELECT count(*) FROM (SELECT id FROM articles WHERE status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1))
                                     UNION ALL SELECT id FROM findings WHERE status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1))) y)::int AS total`,
      [readable],
    )
  ).rows[0];
  const unowned = await db.query(
    `SELECT a.id, a.title, a.type, s.slug AS scope, a.updated_at FROM articles a JOIN scopes s ON s.id = a.scope_id
      WHERE a.owner_id IS NULL AND a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1))
      ORDER BY a.updated_at LIMIT 8`,
    [readable],
  );

  const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  // Sessions helping each other (questions in projects the caller can read, or their own): measured, not estimated.
  const sessions = (
    await db.query(
      `SELECT count(DISTINCT coalesce(q.group_id, q.id))::int AS asked,
              count(*) FILTER (WHERE q.status = 'answered' AND q.kind = 'question')::int AS answered,
              count(*) FILTER (WHERE q.status = 'answered' AND q.kind = 'question' AND q.answered_by_session_id IS NOT NULL)::int AS answered_by_sessions,
              count(*) FILTER (WHERE q.status = 'answered' AND q.kind = 'question' AND q.answered_by_session_id IS NULL)::int AS answered_by_people,
              count(*) FILTER (WHERE q.status = 'answered' AND q.kind = 'question' AND q.answered_at - q.created_at <= interval '45 seconds')::int AS within_wait,
              count(*) FILTER (WHERE q.status = 'declined')::int AS declined,
              count(*) FILTER (WHERE q.status = 'expired')::int AS expired,
              count(*) FILTER (WHERE q.saved_item_id IS NOT NULL)::int AS saved_as_findings,
              count(*) FILTER (WHERE q.kind = 'handoff')::int AS handoffs,
              count(*) FILTER (WHERE q.kind = 'handoff' AND q.status = 'answered')::int AS handoffs_accepted,
              round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY q.answered_at - q.created_at) FILTER (WHERE q.status = 'answered' AND q.kind = 'question')))::numeric)::int AS median_answer_seconds,
              count(DISTINCT q.from_user_id)::int AS people_asking
         FROM session_questions q LEFT JOIN agent_sessions ts ON ts.id = q.to_session_id
        WHERE q.created_at > now() - make_interval(days => $1)
          AND ($2::uuid[] IS NULL OR q.from_user_id = $3 OR q.to_user_id = $3 OR ts.user_id = $3 OR coalesce(q.to_scope_id, ts.scope_id) = ANY($2))`,
      [days, readable, ctx.actor.id],
    )
  ).rows[0];
  const claims = (
    await db.query(
      `SELECT count(DISTINCT c.session_id)::int AS sessions_claiming, count(*)::int AS files_claimed
         FROM work_claims c JOIN agent_sessions s ON s.id = c.session_id
        WHERE c.created_at > now() - make_interval(days => $1) AND ($2::uuid[] IS NULL OR s.user_id = $3 OR s.scope_id = ANY($2))`,
      [days, readable, ctx.actor.id],
    )
  ).rows[0];

  return {
    days,
    sessions: { ...sessions, answer_rate: rate(sessions.answered, sessions.answered + sessions.declined + sessions.expired), ...claims },
    reuse: { ...reuse, rate: rate(reuse.verifications, reuse.verifications + reuse.proposals) },
    search: {
      ...search,
      hit_rate: rate(search.answered, search.total),
      keyword_hit_rate: rate(search.keyword_answered, search.total),
      agent_hit_rate: rate(search.agents_answered, search.from_agents),
    },
    weekly: weekly.rows,
    review,
    repeats: repeats.rows,
    hygiene,
    unowned: unowned.rows,
    gaps_visible: can(ctx, "view_metrics"),
  };
}

/**
 * Searches that matched nothing by keyword, grouped by what was typed.
 * "none" means nothing at all came back; "loose" means only meaning-based
 * matches did, which often aren't the answer.
 */
export async function knowledgeGaps(ctx: RequestContext, opts: { days?: number } = {}) {
  if (!can(ctx, "view_metrics")) throw new ForbiddenError("knowledge gaps show what people searched for; admins and auditors only");
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const { rows } = await ctx.db.query(
    `SELECT lower(query) AS query, count(*)::int AS searches, count(DISTINCT actor_id)::int AS people,
            bool_and(results = 0) AS no_results, max(at) AS last_searched,
            count(*) FILTER (WHERE source = 'mcp')::int AS from_agents
       FROM search_log
      WHERE query IS NOT NULL AND at > now() - make_interval(days => $1)
      GROUP BY lower(query) ORDER BY searches DESC, last_searched DESC LIMIT 50`,
    [days],
  );
  return { days, gaps: rows.map((r) => ({ ...r, kind: r.no_results ? "none" : "loose" })) };
}

/** Dismisses a gap once it's been answered (or was noise): its logged searches lose their text. */
export async function dismissGap(ctx: RequestContext, query: string) {
  if (!can(ctx, "view_metrics")) throw new ForbiddenError("admins only");
  const { rowCount } = await ctx.db.query("UPDATE search_log SET query = NULL WHERE lower(query) = lower($1)", [query]);
  return { query, cleared: rowCount };
}
