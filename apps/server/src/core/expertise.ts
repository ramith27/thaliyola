import type { Queryable } from "../db/pool.js";
import { ValidationError, type RequestContext } from "./context.js";
import { readableScopes } from "./permissions.js";

/**
 * Who knows what: scores per person and topic (a project, a repository, an entity such as a service or a table, a
 * tag), worked out from what they did, never from what they say about themselves. Rebuilt nightly; signals decay with
 * a 180-day half-life. Personal spaces, service accounts and people who opted out (prefs.hide_expertise) never count.
 */

/** Weights per signal: writing and owning count most, answering a question about as much as reviewing. */
const WEIGHTS = { authored: 3, approved: 1.5, reviewed: 1.5, commented: 0.5, answered: 2, documented: 2, owns: 2 };

/** Rebuilds the table from scratch (in one statement, so readers never see it half-built). */
export async function rebuildExpertise(db: Queryable) {
  await db.query(`
    WITH signal AS (
      SELECT v.author_id AS user_id, v.target_kind AS item_kind, v.target_id AS item_id, ${WEIGHTS.authored}::real AS w, 'authored' AS why, v.created_at AS at FROM item_versions v WHERE v.author_id IS NOT NULL
      UNION ALL SELECT v.approver_id, v.target_kind, v.target_id, ${WEIGHTS.approved}, 'approved', v.created_at FROM item_versions v WHERE v.approver_id IS NOT NULL AND v.approver_id IS DISTINCT FROM v.author_id
      UNION ALL SELECT r.reviewer_id, r.target_kind, r.target_id, ${WEIGHTS.reviewed}, 'reviewed', r.decided_at FROM revisions r WHERE r.reviewer_id IS NOT NULL AND r.decided_at IS NOT NULL AND r.target_id IS NOT NULL
      UNION ALL SELECT c.author_id, r.target_kind, r.target_id, ${WEIGHTS.commented}, 'commented', c.created_at FROM revision_comments c JOIN revisions r ON r.id = c.revision_id WHERE r.target_id IS NOT NULL
      UNION ALL SELECT a.owner_id, 'article', a.id, ${WEIGHTS.owns}, 'owns', coalesce(a.last_verified_at, a.updated_at) FROM articles a WHERE a.owner_id IS NOT NULL
    ),
    item AS (
      SELECT 'article' AS kind, id, scope_id, component_ids, tags, status FROM articles
      UNION ALL SELECT 'finding', id, scope_id, component_ids, tags, status FROM findings
    ),
    weighted AS (
      SELECT s.user_id, i.scope_id, i.kind AS item_kind, i.id AS item_id, i.component_ids, i.tags, s.why,
             s.w * power(0.5, greatest(extract(epoch FROM now() - s.at) / 86400.0, 0) / 180.0) AS w
        FROM signal s JOIN item i ON i.kind = s.item_kind AND i.id = s.item_id
       WHERE i.status NOT IN ('deleted', 'draft')
      UNION ALL
      -- Answers: count for the project (and the repository) the question went to, or the answering session's.
      SELECT q.answered_by_user_id, coalesce(q.to_scope_id, sess.scope_id), 'question', q.id,
             coalesce(ARRAY(SELECT c.id FROM components c WHERE c.scope_id = coalesce(q.to_scope_id, sess.scope_id) AND c.slug = coalesce(q.to_component, sess.component)), '{}'),
             '{}', 'answered', ${WEIGHTS.answered} * power(0.5, extract(epoch FROM now() - q.answered_at) / 86400.0 / 180.0)
        FROM session_questions q LEFT JOIN agent_sessions sess ON sess.id = q.answered_by_session_id
       WHERE q.status = 'answered' AND q.kind = 'question' AND q.answered_by_user_id IS NOT NULL AND coalesce(q.to_scope_id, sess.scope_id) IS NOT NULL
      UNION ALL
      SELECT d.started_by, d.scope_id, 'doc_run', d.id, CASE WHEN d.component_id IS NULL THEN '{}' ELSE ARRAY[d.component_id] END, '{}', 'documented',
             ${WEIGHTS.documented} * power(0.5, extract(epoch FROM now() - d.started_at) / 86400.0 / 180.0)
        FROM doc_runs d WHERE d.started_by IS NOT NULL AND d.status = 'finished'
    ),
    eligible AS (
      SELECT w.* FROM weighted w
        JOIN users u ON u.id = w.user_id AND u.kind = 'human' AND u.disabled_at IS NULL AND coalesce((u.prefs->>'hide_expertise')::boolean, false) = false
        JOIN scopes s ON s.id = w.scope_id AND s.kind <> 'personal' AND s.status = 'active'
    ),
    topics AS (
      SELECT user_id, scope_id, 'project' AS topic_kind, scope_id::text AS topic, why, w FROM eligible
      UNION ALL SELECT user_id, scope_id, 'component', unnest(component_ids)::text, why, w FROM eligible
      UNION ALL SELECT user_id, scope_id, 'tag', lower(unnest(tags)), why, w FROM eligible
      UNION ALL SELECT e.user_id, e.scope_id, 'entity', l.entity_id::text, e.why, e.w FROM eligible e JOIN entity_links l ON l.target_kind = e.item_kind AND l.target_id = e.item_id
    ),
    summed AS (
      SELECT user_id, scope_id, topic_kind, topic, sum(w)::real AS score, jsonb_object_agg(why, n) AS evidence
        FROM (SELECT user_id, scope_id, topic_kind, topic, why, sum(w) AS w, count(*) AS n FROM topics WHERE topic <> '' GROUP BY 1, 2, 3, 4, 5) x
       GROUP BY 1, 2, 3, 4 HAVING sum(w) >= 0.25
    ),
    labelled AS (
      SELECT s.*, coalesce(
               CASE s.topic_kind WHEN 'project' THEN (SELECT name FROM scopes WHERE id::text = s.topic)
                                 WHEN 'component' THEN (SELECT sc.slug || '/' || c.slug FROM components c JOIN scopes sc ON sc.id = c.scope_id WHERE c.id::text = s.topic)
                                 WHEN 'entity' THEN (SELECT name FROM entities WHERE id::text = s.topic)
                                 ELSE s.topic END, s.topic) AS label
        FROM summed s
    ),
    gone AS (DELETE FROM expertise)
    INSERT INTO expertise (user_id, scope_id, topic_kind, topic, label, score, evidence) SELECT user_id, scope_id, topic_kind, topic, label, score, evidence FROM labelled`);
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM expertise")).rows[0]!.n;
}

export interface Expert {
  user_id: string;
  name: string;
  email: string | null;
  score: number;
  topics: string[];
  online_sessions: string[];
}

/**
 * The people who know most about a topic: a project slug, project/repository, an entity name or a tag (or free words
 * matched against those). Only from projects the caller can read.
 */
export async function findExperts(ctx: RequestContext, input: { topic?: string; project?: string; component?: string; limit?: number }): Promise<{ topic: string; experts: Expert[] }> {
  const readable = await readableScopes(ctx);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  let where: string;
  let params: unknown[];
  let topic: string;
  if (input.project) {
    const scope = (await ctx.db.query<{ id: string; slug: string }>("SELECT id, slug FROM scopes WHERE slug = $1 AND status = 'active'", [input.project])).rows[0];
    if (!scope || (readable !== null && !readable.includes(scope.id))) return { topic: input.project, experts: [] };
    if (input.component) {
      const c = (await ctx.db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, input.component])).rows[0];
      if (!c) return { topic: `${input.project}/${input.component}`, experts: [] };
      where = "x.topic_kind = 'component' AND x.topic = $3";
      params = [c.id];
      topic = `${scope.slug}/${input.component}`;
    } else {
      where = "x.topic_kind = 'project' AND x.topic = $3";
      params = [scope.id];
      topic = scope.slug;
    }
  } else {
    const t = (input.topic ?? "").trim().toLowerCase();
    if (!t) throw new ValidationError("say what about: a topic (a service, table, tag…), or a project");
    where = "(lower(x.label) = $3 OR lower(x.label) LIKE '%' || $3 || '%' OR (x.topic_kind = 'tag' AND x.topic = $3))";
    params = [t];
    topic = t;
  }
  const { rows } = await ctx.db.query<Expert>(
    `SELECT x.user_id, coalesce(u.display_name, u.email) AS name, u.email, round(sum(x.score)::numeric, 1)::float AS score,
            (array_agg(DISTINCT x.label))[1:4] AS topics,
            coalesce((SELECT array_agg(s.handle) FROM agent_sessions s WHERE s.user_id = x.user_id AND s.visibility = 'project' AND s.ended_at IS NULL
                        AND s.last_seen_at > now() - interval '3 minutes' AND ($1::uuid[] IS NULL OR s.scope_id = ANY($1))), '{}') AS online_sessions
       FROM expertise x JOIN users u ON u.id = x.user_id
      WHERE ($1::uuid[] IS NULL OR x.scope_id = ANY($1)) AND ${where} AND x.user_id <> $2
      GROUP BY x.user_id, u.display_name, u.email ORDER BY sum(x.score) DESC LIMIT ${limit}`,
    [readable, ctx.actor.id, ...params],
  );
  return { topic, experts: rows };
}

/** What a person knows about (their page), from projects the caller can read. */
export async function knowsAbout(ctx: RequestContext, userId: string, limit = 10) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query<{ topic_kind: string; label: string; score: number }>(
    `SELECT topic_kind, label, round(sum(score)::numeric, 1)::float AS score FROM expertise
      WHERE user_id = $1 AND ($2::uuid[] IS NULL OR scope_id = ANY($2)) AND topic_kind <> 'project'
      GROUP BY topic_kind, label ORDER BY sum(score) DESC LIMIT $3`,
    [userId, readable, limit],
  );
  return rows;
}
