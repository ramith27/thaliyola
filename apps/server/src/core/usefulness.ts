import type { Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { notify, reviewersFor, track } from "./notify.js";
import { assertCanRead, readableScopes } from "./permissions.js";
import { findItem } from "./writes.js";

/**
 * Usefulness: reads (the app, MCP, answer_sources quoting it) and what people and their agents say about an item
 * (helpful, outdated, wrong). Search ranks used, helpful items a little higher and reported ones lower; two people
 * saying it's outdated or wrong make it possibly stale and tell its owner; Review › Suggestions lists what nobody
 * has read in six months.
 */

/** Two different people saying outdated or wrong (within 90 days, on the current version) mark the item possibly stale. */
const REPORTS_TO_STALE = 2;

/** Counts a read (in the background; never fails the request). */
export function recordRead(db: Queryable, kind: "article" | "finding", id: string, how: "read" | "quoted" = "read") {
  track(
    db
      .query(
        `INSERT INTO item_usage (item_kind, item_id, reads, quoted) VALUES ($1, $2, $3, $4)
         ON CONFLICT (item_id, day) DO UPDATE SET reads = item_usage.reads + EXCLUDED.reads, quoted = item_usage.quoted + EXCLUDED.quoted`,
        [kind, id, how === "read" ? 1 : 0, how === "quoted" ? 1 : 0],
      )
      .catch((err) => console.error(`[usefulness] ${(err as Error).message}`)),
  );
}

export async function rateSource(ctx: RequestContext, input: { id: string; verdict: "helpful" | "outdated" | "wrong"; note?: string }) {
  const item = await findItem(ctx.db, input.id);
  await assertCanRead(ctx, item.scope_id, `${item.kind} ${input.id}`);
  if (!["published", "possibly_stale"].includes(item.status)) throw new ValidationError("only published items are rated; comment on a draft or proposal instead");
  const note = input.note?.trim().slice(0, 1000) || null;
  if (input.verdict !== "helpful" && !note) throw new ValidationError("say what's out of date or wrong (note), so the owner can fix it");
  await ctx.db.query(
    `INSERT INTO item_feedback (item_kind, item_id, user_id, verdict, note, via_agent, item_version) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (item_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict, note = EXCLUDED.note, via_agent = EXCLUDED.via_agent, item_version = EXCLUDED.item_version, created_at = now()`,
    [item.kind, item.id, ctx.actor.id, input.verdict, note, !!ctx.viaAgent, item.version],
  );
  await audit(ctx.db, ctx.actor.id, "rate_source", item.id, { targetKind: item.kind, targetLabel: item.title, details: { verdict: input.verdict } });
  let markedStale = false;
  if (input.verdict !== "helpful") {
    const table = item.kind === "article" ? "articles" : "findings";
    const owner = (await ctx.db.query<{ owner: string | null }>(`SELECT ${item.kind === "article" ? "owner_id" : "author_id"} AS owner FROM ${table} WHERE id = $1`, [item.id])).rows[0]?.owner ?? null;
    const to = owner ? [owner] : await reviewersFor(ctx.db, ctx.settings, item.scope_id);
    await notify(
      ctx.db,
      ctx.settings,
      to,
      {
        kind: "stale",
        title: `Reported ${input.verdict}: ${item.title}`,
        body: `${ctx.actor.email ?? "Someone"}${ctx.viaAgent ? " (through Claude)" : ""}: ${note}`,
        link: `#/${item.kind}/${item.id}`,
        targetId: item.id,
        scopeId: item.scope_id,
      },
      { exclude: ctx.actor.id },
    );
    const reports = (
      await ctx.db.query<{ n: number }>(
        "SELECT count(DISTINCT user_id)::int AS n FROM item_feedback WHERE item_id = $1 AND verdict IN ('outdated', 'wrong') AND created_at > now() - interval '90 days' AND item_version = $2",
        [item.id, item.version],
      )
    ).rows[0]!.n;
    if (reports >= REPORTS_TO_STALE && item.status === "published") {
      markedStale = ((await ctx.db.query(`UPDATE ${table} SET status = 'possibly_stale' WHERE id = $1 AND status = 'published'`, [item.id])).rowCount ?? 0) > 0;
    }
  }
  emitChanged();
  return { id: item.id, verdict: input.verdict, ...(markedStale ? { marked_possibly_stale: true } : {}) };
}

/** An item's reads (90 days), feedback counts, the open reports, and what the caller said. */
export async function usefulnessOf(ctx: RequestContext, id: string) {
  const item = await findItem(ctx.db, id);
  await assertCanRead(ctx, item.scope_id, `${item.kind} ${id}`);
  const r = (
    await ctx.db.query<{ reads: number; quoted: number; helpful: number; outdated: number; wrong: number; mine: string | null }>(
      `SELECT coalesce((SELECT sum(reads) FROM item_usage WHERE item_id = $1 AND day > current_date - 90), 0)::int AS reads,
              coalesce((SELECT sum(quoted) FROM item_usage WHERE item_id = $1 AND day > current_date - 90), 0)::int AS quoted,
              (SELECT count(*) FROM item_feedback WHERE item_id = $1 AND verdict = 'helpful')::int AS helpful,
              (SELECT count(*) FROM item_feedback WHERE item_id = $1 AND verdict = 'outdated' AND item_version = $3)::int AS outdated,
              (SELECT count(*) FROM item_feedback WHERE item_id = $1 AND verdict = 'wrong' AND item_version = $3)::int AS wrong,
              (SELECT verdict FROM item_feedback WHERE item_id = $1 AND user_id = $2) AS mine`,
      [id, ctx.actor.id, item.version],
    )
  ).rows[0]!;
  const reports = (
    await ctx.db.query(
      `SELECT f.verdict, f.note, f.via_agent, f.created_at, coalesce(u.display_name, u.email) AS by
         FROM item_feedback f JOIN users u ON u.id = f.user_id
        WHERE f.item_id = $1 AND f.verdict <> 'helpful' AND f.item_version = $2 ORDER BY f.created_at DESC LIMIT 10`,
      [id, item.version],
    )
  ).rows;
  return { ...r, reports };
}

/** Published items nobody has read or quoted in six months (decisions are records, so never listed). */
export async function rarelyUsed(ctx: RequestContext, scopeIds: string[] | null, limit = 20) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query(
    `SELECT x.kind, x.id, x.title, x.type, s.slug AS scope, x.created_at
       FROM (SELECT 'article' AS kind, id, title, type, scope_id, created_at FROM articles WHERE status IN ('published', 'possibly_stale') AND type NOT IN ('decision', 'project_overview')
             UNION ALL
             SELECT 'finding', id, title, type, scope_id, created_at FROM findings WHERE status IN ('published', 'possibly_stale')) x
       JOIN scopes s ON s.id = x.scope_id AND s.kind <> 'personal'
      WHERE x.created_at < now() - interval '180 days'
        AND ($1::uuid[] IS NULL OR x.scope_id = ANY($1)) AND ($2::uuid[] IS NULL OR x.scope_id = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM item_usage u WHERE u.item_id = x.id AND u.day > current_date - 180)
        -- Something else relies on it (a project uses it, a screen depends on it): not unused.
        AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.to_id = x.id AND r.kind IN ('uses', 'depends_on', 'consumed_by'))
      ORDER BY x.created_at LIMIT $3`,
    [scopeIds, readable, limit],
  );
  return rows.map((r) => ({ ...r, hint: "Nobody has opened, searched to or quoted this in six months: retire it (archive), merge it into a page people use, or confirm it's still needed." }));
}
