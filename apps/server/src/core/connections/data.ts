import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { assertCanManage, assertCanPropose, assertCanRead, can, canManage, hasPermission, readableScopes } from "../permissions.js";
import { redact } from "../redaction.js";
import { getReadableScope } from "../scopes.js";
import { refreshTableArticle } from "./catalog.js";
import { KINDS } from "./kinds.js";
import type { ColumnDef, TableDef } from "./schema.js";
import { DATABASE_KINDS, type ConnectionKind, type ConnectionOptions } from "./types.js";

/**
 * Reading what syncs found: the project's Data view, one table with its data dictionary and history, the tools agents
 * use (get_table_schema, describe_columns, list_connections), and the data_sources section of get_project_context.
 * Everything here is for readers of the project; describing columns is for people who may propose there, and only
 * those who manage the project's settings may say a column no longer holds personal data.
 */

type Scope = Awaited<ReturnType<typeof getReadableScope>>;

/** The project (or Team space) whose connections are meant: `project`, or the session's project. */
export async function connectionScope(ctx: RequestContext, project?: string): Promise<Scope> {
  const slug = project ?? ctx.project;
  if (!slug) throw new ValidationError("no project given: pass `project` or set the X-Thaliyola-Project header");
  const scope = await getReadableScope(ctx, slug);
  if (scope.kind !== "project" && scope.kind !== "team") throw new ValidationError(`'${slug}' is a ${scope.kind} space: connections belong to projects`);
  return scope;
}

/** Whether the caller may run read-only queries in a scope: Propose there (Contributors and above), or Manage every project. */
export async function canQuery(ctx: RequestContext, scopeId: string): Promise<boolean> {
  return hasPermission(ctx, scopeId, "propose");
}

/** Whether the caller may add to the data dictionary there (the same rule as proposing). */
async function canDescribe(ctx: RequestContext, scopeId: string): Promise<boolean> {
  try {
    await assertCanPropose(ctx, scopeId);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

interface ConnRow {
  id: string;
  scope_id: string;
  kind: ConnectionKind;
  name: string;
  enabled: boolean;
  health: string;
  options: ConnectionOptions;
  state: { synced_at?: string; sync?: Record<string, unknown> };
  last_ok_at: string | null;
  component: string | null;
}

const CONN = `SELECT c.id, c.scope_id, c.kind, c.name, c.enabled, c.health, c.options, c.state, c.last_ok_at, co.slug AS component
                FROM connections c LEFT JOIN components co ON co.id = c.component_id`;

function connSummary(c: ConnRow) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    label: KINDS[c.kind].label,
    component: c.component,
    enabled: c.enabled,
    health: c.health,
    last_ok_at: c.last_ok_at,
    synced_at: c.state?.synced_at ?? null,
    queries: !!c.options?.allow_query && !!KINDS[c.kind].query,
  };
}

/** A connection of the scope by name (any case) or id. */
export async function findConnection(ctx: RequestContext, scope: Scope, ref: string): Promise<ConnRow> {
  const r = ref.trim();
  const isId = /^[0-9a-f-]{36}$/i.test(r);
  const { rows } = await ctx.db.query<ConnRow>(`${CONN} WHERE c.scope_id = $1 AND ${isId ? "c.id = $2::uuid" : "lower(c.name) = lower($2)"}`, [scope.id, r]);
  if (!rows[0]) {
    const names = (await ctx.db.query<{ name: string }>("SELECT name FROM connections WHERE scope_id = $1 ORDER BY lower(name)", [scope.id])).rows.map((x) => x.name);
    throw new NotFoundError(`connection "${r}" in ${scope.slug}${names.length ? ` (it has: ${names.join(", ")})` : " (it has no connections)"}`);
  }
  return rows[0];
}

// ---- The project's Data view ----------------------------------------------------------------------------------------

interface ObjectListRow {
  id: string;
  connection_id: string;
  key: string;
  kind: "table" | "view";
  schema: string;
  name: string;
  columns: number;
  rows: number | null;
  removed_at: string | null;
  article_id: string | null;
  pii: number;
  described: number;
}

/** HTTP API connections of a project with their synced endpoints (counts only: open an API for those). */
async function projectApis(ctx: RequestContext, scopeId: string) {
  const { rows } = await ctx.db.query<ConnRow & { endpoints: number; removed: number; article_id: string | null; title: string | null; version: string | null }>(
    `SELECT x.*, (SELECT count(*) FROM connection_objects o WHERE o.connection_id = x.id AND o.kind = 'endpoint' AND o.removed_at IS NULL)::int AS endpoints,
            (SELECT count(*) FROM connection_objects o WHERE o.connection_id = x.id AND o.kind = 'endpoint' AND o.removed_at IS NOT NULL)::int AS removed,
            (SELECT a.id FROM articles a WHERE a.id::text = x.state->>'api_article' AND a.status <> 'deleted') AS article_id,
            x.state->'sync'->>'title' AS title, x.state->'sync'->>'version' AS version
       FROM (${CONN} WHERE c.scope_id = $1 AND c.kind = 'http_api') x ORDER BY lower(x.name)`,
    [scopeId],
  );
  return rows.map((c) => ({
    ...connSummary(c),
    queries: false,
    calls: c.options?.allow_calls !== false,
    endpoints: c.endpoints,
    removed: c.removed,
    article_id: c.article_id,
    title: c.title,
    version: c.version,
  }));
}

/** Database connections of a project, each with its schemas and their tables (no columns: open a table for those), and its APIs. */
export async function projectData(ctx: RequestContext, slug: string) {
  const scope = await connectionScope(ctx, slug);
  const { rows: conns } = await ctx.db.query<ConnRow>(`${CONN} WHERE c.scope_id = $1 AND c.kind = ANY($2::text[]) ORDER BY lower(c.name)`, [scope.id, DATABASE_KINDS]);
  const { rows: objects } = await ctx.db.query<ObjectListRow>(
    `SELECT o.id, o.connection_id, o.key, o.kind, coalesce(o.definition->>'schema', split_part(o.key, '.', 1)) AS schema,
            coalesce(o.definition->>'name', o.key) AS name, coalesce(jsonb_array_length(o.definition->'columns'), 0)::int AS columns,
            (o.definition->>'rows')::float8 AS rows, o.removed_at, o.article_id,
            (SELECT count(*) FROM column_notes n WHERE n.object_id = o.id AND n.pii)::int AS pii,
            (SELECT count(*) FROM column_notes n WHERE n.object_id = o.id AND n.description <> '')::int AS described
       FROM connection_objects o JOIN connections c ON c.id = o.connection_id
      WHERE c.scope_id = $1 AND o.kind IN ('table', 'view') AND o.filtered_at IS NULL
      ORDER BY lower(o.key) COLLATE "C", o.key COLLATE "C"`,
    [scope.id],
  );
  return {
    project: scope.slug,
    can_describe: await canDescribe(ctx, scope.id),
    can_query: await canQuery(ctx, scope.id),
    can_manage: await canManage(ctx, scope),
    apis: await projectApis(ctx, scope.id),
    connections: conns.map((c) => {
      const mine = objects.filter((o) => o.connection_id === c.id);
      const schemas = [...new Set(mine.map((o) => o.schema))];
      return {
        ...connSummary(c),
        sync: c.state?.sync ?? null,
        schemas: schemas.map((s) => ({
          name: s,
          tables: mine
            .filter((o) => o.schema === s)
            .map((o) => ({ id: o.id, key: o.key, name: o.name, kind: o.kind, columns: o.columns, rows: o.rows === null ? null : Math.round(o.rows), removed_at: o.removed_at, article_id: o.article_id, pii: o.pii, described: o.described })),
        })),
      };
    }),
  };
}

interface ObjectRow {
  id: string;
  connection_id: string;
  key: string;
  kind: "table" | "view";
  definition: TableDef;
  article_id: string | null;
  first_seen: string;
  last_seen: string;
  removed_at: string | null;
}

/** A synced table, when the caller can read its project. */
async function readableObject(ctx: RequestContext, objectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) throw new NotFoundError(`table ${objectId}`);
  const o = (await ctx.db.query<ObjectRow>("SELECT id, connection_id, key, kind, definition, article_id, first_seen, last_seen, removed_at FROM connection_objects WHERE id = $1 AND kind IN ('table', 'view')", [objectId])).rows[0];
  if (!o) throw new NotFoundError(`table ${objectId}`);
  const conn = (await ctx.db.query<ConnRow & { slug: string; scope_kind: string }>(`SELECT x.*, s.slug, s.kind AS scope_kind FROM (${CONN} WHERE c.id = $1) x JOIN scopes s ON s.id = x.scope_id`, [o.connection_id])).rows[0]!;
  await assertCanRead(ctx, conn.scope_id, `table ${objectId}`);
  return { o, conn };
}

interface NoteRow {
  column: string;
  description: string;
  pii: boolean;
  updated_at: string;
  updated_by: string | null;
}

async function notesFor(ctx: RequestContext, objectId: string) {
  const { rows } = await ctx.db.query<NoteRow>(
    `SELECT n."column", n.description, n.pii, n.updated_at, coalesce(nullif(u.display_name, ''), split_part(coalesce(u.email, u.subject), '@', 1)) AS updated_by
       FROM column_notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.object_id = $1`,
    [objectId],
  );
  return new Map(rows.map((r) => [r.column, r]));
}

/** Text the database stores about its tables (comments, defaults): anyone may have written it, so it's redacted. */
const dbText = (s: string | null | undefined) => (s === null || s === undefined || s === "" ? null : redact(s).text);

/** Columns with their dictionary notes; a note on a column that's gone is kept (and shown) until it's back. */
function columnsWithNotes(cols: ColumnDef[], notes: Map<string, NoteRow>) {
  return cols.map((c) => {
    const n = notes.get(c.name);
    return {
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: dbText(c.default),
      pk: !!c.pk,
      fk: c.fk ?? null,
      comment: dbText(c.comment),
      description: n?.description || null,
      pii: !!n?.pii,
      noted_by: n?.updated_by ?? null,
      noted_at: n?.updated_at ?? null,
    };
  });
}

/**
 * One table for the Data view: columns and notes, its schema history, its article and the entries that link to it.
 * `choices`: also the repositories the caller may say read or write it (the Data view's lineage form).
 */
export async function getTable(ctx: RequestContext, objectId: string, opts: { choices?: boolean } = {}) {
  const { o, conn } = await readableObject(ctx, objectId);
  const notes = await notesFor(ctx, o.id);
  const changes = await ctx.db.query<{ id: string; change: string; detail: Record<string, unknown>; at: string }>(
    "SELECT id, change, detail, at FROM connection_changes WHERE connection_id = $1 AND object_key = $2 ORDER BY at DESC LIMIT 50",
    [o.connection_id, o.key],
  );
  const article = o.article_id
    ? (await ctx.db.query<{ id: string; title: string; status: string; version: number; updated_at: string }>("SELECT id, title, status, version, updated_at FROM articles WHERE id = $1 AND status <> 'deleted'", [o.article_id])).rows[0] ?? null
    : null;
  return {
    id: o.id,
    key: o.key,
    kind: o.kind,
    schema: o.definition.schema,
    name: o.definition.name,
    comment: dbText(o.definition.comment),
    rows: o.definition.rows ?? null,
    first_seen: o.first_seen,
    last_seen: o.last_seen,
    removed_at: o.removed_at,
    project: conn.slug,
    connection: connSummary(conn),
    columns: columnsWithNotes(o.definition.columns ?? [], notes),
    changes: changes.rows,
    article,
    linked: article ? await linkedEntries(ctx, article.id) : [],
    lineage: article ? await lineageOf(ctx, article.id) : [],
    ...(opts.choices ? { lineage_choices: article ? await lineageChoices(ctx) : [] } : {}),
    can_describe: await canDescribe(ctx, conn.scope_id),
    can_unflag_pii: await canManage(ctx, { id: conn.scope_id, kind: conn.scope_kind }),
  };
}

/** Entries that link to the table's article, or are tagged with its table entity, in projects the caller can read. */
async function linkedEntries(ctx: RequestContext, articleId: string) {
  const { rows } = await ctx.db.query<{ kind: string; id: string; title: string; type: string; status: string; scope: string; via: string }>(
    `WITH ids AS (
       SELECT r.from_kind AS kind, r.from_id AS id, r.kind AS via FROM relations r WHERE r.to_id = $1 AND r.from_kind IN ('article', 'finding')
       UNION SELECT r.to_kind, r.to_id, r.kind FROM relations r WHERE r.from_id = $1 AND r.to_kind IN ('article', 'finding')
       UNION SELECT l.target_kind, l.target_id, 'tagged' FROM entity_links l JOIN entity_links mine ON mine.entity_id = l.entity_id AND mine.target_id = $1
              WHERE l.target_id <> $1 AND l.target_kind IN ('article', 'finding'))
     SELECT DISTINCT ON (ids.id) ids.kind, ids.id, coalesce(a.title, f.title) AS title, coalesce(a.type, f.type) AS type,
            coalesce(a.status, f.status) AS status, s.slug AS scope, ids.via
       FROM ids LEFT JOIN articles a ON ids.kind = 'article' AND a.id = ids.id LEFT JOIN findings f ON ids.kind = 'finding' AND f.id = ids.id
       JOIN scopes s ON s.id = coalesce(a.scope_id, f.scope_id)
      WHERE coalesce(a.status, f.status) IN ('published', 'possibly_stale') AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
      ORDER BY ids.id LIMIT 50`,
    [articleId, await readableScopes(ctx)],
  );
  return rows;
}

/**
 * Whether the caller may propose in scope `s` (SQL; $2 the caller, $3 Manage every project): the rule of
 * assertCanPropose (hasPermission, or a team-visible project where nobody holds Propose yet), in one query.
 */
const MAY_PROPOSE = `($3 OR EXISTS (SELECT 1 FROM scope_permissions p WHERE p.scope_id = s.id AND p.user_id = $2 AND p.permission = 'propose')
   OR (s.visibility <> 'members' AND NOT EXISTS (SELECT 1 FROM scope_permissions q WHERE q.scope_id = s.id AND q.permission = 'propose')))`;

/** Repositories that read or write the table (lineage); `can_remove` for people who may propose in the repository's project. */
async function lineageOf(ctx: RequestContext, articleId: string) {
  const { rows } = await ctx.db.query<{ kind: string; component: string; project: string; can_remove: boolean }>(
    `SELECT r.kind, c.slug AS component, s.slug AS project, ${MAY_PROPOSE} AS can_remove
       FROM relations r JOIN components c ON c.id = r.from_id JOIN scopes s ON s.id = c.scope_id
      WHERE r.to_id = $1 AND r.from_kind = 'component' AND r.kind IN ('reads', 'writes') AND ($4::uuid[] IS NULL OR s.id = ANY($4::uuid[]))
      ORDER BY s.slug, c.slug, r.kind`,
    [articleId, ctx.actor.id, can(ctx, "manage_all_projects"), await readableScopes(ctx)],
  );
  return rows;
}

/** Repositories the caller may say read or write a table: those of projects where they may propose (at most 300). */
async function lineageChoices(ctx: RequestContext) {
  const { rows } = await ctx.db.query<{ project: string; project_name: string; component: string; kind: string }>(
    `SELECT s.slug AS project, s.name AS project_name, c.slug AS component, c.kind FROM components c JOIN scopes s ON s.id = c.scope_id
      WHERE s.kind = 'project' AND s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[])) AND ${MAY_PROPOSE}
      ORDER BY s.name, c.slug LIMIT 300`,
    [await readableScopes(ctx), ctx.actor.id, can(ctx, "manage_all_projects")],
  );
  return rows;
}

/** Changes a sync recorded for a connection (newest first), for readers of its project. */
export async function listChanges(ctx: RequestContext, connectionId: string, limit = 100) {
  const conn = (await ctx.db.query<{ scope_id: string; name: string }>("SELECT scope_id, name FROM connections WHERE id = $1", [connectionId])).rows[0];
  if (!conn) throw new NotFoundError(`connection ${connectionId}`);
  await assertCanRead(ctx, conn.scope_id, `connection ${connectionId}`);
  const { rows } = await ctx.db.query(
    `SELECT ch.id, ch.object_key AS key, ch.change, ch.detail, ch.at, o.id AS table_id FROM connection_changes ch
       LEFT JOIN connection_objects o ON o.connection_id = ch.connection_id AND o.key = ch.object_key
      WHERE ch.connection_id = $1 ORDER BY ch.at DESC LIMIT $2`,
    [connectionId, Math.min(Math.max(limit, 1), 500)],
  );
  return { connection: conn.name, changes: rows };
}

/** The query log of a connection: what was run, by whom, how long it took. For people who manage the project. */
export async function listCalls(ctx: RequestContext, connectionId: string, limit = 100) {
  const conn = (await ctx.db.query<{ scope_id: string; kind: string; name: string }>("SELECT c.scope_id, s.kind, c.name FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.id = $1", [connectionId])).rows[0];
  if (!conn) throw new NotFoundError(`connection ${connectionId}`);
  await assertCanRead(ctx, conn.scope_id, `connection ${connectionId}`);
  await assertCanManage(ctx, { id: conn.scope_id, kind: conn.kind });
  const { rows } = await ctx.db.query(
    `SELECT k.id, k.kind, k.text, k.rows, k.status, k.ms, k.error, k.at, coalesce(nullif(u.display_name, ''), u.email, u.subject) AS actor,
            coalesce(u.email, u.subject) AS actor_email, u.kind AS actor_kind
       FROM connection_calls k LEFT JOIN users u ON u.id = k.actor_id WHERE k.connection_id = $1 ORDER BY k.at DESC LIMIT $2`,
    [connectionId, Math.min(Math.max(limit, 1), 500)],
  );
  return { connection: conn.name, calls: rows };
}

// ---- Agents: find a table, read its schema, describe its columns ------------------------------------------------

/**
 * A table by name: "table", "schema.table", or "connection.schema.table" (the entity name), optionally within one
 * connection. Ambiguous names list the candidates.
 */
export async function findTable(ctx: RequestContext, input: { project?: string; table: string; connection?: string }) {
  const scope = await connectionScope(ctx, input.project);
  const conn = input.connection ? await findConnection(ctx, scope, input.connection) : null;
  const want = input.table.trim().replace(/["`]/g, "").toLowerCase();
  if (!want) throw new ValidationError("table is empty");
  const { rows } = await ctx.db.query<{ id: string; key: string; connection: string }>(
    `SELECT o.id, o.key, c.name AS connection FROM connection_objects o JOIN connections c ON c.id = o.connection_id
      WHERE c.scope_id = $1 AND o.kind IN ('table', 'view') AND o.filtered_at IS NULL AND ($2::uuid IS NULL OR c.id = $2)
        AND (lower(o.key) = $3 OR lower(coalesce(o.definition->>'name', '')) = $3 OR lower(c.name || '.' || o.key) = $3)
      ORDER BY o.removed_at IS NOT NULL, o.key, c.name`,
    [scope.id, conn?.id ?? null, want],
  );
  if (!rows.length) throw new NotFoundError(`table "${input.table}" in ${scope.slug}'s synced connections (list them with list_connections, or check the name in get_project_context's data_sources)`);
  const exact = rows.filter((r) => r.key.toLowerCase() === want || `${r.connection}.${r.key}`.toLowerCase() === want);
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length > 1) throw new ValidationError(`"${input.table}" matches several tables: ${pick.map((r) => `${r.connection}.${r.key}`).join(", ")}. Pass connection, or schema.table`);
  return pick[0]!.id;
}

/** get_table_schema: columns, keys, row estimate, dictionary notes, recent changes, and the article to read and extend. */
export async function getTableSchema(ctx: RequestContext, input: { project?: string; table: string; connection?: string }) {
  const t = await getTable(ctx, await findTable(ctx, input));
  return {
    table: t.key,
    kind: t.kind,
    connection: { name: t.connection.name, kind: t.connection.kind, queries: t.connection.queries },
    rows_estimate: t.rows,
    comment: t.comment,
    removed_at: t.removed_at,
    last_synced: t.last_seen,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      ...(c.default ? { default: c.default } : {}),
      ...(c.pk ? { pk: true } : {}),
      ...(c.fk ? { fk: c.fk } : {}),
      ...(c.description || c.comment ? { description: c.description ?? c.comment } : {}),
      ...(c.pii ? { pii: true } : {}),
    })),
    recent_changes: t.changes.slice(0, 10).map((c) => ({ change: c.change, ...c.detail, at: c.at })),
    article: t.article ? { id: t.article.id, title: t.article.title, hint: "get_article for its grain, joins, gotchas and example queries; propose_article_edit to add what you learn (outside the synced block)" } : null,
    linked: t.linked.map((l) => ({ kind: l.kind, id: l.id, title: l.title, type: l.type })),
    ...(t.lineage.length ? { lineage: t.lineage.map(({ can_remove: _, ...l }) => l) } : {}),
  };
}

export interface ColumnNoteInput {
  column: string;
  description?: string;
  pii?: boolean;
}

/**
 * The data dictionary: what columns mean, and which hold personal data (masked in query results). Writers add notes;
 * saying a column is not personal data any more takes Manage settings. The table's article is updated with them.
 */
export async function describeColumns(ctx: RequestContext, input: { table_id?: string; project?: string; table?: string; connection?: string; notes: ColumnNoteInput[] }) {
  const id = input.table_id ?? (input.table ? await findTable(ctx, { project: input.project, table: input.table, connection: input.connection }) : null);
  if (!id) throw new ValidationError("pass table (or table_id)");
  const { o, conn } = await readableObject(ctx, id);
  if (input.project && input.table_id && conn.slug !== input.project) throw new NotFoundError(`table ${id} in ${input.project}`);
  await assertCanPropose(ctx, conn.scope_id);
  if (!input.notes?.length) throw new ValidationError("notes is empty");
  if (input.notes.length > 200) throw new ValidationError("at most 200 notes at a time");
  const names = new Map((o.definition.columns ?? []).map((c) => [c.name.toLowerCase(), c.name]));
  const current = await notesFor(ctx, o.id);
  const manager = await canManage(ctx, { id: conn.scope_id, kind: conn.scope_kind });
  const changes: { column: string; description: string; pii: boolean }[] = [];
  for (const n of input.notes) {
    const column = names.get(String(n.column ?? "").trim().toLowerCase());
    if (!column) throw new ValidationError(`${o.key} has no column "${n.column}" (columns: ${[...names.values()].slice(0, 40).join(", ")})`);
    const before = current.get(column);
    const description = n.description === undefined ? (before?.description ?? "") : redact(String(n.description).trim()).text.slice(0, 1000);
    const pii = n.pii === undefined ? !!before?.pii : !!n.pii;
    if (before?.pii && !pii && !manager) throw new ForbiddenError(`only people who manage ${conn.slug}'s settings can say ${column} isn't personal data any more`);
    if (before && before.description === description && before.pii === pii) continue;
    changes.push({ column, description, pii });
  }
  for (const c of changes) {
    await ctx.db.query(
      `INSERT INTO column_notes (object_id, "column", description, pii, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (object_id, "column") DO UPDATE SET description = EXCLUDED.description, pii = EXCLUDED.pii, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [o.id, c.column, c.description, c.pii, ctx.actor.id],
    );
  }
  let article = null;
  if (changes.length) {
    await audit(ctx.db, ctx.actor.id, "describe_columns", conn.id, {
      targetKind: "connection",
      targetLabel: conn.name,
      details: { project: conn.slug, table: o.key, columns: changes.map((c) => c.column), personal_data: changes.filter((c) => c.pii).map((c) => c.column) },
    });
    // By name: version summaries are shown to every reader, so not the email address.
    const who = (await ctx.db.query<{ who: string | null }>("SELECT coalesce(nullif(display_name, ''), split_part(coalesce(email, subject), '@', 1)) AS who FROM users WHERE id = $1", [ctx.actor.id])).rows[0]?.who ?? "someone";
    article = await refreshTableArticle(ctx.db, o.id, `Data dictionary: ${changes.map((c) => c.column).join(", ")} (${who})`.slice(0, 300));
  }
  const after = await notesFor(ctx, o.id);
  return {
    table: o.key,
    updated: changes.map((c) => c.column),
    article_id: article?.article_id ?? o.article_id,
    columns: columnsWithNotes(o.definition.columns ?? [], after)
      .filter((c) => c.description || c.pii)
      .map((c) => ({ name: c.name, description: c.description, pii: c.pii })),
  };
}

// ---- What agents see first -------------------------------------------------------------------------------------------

/** list_connections: what a project is connected to and what's synced. Never configuration or secrets. */
export async function listConnectionsFor(ctx: RequestContext, project?: string) {
  const scope = await connectionScope(ctx, project);
  const { rows } = await ctx.db.query<ConnRow & { tables: number; endpoints: number }>(
    `SELECT x.*, (SELECT count(*) FROM connection_objects o WHERE o.connection_id = x.id AND o.removed_at IS NULL AND o.filtered_at IS NULL AND o.kind IN ('table', 'view'))::int AS tables,
            (SELECT count(*) FROM connection_objects o WHERE o.connection_id = x.id AND o.removed_at IS NULL AND o.kind = 'endpoint')::int AS endpoints
       FROM (${CONN} WHERE c.scope_id = $1) x ORDER BY lower(x.name)`,
    [scope.id],
  );
  const mayQuery = await canQuery(ctx, scope.id);
  return {
    project: scope.slug,
    connections: rows.map((c) => ({
      ...connSummary(c),
      group: KINDS[c.kind].group,
      tables: DATABASE_KINDS.includes(c.kind) ? c.tables : undefined,
      ...(c.kind === "http_api" ? { endpoints: c.endpoints, calls: c.options?.allow_calls !== false } : {}),
    })),
    you_can_query: mayQuery,
    hint: "get_table_schema for a table's columns and notes; query_database runs a read-only SELECT on connections with queries: true. list_api_endpoints and call_api for HTTP APIs (calls: true); read_repo_file reads a repository's files through a git connection. Queries, calls and reads need Contributors and above.",
  };
}

/** get_project_context's data_sources: the project's databases and their most used (largest) tables, and its APIs. */
export async function projectDataSources(ctx: RequestContext, scopeId: string) {
  const apis = await projectApis(ctx, scopeId);
  const { rows: conns } = await ctx.db.query<ConnRow & { tables: number }>(
    `SELECT x.*, (SELECT count(*) FROM connection_objects o WHERE o.connection_id = x.id AND o.removed_at IS NULL AND o.filtered_at IS NULL AND o.kind IN ('table', 'view'))::int AS tables
       FROM (${CONN} WHERE c.scope_id = $1 AND c.kind = ANY($2::text[])) x ORDER BY lower(x.name)`,
    [scopeId, DATABASE_KINDS],
  );
  const { rows: trackers } = await ctx.db.query<{ name: string; kind: string; health: string; enabled: boolean }>(
    "SELECT name, kind, health, enabled FROM connections WHERE scope_id = $1 AND kind IN ('jira', 'linear') ORDER BY lower(name)",
    [scopeId],
  );
  if (!conns.length && !apis.length && !trackers.length) return null;
  const { rows: top } = await ctx.db.query<{ connection: string; key: string; kind: string; rows: number | null; article_id: string | null }>(
    `SELECT c.name AS connection, o.key, o.kind, (o.definition->>'rows')::float8 AS rows, o.article_id
       FROM connection_objects o JOIN connections c ON c.id = o.connection_id
      WHERE c.scope_id = $1 AND o.removed_at IS NULL AND o.filtered_at IS NULL AND o.kind IN ('table', 'view')
      ORDER BY (o.definition->>'rows')::float8 DESC NULLS LAST, o.key LIMIT 20`,
    [scopeId],
  );
  return {
    hint: "Databases and APIs this project uses. get_table_schema(table) for columns and notes; query_database for a small read-only SELECT (queries: true); describe_columns to record what a column means. list_api_endpoints for an API's endpoints; call_api to call one (calls: true).",
    connections: conns.map((c) => ({ name: c.name, kind: c.kind, health: c.health, tables: c.tables, synced_at: c.state?.synced_at ?? null, queries: !!c.options?.allow_query })),
    top_tables: top.map((t) => ({ connection: t.connection, table: t.key, kind: t.kind, rows_estimate: t.rows === null ? null : Math.round(t.rows), article_id: t.article_id })),
    ...(apis.length
      ? { apis: apis.map((a) => ({ name: a.name, health: a.health, title: a.title, version: a.version, endpoints: a.endpoints, synced_at: a.synced_at, calls: a.calls, article_id: a.article_id })) }
      : {}),
    // Jira and Linear: create_ticket opens an issue for a finding or article, link_ticket attaches one.
    ...(trackers.length ? { issue_trackers: trackers.map((t) => ({ name: t.name, kind: t.kind, health: t.health, paused: !t.enabled })) } : {}),
  };
}

// ---- One API for the Data view -------------------------------------------------------------------------------------

/** An HTTP API connection's endpoints (full definitions, removed ones last), its recent changes and its article. */
export async function getApi(ctx: RequestContext, connectionId: string) {
  const c = (await ctx.db.query<ConnRow & { slug: string }>(`SELECT x.*, s.slug FROM (${CONN} WHERE c.id = $1) x JOIN scopes s ON s.id = x.scope_id`, [connectionId])).rows[0];
  if (!c || c.kind !== "http_api") throw new NotFoundError(`API ${connectionId}`);
  await assertCanRead(ctx, c.scope_id, `API ${connectionId}`);
  const st = (await ctx.db.query<{ state: Record<string, unknown> }>("SELECT state FROM connections WHERE id = $1", [c.id])).rows[0]!.state ?? {};
  const { rows: endpoints } = await ctx.db.query<{ id: string; key: string; definition: Record<string, unknown>; first_seen: string; removed_at: string | null }>(
    `SELECT id, key, definition, first_seen, removed_at FROM connection_objects WHERE connection_id = $1 AND kind = 'endpoint'
      ORDER BY removed_at IS NOT NULL, definition->>'path', key LIMIT 5000`,
    [c.id],
  );
  const { rows: changes } = await ctx.db.query<{ id: string; key: string; change: string; detail: Record<string, unknown>; at: string }>(
    "SELECT id, object_key AS key, change, detail, at FROM connection_changes WHERE connection_id = $1 ORDER BY at DESC LIMIT 50",
    [c.id],
  );
  const articleId = typeof st.api_article === "string" ? st.api_article : null;
  const article = articleId ? (await ctx.db.query<{ id: string; title: string; status: string; version: number }>("SELECT id, title, status, version FROM articles WHERE id = $1 AND status <> 'deleted'", [articleId])).rows[0] ?? null : null;
  const sync = (st.sync ?? {}) as Record<string, unknown>;
  return {
    id: c.id,
    project: c.slug,
    connection: { ...connSummary(c), queries: false, calls: c.options?.allow_calls !== false },
    title: (sync.title as string) || null,
    version: (sync.version as string) || null,
    format: (sync.format as string) || null,
    // The spec was taken off the connection: the endpoints listed are the last one's, all marked removed.
    spec_removed: sync.spec_removed === true,
    endpoints: endpoints.map((e) => ({ id: e.id, key: e.key, ...e.definition, first_seen: e.first_seen, removed_at: e.removed_at })),
    changes,
    article,
    can_call: (await canQuery(ctx, c.scope_id)) && c.options?.allow_calls !== false,
  };
}
