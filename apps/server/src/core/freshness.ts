import { sendDigests } from "./digest.js";
import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { onStale } from "./notify.js";
import type { RequestContext } from "./context.js";
import { resolveScopeFilter } from "./scopes.js";

/**
 * Knowledge goes stale. Published entries nobody has verified within the
 * window become `possibly_stale`: they rank lower, carry a warning, and show
 * up in "needs attention" until someone verifies or supersedes them.
 */
export async function markStale(db: Db, opts: { findingDays: number; articleDays: number }, settings?: Settings) {
  const findings = await db.query<{ id: string; title: string; owner_id: string | null; scope_id: string }>(
    `UPDATE findings SET status = 'possibly_stale'
      WHERE status = 'published' AND coalesce(last_verified_at, updated_at) < now() - make_interval(days => $1)
      RETURNING id, title, author_id AS owner_id, scope_id`,
    [opts.findingDays],
  );
  const articles = await db.query<{ id: string; title: string; owner_id: string | null; scope_id: string }>(
    `UPDATE articles SET status = 'possibly_stale'
      WHERE status = 'published' AND coalesce(last_verified_at, updated_at) < now() - make_interval(days => $1)
      RETURNING id, title, owner_id, scope_id`,
    [opts.articleDays],
  );
  if (settings) {
    await onStale(db, settings, [
      ...findings.rows.map((r) => ({ ...r, kind: "finding" })),
      ...articles.rows.map((r) => ({ ...r, kind: "article" })),
    ]);
  }
  return { findings: findings.rowCount ?? 0, articles: articles.rowCount ?? 0 };
}

/** Stale entries and articles past their review date, in the caller's default scopes (or one scope). */
export async function needsAttention(ctx: RequestContext, opts: { scope?: string; project?: string; limit?: number } = {}) {
  const filter = await resolveScopeFilter(ctx, opts.scope ?? (opts.project || ctx.project ? undefined : "all"), opts.project);
  const scopeIds = filter.mode === "ids" ? filter.scopeIds : null;
  const { rows } = await ctx.db.query(
    `SELECT * FROM (
       SELECT 'article' AS kind, a.id, a.title, a.type, a.status, s.slug AS scope,
              coalesce(a.last_verified_at, a.updated_at) AS last_verified_at, a.review_due,
              CASE WHEN a.status = 'possibly_stale' THEN 'not verified recently' ELSE 'review overdue' END AS reason,
              coalesce(u.email, u.subject) AS owner, u.display_name AS owner_name
         FROM articles a JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.owner_id
        WHERE (a.status = 'possibly_stale' OR (a.status = 'published' AND a.review_due < current_date))
          AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1))
       UNION ALL
       SELECT 'finding', f.id, f.title, f.type, f.status, s.slug,
              coalesce(f.last_verified_at, f.updated_at), NULL, 'not verified recently', coalesce(u.email, u.subject), u.display_name
         FROM findings f JOIN scopes s ON s.id = f.scope_id LEFT JOIN users u ON u.id = f.author_id
        WHERE f.status = 'possibly_stale' AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1))
     ) x ORDER BY last_verified_at ASC LIMIT $2`,
    [scopeIds, Math.min(opts.limit ?? 25, 200)],
  );
  return { entries: rows };
}

/**
 * Runs periodic maintenance in-process. A Postgres advisory lock makes sure
 * only one server instance does the work when several are running.
 */
export function startJobs(db: Db, opts: { findingDays: number; articleDays: number; intervalHours: number; settings?: Settings }, log: (msg: string) => void) {
  const LOCK = 7_402_211; // arbitrary, stable key for "thaliyola maintenance"
  async function run() {
    // Database unreachable: log and try again next time instead of an unhandled rejection that ends the process.
    const client = await db.connect().catch((err: Error) => void log(`maintenance failed: ${err.message}`));
    if (!client) return;
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK]);
      if (!rows[0]?.locked) return;
      try {
        const stale = await markStale(db, opts, opts.settings);
        await db.query("DELETE FROM sessions WHERE expires_at < now()");
        await db.query("DELETE FROM auth_throttle WHERE reset_at < now()");
        await db.query("DELETE FROM oauth_requests WHERE expires_at < now()");
        await db.query("DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'");
        await db.query("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '7 days'");
        await db.query("DELETE FROM invitations WHERE expires_at < now() - interval '30 days' AND accepted_at IS NULL");
        if (opts.settings) await db.query("DELETE FROM search_log WHERE at < now() - make_interval(days => $1)", [opts.settings.searchLogDays]);
        if (stale.findings || stale.articles) log(`marked ${stale.findings} finding(s) and ${stale.articles} article(s) possibly stale`);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
    } catch (err) {
      log(`maintenance failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  // Weekly digests: checked every 15 minutes, sent once per person per week (one instance at a time).
  const DIGEST_LOCK = 7_402_212;
  async function digests() {
    if (!opts.settings || opts.settings.mailTransport === "off") return;
    const client = await db.connect().catch((err: Error) => void log(`digest failed: ${err.message}`));
    if (!client) return;
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [DIGEST_LOCK]);
      if (!rows[0]?.locked) return;
      try {
        const r = await sendDigests(db, opts.settings);
        if (r.sent) log(`sent ${r.sent} weekly digest(s)`);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [DIGEST_LOCK]);
      }
    } catch (err) {
      log(`digest failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  // Runs the timers started, so shutdown can wait for them (an interrupted run is redone by the next one).
  const active = new Set<Promise<void>>();
  const start = (job: () => Promise<void>) => () => {
    const p = job();
    active.add(p);
    void p.finally(() => active.delete(p));
  };
  const first = setTimeout(start(run), 30_000);
  const timer = setInterval(start(run), opts.intervalHours * 3600_000);
  const digestTimer = setInterval(start(digests), 15 * 60_000);
  return {
    run,
    digests,
    /** Starts no more runs; resolves when the one in progress (if any) has finished. */
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(digestTimer);
      await Promise.allSettled([...active]);
    },
  };
}
