import { randomUUID } from "node:crypto";
import type { Settings } from "../../config.js";
import { withTx } from "../../db/pool.js";
import { audit, type AuditExtra } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { emitChanged } from "../events.js";
import { assertCanManage, assertCanRead, canManage } from "../permissions.js";
import { getComponent, getReadableScope } from "../scopes.js";
import { canSeal, hintOf, sealJson } from "../secrets.js";
import { checkComplete, defaultName, KINDS, kindSpec, showsTail, targetChanged, validateConfig, validateOptions, validateSecretInput, type FieldSpec, type SecretSpec } from "./kinds.js";
import { parseOpenApi, parseSpecText } from "./openapi.js";
import { aad, detailText, errorText, driverEnv, openSecrets, recordOutcome, runConnection, SyncBusyError, syncKind, syncsSchema, targetOf, type ConnectionRow, type Outcome } from "./sync.js";
import { CONNECTION_KINDS, type ConnectionKind, type ConnectionOptions } from "./types.js";

/**
 * Connections of a project (or of the Team space): CRUD, Test and health. Who manages them: people with Manage
 * settings in the project (Project admins) and Administrators (Team space: Administrators). Readers of the project see
 * that a connection exists, its kind and health, never its configuration. Secrets go in, never out: responses carry
 * only which secret fields are stored and, for long ones, their last characters.
 */

/** The kinds and their fields, for the UI. `configured`: secrets can be stored (CONNECTIONS_KEY is set). */
export function connectionKinds(settings: Settings) {
  const sealable = canSeal(settings.connections?.keys);
  const field = (f: FieldSpec) => ({
    key: f.key,
    label: f.label,
    required: !!f.required,
    hint: f.hint,
    placeholder: f.placeholder,
    type: f.type ?? "text",
    options: f.options,
    default: f.default,
    when: f.when,
  });
  const secret = (f: SecretSpec) => ({ key: f.key, label: f.label, required: !!f.required, hint: f.hint, multiline: !!f.multiline, when: f.when });
  return CONNECTION_KINDS.map((kind) => {
    const spec = KINDS[kind];
    return {
      kind,
      label: spec.label,
      group: spec.group,
      description: spec.description,
      scheduled: spec.scheduled,
      // What Sync now brings in: a database's tables (and read-only queries), an API's endpoints, repositories' facts.
      syncs: !!syncKind(kind),
      sync_kind: syncKind(kind),
      tables: syncsSchema(kind),
      queries: !!spec.query,
      target_fields: spec.targetFields,
      fields: spec.fields.map(field),
      secret_fields: spec.secretFields.map(secret),
      configured: sealable,
      needs: sealable ? null : "CONNECTIONS_KEY",
    };
  });
}

const VIEW = `SELECT c.id, c.kind, c.name, c.scope_id, s.slug AS scope, s.name AS scope_name, s.kind AS scope_kind, co.slug AS component,
                     c.config, c.secret_hints, octet_length(c.spec) AS spec_bytes, c.options, c.interval_minutes, c.enabled, c.health, c.failures, c.last_ok_at, c.last_run_at, c.last_error,
                     c.next_run_at, c.state->>'last_detail' AS last_detail, c.state->>'synced_at' AS synced_at, c.state->'sync' AS sync, c.state->>'last_warning' AS warning, c.created_at, c.updated_at,
                     coalesce(nullif(u.display_name, ''), u.email, u.subject) AS created_by, coalesce(u.email, u.subject) AS created_by_email
                FROM connections c JOIN scopes s ON s.id = c.scope_id LEFT JOIN components co ON co.id = c.component_id LEFT JOIN users u ON u.id = c.created_by`;

interface ViewRow {
  id: string;
  kind: ConnectionKind;
  name: string;
  scope_id: string;
  scope: string;
  scope_name: string;
  scope_kind: string;
  component: string | null;
  config: Record<string, string>;
  secret_hints: Record<string, string>;
  spec_bytes: number | null;
  options: ConnectionOptions;
  interval_minutes: number;
  enabled: boolean;
  health: "untested" | "ok" | "failing";
  failures: number;
  last_ok_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  last_detail: string | null;
  synced_at: string | null;
  sync: Record<string, unknown> | null;
  warning: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_email: string | null;
}

/** What managers see: everything but the secret itself. */
function managerView(r: ViewRow) {
  const { secret_hints, scope_id: _s, scope_kind: _k, spec_bytes, ...rest } = r;
  return {
    ...rest,
    label: KINDS[r.kind].label,
    group: KINDS[r.kind].group,
    scheduled: KINDS[r.kind].scheduled,
    syncs: !!syncKind(r.kind),
    sync_kind: syncKind(r.kind),
    // A pasted OpenAPI spec: its size only (the endpoints it describes are in the Data view).
    spec: spec_bytes ? { pasted: true, bytes: spec_bytes } : null,
    queries: !!KINDS[r.kind].query,
    // Tails only for the fields that may show one (also for hints stored before a field stopped showing it).
    secrets: Object.fromEntries(Object.entries(secret_hints ?? {}).map(([k, hint]) => [k, { set: true, hint: (showsTail(r.kind, k, r.config ?? {}) && hint) || null }])),
  };
}

/** What other readers of the project see. */
function readerView(r: ViewRow) {
  return {
    id: r.id,
    kind: r.kind,
    label: KINDS[r.kind].label,
    group: KINDS[r.kind].group,
    name: r.name,
    scope: r.scope,
    component: r.component,
    enabled: r.enabled,
    health: r.health,
    last_ok_at: r.last_ok_at,
    synced_at: r.synced_at,
  };
}

/** Connections belong to projects and the Team space (Administrators); not to the Library or personal spaces. */
function assertConnectable(scope: { kind: string; slug: string }) {
  if (scope.kind !== "project" && scope.kind !== "team") throw new ValidationError(`connections belong to a project (or the Team space), not ${scope.kind === "personal" ? "a personal space" : "the Library"}`);
}

function checkInterval(n: number | undefined) {
  if (n === undefined) return;
  if (!Number.isInteger(n) || n < 15 || n > 7 * 24 * 60) throw new ValidationError("interval_minutes must be between 15 and 10080 (a week)");
}

function checkName(name: string | undefined) {
  const n = name?.trim() ?? "";
  if (n.length > 80) throw new ValidationError("a connection name is at most 80 characters");
  return n;
}

async function componentId(ctx: RequestContext, scopeId: string, slug: string | null | undefined) {
  if (!slug) return null;
  return (await getComponent(ctx.db, scopeId, slug)).id;
}

function nameTaken(err: unknown, name: string): never {
  if ((err as { code?: string }).code === "23505") throw new ValidationError(`a connection called "${name}" already exists here; choose another name`);
  throw err;
}

export async function listConnections(ctx: RequestContext, slug: string) {
  const scope = await getReadableScope(ctx, slug);
  assertConnectable(scope);
  const manager = await canManage(ctx, scope);
  const { rows } = await ctx.db.query<ViewRow>(`${VIEW} WHERE c.scope_id = $1 ORDER BY lower(c.name)`, [scope.id]);
  const c = ctx.settings.connections;
  return {
    project: scope.slug,
    can_manage: manager,
    // Connections are kept but not checked or used when they're turned off on the server.
    enabled: c?.enabled ?? false,
    key_set: canSeal(c?.keys),
    connections: manager ? rows.map(managerView) : rows.map(readerView),
    kinds: manager ? connectionKinds(ctx.settings) : undefined,
  };
}

/** The connection, when the caller manages its project. Unreadable projects' connections don't exist. */
async function manageable(ctx: RequestContext, id: string): Promise<ConnectionRow & { scope_kind: string }> {
  const { rows } = await ctx.db.query<ConnectionRow & { scope_kind: string }>("SELECT c.*, s.kind AS scope_kind FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.id = $1", [id]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`connection ${id}`);
  await assertCanRead(ctx, row.scope_id, `connection ${id}`);
  await assertCanManage(ctx, { id: row.scope_id, kind: row.scope_kind });
  return row;
}

export async function getConnection(ctx: RequestContext, id: string) {
  await manageable(ctx, id);
  return managerView((await ctx.db.query<ViewRow>(`${VIEW} WHERE c.id = $1`, [id])).rows[0]!);
}

export interface ConnectionInput {
  kind: string;
  name?: string;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown>;
  options?: Record<string, unknown>;
  interval_minutes?: number;
  enabled?: boolean;
  component?: string | null;
  /** HTTP APIs: an OpenAPI (Swagger) spec, JSON or YAML, pasted instead of a spec URL; null or "" removes it. */
  spec?: string | null;
}

/** Pasted specs (request bodies are capped at 1 MB); a larger spec is read from its URL (up to 3 MB). */
export const MAX_SPEC_BYTES = 900 * 1024;

/** A pasted spec, checked now so a typo shows when saving rather than at the next sync. */
function checkSpec(kind: ConnectionKind, spec: string | null | undefined): string | null | undefined {
  if (spec === undefined) return undefined;
  if (spec === null || !spec.trim()) return null;
  if (kind !== "http_api") throw new ValidationError("only HTTP API connections take an OpenAPI spec");
  if (Buffer.byteLength(spec) > MAX_SPEC_BYTES) throw new ValidationError("the spec is larger than 900 KB; give its URL instead");
  parseOpenApi(parseSpecText(spec), { maxEndpoints: 0 });
  return spec.trim();
}

/**
 * Seals the secret fields (none: no secret stored) and their hints: which fields are stored, and for random tokens and
 * keys their last characters (never for passwords, passphrases or key files).
 */
function sealed(ctx: RequestContext, id: string, kind: ConnectionKind, config: Record<string, string>, secret: Record<string, string>) {
  const keys = Object.keys(secret);
  if (!keys.length) return { blob: null, hints: {} };
  const hints = Object.fromEntries(keys.map((k) => [k, showsTail(kind, k, config) ? hintOf(secret[k]!) : ""]));
  return { blob: sealJson(secret, ctx.settings.connections?.keys, aad(id)), hints };
}

/** Secret fields that apply to the config (e.g. no API key once authentication is "none"). */
function applicable(kind: ConnectionKind, config: Record<string, string>, secret: Record<string, string>) {
  return Object.fromEntries(Object.entries(secret).filter(([k]) => {
    const when = KINDS[kind].secretFields.find((f) => f.key === k)?.when;
    return !when || when.values.includes(config[when.key] ?? "");
  }));
}

export async function createConnection(ctx: RequestContext, slug: string, input: ConnectionInput) {
  const scope = await getReadableScope(ctx, slug);
  assertConnectable(scope);
  await assertCanManage(ctx, scope);
  kindSpec(input.kind);
  const kind = input.kind as ConnectionKind;
  const config = validateConfig(kind, input.config ?? {});
  const given = validateSecretInput(kind, input.secret);
  const secret = applicable(kind, config, Object.fromEntries(Object.entries(given).filter((e): e is [string, string] => e[1] !== null)));
  checkComplete(kind, config, new Set(Object.keys(secret)));
  const options = validateOptions(kind, input.options);
  checkInterval(input.interval_minutes);
  const name = checkName(input.name) || defaultName(kind, config);
  const component = await componentId(ctx, scope.id, input.component);
  const spec = checkSpec(kind, input.spec) ?? null;
  const id = randomUUID();
  const { blob, hints } = sealed(ctx, id, kind, config, secret);
  await ctx.db
    .query(
      `INSERT INTO connections (id, scope_id, component_id, kind, name, config, secret, secret_hints, options, interval_minutes, enabled, next_run_at, created_by, spec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN now() END, $13, $14)`,
      [id, scope.id, component, kind, name, config, blob, hints, options, input.interval_minutes ?? 360, input.enabled ?? true, KINDS[kind].scheduled, ctx.actor.id, spec],
    )
    .catch((err) => nameTaken(err, name));
  await audit(ctx.db, ctx.actor.id, "create_connection", id, {
    targetKind: "connection",
    targetLabel: name,
    details: { project: scope.slug, connection_kind: kind, name, enabled: input.enabled ?? true, secret_fields: Object.keys(secret).sort(), ...(input.component ? { repository: input.component } : {}) },
  });
  emitChanged();
  return getConnection(ctx, id);
}

export async function updateConnection(ctx: RequestContext, id: string, patch: Omit<ConnectionInput, "kind">) {
  const row = await manageable(ctx, id);
  const kind = row.kind;
  const config = patch.config ? validateConfig(kind, patch.config) : row.config;
  const given = validateSecretInput(kind, patch.secret);
  const configChanged = JSON.stringify(config) !== JSON.stringify(row.config);
  const stored = new Set(Object.keys(row.secret_hints ?? {}));
  // Pointing the connection somewhere else: stored secrets don't go along (they must be entered again).
  const moved = stored.size > 0 && targetChanged(kind, row.config, config);
  let blob: string | null | undefined;
  let hints: Record<string, string> | undefined;
  // Only open what's stored when something about the secret changes.
  const dropping = [...stored].some((k) => !(k in applicable(kind, config, { [k]: "x" })));
  if (Object.keys(given).length || dropping || moved) {
    const replacingAll = [...stored].every((k) => k in given);
    const current = row.secret && !replacingAll && !moved ? await openSecrets(ctx.db, ctx.settings, row) : {};
    for (const [k, v] of Object.entries(given)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    const next = applicable(kind, config, current);
    try {
      checkComplete(kind, config, new Set(Object.keys(next)));
    } catch (err) {
      if (moved && err instanceof ValidationError) throw new ValidationError(`${err.message}: this connection now points somewhere else, so its stored secrets must be entered again`);
      throw err;
    }
    ({ blob, hints } = sealed(ctx, id, kind, config, next));
  } else {
    checkComplete(kind, config, stored);
    // A field that no longer shows its tail (e.g. a token that's now a basic-auth password) stops showing it.
    const shown = row.secret_hints ?? {};
    if (Object.entries(shown).some(([k, h]) => h && !showsTail(kind, k, config))) {
      blob = row.secret;
      hints = Object.fromEntries(Object.entries(shown).map(([k, h]) => [k, showsTail(kind, k, config) ? h : ""]));
    }
  }
  const options = patch.options ? validateOptions(kind, patch.options) : undefined;
  checkInterval(patch.interval_minutes);
  const name = checkName(patch.name);
  const component = patch.component === undefined ? undefined : await componentId(ctx, row.scope_id, patch.component);
  const spec = checkSpec(kind, patch.spec);
  // A changed address or secret means the last check says nothing about the connection any more.
  const reset = configChanged || blob !== undefined;
  await ctx.db
    .query(
      `UPDATE connections SET name = coalesce($2, name), config = $3,
              secret = CASE WHEN $4 THEN $5 ELSE secret END, secret_hints = CASE WHEN $4 THEN $6::jsonb ELSE secret_hints END,
              options = coalesce($7, options), interval_minutes = coalesce($8, interval_minutes), enabled = coalesce($9, enabled),
              component_id = CASE WHEN $10 THEN $11 ELSE component_id END,
              spec = CASE WHEN $13 THEN $14 ELSE spec END,
              health = CASE WHEN $12 THEN 'untested' ELSE health END, failures = CASE WHEN $12 THEN 0 ELSE failures END,
              last_error = CASE WHEN $12 THEN NULL ELSE last_error END,
              state = CASE WHEN $12 THEN state - 'last_detail' - 'last_warning' ELSE state END,
              next_run_at = CASE WHEN next_run_at IS NULL THEN NULL
                                 WHEN $12 OR $13 OR ($9 IS TRUE AND NOT enabled) THEN now()
                                 WHEN $8::int IS NOT NULL THEN least(next_run_at, now() + make_interval(mins => $8::int))
                                 ELSE next_run_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        name || null,
        config,
        blob !== undefined,
        blob ?? null,
        hints ?? {},
        options ?? null,
        patch.interval_minutes ?? null,
        patch.enabled ?? null,
        component !== undefined,
        component ?? null,
        reset,
        spec !== undefined,
        spec ?? null,
      ],
    )
    .catch((err) => nameTaken(err, name));
  // What changed, by field name: config values can name hosts and users, never the secret values (only which ones).
  const changed = [
    ...(name && name !== row.name ? ["name"] : []),
    ...(configChanged ? Object.keys({ ...row.config, ...config }).filter((k) => JSON.stringify(row.config[k]) !== JSON.stringify(config[k])).map((k) => `config.${k}`) : []),
    ...(options ? ["options"] : []),
    ...(patch.interval_minutes !== undefined && patch.interval_minutes !== row.interval_minutes ? ["interval_minutes"] : []),
    ...(component !== undefined && component !== row.component_id ? ["repository"] : []),
    ...(spec !== undefined ? ["spec"] : []),
  ];
  await audit(ctx.db, ctx.actor.id, "update_connection", id, {
    targetKind: "connection",
    targetLabel: name || row.name,
    details: {
      connection_kind: kind,
      ...(name && name !== row.name ? { name_before: row.name, name_after: name } : {}),
      fields: changed,
      ...(patch.enabled !== undefined && patch.enabled !== row.enabled ? { paused: !patch.enabled } : {}),
      ...(blob !== undefined ? { secret_fields: Object.keys(hints ?? {}).sort(), secret_changed: Object.keys(given).sort() } : {}),
    },
  });
  emitChanged();
  return getConnection(ctx, id);
}

export async function deleteConnection(ctx: RequestContext, id: string) {
  const row = await manageable(ctx, id);
  await withTx(ctx.db, async (tx) => {
    // What a git connection read about repositories (from a token that may see private ones) goes with it.
    await tx.query("UPDATE components SET repo_info = NULL, repo_synced_at = NULL WHERE repo_info->>'connection' = $1", [id]);
    await tx.query("DELETE FROM connections WHERE id = $1", [id]);
  });
  await audit(ctx.db, ctx.actor.id, "delete_connection", id, { targetKind: "connection", targetLabel: row.name, details: { connection_kind: row.kind, name: row.name } });
  emitChanged();
  return { deleted: id };
}

function assertEnabled(ctx: RequestContext) {
  if (!ctx.settings.connections?.enabled) throw new ForbiddenError("connections are turned off on this server (CONNECTIONS=off)");
}

/**
 * Tests (and syncs started by hand) reach out to other hosts (private networks included, for databases), so each person gets a few a minute and
 * at most two at a time (per server instance). The minute's budget is reserved before the test runs: under a lock per
 * person, the minute's tests are counted and this one's audit row written, so tests started in parallel (on any
 * instance) can't all see room under the limit.
 */
export const TESTS_PER_MINUTE = 20;
export const TESTS_AT_ONCE = 2;
const running = new Map<string, number>();

/** Reserves one test for the caller (audited as `tool`); call the returned function when the test is done. */
export async function reserveTest(
  ctx: RequestContext,
  tool: "test_connection" | "test_connection_draft" | "sync_connection" | "send_digest",
  targetId: string | null,
  atOnce = TESTS_AT_ONCE,
  extra: AuditExtra = {},
): Promise<() => void> {
  const who = ctx.actor.id;
  const now = running.get(who) ?? 0;
  if (now >= atOnce) throw new ValidationError(`you already have ${atOnce} connection tests running; wait for them to finish`);
  running.set(who, now + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (running.get(who) ?? 1) - 1;
    if (n > 0) running.set(who, n);
    else running.delete(who);
  };
  try {
    // One person's reservations take turns (a lock per person, held for the count and the insert), on every instance.
    await withTx(ctx.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7402216, hashtext($1))", [who]);
      const { rows } = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND tool IN ('test_connection', 'test_connection_draft', 'sync_connection', 'send_digest') AND at > clock_timestamp() - interval '1 minute'",
        [who],
      );
      if ((rows[0]?.n ?? 0) >= TESTS_PER_MINUTE) throw new ValidationError(`that's ${TESTS_PER_MINUTE} connection tests in a minute; wait a moment and try again`);
      // Recorded like any other change (same request as the web or MCP call, with what it was about).
      await audit(tx, who, tool, targetId, extra);
    });
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

const result = (o: Outcome) => (o.ok ? { ok: true as const, detail: o.detail, warning: o.warning ?? null } : { ok: false as const, error: o.error });

/** Tests a saved connection now and records the result as its health. */
export async function testConnection(ctx: RequestContext, id: string) {
  assertEnabled(ctx);
  const row = await manageable(ctx, id);
  const done = await reserveTest(ctx, "test_connection", id, TESTS_AT_ONCE, { targetKind: "connection", targetLabel: row.name, details: { connection_kind: row.kind } });
  let outcome: Outcome;
  try {
    outcome = await runConnection(ctx.db, ctx.settings, row);
  } finally {
    done();
  }
  await recordOutcome(ctx.db, ctx.settings, row, outcome, { scheduled: false, actorId: ctx.actor.id });
  const after = (await ctx.db.query<{ health: string; last_ok_at: string | null }>("SELECT health, last_ok_at FROM connections WHERE id = $1", [id])).rows[0];
  return { ...result(outcome), health: after?.health, last_ok_at: after?.last_ok_at ?? null };
}

/**
 * Tests what's in the form before saving it. Editing an existing connection (`id`): secret fields left empty use
 * the stored ones. Nothing is stored.
 */
export async function testDraft(ctx: RequestContext, slug: string, input: ConnectionInput & { id?: string }) {
  assertEnabled(ctx);
  const scope = await getReadableScope(ctx, slug);
  assertConnectable(scope);
  await assertCanManage(ctx, scope);
  kindSpec(input.kind);
  const kind = input.kind as ConnectionKind;
  const config = validateConfig(kind, input.config ?? {});
  const given = validateSecretInput(kind, input.secret);
  let secret: Record<string, string> = {};
  if (input.id) {
    const row = await manageable(ctx, input.id);
    if (row.scope_id !== scope.id || row.kind !== kind) throw new ValidationError("that connection is of another kind or project");
    // Stored secrets are only ever sent where the saved connection points.
    if (!targetChanged(kind, row.config, config)) secret = await openSecrets(ctx.db, ctx.settings, row);
  }
  for (const [k, v] of Object.entries(given)) {
    if (v === null) delete secret[k];
    else secret[k] = v;
  }
  secret = applicable(kind, config, secret);
  checkComplete(kind, config, new Set(Object.keys(secret)));
  const options = validateOptions(kind, input.options);
  const done = await reserveTest(ctx, "test_connection_draft", input.id ?? null, TESTS_AT_ONCE, {
    targetKind: input.id ? "connection" : "project",
    targetLabel: input.id ? (checkName(input.name) || null) : scope.name,
    details: { project: scope.slug, connection_kind: kind, draft: true },
  });
  try {
    const r = await KINDS[kind].test(targetOf({ id: input.id ?? "draft", kind, config, options }, secret), driverEnv(ctx.settings));
    return { ok: true as const, detail: detailText(r.detail, secret), warning: r.warning ? detailText(r.warning, secret) : null };
  } catch (err) {
    return { ok: false as const, error: errorText(err, secret) };
  } finally {
    done();
  }
}

/**
 * Sync now: a database's tables into the knowledge base, right away (it also counts as a check of the connection).
 * Same budget as Test. A sync already running for the connection, from the schedule or someone else, is refused.
 */
export async function syncConnection(ctx: RequestContext, id: string) {
  assertEnabled(ctx);
  const row = await manageable(ctx, id);
  if (!syncKind(row.kind)) throw new ValidationError(`${KINDS[row.kind].label} connections have nothing to sync`);
  if (!row.enabled) throw new ValidationError(`${row.name} is paused; resume it first`);
  const done = await reserveTest(ctx, "sync_connection", id, TESTS_AT_ONCE, { targetKind: "connection", targetLabel: row.name, details: { connection_kind: row.kind } });
  let outcome: Outcome;
  try {
    outcome = await runConnection(ctx.db, ctx.settings, row, { sync: true });
  } catch (err) {
    if (err instanceof SyncBusyError) throw new ValidationError(err.message);
    throw err;
  } finally {
    done();
  }
  await recordOutcome(ctx.db, ctx.settings, row, outcome, { scheduled: false, actorId: ctx.actor.id });
  const after = (await ctx.db.query<{ health: string; last_ok_at: string | null; synced_at: string | null; sync: Record<string, unknown> | null }>(
    "SELECT health, last_ok_at, state->>'synced_at' AS synced_at, state->'sync' AS sync FROM connections WHERE id = $1",
    [id],
  )).rows[0];
  return { ...result(outcome), health: after?.health, last_ok_at: after?.last_ok_at ?? null, synced_at: after?.synced_at ?? null, sync: after?.sync ?? null };
}
