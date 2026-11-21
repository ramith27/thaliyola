import type { Db, Queryable } from "../db/pool.js";

/**
 * How background jobs (and the backup scripts) went: each run is recorded in job_runs (status, last success, last
 * error, duration, consecutive failures, details) for the health page and failure alerts. runJob also takes the job's
 * advisory lock, so a job runs on one replica at a time.
 */

export async function recordJob(db: Queryable, name: string, r: { ok: boolean; error?: string | null; durationMs?: number; details?: Record<string, unknown> }) {
  await db.query(
    `INSERT INTO job_runs (name, last_run, status, last_success, last_error, duration_ms, failures, details)
     VALUES ($1, now(), $2, CASE WHEN $2 = 'ok' THEN now() END, $3, $4, CASE WHEN $2 = 'ok' THEN 0 ELSE 1 END, coalesce($5::jsonb, '{}'))
     ON CONFLICT (name) DO UPDATE SET last_run = now(), status = EXCLUDED.status,
       last_success = CASE WHEN EXCLUDED.status = 'ok' THEN now() ELSE job_runs.last_success END,
       last_error = CASE WHEN EXCLUDED.status = 'ok' THEN job_runs.last_error ELSE EXCLUDED.last_error END,
       duration_ms = EXCLUDED.duration_ms,
       failures = CASE WHEN EXCLUDED.status = 'ok' THEN 0 ELSE job_runs.failures + 1 END,
       details = CASE WHEN $5::jsonb IS NULL THEN job_runs.details ELSE EXCLUDED.details END,
       alerted_at = CASE WHEN EXCLUDED.status = 'ok' THEN NULL ELSE job_runs.alerted_at END`,
    [name, r.ok ? "ok" : "failed", r.error ? r.error.slice(0, 1000) : null, r.durationMs ?? null, r.details ? JSON.stringify(r.details) : null],
  );
}

/**
 * Runs one tick of a job under its advisory lock (skipped when another replica holds it), recording the outcome.
 * Errors are logged and recorded, never thrown: a failing job must not take the process down.
 */
export async function runJob(db: Db, name: string, lock: number, log: (m: string) => void, fn: () => Promise<Record<string, unknown> | void>) {
  const client = await db.connect().catch((err: Error) => void log(`${name} failed: ${err.message}`));
  if (!client) return;
  try {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [lock]);
    if (!rows[0]?.locked) return;
    const started = Date.now();
    try {
      const details = await fn();
      await recordJob(db, name, { ok: true, durationMs: Date.now() - started, details: details ?? undefined }).catch(() => undefined);
    } catch (err) {
      log(`${name} failed: ${(err as Error).message}`);
      await recordJob(db, name, { ok: false, error: (err as Error).message, durationMs: Date.now() - started }).catch(() => undefined);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lock]);
    }
  } catch (err) {
    log(`${name} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}
