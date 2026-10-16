import type { RequestContext } from "./context.js";
import { ValidationError } from "./context.js";
import { VECTOR_CANDIDATES } from "../db/pool.js";
import { toPgVector } from "./embeddings.js";
import { readableScopes } from "./permissions.js";
import { track } from "./notify.js";
import { redact } from "./redaction.js";
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
  /** Search as you type: the last word also matches as a prefix ("conv" finds "conversion"). */
  prefix?: boolean;
  /** Where the search came from, for the hit rate and knowledge gaps; unset searches aren't logged. */
  source?: "web" | "mcp";
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
  match: "keyword" | "semantic" | "keyword+semantic";
  warning?: string;
}

/** The last word as a tsquery prefix term (`conv:*`), or null. Only letters, digits and underscores survive. */
function prefixTerm(query: string, enabled?: boolean): string | null {
  if (!enabled) return null;
  const last = query.toLowerCase().split(/\s+/).at(-1)?.replace(/[^\p{L}\p{N}_]/gu, "") ?? "";
  return last.length >= 2 ? `${last}:*` : null;
}

/** Hidden unless asked for: drafts are unreviewed, superseded/rejected are history. */
const DEFAULT_STATUSES = ["published", "possibly_stale"];

/**
 * Hybrid search over article sections and findings: Postgres full-text
 * (terms OR-ed, chunks matching every term ranked higher) fused with
 * embedding similarity by normalized score fusion. Results keep the best chunk
 * per item, boosted for published items and the current project, then list
 * article sections before findings (source of truth first).
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
  const readable = await readableScopes(ctx);
  if (readable !== null) where.push(`c.scope_id = ANY(${p(readable)}::uuid[])`);
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

  // Semantic candidates when an embedder is configured; keyword-only otherwise
  // (or if the model can't be loaded).
  let queryVector: string | null = null;
  if (ctx.embedder) {
    try {
      queryVector = toPgVector(await ctx.embedder.embedQuery(query));
    } catch {
      queryVector = null;
    }
  }
  // Candidates come from the indexes first (GIN for keywords, HNSW for meaning); the filters then
  // apply to those candidates only, so cost tracks matches rather than the size of the knowledge base.
  const filters = where.filter((w) => w !== "c.tsv @@ q.any_term").join("\n           AND ");
  const vec = queryVector
    ? `SELECT nn.id, row_number() OVER (ORDER BY nn.dist) AS r, 1 - nn.dist AS sim
         FROM (SELECT c.id, c.embedding <=> ${p(queryVector)}::vector AS dist FROM chunks c
                WHERE c.embedding IS NOT NULL
                ORDER BY c.embedding <=> ${p(queryVector)}::vector LIMIT ${VECTOR_CANDIDATES}) nn
         JOIN chunks c ON c.id = nn.id AND c.embedding_model = ${p(ctx.embedder!.model)}
         LEFT JOIN articles a ON c.parent_kind = 'article' AND a.id = c.parent_id
         LEFT JOIN findings f ON c.parent_kind = 'finding' AND f.id = c.parent_id
        WHERE 1 - nn.dist >= ${p(ctx.settings.searchMinSimilarity)}
          AND ${filters}
        ORDER BY nn.dist LIMIT 50`
    : "SELECT NULL::bigint AS id, NULL::bigint AS r, NULL::float AS sim WHERE false";
  // Small embedding models compress similarities into a narrow band, so a meaning-only hit must also be
  // close to the best meaning match for this query, not just above the floor.
  const vecWindowed = queryVector
    ? `SELECT id, r, sim FROM (SELECT v.*, max(v.sim) OVER () AS best FROM vec_raw v) w WHERE sim >= best - ${p(ctx.settings.searchSimilarityWindow)}`
    : "SELECT NULL::bigint AS id, NULL::bigint AS r, NULL::float AS sim WHERE false";

  const sql = `
    WITH q AS (
      SELECT to_tsquery('simple', concat_ws(' | ', nullif(string_agg(t, ' | '), ''), ${p(prefixTerm(query, input.prefix))}::text)) AS any_term,
             websearch_to_tsquery('english', $1) AS all_terms
        FROM (SELECT regexp_replace(l, '[^[:alnum:]_]', '', 'g') AS t
                FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS l) terms
       WHERE t <> ''
    ),
    fts AS (
      SELECT id, rank
        FROM (SELECT c.id, ts_rank(c.tsv, q.any_term, 1) * CASE WHEN c.tsv @@ q.all_terms THEN 2.0 ELSE 1.0 END AS rank
                FROM chunks c CROSS JOIN q
                LEFT JOIN articles a ON c.parent_kind = 'article' AND a.id = c.parent_id
                LEFT JOIN findings f ON c.parent_kind = 'finding' AND f.id = c.parent_id
               WHERE c.tsv @@ q.any_term
                 AND ${filters}) x
       ORDER BY rank DESC LIMIT 50
    ),
    vec_raw AS (${vec}),
    vec AS (${vecWindowed}),
    -- Score fusion: keyword relevance relative to the best keyword hit, and similarity relative to the
    -- best semantic hit (within the window), each in [0, 1]. Unlike rank-only fusion this keeps how much
    -- better a hit is, so a boost can't lift a weak match over a much stronger one.
    fts_n AS (SELECT id, rank / nullif(max(rank) OVER (), 0) AS kw FROM fts),
    vec_n AS (
      SELECT id, sim, CASE WHEN max(sim) OVER () > min(sim) OVER () THEN (sim - min(sim) OVER ()) / (max(sim) OVER () - min(sim) OVER ()) ELSE 1 END AS vs
        FROM vec
    ),
    fused AS (
      SELECT coalesce(k.id, v.id) AS id,
             0.6 * coalesce(k.kw, 0) + 0.4 * coalesce(v.vs, 0) AS rrf,
             v.sim, k.id IS NOT NULL AS keyword_match
        FROM fts_n k FULL OUTER JOIN vec_n v ON k.id = v.id
    ),
    scored AS (
      SELECT DISTINCT ON (c.parent_kind, c.parent_id)
             c.parent_kind, c.parent_id, c.heading, c.ord, c.text, c.scope_id, (${usesLinked}) AS via_uses_link, fused.sim, fused.keyword_match,
             fused.rrf
               * CASE coalesce(a.status, f.status) WHEN 'published' THEN 1.0 WHEN 'possibly_stale' THEN 0.6 ELSE 0.4 END
               * CASE WHEN c.scope_id = ${currentProject} THEN 1.15 ELSE 1.0 END AS score
        FROM fused JOIN chunks c ON c.id = fused.id
        LEFT JOIN articles a ON c.parent_kind = 'article' AND a.id = c.parent_id
        LEFT JOIN findings f ON c.parent_kind = 'finding' AND f.id = c.parent_id
       ORDER BY c.parent_kind, c.parent_id, score DESC, c.ord
    ),
    top AS (SELECT * FROM scored ORDER BY score DESC LIMIT ${limitParam})
    SELECT top.parent_kind AS kind, top.parent_id AS id, top.score, top.via_uses_link, top.sim, top.keyword_match,
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
    // Chunks are indexed with the item title in front; drop it from the snippet.
    snippet: r.snippet.startsWith(r.title) ? r.snippet.slice(r.title.length).trimStart() : r.snippet,
    scope: { slug: r.scope_slug, kind: r.scope_kind },
    via_uses_link: r.via_uses_link,
    last_verified_at: r.last_verified_at?.toISOString() ?? null,
    updated_at: r.updated_at.toISOString(),
    score: Number(Number(r.score).toFixed(5)),
    match: r.keyword_match ? (r.sim !== null ? "keyword+semantic" : "keyword") : "semantic",
    ...(r.status === "possibly_stale" ? { warning: "Not verified recently; confirm before relying on it." } : {}),
  }));
  if (input.source && !input.prefix) logSearch(ctx, input.source, query, hits);
  return {
    articles: hits.filter((h) => h.kind === "article"),
    findings: hits.filter((h) => h.kind === "finding"),
  };
}

/** Records a search in the background; the text only when no keyword matched, redacted. */
function logSearch(ctx: RequestContext, source: "web" | "mcp", query: string, hits: SearchHit[]) {
  const keywordHits = hits.filter((h) => h.match !== "semantic").length;
  const text = keywordHits === 0 ? redact(query.trim().replace(/\s+/g, " ").slice(0, 200)).text : null;
  track(
    ctx.db
      .query("INSERT INTO search_log (actor_id, source, results, keyword_hits, query) VALUES ($1, $2, $3, $4, $5)", [ctx.actor.id, source, hits.length, keywordHits, text])
      .catch((err) => console.error(`[search] log failed: ${(err as Error).message}`)),
  );
}
