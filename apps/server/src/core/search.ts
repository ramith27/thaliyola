import type { RequestContext } from "./context.js";
import { ValidationError } from "./context.js";
import { resolveScopeFilter } from "./scopes.js";

export interface SearchInput {
  query: string;
  scope?: string;
  project?: string;
  types?: string[];
  statuses?: string[];
  entity?: string;
  tags?: string[];
  updatedAfter?: string;
  limit?: number;
}

export interface SearchHit {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  status: string;
  section: string | null;
  snippet: string;
  scope: { slug: string; kind: string };
  via_uses_link: boolean;
  last_verified_at: string | null;
  updated_at: string;
  score: number;
  warning?: string;
}

/** Hidden unless asked for: drafts are unreviewed, superseded/rejected are history. */
const DEFAULT_STATUSES = ["published", "possibly_stale"];

/**
 * Keyword search over article sections and findings (Postgres FTS).
 *
 * Terms are OR-ed so a symptom phrased differently still matches; chunks that
 * match every term get a boost. Results keep the best chunk per item, then
 * list article sections before findings (source of truth first).
 */
export async function searchKnowledge(ctx: RequestContext, input: SearchInput): Promise<{ articles: SearchHit[]; findings: SearchHit[] }> {
  const query = input.query.trim();
  if (!query) throw new ValidationError("query must not be empty");
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);
  const filter = await resolveScopeFilter(ctx, input.scope, input.project);

  const params: unknown[] = [query];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const where: string[] = ["c.tsv @@ q.any_term"];
  let usesLinked = "false";
  if (filter.mode === "ids") {
    const scopeIds = p(filter.scopeIds);
    if (filter.currentProjectId) {
      // Items in other scopes that the current project (or one of its items) declared it `uses`.
      const projectId = p(filter.currentProjectId);
      usesLinked = `c.parent_id IN (
        SELECT r.to_id FROM relations r
         WHERE r.kind = 'uses'
           AND (r.from_id = ${projectId}
                OR r.from_id IN (SELECT id FROM articles WHERE scope_id = ${projectId})
                OR r.from_id IN (SELECT id FROM findings WHERE scope_id = ${projectId})))`;
    }
    where.push(`(c.scope_id = ANY(${scopeIds}::uuid[]) OR ${usesLinked})`);
  }
  where.push(`coalesce(a.status, f.status) = ANY(${p(input.statuses?.length ? input.statuses : DEFAULT_STATUSES)}::text[])`);
  if (input.types?.length) where.push(`coalesce(a.type, f.type) = ANY(${p(input.types)}::text[])`);
  if (input.tags?.length) where.push(`coalesce(a.tags, f.tags) && ${p(input.tags)}::text[]`);
  if (input.updatedAfter) where.push(`coalesce(a.updated_at, f.updated_at) >= ${p(input.updatedAfter)}::timestamptz`);
  if (input.entity) {
    const e = p(input.entity.toLowerCase());
    where.push(`EXISTS (SELECT 1 FROM entity_links el JOIN entities en ON en.id = el.entity_id
                         WHERE el.target_id = c.parent_id
                           AND (lower(en.name) = ${e} OR ${e} = ANY(SELECT lower(x) FROM unnest(en.aliases) x)))`);
  }
  const currentProject = filter.mode === "ids" && filter.currentProjectId ? p(filter.currentProjectId) : "NULL";
  const limitParam = p(limit);

  const sql = `
    WITH q AS (
      SELECT to_tsquery('simple', coalesce(string_agg(t, ' | '), '')) AS any_term,
             websearch_to_tsquery('english', $1) AS all_terms
        FROM (SELECT regexp_replace(l, '[^[:alnum:]_]', '', 'g') AS t
                FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS l) terms
       WHERE t <> ''
    ),
    scored AS (
      SELECT DISTINCT ON (c.parent_kind, c.parent_id)
             c.parent_kind, c.parent_id, c.heading, c.ord, c.text, c.scope_id,
             (${usesLinked}) AS via_uses_link,
             ts_rank_cd(c.tsv, q.any_term)
               * CASE WHEN c.tsv @@ q.all_terms THEN 2.0 ELSE 1.0 END
               * CASE coalesce(a.status, f.status) WHEN 'published' THEN 1.0 WHEN 'possibly_stale' THEN 0.6 ELSE 0.4 END
               * CASE WHEN c.scope_id = ${currentProject} THEN 1.3 ELSE 1.0 END AS score
        FROM chunks c
        CROSS JOIN q
        LEFT JOIN articles a ON c.parent_kind = 'article' AND a.id = c.parent_id
        LEFT JOIN findings f ON c.parent_kind = 'finding' AND f.id = c.parent_id
       WHERE ${where.join("\n         AND ")}
       ORDER BY c.parent_kind, c.parent_id, score DESC, c.ord
    ),
    top AS (SELECT * FROM scored ORDER BY score DESC LIMIT ${limitParam})
    SELECT top.parent_kind AS kind, top.parent_id AS id, top.score, top.via_uses_link,
           CASE WHEN top.parent_kind = 'article' AND top.heading <> a.title THEN top.heading END AS section,
           ts_headline('english', top.text, q.any_term,
                       'MaxWords=35, MinWords=12, MaxFragments=2, StartSel=**, StopSel=**') AS snippet,
           coalesce(a.title, f.title) AS title,
           coalesce(a.type, f.type) AS type,
           coalesce(a.status, f.status) AS status,
           coalesce(a.last_verified_at, f.last_verified_at) AS last_verified_at,
           coalesce(a.updated_at, f.updated_at) AS updated_at,
           s.slug AS scope_slug, s.kind AS scope_kind
      FROM top
      CROSS JOIN q
      JOIN scopes s ON s.id = top.scope_id
      LEFT JOIN articles a ON top.parent_kind = 'article' AND a.id = top.parent_id
      LEFT JOIN findings f ON top.parent_kind = 'finding' AND f.id = top.parent_id
     ORDER BY top.score DESC`;

  const { rows } = await ctx.db.query(sql, params);
  const hits: SearchHit[] = rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    section: r.section,
    snippet: r.snippet,
    scope: { slug: r.scope_slug, kind: r.scope_kind },
    via_uses_link: r.via_uses_link,
    last_verified_at: r.last_verified_at?.toISOString() ?? null,
    updated_at: r.updated_at.toISOString(),
    score: Number(Number(r.score).toFixed(4)),
    ...(r.status === "possibly_stale" ? { warning: "Not verified recently; confirm before relying on it." } : {}),
  }));
  return {
    articles: hits.filter((h) => h.kind === "article"),
    findings: hits.filter((h) => h.kind === "finding"),
  };
}
