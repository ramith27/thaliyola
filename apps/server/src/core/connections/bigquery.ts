import { createPrivateKey } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SignJWT } from "jose";
import { ValidationError } from "../context.js";
import type { PinnedResponse } from "./network.js";
import { base, call, callJson, DatabaseError, failWith } from "./remote.js";
import { jsonPrefix, RESULT_MAX_CHARS, rowChars } from "./result-size.js";
import { schemaWanted, type ColumnDef, type IntrospectFilter, type TableDef } from "./schema.js";
import type { GuardedSql } from "./sql-guard.js";
import type { ConnTarget, DriverEnv, QueryLimits, RawResult, TestResult } from "./types.js";

/**
 * BigQuery through its REST API with a service account key: a JWT signed with the key (RS256, via jose) is exchanged
 * for an access token at Google's token endpoint. The key's own token_uri is ignored, so the key file can't point
 * Thaliyola at another host.
 *
 * The token only has the read-only scope, so Google itself refuses anything that writes. Queries also run inside
 * `SELECT * FROM (…)`, with a timeout, a row cap and a cap on the bytes one query may bill (max_gb_billed).
 */

export interface ServiceAccountKey {
  type: string;
  project_id?: string;
  client_email: string;
  private_key: string;
}

/** The read-only BigQuery scope: enough to list datasets and run query jobs (jobs.query), not to change anything. */
export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

export function parseServiceAccount(json: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(json) as Partial<ServiceAccountKey>;
  } catch {
    throw new ValidationError("the service account key must be the JSON file Google Cloud gives you");
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) throw new ValidationError("the JSON isn't a service account key (it needs type, client_email and private_key)");
  return key as ServiceAccountKey;
}

export async function bigqueryToken(c: ConnTarget, env: DriverEnv, now = Math.floor(Date.now() / 1000)): Promise<{ token: string; key: ServiceAccountKey }> {
  const key = parseServiceAccount(c.secret.service_account_json ?? "");
  const tokenUrl = base(env, "google_token", "https://oauth2.googleapis.com/token");
  let signingKey;
  try {
    signingKey = createPrivateKey({ key: key.private_key, format: "pem" });
  } catch {
    throw new ValidationError("the service account key's private_key isn't a valid PEM key");
  }
  const assertion = await new SignJWT({ scope: BIGQUERY_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
  const r = await callJson<{ access_token?: string }>(tokenUrl, "database", env, "Google's token endpoint", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!r.access_token) throw new ValidationError("Google's token endpoint didn't return an access token");
  return { token: r.access_token, key };
}

const PROJECT_ID = /^[a-z][a-z0-9.:-]{3,62}$/;

export function bigqueryProject(c: ConnTarget, key: ServiceAccountKey): string {
  const project = c.config.project_id || key.project_id;
  if (!project) throw new ValidationError("set the project ID (the key doesn't name one)");
  if (!PROJECT_ID.test(project)) throw new ValidationError("the project ID looks like my-project-123");
  return project;
}

export async function testBigquery(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const { token, key } = await bigqueryToken(c, env);
  const project = bigqueryProject(c, key);
  const api = base(env, "bigquery", "https://bigquery.googleapis.com");
  const r = await callJson<{ datasets?: unknown[] }>(`${api}/bigquery/v2/projects/${encodeURIComponent(project)}/datasets?maxResults=50`, "database", env, "BigQuery", {
    headers: { authorization: `Bearer ${token}` },
  });
  const n = r.datasets?.length ?? 0;
  return { detail: `Connected to BigQuery project ${project} as ${key.client_email} (${n === 50 ? "50 or more" : n} dataset${n === 1 ? "" : "s"} visible).` };
}

// ---- Queries (jobs.query) ------------------------------------------------------------------------------------------

export interface BqField {
  name: string;
  type: string;
  mode?: string;
  fields?: BqField[];
}
type BqCell = { v: unknown };
interface BqResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: BqField[] };
  rows?: { f: BqCell[] }[];
  totalRows?: string;
  pageToken?: string;
  errors?: { reason?: string; message?: string }[];
  /** The response stopped at maxBytes: `rows` holds the rows that arrived whole. */
  cut?: boolean;
}

/** A session with BigQuery: the token, the project and where jobs run. */
export interface BqSession {
  api: string;
  project: string;
  token: string;
  location?: string;
}

export async function bigquerySession(c: ConnTarget, env: DriverEnv): Promise<BqSession> {
  const { token, key } = await bigqueryToken(c, env);
  return { api: base(env, "bigquery", "https://bigquery.googleapis.com"), project: bigqueryProject(c, key), token, location: c.config.location || undefined };
}

export type BqParam = string | number | string[];

function queryParameters(params: Record<string, BqParam>) {
  return Object.entries(params).map(([name, v]) =>
    Array.isArray(v)
      ? { name, parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: v.map((value) => ({ value })) } }
      : { name, parameterType: { type: typeof v === "number" ? "INT64" : "STRING" }, parameterValue: { value: String(v) } },
  );
}

/** A refused job: its reason (invalidQuery, accessDenied…) is kept, so a message that quotes data can be hidden. */
function refuse(res: PinnedResponse): never {
  let reason: string | undefined;
  let message: string | undefined;
  try {
    const body = JSON.parse(res.text) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status;
    message = body.error?.message;
  } catch {
    // not JSON
  }
  if (reason && res.status !== 401) {
    const text = (message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new DatabaseError(`BigQuery refused the query (${reason})${text ? `: ${text}` : ""}`, res.status, `BigQuery ${reason}`);
  }
  failWith(res, "BigQuery");
}

function parse(res: PinnedResponse): BqResponse {
  if (res.status < 200 || res.status >= 300) refuse(res);
  if (res.cut) {
    // Rows only come with a finished job, after the schema; whatever follows them (jobComplete too) was cut off.
    const part = jsonPrefix(res.text) as BqResponse | null;
    if (!part || !Array.isArray(part.rows)) throw new ValidationError("the result is too large to read; select fewer columns or rows");
    return { ...part, jobComplete: true, cut: true };
  }
  try {
    return JSON.parse(res.text) as BqResponse;
  } catch {
    throw new ValidationError(`BigQuery didn't answer with JSON (HTTP ${res.status})`);
  }
}

export interface BqQueryOptions {
  params?: Record<string, BqParam>;
  timeoutMs: number;
  /** Rows wanted: pages are read until there are this many (or none are left). */
  maxRows: number;
  maxBytes?: number;
  maxBytesBilled?: string;
  /** Location for this query (overrides the session's). */
  location?: string;
  /** Stop reading pages once rows hold this many characters. */
  maxChars?: number;
}

export interface BqResult {
  fields: BqField[];
  rows: BqCell[][];
  /** More rows exist than were read. */
  more: boolean;
  /** Stopped at maxChars, or a page stopped at maxBytes. */
  cut: boolean;
}

/**
 * Runs one GoogleSQL query and reads its rows. The job carries its own timeout (jobTimeoutMs), so BigQuery stops it
 * at the deadline; cancelling it is also tried, though a read-only token may not be allowed to.
 */
export async function bigqueryQuery(s: BqSession, env: DriverEnv, sql: string, opts: BqQueryOptions): Promise<BqResult> {
  const headers = { authorization: `Bearer ${s.token}`, accept: "application/json" };
  const location = opts.location ?? s.location;
  const deadline = Date.now() + opts.timeoutMs + 5_000;
  const project = encodeURIComponent(s.project);
  const body: Record<string, unknown> = {
    query: sql,
    useLegacySql: false,
    maxResults: Math.min(opts.maxRows, 10_000),
    timeoutMs: Math.min(opts.timeoutMs, 60_000),
    jobTimeoutMs: String(opts.timeoutMs),
    labels: { source: "thaliyola" },
    ...(location ? { location } : {}),
    ...(opts.maxBytesBilled ? { maximumBytesBilled: opts.maxBytesBilled } : {}),
    ...(opts.params ? { parameterMode: "NAMED", queryParameters: queryParameters(opts.params) } : {}),
  };
  // Someone's query (maxChars): a page past maxBytes comes back cut, with the rows read so far.
  const req = { headers, timeoutMs: opts.timeoutMs + 5_000, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}), ...(opts.maxChars ? { truncate: true } : {}) };
  let r = parse(await call(`${s.api}/bigquery/v2/projects/${project}/queries`, "database", env, { ...req, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const job = r.jobReference?.jobId;
  const jobLocation = r.jobReference?.location ?? location;
  const results = (extra: Record<string, string>) => {
    if (!job || !/^[A-Za-z0-9_-]{1,1024}$/.test(job)) throw new ValidationError("BigQuery didn't say which job ran the query");
    const q = new URLSearchParams({ maxResults: String(Math.min(opts.maxRows, 10_000)), ...(jobLocation ? { location: jobLocation } : {}), ...extra });
    return `${s.api}/bigquery/v2/projects/${project}/queries/${encodeURIComponent(job)}?${q}`;
  };
  for (let wait = 250; !r.jobComplete; wait = Math.min(wait * 2, 2_000)) {
    if (Date.now() + wait > deadline) {
      if (job) await call(`${s.api}/bigquery/v2/projects/${project}/jobs/${encodeURIComponent(job)}/cancel${jobLocation ? `?location=${encodeURIComponent(jobLocation)}` : ""}`, "database", env, { method: "POST", headers, timeoutMs: 5_000 }).catch(() => undefined);
      throw Object.assign(new Error("the query took longer than the time allowed"), { name: "TimeoutError" });
    }
    await sleep(wait);
    r = parse(await call(results({ timeoutMs: String(Math.max(1_000, Math.min(10_000, deadline - Date.now()))) }), "database", env, req));
  }
  if (r.errors?.length) throw new DatabaseError(`BigQuery refused the query (${r.errors[0]!.reason ?? "error"})`, 400, `BigQuery ${r.errors[0]!.reason ?? "error"}`);
  const fields = r.schema?.fields ?? [];
  if (r.cut && !fields.length) throw new ValidationError("the result is too large to read; select fewer columns or rows");
  const rows: BqCell[][] = [];
  let chars = 0;
  let cut = false;
  const take = (page: BqResponse) => {
    for (const row of page.rows ?? []) {
      chars += rowChars(row.f.map((c) => (typeof c.v === "string" ? c.v : JSON.stringify(c.v ?? null))));
      if (opts.maxChars && chars > opts.maxChars) {
        cut = true;
        return;
      }
      rows.push(row.f);
      if (rows.length >= opts.maxRows) return;
    }
    if (page.cut) cut = true;
  };
  take(r);
  let token = r.pageToken;
  while (token && !cut && rows.length < opts.maxRows && Date.now() < deadline) {
    const page = parse(await call(results({ pageToken: token }), "database", env, req));
    take(page);
    token = page.pageToken;
  }
  return { fields, rows, more: cut || !!token || Number(r.totalRows ?? rows.length) > rows.length, cut };
}

/** A BigQuery cell as JSON: numbers and booleans as such, timestamps as ISO, records as objects, repeated as arrays. */
export function bigqueryValue(v: unknown, f: BqField): unknown {
  if (v === null || v === undefined) return null;
  if (f.mode === "REPEATED") return Array.isArray(v) ? v.map((x) => bigqueryValue((x as BqCell).v, { ...f, mode: "NULLABLE" })) : v;
  const type = f.type.toUpperCase();
  if (type === "RECORD" || type === "STRUCT") {
    const cells = (v as { f?: BqCell[] }).f ?? [];
    return Object.fromEntries((f.fields ?? []).map((sub, i) => [sub.name, bigqueryValue(cells[i]?.v, sub)]));
  }
  if (typeof v !== "string") return v;
  if (type === "INTEGER" || type === "INT64") return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  if (type === "FLOAT" || type === "FLOAT64") return Number.isFinite(Number(v)) ? Number(v) : v;
  if (type === "BOOLEAN" || type === "BOOL") return v === "true";
  if (type === "TIMESTAMP" && Number.isFinite(Number(v))) return new Date(Math.round(Number(v) * 1000)).toISOString();
  return v;
}

// ---- Schema sync ---------------------------------------------------------------------------------------------------

const quoted = (s: string) => `\`${s.replace(/[`\\]/g, "")}\``;
type Row = Record<string, unknown>;

function asObjects(r: BqResult): Row[] {
  return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name.toLowerCase(), bigqueryValue(row[i]?.v, f)])));
}

/**
 * Datasets and their tables and views. Datasets are BigQuery's schemas: all those the account sees, or those "schemas
 * to sync" name. INFORMATION_SCHEMA is read once per region; where the account can't read a region's views, each
 * dataset's own views are read instead.
 */
export async function introspectBigquery(c: ConnTarget, env: DriverEnv, f: IntrospectFilter): Promise<TableDef[]> {
  const s = await bigquerySession(c, env);
  const datasets: { id: string; location: string }[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ maxResults: "1000", ...(pageToken ? { pageToken } : {}) });
    const page = await callJson<{ datasets?: { datasetReference?: { datasetId?: string }; location?: string }[]; nextPageToken?: string }>(
      `${s.api}/bigquery/v2/projects/${encodeURIComponent(s.project)}/datasets?${q}`,
      "database",
      env,
      "BigQuery",
      { headers: { authorization: `Bearer ${s.token}` } },
    );
    for (const d of page.datasets ?? []) {
      const id = d.datasetReference?.datasetId;
      if (id && /^[A-Za-z0-9_]{1,1024}$/.test(id) && schemaWanted(id, f)) datasets.push({ id, location: d.location || s.location || "US" });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && datasets.length < 10_000);
  if (!datasets.length) return [];
  datasets.sort((a, b) => a.id.localeCompare(b.id));

  const timeoutMs = Math.max(env.timeoutMs, 60_000);
  const byLocation = new Map<string, string[]>();
  for (const d of datasets) byLocation.set(d.location, [...(byLocation.get(d.location) ?? []), d.id]);
  /** Runs an INFORMATION_SCHEMA query (`{from}` is the qualifier) for every location, falling back to each dataset. */
  const info = async (template: string, opts: { optional?: boolean; max?: number } = {}): Promise<Row[]> => {
    const out: Row[] = [];
    const run = async (from: string, schemas: string[], location: string) =>
      asObjects(await bigqueryQuery(s, env, template.replaceAll("{from}", from), { params: { schemas, ...(opts.max ? { max: opts.max } : {}) }, timeoutMs, maxRows: opts.max ?? 200_000, maxBytes: 16 * 1024 * 1024, location }));
    for (const [location, schemas] of byLocation) {
      try {
        out.push(...(await run(`${quoted(s.project)}.${quoted(`region-${location.toLowerCase()}`)}`, schemas, location)));
      } catch (err) {
        if (!(err instanceof DatabaseError)) throw err;
        for (const ds of schemas) {
          try {
            out.push(...(await run(quoted(`${s.project}.${ds}`), [ds], location)));
          } catch (e) {
            if (!opts.optional) throw e;
          }
        }
      }
    }
    return out;
  };
  const optional = (p: Promise<Row[]>) => p.catch(() => [] as Row[]);

  const tables = (
    await info("SELECT table_schema, table_name, table_type FROM {from}.INFORMATION_SCHEMA.TABLES WHERE table_schema IN UNNEST(@schemas) ORDER BY table_schema, table_name LIMIT @max", { max: f.maxObjects + 1 })
  )
    .map((t) => ({ schema: String(t.table_schema), name: String(t.table_name), type: String(t.table_type ?? "") }))
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name))
    .slice(0, f.maxObjects + 1);
  if (!tables.length) return [];
  const cols = await info(
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, p.description
       FROM {from}.INFORMATION_SCHEMA.COLUMNS c LEFT JOIN {from}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS p
         ON p.table_schema = c.table_schema AND p.table_name = c.table_name AND p.field_path = c.column_name
      WHERE c.table_schema IN UNNEST(@schemas) ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  );
  const [descriptions, storage, keys, views] = await Promise.all([
    optional(info("SELECT table_schema, table_name, option_value FROM {from}.INFORMATION_SCHEMA.TABLE_OPTIONS WHERE option_name = 'description' AND table_schema IN UNNEST(@schemas)", { optional: true })),
    optional(info("SELECT table_schema, table_name, total_rows FROM {from}.INFORMATION_SCHEMA.TABLE_STORAGE WHERE table_schema IN UNNEST(@schemas)", { optional: true })),
    optional(
      info(
        `SELECT k.table_schema, k.table_name, k.column_name, t.constraint_type, u.table_schema AS ref_schema, u.table_name AS ref_table, u.column_name AS ref_column
           FROM {from}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
           JOIN {from}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS t ON t.constraint_schema = k.constraint_schema AND t.constraint_name = k.constraint_name
           LEFT JOIN {from}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE u ON t.constraint_type = 'FOREIGN KEY' AND u.constraint_schema = k.constraint_schema AND u.constraint_name = k.constraint_name
          WHERE k.table_schema IN UNNEST(@schemas)`,
        { optional: true },
      ),
    ),
    tables.some((t) => /VIEW/i.test(t.type))
      ? optional(info("SELECT table_schema, table_name, view_definition FROM {from}.INFORMATION_SCHEMA.VIEWS WHERE table_schema IN UNNEST(@schemas)", { optional: true }))
      : Promise.resolve([] as Row[]),
  ]);
  const k = (r: Row) => `${r.table_schema}.${r.table_name}`;
  const comment = new Map(descriptions.map((d) => [k(d), unquote(String(d.option_value ?? ""))]));
  const rowsOf = new Map(storage.map((d) => [k(d), d.total_rows === null || d.total_rows === undefined ? null : Number(d.total_rows)]));
  const pks = new Set(keys.filter((x) => x.constraint_type === "PRIMARY KEY").map((x) => `${k(x)}.${x.column_name}`));
  const fks = new Map(keys.filter((x) => x.constraint_type === "FOREIGN KEY" && x.ref_table).map((x) => [`${k(x)}.${x.column_name}`, `${x.ref_schema}.${x.ref_table}.${x.ref_column}`]));
  const defs = new Map(views.map((v) => [k(v), String(v.view_definition ?? "").toLowerCase()]));
  const byTable = new Map<string, ColumnDef[]>();
  for (const col of cols) {
    const key = k(col);
    const list = byTable.get(key) ?? [];
    if (list.some((x) => x.name === col.column_name)) continue;
    list.push({
      name: String(col.column_name),
      type: String(col.data_type),
      nullable: col.is_nullable !== "NO",
      default: col.column_default && col.column_default !== "NULL" ? String(col.column_default) : null,
      pk: pks.has(`${key}.${col.column_name}`) || undefined,
      fk: fks.get(`${key}.${col.column_name}`) ?? null,
      comment: col.description ? String(col.description) : null,
    });
    byTable.set(key, list);
  }
  const usesOf = (key: string) => {
    const words = new Set((defs.get(key) ?? "").split(/[^a-z0-9_$]+/));
    return tables.filter((o) => `${o.schema}.${o.name}` !== key && words.has(o.name.toLowerCase())).map((o) => `${o.schema}.${o.name}`).sort();
  };
  return tables.map((t) => {
    const view = /VIEW/i.test(t.type);
    const key = `${t.schema}.${t.name}`;
    return {
      schema: t.schema,
      name: t.name,
      kind: view ? "view" : "table",
      rows: view ? null : (rowsOf.get(key) ?? null),
      comment: comment.get(key) || null,
      columns: byTable.get(key) ?? [],
      ...(view ? { uses: usesOf(key) } : {}),
    };
  });
}

/** TABLE_OPTIONS values are GoogleSQL literals: "text" → text. */
function unquote(v: string): string {
  try {
    return v.startsWith('"') ? String(JSON.parse(v)) : v;
  } catch {
    return v.replace(/^"|"$/g, "");
  }
}

// ---- Read-only queries -------------------------------------------------------------------------------------------

const SCALAR = new Set(["INTEGER", "INT64", "FLOAT", "FLOAT64", "NUMERIC", "BIGNUMERIC", "BOOLEAN", "BOOL"]);
const GB = 1024 * 1024 * 1024;

/**
 * Runs a guarded statement as a query job: SELECT and WITH inside `SELECT * FROM (…) LIMIT cap+1`, with the job
 * timeout, the bytes it may bill (max_gb_billed, 10 GB unless set) and the row cap; pages are read until the cap or
 * RESULT_MAX_CHARS.
 */
export async function queryBigquery(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult> {
  const s = await bigquerySession(c, env);
  const sql = q.verb === "SELECT" || q.verb === "WITH" ? `SELECT * FROM (${q.sql}) LIMIT ${limits.maxRows + 1}` : q.sql;
  const gb = Number(c.config.max_gb_billed) || 10;
  const r = await bigqueryQuery(s, { ...env, timeoutMs: limits.timeoutMs }, sql, {
    timeoutMs: limits.timeoutMs,
    maxRows: limits.maxRows + 1,
    maxBytes: RESULT_MAX_CHARS * 2,
    maxChars: RESULT_MAX_CHARS,
    maxBytesBilled: String(Math.round(gb * GB)),
  });
  const rows = r.rows.map((row) => row.map((cell, i) => bigqueryValue(cell?.v, r.fields[i] ?? { name: "", type: "STRING" })));
  return {
    fields: r.fields.map((f) => ({ name: f.name, origin: null, scalar: SCALAR.has(f.type.toUpperCase()) && f.mode !== "REPEATED" })),
    rows: rows.slice(0, limits.maxRows),
    truncated: r.cut || rows.length > limits.maxRows || (r.more && rows.length >= limits.maxRows),
    ...(r.cut ? { cut: "size" as const } : {}),
  };
}
