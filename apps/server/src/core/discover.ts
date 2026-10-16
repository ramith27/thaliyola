import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { getArticle, getFinding } from "./items.js";
import { readableScopes } from "./permissions.js";
import { searchKnowledge, type SearchHit } from "./search.js";
import { findItem } from "./writes.js";

/**
 * Finding things: the "Ask Thaliyola" best answer, entity pages, and each
 * person's favourites.
 */

const ANSWER_CHARS = 2400;

/**
 * Search, then lift the single best hit into an answer card: the matching
 * article section, or the finding's symptoms, cause and fix. No LLM: the
 * answer is the team's own text, quoted.
 */
export async function ask(ctx: RequestContext, question: string, opts: { project?: string } = {}) {
  const q = question.trim();
  if (!q) throw new ValidationError("ask a question");
  const res = await searchKnowledge(ctx, { query: q, project: opts.project, limit: 6 });
  const hits = [...res.articles, ...res.findings].sort((a, b) => b.score - a.score);
  const best = hits[0];
  if (!best) return { question: q, best: null, others: [] };

  let answer_md: string;
  if (best.kind === "article") {
    const article = await getArticle(ctx, best.id, best.section ?? undefined).catch(() => getArticle(ctx, best.id));
    answer_md = article.body_md.replace(/^## .*\n+/, "");
  } else {
    const f = await getFinding(ctx, best.id);
    answer_md = [`**Symptoms.** ${f.symptoms}`, `**Root cause.** ${f.root_cause}`, f.fix ? `**Fix.** ${f.fix}` : ""].filter(Boolean).join("\n\n");
  }
  const truncated = answer_md.length > ANSWER_CHARS;
  return {
    question: q,
    best: {
      ...best,
      answer_md: truncated ? `${answer_md.slice(0, ANSWER_CHARS).replace(/\s+\S*$/, "")}…` : answer_md,
      truncated,
      // Both keyword and meaning matched: a confident answer. Otherwise, say it's a lead.
      confidence: best.match === "keyword+semantic" ? "strong" : "weak",
    },
    others: hits.slice(1, 6).map((h: SearchHit) => ({ kind: h.kind, id: h.id, title: h.title, type: h.type, section: h.section, scope: h.scope, status: h.status })),
  };
}

// ---- Entities -----------------------------------------------------------------

/** Entities whose name or alias starts with (or contains) `q`, with how many readable items mention them. */
export async function searchEntities(ctx: RequestContext, q: string, limit = 10) {
  const readable = await readableScopes(ctx);
  const term = q.trim().toLowerCase();
  const { rows } = await ctx.db.query(
    `SELECT e.kind, e.name, e.aliases,
            (SELECT count(*) FROM entity_links el
               LEFT JOIN articles a ON el.target_kind = 'article' AND a.id = el.target_id
               LEFT JOIN findings f ON el.target_kind = 'finding' AND f.id = el.target_id
              WHERE el.entity_id = e.id AND coalesce(a.status, f.status) IN ('published', 'possibly_stale')
                AND ($2::uuid[] IS NULL OR coalesce(a.scope_id, f.scope_id) = ANY($2)))::int AS items
       FROM entities e
      WHERE $1 = '' OR lower(e.name) LIKE '%' || $1 || '%' OR EXISTS (SELECT 1 FROM unnest(e.aliases) al WHERE lower(al) LIKE '%' || $1 || '%')
      ORDER BY (lower(e.name) LIKE $1 || '%') DESC, items DESC, e.name
      LIMIT $3`,
    [term, readable, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.filter((r) => r.items > 0 || term.length > 0);
}

/** An entity with every readable item that mentions it, and the entities they mention together. */
export async function getEntity(ctx: RequestContext, kind: string, name: string) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query<{ id: string; kind: string; name: string; aliases: string[] }>(
    "SELECT id, kind, name, aliases FROM entities WHERE kind = $1 AND (lower(name) = lower($2) OR lower($2) = ANY(SELECT lower(x) FROM unnest(aliases) x))",
    [kind, name],
  );
  const e = rows[0];
  if (!e) throw new NotFoundError(`${kind} '${name}'`);
  const items = await ctx.db.query(
    `SELECT * FROM (
       SELECT 'article' AS kind, a.id, a.title, a.type, a.status, s.slug AS scope, s.kind AS scope_kind, a.updated_at
         FROM entity_links el JOIN articles a ON a.id = el.target_id JOIN scopes s ON s.id = a.scope_id
        WHERE el.entity_id = $1 AND a.status IN ('published', 'possibly_stale') AND ($2::uuid[] IS NULL OR a.scope_id = ANY($2))
       UNION ALL
       SELECT 'finding', f.id, f.title, f.type, f.status, s.slug, s.kind, f.updated_at
         FROM entity_links el JOIN findings f ON f.id = el.target_id JOIN scopes s ON s.id = f.scope_id
        WHERE el.entity_id = $1 AND f.status IN ('published', 'possibly_stale') AND ($2::uuid[] IS NULL OR f.scope_id = ANY($2))
     ) x ORDER BY kind, updated_at DESC`,
    [e.id, readable],
  );
  const ids = items.rows.map((r) => r.id);
  const related = await ctx.db.query(
    `SELECT e.kind, e.name, count(*)::int AS shared FROM entity_links el JOIN entities e ON e.id = el.entity_id
      WHERE el.target_id = ANY($1::uuid[]) AND e.id <> $2 GROUP BY e.kind, e.name ORDER BY shared DESC, e.name LIMIT 12`,
    [ids, e.id],
  );
  return { kind: e.kind, name: e.name, aliases: e.aliases, items: items.rows, related: related.rows };
}

// ---- Favourites -----------------------------------------------------------------

export async function listFavourites(ctx: RequestContext) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query(
    `SELECT fav.target_kind AS kind, fav.target_id AS id, coalesce(a.title, f.title, s.name) AS title,
            coalesce(sa.slug, sf.slug, s.slug) AS scope, s.kind AS scope_kind
       FROM favourites fav
       LEFT JOIN articles a ON fav.target_kind = 'article' AND a.id = fav.target_id
       LEFT JOIN findings f ON fav.target_kind = 'finding' AND f.id = fav.target_id
       LEFT JOIN scopes s ON fav.target_kind = 'scope' AND s.id = fav.target_id
       LEFT JOIN scopes sa ON sa.id = a.scope_id
       LEFT JOIN scopes sf ON sf.id = f.scope_id
      WHERE fav.user_id = $1
        AND coalesce(a.scope_id, f.scope_id, s.id) IS NOT NULL
        AND ($2::uuid[] IS NULL OR coalesce(a.scope_id, f.scope_id, s.id) = ANY($2))
      ORDER BY fav.created_at`,
    [ctx.actor.id, readable],
  );
  return rows;
}

export async function setFavourite(ctx: RequestContext, id: string, on: boolean) {
  if (!on) {
    await ctx.db.query("DELETE FROM favourites WHERE user_id = $1 AND target_id = $2", [ctx.actor.id, id]);
    return { id, favourite: false };
  }
  let kind: string;
  const scope = (await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE id = $1", [id])).rows[0];
  if (scope) {
    kind = "scope";
    if (!((await readableScopes(ctx))?.includes(id) ?? true)) throw new NotFoundError(`scope ${id}`);
  } else {
    const item = await findItem(ctx.db, id);
    const readable = await readableScopes(ctx);
    if (readable && !readable.includes(item.scope_id)) throw new NotFoundError(`${item.kind} ${id}`);
    kind = item.kind;
  }
  await ctx.db.query("INSERT INTO favourites (user_id, target_kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ctx.actor.id, kind, id]);
  return { id, favourite: true };
}
