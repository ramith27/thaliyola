import { repoKey } from "./bootstrap.js";
import { buildBriefing } from "./briefings.js";
import { ValidationError, type RequestContext } from "./context.js";
import { readableScopes } from "./permissions.js";
import { pathMatches, rulesFor } from "./rules.js";

/**
 * What's known about one file, for an editor's side panel (the VS Code extension): which project and repository
 * it belongs to, the facts in the docs that cite its lines, the docs, contracts, known issues and vulnerabilities
 * about it, who else is working on it, and the project's rules for it. Only projects the caller can read.
 */
export async function fileKnowledge(ctx: RequestContext, input: { repo: string; path: string }) {
  const key = repoKey(input.repo);
  if (!key) throw new ValidationError("repo: the repository's remote URL (git remote get-url origin)");
  const path = input.path.trim().replace(/^\.?\/+/, "");
  if (!path || path.includes("..")) throw new ValidationError("path: the file's path inside the repository");
  const readable = await readableScopes(ctx);
  const comp = (
    await ctx.db.query<{ id: string; slug: string; repo_url: string | null; scope_id: string; project: string; project_name: string }>(
      `SELECT c.id, c.slug, c.repo_url, c.scope_id, s.slug AS project, s.name AS project_name FROM components c JOIN scopes s ON s.id = c.scope_id AND s.status = 'active'
        WHERE c.repo_key = $1 AND ($2::uuid[] IS NULL OR c.scope_id = ANY($2)) ORDER BY s.kind = 'project' DESC, s.slug LIMIT 1`,
      [key, readable],
    )
  ).rows[0];
  if (!comp) return { known: false as const, note: "This repository isn't part of a project you can read in Thaliyola (a Project admin adds it in project settings › Repositories)." };
  const briefing = await buildBriefing(ctx.db, comp.scope_id, comp, [path]);
  const facts = (
    await ctx.db.query<{ article_id: string; article: string; text: string; start: number | null; end: number | null; status: string }>(
      `SELECT c.article_id, a.title AS article, c.text, (e->>'start')::int AS start, (e->>'end')::int AS "end", c.status
         FROM claims c CROSS JOIN LATERAL jsonb_array_elements(c.evidence) e JOIN articles a ON a.id = c.article_id
        WHERE e->>'path' = $3 AND c.status <> 'retired' AND a.status IN ('published', 'possibly_stale')
          AND c.article_id IN (SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2)
        ORDER BY (e->>'start')::int NULLS LAST LIMIT 100`,
      [comp.scope_id, comp.slug, path],
    )
  ).rows;
  const rules = (await rulesFor(ctx.db, comp.scope_id, comp.slug)).filter((r) => pathMatches(r.paths, path)).map((r) => ({ kind: r.kind, message: r.message, read_first: r.article }));
  return { known: true as const, project: comp.project, project_name: comp.project_name, repository: comp.slug, path, rules, facts, briefing };
}
