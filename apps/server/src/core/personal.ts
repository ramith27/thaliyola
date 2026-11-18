import { ValidationError, type RequestContext } from "./context.js";
import { createArticle, findItemFor, proposeArticleEdit } from "./writes.js";
import { personalScope, PERSONAL_ALIAS } from "./scopes.js";

/**
 * Personal context: each person's own notes (preferences, how they work, what they're on, things they keep
 * looking up), kept in their personal space. Only they can read them; search finds them from every project.
 * Writes there publish straight away (their owner is their only reviewer).
 */

const EXCERPT = 600;

/** Everything in the caller's personal space, newest first, with a short excerpt of each. */
export async function getPersonalContext(ctx: RequestContext, opts: { limit?: number } = {}) {
  const scope = await personalScope(ctx, false);
  if (!scope) return { scope: PERSONAL_ALIAS, notes: [], findings: [], note: "Nothing saved yet. save_personal_note stores something for next time." };
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const notes = await ctx.db.query(
    `SELECT id, type, title, path, tags, updated_at, left(body_md, $3) AS excerpt, length(body_md) > $3 AS truncated
       FROM articles WHERE scope_id = $1 AND status IN ('published', 'possibly_stale', 'draft')
      ORDER BY updated_at DESC LIMIT $2`,
    [scope.id, limit, EXCERPT],
  );
  const findings = await ctx.db.query(
    `SELECT id, type, title, tags, updated_at, left(symptoms, 300) AS symptoms
       FROM findings WHERE scope_id = $1 AND status IN ('published', 'possibly_stale', 'draft')
      ORDER BY updated_at DESC LIMIT $2`,
    [scope.id, limit],
  );
  return { scope: PERSONAL_ALIAS, notes: notes.rows, findings: findings.rows };
}

/** Saves a note in the caller's personal space: new, or (with id) replacing that note's text. Published at once. */
export async function savePersonalNote(
  ctx: RequestContext,
  input: { title: string; body_md: string; id?: string; path?: string; tags?: string[] },
) {
  const scope = (await personalScope(ctx))!;
  if (!input.id) {
    return createArticle(ctx, { scope: PERSONAL_ALIAS, type: "note", title: input.title, body_md: input.body_md, path: input.path, tags: input.tags });
  }
  const item = await findItemFor(ctx, input.id);
  if (item.scope_id !== scope.id || item.kind !== "article") throw new ValidationError(`${input.id} is not a note in your personal space`);
  return proposeArticleEdit(ctx, { id: input.id, version: item.version, text: input.body_md, title: input.title, summary: `Update ${input.title}`.slice(0, 300) });
}
