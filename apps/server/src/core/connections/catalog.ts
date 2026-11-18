import type { Settings } from "../../config.js";
import { withTx, type Db, type Queryable } from "../../db/pool.js";
import { insertArticle, tagEntity } from "../bootstrap.js";
import { reindexArticle } from "../chunking.js";
import { emitChanged } from "../events.js";
import { membersOf, notify, readersOf, settingsManagersFor, watchersOf, type NotificationInput } from "../notify.js";
import { snapshot } from "../review.js";
import { systemActor } from "../users.js";
import { KINDS } from "./kinds.js";
import {
  BREAKING,
  currentSyncedBlock,
  definitionHash,
  describeChange,
  diffTable,
  newTableBody,
  renderSyncedBlock,
  replaceSyncedBlock,
  schemaWanted,
  tableKey,
  type ColumnNote,
  type SchemaChange,
  type TableDef,
} from "./schema.js";
import type { ConnectionKind, ConnTarget, DriverEnv } from "./types.js";

/**
 * Schema sync: a database's tables and views become connection_objects (one per table, keyed "schema.table") and one
 * `table` article each. The article's "Columns (synced)" block, between the sync markers, is the only part the sync
 * writes, and only when it changed; everything else in it is people's and agents'. Differences from the last sync are
 * the schema history (connection_changes). Breaking ones (a column or table gone, a type changed) raise impact notices
 * and tell the people who care.
 *
 * Synced facts publish directly, as "Thaliyola sync": they're what the database says, not someone's opinion. Every
 * version is kept, like a reviewed edit.
 */

export const DEFAULT_MAX_OBJECTS = 500;

export interface SyncConnection {
  id: string;
  scope_id: string;
  component_id: string | null;
  kind: ConnectionKind;
  name: string;
  state: Record<string, unknown>;
}

export interface SyncSummary {
  tables: number;
  views: number;
  added: number;
  changed: number;
  removed: number;
  /** More tables than max_objects: the rest weren't synced (and nothing was marked removed). */
  truncated: boolean;
  articles_written: number;
  breaking: number;
}

interface ObjectRow {
  id: string;
  key: string;
  kind: "table" | "view";
  definition: TableDef;
  hash: string;
  article_id: string | null;
  removed_at: string | null;
  filtered_at: string | null;
}

/** The entity a table article is tagged with: entities are global, so the connection name qualifies it. */
export const entityName = (connection: string, key: string) => `${connection}.${key}`;

/** Where a connection's table articles live. */
export const folderOf = (connection: string) => `Data/${connection.replace(/\//g, "-").trim()}`;

/** The Data view's link to one table. */
export const tableLink = (project: string, objectId: string) => `#/project/${project}?tab=data&table=${objectId}`;

async function notesOf(db: Queryable, objectIds: string[]): Promise<Map<string, Map<string, ColumnNote>>> {
  const out = new Map<string, Map<string, ColumnNote>>();
  if (!objectIds.length) return out;
  const { rows } = await db.query<{ object_id: string; column: string; description: string; pii: boolean }>(
    `SELECT object_id, "column", description, pii FROM column_notes WHERE object_id = ANY($1::uuid[])`,
    [objectIds],
  );
  for (const r of rows) {
    const m = out.get(r.object_id) ?? new Map<string, ColumnNote>();
    m.set(r.column, { column: r.column, description: r.description, pii: r.pii });
    out.set(r.object_id, m);
  }
  return out;
}

export interface ArticleWrite {
  article_id: string | null;
  /** A new version was written (or the article created). */
  written: boolean;
  version: number | null;
}

/**
 * Brings a table's article up to date: creates it on the first sync (and when it was purged), or replaces its synced
 * block when that changed. An article someone deleted stays deleted.
 */
export async function writeTableArticle(
  db: Queryable,
  conn: Pick<SyncConnection, "id" | "scope_id" | "component_id" | "kind" | "name">,
  obj: { id: string; key: string; article_id: string | null; removed_at: string | null },
  def: TableDef,
  notes: Map<string, ColumnNote>,
  summary: string,
  sysId: string,
): Promise<ArticleWrite> {
  const block = renderSyncedBlock(def, notes, { connection: conn.name, kind: KINDS[conn.kind].label, removedAt: obj.removed_at });
  if (obj.article_id) {
    const a = (await db.query<{ id: string; status: string; body_md: string; version: number; scope_id: string; title: string }>("SELECT id, status, body_md, version, scope_id, title FROM articles WHERE id = $1", [obj.article_id])).rows[0];
    if (a) {
      if (a.status === "deleted" || a.status === "rejected" || a.status === "superseded") return { article_id: a.id, written: false, version: a.version };
      if (currentSyncedBlock(a.body_md) === block) return { article_id: a.id, written: false, version: a.version };
      const body = replaceSyncedBlock(a.body_md, block);
      const { rows } = await db.query<{ id: string; scope_id: string; title: string; body_md: string; version: number }>(
        `UPDATE articles SET body_md = $2, version = version + 1, updated_at = now(), last_verified_at = now() WHERE id = $1
         RETURNING id, scope_id, title, body_md, version`,
        [a.id, body],
      );
      await reindexArticle(db, rows[0]!);
      await snapshot(db, "article", a.id, sysId, null, summary);
      return { article_id: a.id, written: true, version: rows[0]!.version };
    }
  }
  const id = await insertArticle(db, {
    scopeId: conn.scope_id,
    type: "table",
    title: obj.key,
    body: newTableBody(block),
    path: folderOf(conn.name),
    status: "published",
    componentIds: conn.component_id ? [conn.component_id] : [],
    ownerId: sysId,
  });
  await snapshot(db, "article", id, sysId, null, summary);
  // No bare "schema.table" alias: entities are global, so it would match another connection's table (or one in a
  // project the tagger can't read).
  await tagEntity(db, "table", entityName(conn.name, obj.key), { kind: "article", id });
  await db.query("UPDATE connection_objects SET article_id = $2 WHERE id = $1", [obj.id, id]);
  return { article_id: id, written: true, version: 1 };
}

/** Re-renders one table's article after its dictionary notes changed. */
export async function refreshTableArticle(db: Db, objectId: string, summary: string): Promise<ArticleWrite | null> {
  const row = (
    await db.query<Omit<ObjectRow, "id" | "kind"> & SyncConnection & { obj_id: string }>(
      `SELECT o.id AS obj_id, o.key, o.definition, o.hash, o.article_id, o.removed_at, c.id, c.scope_id, c.component_id, c.kind, c.name, c.state
         FROM connection_objects o JOIN connections c ON c.id = o.connection_id WHERE o.id = $1`,
      [objectId],
    )
  ).rows[0];
  if (!row) return null;
  const notes = (await notesOf(db, [objectId])).get(objectId) ?? new Map();
  const sysId = (await systemActor(db)).id;
  const res = await withTx(db, (tx) => writeTableArticle(tx, row, { id: row.obj_id, key: row.key, article_id: row.article_id, removed_at: row.removed_at }, row.definition, notes, summary, sysId));
  if (res.written) emitChanged();
  return res;
}

export interface TableChanges {
  objectId: string;
  key: string;
  articleId: string | null;
  version: number | null;
  changes: SchemaChange[];
}

/**
 * Syncs a database connection's schema into Thaliyola. The caller has opened the secret; `first` says whether the
 * connection was ever synced (a first sync doesn't report every table as new).
 */
export async function syncSchema(db: Db, settings: Settings, conn: SyncConnection & { options: { schemas_include?: string[]; schemas_exclude?: string[]; max_objects?: number } }, target: ConnTarget, env: DriverEnv): Promise<SyncSummary> {
  const spec = KINDS[conn.kind];
  if (!spec.introspect) throw new Error(`${spec.label} has no schema sync`);
  const filter = { include: conn.options.schemas_include, exclude: conn.options.schemas_exclude };
  const max = conn.options.max_objects ?? DEFAULT_MAX_OBJECTS;
  // Reading a large catalogue can take longer than a query may.
  const found = await spec.introspect(target, { ...env, timeoutMs: Math.max(env.timeoutMs, 60_000) }, { ...filter, maxObjects: max });
  const truncated = found.length > max;
  const tables = found.slice(0, max);
  const first = !conn.state?.synced_at;
  const sysId = (await systemActor(db)).id;

  const existing = new Map(
    (await db.query<ObjectRow>("SELECT id, key, kind, definition, hash, article_id, removed_at, filtered_at FROM connection_objects WHERE connection_id = $1 AND kind IN ('table', 'view')", [conn.id])).rows.map((r) => [r.key, r]),
  );
  const notes = await notesOf(db, [...existing.values()].map((o) => o.id));
  const summary: SyncSummary = { tables: 0, views: 0, added: 0, changed: 0, removed: 0, truncated, articles_written: 0, breaking: 0 };
  const changed: TableChanges[] = [];
  const unchangedArticles: string[] = [];
  const seen = new Set<string>();
  const when = new Date().toISOString().slice(0, 10);

  for (const def of tables) {
    const key = tableKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    def.kind === "view" ? summary.views++ : summary.tables++;
    const hash = definitionHash(def);
    const old = existing.get(key);
    await withTx(db, async (tx) => {
      let changes: SchemaChange[] = [];
      let obj: { id: string; key: string; article_id: string | null; removed_at: string | null };
      if (!old) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO connection_objects (connection_id, kind, key, definition, hash) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (connection_id, key) DO UPDATE SET definition = EXCLUDED.definition, hash = EXCLUDED.hash, last_seen = now(), removed_at = NULL, filtered_at = NULL
           RETURNING id`,
          [conn.id, def.kind, key, def, hash],
        );
        obj = { id: rows[0]!.id, key, article_id: null, removed_at: null };
        // A first sync doesn't call every table new, in the history or in its summary.
        if (!first) {
          changes = [{ change: "added", detail: { kind: def.kind } }];
          summary.added++;
        }
      } else {
        obj = { id: old.id, key, article_id: old.article_id, removed_at: null };
        // Back from a schema filter: quietly, like it was never left out (no history for what changed meanwhile).
        if (!old.filtered_at) {
          if (old.removed_at) changes.push({ change: "added", detail: { kind: def.kind, returned: true } });
          if (old.hash !== hash) changes.push(...diffTable(old.definition, def));
          if (old.hash !== hash || old.removed_at) summary.changed++;
        }
        await tx.query("UPDATE connection_objects SET kind = $2, definition = $3, hash = $4, last_seen = now(), removed_at = NULL, filtered_at = NULL WHERE id = $1", [old.id, def.kind, def, hash]);
      }
      for (const c of changes) await tx.query("INSERT INTO connection_changes (connection_id, object_key, change, detail) VALUES ($1, $2, $3, $4)", [conn.id, key, c.change, c.detail]);
      const what = changes.length ? changes.map((c) => describeChange(key, c)).join("; ") : `${key}: schema synced`;
      const res = await writeTableArticle(tx, conn, obj, def, notes.get(obj.id) ?? new Map(), `Sync ${when}: ${what}`.slice(0, 300), sysId);
      if (res.written) summary.articles_written++;
      else if (res.article_id) unchangedArticles.push(res.article_id);
      if (changes.some((c) => BREAKING.includes(c.change))) changed.push({ objectId: obj.id, key, articleId: res.article_id, version: res.version, changes });
    });
  }

  // Tables that are gone. A list cut at max_objects says nothing about what's missing; tables a filter now leaves out
  // aren't gone either: they're set aside quietly (filtered_at), keeping their notes, personal-data flags and article
  // for when the filter takes them in again.
  for (const old of existing.values()) {
    if (seen.has(old.key)) continue;
    const schema = old.definition?.schema ?? old.key.split(".")[0] ?? "";
    if (!schemaWanted(schema, filter)) {
      if (!old.filtered_at) await db.query("UPDATE connection_objects SET filtered_at = now() WHERE id = $1", [old.id]);
      continue;
    }
    if (truncated || old.removed_at) continue;
    await withTx(db, async (tx) => {
      const { rows } = await tx.query<{ removed_at: string }>("UPDATE connection_objects SET removed_at = now(), filtered_at = NULL WHERE id = $1 RETURNING removed_at", [old.id]);
      const change: SchemaChange = { change: "removed", detail: { kind: old.kind } };
      await tx.query("INSERT INTO connection_changes (connection_id, object_key, change, detail) VALUES ($1, $2, $3, $4)", [conn.id, old.key, change.change, change.detail]);
      const removedAt = new Date(rows[0]!.removed_at).toISOString();
      const res = await writeTableArticle(tx, conn, { id: old.id, key: old.key, article_id: old.article_id, removed_at: removedAt }, old.definition, notes.get(old.id) ?? new Map(), `Sync ${when}: ${describeChange(old.key, change)}`, sysId);
      if (res.written) summary.articles_written++;
      summary.removed++;
      changed.push({ objectId: old.id, key: old.key, articleId: res.article_id, version: res.version, changes: [change] });
    });
  }

  // The sync confirms the columns of articles it didn't need to change.
  if (unchangedArticles.length) await db.query("UPDATE articles SET last_verified_at = now() WHERE id = ANY($1::uuid[]) AND status = 'published'", [unchangedArticles]);
  summary.breaking = changed.length;
  if (changed.length) await announceChanges(db, settings, conn, changed);
  if (summary.articles_written || summary.added || summary.removed || summary.changed) emitChanged();
  return summary;
}

/**
 * Breaking changes: impact notices for the connection's project, for repositories that read or write the table, and
 * for projects whose entries link to its article or are tagged with its entity; then notifications: the project's
 * admins and whoever watches the table or the project (kind "connection"), and members of the other projects
 * (kind "change", like any upstream change). Watchers are told only while they can still read the project.
 *
 * Another project hears the details (connection, table and column names) only when the connection's project is open
 * to the whole team. A members-only project's tables are its own: anyone can tag an entry with a table's name, so the
 * other project gets a notification without names instead (and no notice, which would show the table's title).
 */
export async function announceChanges(db: Db, settings: Settings, conn: SyncConnection, tables: TableChanges[]) {
  const scope = (await db.query<{ slug: string; name: string; visibility: string }>("SELECT slug, name, visibility FROM scopes WHERE id = $1", [conn.scope_id])).rows[0];
  if (!scope) return;
  const open = scope.visibility === "team";
  const others = new Map<string, { slug: string; lines: string[]; articleId: string }>();
  const routed: { event: NotificationInput; lines: string[] }[] = [];
  for (const t of tables) {
    const lines = t.changes.filter((c) => BREAKING.includes(c.change)).map((c) => describeChange(t.key, c));
    const summary = `${conn.name}: ${lines.join("; ")}`.slice(0, 500);
    // Notices point at the table's article: not when someone deleted it.
    const live = t.articleId ? (await db.query("SELECT 1 FROM articles WHERE id = $1 AND status IN ('published', 'possibly_stale')", [t.articleId])).rowCount : 0;
    if (t.articleId && t.version && live) {
      await db.query("INSERT INTO impact_notices (source_kind, source_id, source_version, scope_id, summary) VALUES ('article', $1, $2, $3, $4)", [t.articleId, t.version, conn.scope_id, summary]);
      // Repositories of this project, and of others only when this one is open to everyone.
      await db.query(
        `INSERT INTO impact_notices (source_kind, source_id, source_version, component_id, summary)
         SELECT DISTINCT 'article', $1::uuid, $2::int, r.from_id, $3 FROM relations r JOIN components c ON c.id = r.from_id
          WHERE r.to_id = $1 AND r.from_kind = 'component' AND r.kind IN ('reads', 'writes') AND ($4 OR c.scope_id = $5)`,
        [t.articleId, t.version, summary, open, conn.scope_id],
      );
      const { rows } = await db.query<{ id: string; slug: string }>(
        `SELECT DISTINCT s.id, s.slug FROM scopes s
          WHERE s.kind = 'project' AND s.id <> $2 AND s.status = 'active' AND s.id IN (
                SELECT coalesce(a.scope_id, f.scope_id) FROM relations r
                  LEFT JOIN articles a ON r.from_kind = 'article' AND a.id = r.from_id
                  LEFT JOIN findings f ON r.from_kind = 'finding' AND f.id = r.from_id
                 WHERE r.to_id = $1
                UNION
                -- Repositories elsewhere get a notice of their own when this project is open; otherwise their project hears.
                SELECT c.scope_id FROM relations r JOIN components c ON r.from_kind = 'component' AND c.id = r.from_id
                 WHERE r.to_id = $1 AND r.kind IN ('reads', 'writes') AND NOT $3
                UNION
                SELECT coalesce(a.scope_id, f.scope_id) FROM entity_links l
                  JOIN entity_links mine ON mine.entity_id = l.entity_id AND mine.target_id = $1
                  LEFT JOIN articles a ON l.target_kind = 'article' AND a.id = l.target_id AND a.status IN ('published', 'possibly_stale')
                  LEFT JOIN findings f ON l.target_kind = 'finding' AND f.id = l.target_id AND f.status IN ('published', 'possibly_stale')
                 WHERE l.target_id <> $1)`,
        [t.articleId, conn.scope_id, open],
      );
      for (const r of rows) {
        if (open) await db.query("INSERT INTO impact_notices (source_kind, source_id, source_version, scope_id, summary) VALUES ('article', $1, $2, $3, $4)", [t.articleId, t.version, r.id, summary]);
        const o = others.get(r.id) ?? { slug: r.slug, lines: [], articleId: t.articleId };
        o.lines.push(...lines);
        others.set(r.id, o);
      }
    }
    const watchers = await readersOf(db, settings, conn.scope_id, await watchersOf(db, [conn.scope_id, ...(t.articleId ? [t.articleId] : [])]));
    const event: NotificationInput = {
      kind: "connection",
      title: `Schema changed: ${t.key} (${conn.name}, ${scope.name})`,
      body: `${lines.join("\n")}\nCode and queries that use it may need changing.`,
      link: tableLink(scope.slug, t.objectId),
      targetId: t.articleId ?? conn.id,
      scopeId: conn.scope_id,
    };
    // People hear about each table; Slack and Trello routes get one post for the whole sync (below).
    await notify(db, settings, [...(await settingsManagersFor(db, settings, conn.scope_id)), ...watchers], { ...event, route: false });
    routed.push({ event, lines });
  }
  if (routed.length === 1) await notify(db, settings, [], routed[0]!.event);
  else if (routed.length > 1) {
    const SHOWN = 15;
    const all = routed.flatMap((r) => r.lines);
    await notify(db, settings, [], {
      kind: "connection",
      title: `Schema changed: ${routed.length} tables (${conn.name}, ${scope.name})`,
      body: `${all.slice(0, SHOWN).join("\n")}${all.length > SHOWN ? `\n…and ${all.length - SHOWN} more` : ""}\nCode and queries that use them may need changing.`,
      link: `#/project/${scope.slug}?tab=data`,
      targetId: conn.id,
      scopeId: conn.scope_id,
    });
  }
  for (const [scopeId, o] of others) {
    const people = [...(await membersOf(db, scopeId)), ...(await readersOf(db, settings, scopeId, await watchersOf(db, [scopeId])))];
    await notify(
      db,
      settings,
      people,
      open
        ? {
            kind: "change",
            title: `Upstream change for ${o.slug}: ${conn.name} schema changed`,
            body: `${o.lines.slice(0, 10).join("\n")}\nCheck what your code needs to handle.`,
            link: `#/project/${o.slug}`,
            targetId: o.articleId,
            scopeId,
          }
        : {
            kind: "change",
            title: `Upstream change for ${o.slug}: a table it links to changed`,
            body: "A database table that this project's entries or repositories link to had a breaking change (a column or table gone, or a type changed). It belongs to a project you may not be able to open: ask its admins what changed.",
            link: `#/project/${o.slug}`,
            targetId: scopeId,
            scopeId,
          },
    );
  }
}
