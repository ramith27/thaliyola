import type { RequestContext } from "./context.js";
import { ForbiddenError } from "./context.js";
import { isAdmin, readableScopes } from "./permissions.js";

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
  return {
    days,
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
    gaps_visible: isAdmin(ctx),
  };
}

/**
 * Searches that matched nothing by keyword, grouped by what was typed.
 * "none" means nothing at all came back; "loose" means only meaning-based
 * matches did, which often aren't the answer.
 */
export async function knowledgeGaps(ctx: RequestContext, opts: { days?: number } = {}) {
  if (!isAdmin(ctx)) throw new ForbiddenError("knowledge gaps show what people searched for; admins only");
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
  if (!isAdmin(ctx)) throw new ForbiddenError("admins only");
  const { rowCount } = await ctx.db.query("UPDATE search_log SET query = NULL WHERE lower(query) = lower($1)", [query]);
  return { query, cleared: rowCount };
}
