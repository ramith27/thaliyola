import type { Settings } from "../../config.js";
import type { Db, Queryable } from "../../db/pool.js";
import { emitChanged } from "../events.js";
import { notify, settingsManagersFor } from "../notify.js";
import { redact } from "../redaction.js";
import { canSeal, openJson, scrubSecrets, sealJson, SecretsUnavailableError } from "../secrets.js";
import { apiSyncDetail, syncApi } from "./apis.js";
import { syncSchema, type SyncSummary } from "./catalog.js";
import { KINDS } from "./kinds.js";
import type { NetPolicy } from "./network.js";
import { repoSyncDetail, syncRepos } from "./repos.js";
import { sendRouteDigests } from "./routes.js";
import { refreshDueTickets } from "./tickets.js";
import type { ConnectionKind, ConnectionOptions, ConnTarget, DriverEnv } from "./types.js";

/**
 * Running connections: the scheduled check (health, and the schema sync of databases), recording health,
 * telling a project's admins when a connection keeps failing (and once when it works again), and re-sealing secrets
 * after a key rotation. One server instance runs the schedule at a time (advisory lock).
 */

export interface ConnectionRow {
  id: string;
  scope_id: string;
  component_id: string | null;
  kind: ConnectionKind;
  name: string;
  config: Record<string, string>;
  secret: string | null;
  secret_hints: Record<string, string>;
  /** HTTP APIs: an OpenAPI spec pasted instead of a spec URL. */
  spec: string | null;
  options: ConnectionOptions;
  interval_minutes: number;
  enabled: boolean;
  state: { last_detail?: string; last_warning?: string; alerted?: boolean } & Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  failures: number;
  health: "untested" | "ok" | "failing";
}

export type Outcome = { ok: true; detail: string; warning?: string } | { ok: false; error: string };

export const aad = (id: string) => `connection:${id}`;

export function netPolicy(settings: Settings): NetPolicy {
  const c = settings.connections;
  return { allowPrivate: c?.allowPrivate ?? false, allowLocal: c?.allowLocal, ownHosts: c?.ownHosts ?? [], lookup: c?.lookup };
}

export function driverEnv(settings: Settings): DriverEnv {
  const c = settings.connections;
  return { net: netPolicy(settings), timeoutMs: c?.queryTimeoutMs ?? 15_000, endpoints: c?.endpoints };
}

/** A connection's secrets; sealed again with the current key when an older one opened them (unless `reseal` is false). */
export async function openSecrets(db: Queryable, settings: Settings, row: Pick<ConnectionRow, "id" | "secret">, opts: { reseal?: boolean } = {}): Promise<Record<string, string>> {
  if (!row.secret) return {};
  const keys = settings.connections?.keys;
  const { value, rotated } = openJson(row.secret, keys, aad(row.id));
  if (rotated && opts.reseal !== false && canSeal(keys)) await db.query("UPDATE connections SET secret = $2 WHERE id = $1 AND secret = $3", [row.id, sealJson(value, keys, aad(row.id)), row.secret]);
  return value;
}

export function targetOf(row: Pick<ConnectionRow, "id" | "kind" | "config" | "options">, secret: Record<string, string>): ConnTarget {
  return { id: row.id, kind: row.kind, config: row.config ?? {}, secret, options: row.options ?? {} };
}

/** A failure as people may see it: no secret values, nothing the redaction rules catch, one short paragraph. */
export function errorText(err: unknown, secrets: Record<string, string> = {}): string {
  const e = err as Error & { code?: string; errors?: Error[] };
  let message = e?.name === "TimeoutError" ? "timed out" : e?.message || (e?.errors?.[0]?.message ?? "") || e?.code || String(err);
  if (/timeout/i.test(message) && !/timed out/i.test(message)) message = `timed out (${message})`;
  message = scrubSecrets(message, Object.values(secrets));
  return redact(message).text.replace(/\s+/g, " ").trim().slice(0, 500) || "failed";
}

/** A success message: ours, but it can carry what the remote said (names, versions); no secret values in it. */
export function detailText(text: string, secrets: Record<string, string> = {}): string {
  return scrubSecrets(text, Object.values(secrets)).replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Whether a kind's scheduled run syncs a schema (databases with a driver for it), not just checks the connection. */
export const syncsSchema = (kind: ConnectionKind) => !!KINDS[kind].introspect;

/**
 * What a kind's scheduled run (and Sync now) brings into Thaliyola besides checking the connection: a database's tables
 * ("schema"), an API's endpoints from its OpenAPI spec ("api"), or the project's repositories' facts ("repos").
 */
export type SyncKind = "schema" | "api" | "repos";
export function syncKind(kind: ConnectionKind): SyncKind | null {
  if (syncsSchema(kind)) return "schema";
  if (kind === "http_api") return "api";
  if (kind === "git") return "repos";
  return null;
}

/** "12 tables and 3 views (2 changed)". */
export function syncDetail(s: SyncSummary): string {
  const parts = [s.tables ? `${s.tables} ${s.tables === 1 ? "table" : "tables"}` : "", s.views ? `${s.views} ${s.views === 1 ? "view" : "views"}` : ""].filter(Boolean);
  const what = parts.length ? parts.join(" and ") : "no tables";
  const changes = [s.added ? `${s.added} new` : "", s.changed ? `${s.changed} changed` : "", s.removed ? `${s.removed} removed` : ""].filter(Boolean);
  return `Synced ${what}${changes.length ? ` (${changes.join(", ")})` : ""}.${s.truncated ? " The list was cut at the most tables a sync keeps (max_objects): narrow it with schemas to sync." : ""}`;
}

/** A sync already running (on any instance) for this connection; one that started over 30 minutes ago is abandoned. */
async function claimSync(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE connections SET state = state || jsonb_build_object('sync_started', now())
      WHERE id = $1 AND (state->>'sync_started' IS NULL OR (state->>'sync_started')::timestamptz < now() - interval '30 minutes')`,
    [id],
  );
  return !!rowCount;
}

export class SyncBusyError extends Error {}

/**
 * Checks a connection; with `sync` (scheduled runs and Sync now), databases with schema sync also bring their tables
 * into the knowledge base. Never throws, except SyncBusyError when asked to sync while a sync is running.
 */
export async function runConnection(db: Db, settings: Settings, row: ConnectionRow, opts: { sync?: boolean } = {}): Promise<Outcome> {
  let secrets: Record<string, string> = {};
  const what = opts.sync ? syncKind(row.kind) : null;
  const sync = !!what;
  if (sync && !(await claimSync(db, row.id))) throw new SyncBusyError("a sync of this connection is already running; wait for it to finish");
  try {
    secrets = await openSecrets(db, settings, row);
    const env = driverEnv(settings);
    const target = targetOf(row, secrets);
    const r = await KINDS[row.kind].test(target, env);
    let detail = r.detail;
    const synced = async (summary: Record<string, unknown>) =>
      db.query(`UPDATE connections SET state = state || jsonb_build_object('synced_at', now(), 'sync', $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify(summary)]);
    if (what === "schema") {
      const s = await syncSchema(db, settings, row, target, env);
      await synced({ tables: s.tables, views: s.views, added: s.added, changed: s.changed, removed: s.removed, truncated: s.truncated });
      detail = `${r.detail} ${syncDetail(s)}`;
    } else if (what === "api") {
      const s = await syncApi(db, settings, row, target, env);
      if (s.spec || s.spec_removed)
        await synced({ endpoints: s.endpoints, added: s.added, changed: s.changed, removed: s.removed, truncated: s.truncated, title: s.title, version: s.version, format: s.format, ...(s.spec_removed ? { spec_removed: true } : {}) });
      detail = `${r.detail} ${apiSyncDetail(s)}`;
    } else if (what === "repos") {
      const s = await syncRepos(db, row, target, env, (err) => errorText(err, secrets));
      await synced({ repositories: s.repositories, synced: s.synced, failed: s.failed.length });
      detail = `${r.detail} ${repoSyncDetail(s)}`;
    }
    return { ok: true, detail: detailText(detail, secrets), warning: r.warning ? detailText(r.warning, secrets) : undefined };
  } catch (err) {
    return { ok: false, error: errorText(err, secrets) };
  } finally {
    if (sync) await db.query("UPDATE connections SET state = state - 'sync_started' WHERE id = $1", [row.id]).catch(() => undefined);
  }
}

const settingsLink = (slug: string) => `#/scope/${slug}/settings?tab=connections`;

/**
 * Records a test or scheduled run on the connection: health, last error, failures, next run (backing off while it
 * fails: the interval, then twice it, four times… up to a day, or the interval if that's longer). Scheduled runs that
 * fail twice in a row tell the project's admins once; the first success after that tells them it works again.
 */
export async function recordOutcome(db: Db, settings: Settings, row: Pick<ConnectionRow, "id" | "name" | "scope_id">, outcome: Outcome, opts: { scheduled: boolean; actorId?: string }) {
  type Result = { failures: number; was_alerted: boolean; slug: string; project: string };
  let r: Result | undefined;
  if (outcome.ok) {
    r = (
      await db.query<Result>(
        `WITH old AS (SELECT id, coalesce((state->>'alerted')::boolean, false) AS alerted FROM connections WHERE id = $1 FOR UPDATE)
         UPDATE connections c SET health = 'ok', last_ok_at = now(), last_error = NULL, failures = 0,
                last_run_at = CASE WHEN $4 THEN now() ELSE c.last_run_at END,
                next_run_at = CASE WHEN c.next_run_at IS NULL THEN NULL WHEN $4 THEN now() + make_interval(mins => c.interval_minutes) ELSE c.next_run_at END,
                state = (c.state - 'alerted' - 'last_warning') || jsonb_strip_nulls(jsonb_build_object('last_detail', $2::text, 'last_warning', $3::text))
           FROM old, scopes s WHERE c.id = old.id AND s.id = c.scope_id
         RETURNING c.failures, old.alerted AS was_alerted, s.slug, s.name AS project`,
        [row.id, outcome.detail, outcome.warning ?? null, opts.scheduled],
      )
    ).rows[0];
  } else {
    r = (
      await db.query<Result>(
        `WITH old AS (SELECT id, failures, coalesce((state->>'alerted')::boolean, false) AS alerted FROM connections WHERE id = $1 FOR UPDATE)
         UPDATE connections c SET health = 'failing', last_error = $2, failures = old.failures + 1,
                last_run_at = CASE WHEN $3 THEN now() ELSE c.last_run_at END,
                next_run_at = CASE WHEN c.next_run_at IS NULL THEN NULL
                                   WHEN $3 THEN now() + make_interval(mins => LEAST(c.interval_minutes * power(2, LEAST(old.failures, 6))::int, GREATEST(c.interval_minutes, 1440)))
                                   ELSE c.next_run_at END,
                state = (c.state - 'last_detail' - 'last_warning') || CASE WHEN $3 AND old.failures + 1 >= 2 THEN '{"alerted": true}'::jsonb ELSE '{}'::jsonb END
           FROM old, scopes s WHERE c.id = old.id AND s.id = c.scope_id
         RETURNING c.failures, old.alerted AS was_alerted, s.slug, s.name AS project`,
        [row.id, outcome.error, opts.scheduled],
      )
    ).rows[0];
  }
  if (!r) return;
  emitChanged();
  if (!outcome.ok && opts.scheduled && r.failures >= 2 && !r.was_alerted) {
    await notify(
      db,
      settings,
      await settingsManagersFor(db, settings, row.scope_id),
      {
        kind: "connection",
        title: `Connection failing: ${row.name} (${r.project})`,
        body: `It failed ${r.failures} checks in a row: ${outcome.error}\nThaliyola keeps trying, less often while it fails.`,
        link: settingsLink(r.slug),
        targetId: row.id,
        scopeId: row.scope_id,
      },
      { exclude: opts.actorId },
    );
  } else if (outcome.ok && r.was_alerted) {
    await notify(
      db,
      settings,
      await settingsManagersFor(db, settings, row.scope_id),
      { kind: "connection", title: `Connection working again: ${row.name} (${r.project})`, body: outcome.detail, link: settingsLink(r.slug), targetId: row.id, scopeId: row.scope_id },
      { exclude: opts.actorId },
    );
  }
}

/**
 * Runs every connection that's due (10 at a time). Connections whose secret can't be opened without a key wait, and
 * connections of archived projects or projects in the trash aren't checked at all (they wait until it's restored).
 */
export async function runDueConnections(db: Db, settings: Settings, log: (msg: string) => void) {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT c.* FROM connections c JOIN scopes s ON s.id = c.scope_id
      WHERE c.enabled AND s.status = 'active' AND c.next_run_at IS NOT NULL AND c.next_run_at <= now()
      ORDER BY c.next_run_at LIMIT 10`,
  );
  const keys = settings.connections?.keys;
  let waiting = 0;
  for (const row of rows) {
    if (row.secret && !keys?.key && !keys?.oldKey) {
      waiting++;
      await db.query("UPDATE connections SET next_run_at = now() + make_interval(mins => interval_minutes) WHERE id = $1", [row.id]);
      continue;
    }
    let outcome: Outcome;
    try {
      outcome = await runConnection(db, settings, row, { sync: true });
    } catch (err) {
      // A sync started by hand is still running: check again next time.
      if (err instanceof SyncBusyError) continue;
      throw err;
    }
    await recordOutcome(db, settings, row, outcome, { scheduled: true });
    if (!outcome.ok) log(`connection "${row.name}" (${row.kind}) failed: ${outcome.error}`);
  }
  if (waiting) log(`${waiting} connection(s) not checked: CONNECTIONS_KEY isn't set, so their secrets can't be opened`);
  return rows.length;
}

/** After a key rotation: re-seals every secret only CONNECTIONS_KEY_OLD opens. Reports what can't be opened at all. */
export async function resealSecrets(db: Db, settings: Settings, log: (msg: string) => void) {
  const keys = settings.connections?.keys;
  if (!keys?.key) return { resealed: 0, unreadable: 0 };
  const { rows } = await db.query<{ id: string; secret: string }>("SELECT id, secret FROM connections WHERE secret IS NOT NULL");
  let resealed = 0;
  let unreadable = 0;
  for (const row of rows) {
    try {
      const { value, rotated } = openJson(row.secret, keys, aad(row.id));
      if (!rotated) continue;
      const r = await db.query("UPDATE connections SET secret = $2 WHERE id = $1 AND secret = $3", [row.id, sealJson(value, keys, aad(row.id)), row.secret]);
      resealed += r.rowCount ?? 0;
    } catch (err) {
      if (err instanceof SecretsUnavailableError) unreadable++;
      else throw err;
    }
  }
  if (resealed) log(`re-sealed ${resealed} connection secret(s) with the current CONNECTIONS_KEY; CONNECTIONS_KEY_OLD can be removed once every instance has restarted`);
  if (unreadable) log(`${unreadable} connection secret(s) can't be opened with CONNECTIONS_KEY or CONNECTIONS_KEY_OLD; their connections need the secret entered again`);
  return { resealed, unreadable };
}

/**
 * Checks for due connections every five minutes, one instance at a time, posts the project digests that are due and
 * refreshes the status of linked Jira and Linear tickets; re-seals secrets once at start-up.
 */
export function startConnectionJobs(db: Db, settings: Settings, log: (msg: string) => void) {
  if (!settings.connections?.enabled) return { async stop() {} };
  // Its own lock: 7_402_215 is the token checks'.
  const LOCK = 7_402_220;
  let resealed = false;
  async function tick() {
    // Database unreachable: log and try again next tick instead of an unhandled rejection that ends the process.
    const client = await db.connect().catch((err: Error) => void log(`connections failed: ${err.message}`));
    if (!client) return;
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK]);
      if (!rows[0]?.locked) return;
      try {
        if (!resealed) {
          await resealSecrets(db, settings, log);
          resealed = true;
        }
        await runDueConnections(db, settings, log);
        const digests = await sendRouteDigests(db, settings);
        if (digests.sent || digests.failed) log(`posted ${digests.sent} project digest(s) to Slack${digests.failed ? `; ${digests.failed} didn't go through` : ""}`);
        const tickets = await refreshDueTickets(db, settings);
        if (tickets.failed) log(`checked ${tickets.checked} linked ticket(s); ${tickets.failed} couldn't be read`);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
    } catch (err) {
      log(`connections failed: ${errorText(err)}`);
    } finally {
      client.release();
    }
  }
  // One run at a time, so shutdown can wait for it (like the other jobs).
  let current: Promise<void> | null = null;
  const start = () => {
    if (current) return;
    current = tick().finally(() => (current = null));
  };
  const first = setTimeout(start, 30_000);
  const timer = setInterval(start, 5 * 60_000);
  first.unref();
  timer.unref();
  return {
    /** Starts no more runs; resolves when the one in progress (if any) has finished. */
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
  };
}
