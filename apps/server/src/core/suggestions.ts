import type { RequestContext } from "./context.js";
import { resolveScopeFilter } from "./scopes.js";

/**
 * Deterministic suggestions for reviewers and scheduled agents (no LLM):
 * - promote: a root cause keeps coming back (linked as the same root cause,
 *   or verified repeatedly) and isn't folded into an article yet;
 * - duplicates: two findings say nearly the same thing (embedding similarity)
 *   but aren't linked.
 */
export async function listSuggestions(ctx: RequestContext, opts: { scope?: string; project?: string; limit?: number } = {}) {
  const filter = await resolveScopeFilter(ctx, opts.scope ?? (opts.project || ctx.project ? undefined : "all"), opts.project);
  const scopeIds = filter.mode === "ids" ? filter.scopeIds : null;
  const limit = Math.min(opts.limit ?? 20, 100);

  const promote = await ctx.db.query(
    `WITH f AS (
       SELECT f.id, f.title, f.scope_id, s.slug AS scope,
              (SELECT count(*) FROM relations r WHERE r.kind = 'same_root_cause' AND (r.from_id = f.id OR r.to_id = f.id))::int AS recurrences,
              (SELECT count(*) FROM audit_log a WHERE a.target_id = f.id AND a.tool IN ('verify_entry', 'api:verify_entry'))::int AS verifications,
              ARRAY(SELECT CASE WHEN r.from_id = f.id THEN r.to_id ELSE r.from_id END FROM relations r
                     WHERE r.kind = 'same_root_cause' AND (r.from_id = f.id OR r.to_id = f.id)) AS partners
         FROM findings f JOIN scopes s ON s.id = f.scope_id
        WHERE f.status IN ('published', 'possibly_stale')
          AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1))
          AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_id = f.id AND r.kind = 'promoted_into')
     )
     SELECT f.*,
            -- Where it probably belongs: an article it's linked to, else one about the same entity.
            (SELECT json_build_object('id', a.id, 'title', a.title, 'type', a.type, 'version', a.version)
               FROM articles a
              WHERE a.status IN ('published', 'possibly_stale')
                AND (a.id IN (SELECT to_id FROM relations WHERE from_id = f.id AND kind = 'related')
                     OR a.id IN (SELECT from_id FROM relations WHERE to_id = f.id AND kind = 'related')
                     OR a.id IN (SELECT el2.target_id FROM entity_links el1 JOIN entity_links el2 ON el2.entity_id = el1.entity_id
                                  WHERE el1.target_id = f.id AND el2.target_kind = 'article'))
              ORDER BY (a.type IN ('runbook', 'system')) DESC, a.updated_at DESC LIMIT 1) AS suggested_article
       FROM f
      WHERE f.recurrences >= 1 OR f.verifications >= 3
      ORDER BY (SELECT 1 FROM relations r WHERE r.from_id = f.id AND r.kind = 'related' LIMIT 1) IS NOT NULL DESC,
               f.recurrences * 3 + f.verifications DESC
      LIMIT $2`,
    [scopeIds, limit],
  );

  let duplicates: unknown[] = [];
  if (ctx.embedder) {
    const { rows } = await ctx.db.query(
      `SELECT a.parent_id AS a_id, fa.title AS a_title, sa.slug AS a_scope,
              b.parent_id AS b_id, fb.title AS b_title, sb.slug AS b_scope,
              round((1 - (a.embedding <=> b.embedding))::numeric, 3)::float AS similarity
         FROM chunks a
         JOIN chunks b ON b.parent_kind = 'finding' AND a.parent_id < b.parent_id AND b.embedding_model = a.embedding_model
         JOIN findings fa ON fa.id = a.parent_id JOIN scopes sa ON sa.id = fa.scope_id
         JOIN findings fb ON fb.id = b.parent_id JOIN scopes sb ON sb.id = fb.scope_id
        WHERE a.parent_kind = 'finding' AND a.embedding_model = $3
          AND fa.status IN ('published', 'possibly_stale') AND fb.status IN ('published', 'possibly_stale')
          AND ($1::uuid[] IS NULL OR (fa.scope_id = ANY($1) AND fb.scope_id = ANY($1)))
          AND 1 - (a.embedding <=> b.embedding) >= $4
          AND NOT EXISTS (SELECT 1 FROM relations r
                           WHERE r.kind IN ('same_root_cause', 'supersedes', 'related')
                             AND ((r.from_id = a.parent_id AND r.to_id = b.parent_id) OR (r.from_id = b.parent_id AND r.to_id = a.parent_id)))
        ORDER BY similarity DESC LIMIT $2`,
      [scopeIds, limit, ctx.embedder.model, ctx.settings.duplicateSimilarity],
    );
    duplicates = rows.map((r) => ({
      similarity: r.similarity,
      a: { id: r.a_id, title: r.a_title, scope: r.a_scope },
      b: { id: r.b_id, title: r.b_title, scope: r.b_scope },
    }));
  }

  // One suggestion per cluster of same-root-cause findings: the first (best-placed) member stands for the rest.
  const covered = new Set<string>();
  const clusters = promote.rows.filter((r) => {
    if (covered.has(r.id)) return false;
    covered.add(r.id);
    for (const p of r.partners as string[]) covered.add(p);
    return true;
  });

  return {
    promote: clusters.map((r) => ({
      finding: { id: r.id, title: r.title, scope: r.scope },
      recurrences: r.recurrences,
      related_findings: (r.partners as string[]).length,
      verifications: r.verifications,
      suggested_article: r.suggested_article,
      hint: r.suggested_article
        ? `promote_finding into "${r.suggested_article.title}" (version ${r.suggested_article.version})`
        : "no obvious article; consider a runbook or a Known issues section on the system article",
    })),
    duplicates,
    ...(ctx.embedder ? {} : { note: "Duplicate suggestions need semantic search (EMBEDDINGS=local)." }),
  };
}
