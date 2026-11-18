import type { Settings } from "../../config.js";
import { withTx, type Db, type Queryable } from "../../db/pool.js";
import { insertArticle, relate } from "../bootstrap.js";
import { reindexArticle } from "../chunking.js";
import { emitChanged } from "../events.js";
import { membersOf, notify, readersOf, settingsManagersFor, watchersOf } from "../notify.js";
import { snapshot } from "../review.js";
import { systemActor } from "../users.js";
import { DEFAULT_MAX_OBJECTS } from "./catalog.js";
import { withAuth } from "./http-api.js";
import { KINDS } from "./kinds.js";
import { describeEndpointChange, diffEndpoint, endpointHash, endpointKey, parseOpenApi, parseSpecText, type ApiSpec, type EndpointChange, type EndpointDef } from "./openapi.js";
import { call, failWith } from "./remote.js";
import { cell, currentSyncedBlock, replaceSyncedBlock, SYNC_END, SYNC_START } from "./schema.js";
import type { ConnectionKind, ConnectionOptions, ConnTarget, DriverEnv } from "./types.js";

/**
 * API sync: an HTTP API connection's OpenAPI (Swagger) spec, from its spec URL or pasted, becomes one connection
 * object per endpoint (key "GET /orders/{id}") and one `api_contract` article for the whole API. The article's
 * "Interface (synced)" block, between the sync markers, is the only part the sync writes, and only when it changed;
 * Errors, Versioning and Gotchas are people's and agents'. Endpoint differences are the API's history; removed
 * endpoints and changes callers must follow (a new required parameter, a parameter's type, the request body) raise
 * impact notices and tell the people who care, like a table's breaking schema change.
 */

export const API_HEADING = "## Interface (synced)";
const API_FOLDER = "APIs";
/** The article lists this many endpoints and shapes; the rest are in the Data view and list_api_endpoints. */
const ARTICLE_ENDPOINTS = 300;
const ARTICLE_SHAPES = 100;

const WRITTEN: [string, string][] = [
  ["Errors", "Error shapes and codes callers should handle, and what to do about each."],
  ["Versioning", "How versions change, what counts as breaking, and how long old versions live."],
  ["Gotchas", "Rate limits, pagination, idempotency, timezones: what trips callers up."],
];

export interface ApiConnection {
  id: string;
  scope_id: string;
  component_id: string | null;
  kind: ConnectionKind;
  name: string;
  config: Record<string, string>;
  spec: string | null;
  options: ConnectionOptions;
  state: Record<string, unknown>;
}

export interface ApiSyncSummary {
  /** Whether there was a spec to read. */
  spec: boolean;
  title: string;
  version: string;
  format: string;
  endpoints: number;
  added: number;
  changed: number;
  removed: number;
  /** More endpoints than max_objects: the rest weren't synced (and nothing was marked removed). */
  truncated: boolean;
  article_id: string | null;
  articles_written: number;
  breaking: number;
  /** The spec was taken off the connection: the endpoints it had are marked removed and its article possibly stale. */
  spec_removed?: boolean;
}

/** The spec's document, from the spec URL (with the API's credentials only when it's on the API's own origin) or pasted. */
export async function loadSpec(conn: Pick<ApiConnection, "config" | "spec">, target: ConnTarget, env: DriverEnv): Promise<unknown | null> {
  const specUrl = conn.config.spec_url;
  if (specUrl) {
    const sameOrigin = new URL(specUrl).origin === new URL(conn.config.base_url!).origin;
    const accept = { accept: "application/json, application/yaml, text/yaml, */*;q=0.5" };
    const { url, headers } = sameOrigin ? withAuth(target, new URL(specUrl), accept) : { url: new URL(specUrl), headers: accept };
    // A large spec can take longer than a query may.
    const res = await call(url.toString(), "http", { ...env, timeoutMs: Math.max(env.timeoutMs, 30_000) }, { headers });
    if (res.status < 200 || res.status >= 300) failWith(res, `The spec URL (${new URL(specUrl).host})`);
    return parseSpecText(res.text);
  }
  if (conn.spec?.trim()) return parseSpecText(conn.spec);
  return null;
}

const code = (s: string, max = 300) => `\`${cell(s, max).replace(/`/g, "'")}\``;

function paramsText(e: EndpointDef): string {
  const shown = e.params.filter((p) => p.in !== "header" || !/^(authorization|cookie)$/i.test(p.name));
  const out = shown.slice(0, 8).map((p) => `${code(`${p.name}${p.required ? "" : "?"}`, 80)} (${p.in}, ${cell(p.type, 60)})`);
  if (shown.length > 8) out.push(`+${shown.length - 8} more`);
  if (e.body) out.push(`body ${code(e.body.type, 120)}${e.body.required ? "" : " (optional)"}`);
  return out.join(" · ");
}

function responsesText(e: EndpointDef): string {
  return e.responses
    .slice(0, 6)
    .map((r) => (r.type ? `${r.status} ${code(r.type, 80)}` : r.status))
    .join(" · ");
}

/** The generated block: where it comes from, the endpoints grouped by tag, the data shapes and how requests authenticate. */
export function renderApiBlock(spec: ApiSpec, endpoints: EndpointDef[], source: { connection: string; kind: string; total: number }): string {
  const lines: string[] = [SYNC_START];
  lines.push(
    [`Synced from **${cell(source.connection)}** (${source.kind})`, cell(spec.format), spec.version ? `version ${cell(spec.version, 60)}` : "", `${source.total} ${source.total === 1 ? "endpoint" : "endpoints"}`]
      .filter(Boolean)
      .join(" · "),
  );
  if (spec.title) lines.push("", `**${cell(spec.title, 200)}**${spec.description ? `: ${cell(spec.description, 1000)}` : ""}`);
  else if (spec.description) lines.push("", cell(spec.description, 1000));
  if (spec.servers.length) lines.push("", `Servers: ${spec.servers.map((s) => code(s, 200)).join(", ")}`);

  lines.push("", "### Endpoints");
  if (!endpoints.length) lines.push("", "The spec lists no endpoints.");
  const groups = new Map<string, EndpointDef[]>();
  for (const e of endpoints.slice(0, ARTICLE_ENDPOINTS)) {
    const tag = e.tags[0] ?? "Other";
    groups.set(tag, [...(groups.get(tag) ?? []), e]);
  }
  // Endpoints without a tag come last (as in the Data view).
  const other = groups.get("Other");
  if (other && groups.size > 1) {
    groups.delete("Other");
    groups.set("Other", other);
  }
  for (const [tag, list] of groups) {
    if (groups.size > 1 || tag !== "Other") lines.push("", `#### ${cell(tag, 80)}`);
    lines.push("", "| Method | Path | Summary | Parameters | Responses |", "| --- | --- | --- | --- | --- |");
    for (const e of list) {
      const summary = [e.deprecated ? "**Deprecated.**" : "", cell(e.summary ?? e.operation_id ?? "", 200)].filter(Boolean).join(" ");
      lines.push(`| ${e.method} | ${code(e.path, 200)} | ${summary} | ${paramsText(e)} | ${responsesText(e)} |`);
    }
  }
  if (endpoints.length > ARTICLE_ENDPOINTS) lines.push("", `${endpoints.length - ARTICLE_ENDPOINTS} more endpoints are listed in the project's Data view (and by list_api_endpoints).`);
  if (source.total > endpoints.length) lines.push("", `The spec has ${source.total} endpoints; the sync keeps ${endpoints.length} (max_objects).`);

  if (spec.schemas.length) {
    lines.push("", "### Data shapes", "", "| Name | Shape |", "| --- | --- |");
    for (const s of spec.schemas.slice(0, ARTICLE_SHAPES)) lines.push(`| ${code(s.name, 120)} | ${code(s.type, 300)}${s.description ? ` ${cell(s.description, 200)}` : ""} |`);
    if (spec.schemas.length > ARTICLE_SHAPES) lines.push("", `${spec.schemas.length - ARTICLE_SHAPES} more shapes are in the spec.`);
  }

  lines.push("", "### Auth", "");
  if (spec.auth.length) for (const a of spec.auth) lines.push(`- ${code(a.name, 60)}: ${cell(a.detail, 200)}`);
  else lines.push("- The spec doesn't describe authentication.");
  lines.push("", "Thaliyola adds this connection's own credentials to calls made through it (call_api); they're never shown, to people or agents.");
  lines.push(SYNC_END);
  return lines.join("\n");
}

export function newApiBody(block: string): string {
  const written = WRITTEN.map(([h, hint]) => `## ${h}\n\n<!-- Hint: ${hint} -->\n`).join("\n");
  return `${API_HEADING}\n\n${block}\n\n${written}`;
}

interface ArticleWrite {
  article_id: string;
  written: boolean;
  version: number;
}

/** Creates the API's article, or replaces its synced block when that changed. An article someone deleted stays deleted. */
async function writeApiArticle(db: Queryable, conn: ApiConnection, articleId: string | null, block: string, summary: string, sysId: string): Promise<ArticleWrite> {
  if (articleId) {
    const a = (await db.query<{ id: string; status: string; body_md: string; version: number }>("SELECT id, status, body_md, version FROM articles WHERE id = $1", [articleId])).rows[0];
    if (a) {
      if (a.status === "deleted" || a.status === "rejected" || a.status === "superseded" || currentSyncedBlock(a.body_md) === block) return { article_id: a.id, written: false, version: a.version };
      // Synced again: no longer possibly stale (e.g. after its spec was removed and given back).
      const { rows } = await db.query<{ id: string; scope_id: string; title: string; body_md: string; version: number }>(
        `UPDATE articles SET body_md = $2, version = version + 1, updated_at = now(), last_verified_at = now(),
                status = CASE WHEN status = 'possibly_stale' THEN 'published' ELSE status END
          WHERE id = $1
         RETURNING id, scope_id, title, body_md, version`,
        [a.id, replaceSyncedBlock(a.body_md, block, API_HEADING)],
      );
      await reindexArticle(db, rows[0]!);
      await snapshot(db, "article", a.id, sysId, null, summary);
      return { article_id: a.id, written: true, version: rows[0]!.version };
    }
  }
  const id = await insertArticle(db, {
    scopeId: conn.scope_id,
    type: "api_contract",
    title: conn.name,
    body: newApiBody(block),
    path: API_FOLDER,
    status: "published",
    componentIds: conn.component_id ? [conn.component_id] : [],
    ownerId: sysId,
  });
  await snapshot(db, "article", id, sysId, null, summary);
  // The repository chosen for the connection provides the API.
  if (conn.component_id) await relate(db, { kind: "article", id }, "provided_by", { kind: "component", id: conn.component_id });
  return { article_id: id, written: true, version: 1 };
}

interface EndpointRow {
  id: string;
  key: string;
  definition: EndpointDef;
  hash: string;
  removed_at: string | null;
}

interface Breaking {
  key: string;
  line: string;
}

/** Syncs an HTTP API connection's spec into Thaliyola. The caller has opened the secret. */
export async function syncApi(db: Db, settings: Settings, conn: ApiConnection, target: ConnTarget, env: DriverEnv): Promise<ApiSyncSummary> {
  const doc = await loadSpec(conn, target, env);
  const empty: ApiSyncSummary = { spec: false, title: "", version: "", format: "", endpoints: 0, added: 0, changed: 0, removed: 0, truncated: false, article_id: null, articles_written: 0, breaking: 0 };
  if (doc === null) return specRemoved(db, conn, empty);
  const max = conn.options.max_objects ?? DEFAULT_MAX_OBJECTS;
  const spec = parseOpenApi(doc, { maxEndpoints: max });
  const truncated = spec.total > spec.endpoints.length;
  const first = !conn.state?.synced_at;
  const sysId = (await systemActor(db)).id;
  const summary: ApiSyncSummary = { ...empty, spec: true, title: spec.title, version: spec.version, format: spec.format, truncated };
  const breaking: Breaking[] = [];
  const when = new Date().toISOString().slice(0, 10);

  const article = await withTx(db, async (tx) => {
    // One sync of a connection at a time writes its endpoints (a sync is also claimed in runConnection).
    await tx.query("SELECT 1 FROM connections WHERE id = $1 FOR UPDATE", [conn.id]);
    const existing = new Map(
      (await tx.query<EndpointRow>("SELECT id, key, definition, hash, removed_at FROM connection_objects WHERE connection_id = $1 AND kind = 'endpoint'", [conn.id])).rows.map((r) => [r.key, r]),
    );
    const seen = new Set<string>();
    const lines: string[] = [];
    const record = async (key: string, change: string, detail: Record<string, unknown>) =>
      tx.query("INSERT INTO connection_changes (connection_id, object_key, change, detail) VALUES ($1, $2, $3, $4)", [conn.id, key, change, detail]);
    const kept: EndpointDef[] = [];
    for (const e of spec.endpoints) {
      const key = endpointKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(e);
      const hash = endpointHash(e);
      const old = existing.get(key);
      if (!old) {
        await tx.query(
          `INSERT INTO connection_objects (connection_id, kind, key, definition, hash) VALUES ($1, 'endpoint', $2, $3, $4)
           ON CONFLICT (connection_id, key) DO UPDATE SET definition = EXCLUDED.definition, hash = EXCLUDED.hash, last_seen = now(), removed_at = NULL`,
          [conn.id, key, e, hash],
        );
        if (!first) {
          summary.added++;
          await record(key, "added", { kind: "endpoint" });
          lines.push(`${key}: new endpoint`);
        }
        continue;
      }
      if (old.removed_at) {
        summary.added++;
        await record(key, "added", { kind: "endpoint", returned: true });
        lines.push(`${key}: endpoint is back`);
      } else if (old.hash !== hash) {
        summary.changed++;
        const d: EndpointChange = diffEndpoint(old.definition, e);
        await record(key, "changed", { ...d });
        const line = describeEndpointChange(key, d);
        lines.push(line);
        if (d.breaking) breaking.push({ key, line });
      }
      await tx.query("UPDATE connection_objects SET definition = $2, hash = $3, last_seen = now(), removed_at = NULL WHERE id = $1", [old.id, e, hash]);
    }
    // Endpoints that are gone; a list cut at max_objects says nothing about what's missing.
    if (!truncated) {
      for (const old of existing.values()) {
        if (seen.has(old.key) || old.removed_at) continue;
        await tx.query("UPDATE connection_objects SET removed_at = now() WHERE id = $1", [old.id]);
        await record(old.key, "removed", { kind: "endpoint" });
        summary.removed++;
        const line = `${old.key}: endpoint removed`;
        lines.push(line);
        breaking.push({ key: old.key, line });
      }
    }
    summary.endpoints = kept.length;
    const block = renderApiBlock(spec, kept, { connection: conn.name, kind: KINDS[conn.kind].label, total: spec.total });
    const what = lines.length ? lines.slice(0, 5).join("; ") + (lines.length > 5 ? ` (+${lines.length - 5} more)` : "") : "spec synced";
    const current = typeof conn.state?.api_article === "string" ? conn.state.api_article : null;
    const res = await writeApiArticle(tx, conn, current, block, `Sync ${when}: ${what}`.slice(0, 300), sysId);
    if (res.written) summary.articles_written++;
    else
      await tx.query(
        "UPDATE articles SET last_verified_at = now(), status = CASE WHEN status = 'possibly_stale' THEN 'published' ELSE status END WHERE id = $1 AND status IN ('published', 'possibly_stale')",
        [res.article_id],
      );
    await tx.query("UPDATE connection_objects SET article_id = $2 WHERE connection_id = $1 AND kind = 'endpoint' AND article_id IS DISTINCT FROM $2", [conn.id, res.article_id]);
    await tx.query("UPDATE connections SET state = state || jsonb_build_object('api_article', $2::text) WHERE id = $1", [conn.id, res.article_id]);
    return res;
  });
  summary.article_id = article.article_id;
  summary.breaking = breaking.length;
  if (breaking.length) await announceApiChanges(db, settings, conn, article, breaking);
  if (summary.articles_written || summary.added || summary.removed || summary.changed) emitChanged();
  return summary;
}

/**
 * No spec any more (no spec URL, nothing pasted): the endpoints synced from the last one stop being listed as the API's
 * (marked removed, each recorded as removed with spec_removed) and its article is marked possibly stale, so neither
 * people nor agents take them as current. Nothing is announced: the API didn't change, its spec was taken away. A
 * spec given back brings them back.
 */
async function specRemoved(db: Db, conn: ApiConnection, empty: ApiSyncSummary): Promise<ApiSyncSummary> {
  const prev = (conn.state?.sync ?? {}) as { title?: string; version?: string; format?: string };
  const keep = { title: prev.title ?? "", version: prev.version ?? "", format: prev.format ?? "" };
  const removed = await withTx(db, async (tx) => {
    await tx.query("SELECT 1 FROM connections WHERE id = $1 FOR UPDATE", [conn.id]);
    const { rows } = await tx.query<{ key: string }>(
      "UPDATE connection_objects SET removed_at = now() WHERE connection_id = $1 AND kind = 'endpoint' AND removed_at IS NULL RETURNING key",
      [conn.id],
    );
    if (!rows.length) return 0;
    await tx.query(
      `INSERT INTO connection_changes (connection_id, object_key, change, detail)
       SELECT $1, k, 'removed', '{"kind": "endpoint", "spec_removed": true}'::jsonb FROM unnest($2::text[]) AS k`,
      [conn.id, rows.map((r) => r.key)],
    );
    const article = typeof conn.state?.api_article === "string" ? conn.state.api_article : null;
    if (article) await tx.query("UPDATE articles SET status = 'possibly_stale', updated_at = now() WHERE id = $1 AND status = 'published'", [article]);
    return rows.length;
  });
  if (removed) emitChanged();
  // Already marked on an earlier sync: still the same state.
  const already = removed > 0 || (conn.state?.sync as { spec_removed?: boolean } | undefined)?.spec_removed === true;
  return { ...empty, ...keep, removed, spec_removed: already };
}

/** "Synced 42 endpoints (2 new, 1 removed)". */
export function apiSyncDetail(s: ApiSyncSummary): string {
  if (s.spec_removed) return `The spec was removed from this connection${s.removed ? `: its ${s.removed} ${s.removed === 1 ? "endpoint is" : "endpoints are"} no longer listed and the API's article is marked possibly stale` : ""}. Add a spec URL or paste the spec to sync it again.`;
  if (!s.spec) return "No OpenAPI spec yet: add a spec URL or paste the spec to bring its endpoints into the knowledge base.";
  const changes = [s.added ? `${s.added} new` : "", s.changed ? `${s.changed} changed` : "", s.removed ? `${s.removed} removed` : ""].filter(Boolean);
  const what = `${s.endpoints} ${s.endpoints === 1 ? "endpoint" : "endpoints"}`;
  return `Synced ${what}${s.title ? ` of ${s.title}` : ""}${changes.length ? ` (${changes.join(", ")})` : ""}.${s.truncated ? " The spec has more endpoints than a sync keeps (max_objects)." : ""}`;
}

/**
 * Changes callers must follow: an impact notice for the connection's project and for repositories that consume the
 * API (others only when the project is open to the whole team), then notifications to the project's admins and the
 * API's watchers, and to members of projects whose entries or repositories use it (without details when the
 * connection's project is members-only).
 */
async function announceApiChanges(db: Db, settings: Settings, conn: ApiConnection, article: ArticleWrite, changes: Breaking[]) {
  const scope = (await db.query<{ slug: string; name: string; visibility: string }>("SELECT slug, name, visibility FROM scopes WHERE id = $1", [conn.scope_id])).rows[0];
  if (!scope) return;
  const open = scope.visibility === "team";
  const lines = changes.map((c) => c.line);
  const summary = `${conn.name}: ${lines.join("; ")}`.slice(0, 500);
  const live = (await db.query("SELECT 1 FROM articles WHERE id = $1 AND status IN ('published', 'possibly_stale')", [article.article_id])).rowCount;
  let others: { id: string; slug: string }[] = [];
  if (live) {
    await db.query("INSERT INTO impact_notices (source_kind, source_id, source_version, scope_id, summary) VALUES ('article', $1, $2, $3, $4)", [article.article_id, article.version, conn.scope_id, summary]);
    await db.query(
      `INSERT INTO impact_notices (source_kind, source_id, source_version, component_id, summary)
       SELECT DISTINCT 'article', $1::uuid, $2::int, r.to_id, $3 FROM relations r JOIN components c ON c.id = r.to_id
        WHERE r.from_id = $1 AND r.to_kind = 'component' AND r.kind = 'consumed_by' AND ($4 OR c.scope_id = $5)`,
      [article.article_id, article.version, summary, open, conn.scope_id],
    );
    others = (
      await db.query<{ id: string; slug: string }>(
        `SELECT DISTINCT s.id, s.slug FROM scopes s
          WHERE s.kind = 'project' AND s.id <> $2 AND s.status = 'active' AND s.id IN (
                SELECT coalesce(a.scope_id, f.scope_id) FROM relations r
                  LEFT JOIN articles a ON r.from_kind = 'article' AND a.id = r.from_id AND a.status IN ('published', 'possibly_stale')
                  LEFT JOIN findings f ON r.from_kind = 'finding' AND f.id = r.from_id AND f.status IN ('published', 'possibly_stale')
                 WHERE r.to_id = $1
                UNION
                SELECT c.scope_id FROM relations r JOIN components c ON c.id = r.to_id
                 WHERE r.from_id = $1 AND r.to_kind = 'component' AND r.kind = 'consumed_by')`,
        [article.article_id, conn.scope_id],
      )
    ).rows.filter((r) => !!r.id);
    if (open) for (const o of others) await db.query("INSERT INTO impact_notices (source_kind, source_id, source_version, scope_id, summary) VALUES ('article', $1, $2, $3, $4)", [article.article_id, article.version, o.id, summary]);
  }
  const watchers = await readersOf(db, settings, conn.scope_id, await watchersOf(db, [conn.scope_id, article.article_id]));
  await notify(db, settings, [...(await settingsManagersFor(db, settings, conn.scope_id)), ...watchers], {
    kind: "connection",
    title: `API changed: ${conn.name} (${scope.name})`,
    body: `${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `\n…and ${lines.length - 10} more` : ""}\nCode that calls it may need changing.`,
    link: `#/article/${article.article_id}`,
    targetId: article.article_id,
    scopeId: conn.scope_id,
  });
  for (const o of others) {
    const people = [...(await membersOf(db, o.id)), ...(await readersOf(db, settings, o.id, await watchersOf(db, [o.id])))];
    await notify(
      db,
      settings,
      people,
      open
        ? {
            kind: "change",
            title: `Upstream change for ${o.slug}: ${conn.name} API changed`,
            body: `${lines.slice(0, 10).join("\n")}\nCheck what your code needs to handle.`,
            link: `#/project/${o.slug}`,
            targetId: article.article_id,
            scopeId: o.id,
          }
        : {
            kind: "change",
            title: `Upstream change for ${o.slug}: an API it uses changed`,
            body: "An API that this project's entries or repositories link to had a change callers must follow (an endpoint gone, a new required parameter, a changed type). It belongs to a project you may not be able to open: ask its admins what changed.",
            link: `#/project/${o.slug}`,
            targetId: o.id,
            scopeId: o.id,
          },
    );
  }
}

/** Endpoints of an API connection, as the sync stored them. */
export async function endpointsOf(db: Queryable, connectionId: string, includeRemoved = false) {
  const { rows } = await db.query<{ id: string; key: string; definition: EndpointDef; first_seen: string; last_seen: string; removed_at: string | null }>(
    `SELECT id, key, definition, first_seen, last_seen, removed_at FROM connection_objects
      WHERE connection_id = $1 AND kind = 'endpoint' AND ($2 OR removed_at IS NULL)
      ORDER BY removed_at IS NOT NULL, definition->>'path', key`,
    [connectionId, includeRemoved],
  );
  return rows;
}
