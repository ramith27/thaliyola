import { statfs } from "node:fs/promises";
import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { ForbiddenError, type RequestContext } from "./context.js";
import { notify } from "./notify.js";
import { isAdmin } from "./permissions.js";
import { buildInfo } from "./version.js";

/**
 * The installation's health for Administrators (Admin › System › Health): the database, every background job's last
 * run, backups and the last restore check, the embedding backlog, disk space for uploads, failing connections, and
 * what's happening (sessions online, open incidents). Alerts admins when backups stop, a restore check fails or a
 * job keeps failing.
 */

/** Backups older than this are an alert (daily backups, with a day's grace). */
const BACKUP_STALE_HOURS = 36;
/** A job failing this many runs in a row is an alert. */
const JOB_FAILURES = 3;

export async function systemHealth(ctx: RequestContext) {
  if (!isAdmin(ctx)) throw new ForbiddenError("the health page is for Administrators");
  const db = ctx.db;
  const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows[0] as T;
  const database = await one<{ size: string; version: string; encoding: string; migration: string | null }>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS size, current_setting('server_version') AS version,
            pg_encoding_to_char(encoding) AS encoding, (SELECT max(name) FROM schema_migrations) AS migration
       FROM pg_database WHERE datname = current_database()`,
  );
  const jobs = (
    await db.query<{ name: string; last_run: string; status: string | null; last_success: string | null; last_error: string | null; duration_ms: number | null; failures: number; details: Record<string, unknown> }>(
      "SELECT name, last_run, status, last_success, last_error, duration_ms, failures, details FROM job_runs ORDER BY name",
    )
  ).rows;
  const job = (n: string) => jobs.find((j) => j.name === n) ?? null;
  let disk: { free_bytes: number; total_bytes: number } | null = null;
  if (!ctx.settings.s3) {
    try {
      const s = await statfs(ctx.settings.assetDir);
      disk = { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize };
    } catch {
      disk = null;
    }
  }
  const embeddings = await one<{ pending: number }>("SELECT count(*)::int AS pending FROM chunks WHERE embedding IS NULL");
  const connections = (await db.query<{ health: string; n: number }>("SELECT coalesce(health, 'unknown') AS health, count(*)::int AS n FROM connections WHERE enabled GROUP BY 1")).rows;
  const activity = await one<{ sessions: number; incidents: number }>(
    "SELECT (SELECT count(*)::int FROM agent_sessions WHERE ended_at IS NULL AND last_seen_at > now() - interval '3 minutes') AS sessions, (SELECT count(*)::int FROM incidents WHERE status <> 'resolved') AS incidents",
  );
  const backup = job("backup");
  return {
    build: buildInfo(),
    database,
    jobs,
    backups: {
      last: backup,
      offsite: job("backup_offsite"),
      restore_check: job("restore_check"),
      stale: backup ? !backup.last_success || Date.now() - new Date(backup.last_success).getTime() > BACKUP_STALE_HOURS * 3_600_000 : null,
      note: backup ? null : "No backup has reported here yet. The native install's daily backup reports itself; other installs back up the database their own way.",
    },
    embeddings: { enabled: !!ctx.embedder, pending: embeddings.pending },
    disk,
    connections,
    activity,
    problems: problems(jobs, backup),
  };
}

type JobRow = { name: string; status: string | null; last_success: string | null; last_error: string | null; failures: number };

function problems(jobs: JobRow[], backup: JobRow | null) {
  const out: string[] = [];
  if (backup && (!backup.last_success || Date.now() - new Date(backup.last_success).getTime() > BACKUP_STALE_HOURS * 3_600_000)) out.push(`No successful backup in the last ${BACKUP_STALE_HOURS} hours.`);
  const check = jobs.find((j) => j.name === "restore_check");
  if (check?.status === "failed") out.push(`The last restore check failed: ${check.last_error ?? "see the logs"}.`);
  for (const j of jobs) if (j.failures >= JOB_FAILURES && j.name !== "restore_check") out.push(`${j.name} has failed ${j.failures} times in a row: ${j.last_error ?? ""}`.trim());
  return out;
}

/** Tells Administrators about health problems, at most once a day each. Run from the maintenance job. */
export async function alertHealth(db: Db, settings: Settings) {
  const jobs = (await db.query<JobRow & { alerted_at: string | null }>("SELECT name, status, last_success, last_error, failures, alerted_at FROM job_runs")).rows;
  const due = (j: { alerted_at: string | null }) => !j.alerted_at || Date.now() - new Date(j.alerted_at).getTime() > 86_400_000;
  const backup = jobs.find((j) => j.name === "backup");
  const alerts: { job: string; title: string; body: string }[] = [];
  if (backup && due(backup) && (!backup.last_success || Date.now() - new Date(backup.last_success).getTime() > BACKUP_STALE_HOURS * 3_600_000))
    alerts.push({ job: "backup", title: "Thaliyola hasn't been backed up", body: `No successful backup in the last ${BACKUP_STALE_HOURS} hours${backup.last_error ? `: ${backup.last_error}` : ""}. Check thaliyola-backup.timer and the server's disk.` });
  const check = jobs.find((j) => j.name === "restore_check");
  if (check && check.status === "failed" && due(check)) alerts.push({ job: "restore_check", title: "The backup restore check failed", body: check.last_error ?? "The newest backup didn't restore cleanly." });
  for (const j of jobs)
    if (j.failures >= JOB_FAILURES && due(j) && j.name !== "restore_check" && !alerts.some((a) => a.job === j.name))
      alerts.push({ job: j.name, title: `A Thaliyola job keeps failing: ${j.name}`, body: `${j.failures} runs in a row. Last error: ${j.last_error ?? "unknown"}` });
  if (!alerts.length) return 0;
  const admins = (
    await db.query<{ id: string }>("SELECT id FROM users WHERE kind = 'human' AND disabled_at IS NULL AND approved_at IS NOT NULL AND (is_admin OR lower(email) = ANY($1::text[]))", [settings.adminEmails])
  ).rows.map((r) => r.id);
  for (const a of alerts) {
    await notify(db, settings, admins, { kind: "system", title: a.title, body: a.body, link: "#/admin/system?tab=health", route: false });
    await db.query("UPDATE job_runs SET alerted_at = now() WHERE name = $1", [a.job]);
  }
  return alerts.length;
}
