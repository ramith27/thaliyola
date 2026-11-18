import { ValidationError } from "../context.js";
import { call, DatabaseError, reasonOf } from "./remote.js";
import type { PinnedResponse } from "./network.js";
import { jsonPrefix, RESULT_MAX_CHARS, rowChars } from "./result-size.js";
import { schemaWanted, type ColumnDef, type IntrospectFilter, type TableDef } from "./schema.js";
import type { GuardedSql } from "./sql-guard.js";
import type { ConnTarget, DriverEnv, QueryLimits, RawResult, TestResult } from "./types.js";

/**
 * ClickHouse through its HTTP interface. Queries go as GET requests to the server's root with `readonly=1` (after the
 * limits, so they hold: a read-only session can't change settings), and the user name and password travel in headers
 * (never in the URL). Redirects aren't followed (database mode), so the password never goes anywhere but the
 * configured server. A user whose profile is already read-only (readonly=1) can't be sent settings at all: then the
 * request is sent again without them and the profile's own read-only mode holds, but only when the profile has its
 * own time limit (max_execution_time, at most PROFILE_MAX_SECONDS or the query timeout): a query that outlives the
 * client keeps running on the server otherwise. Test reports a profile that can't take queries.
 */

interface ChOptions {
  /** default_format: JSON (rows as objects) or JSONCompact (rows as arrays). */
  format?: "JSON" | "JSONCompact";
  /** Settings besides max_execution_time and readonly. */
  settings?: Record<string, string>;
  /** Query parameters ({name:Type} in the SQL), sent as param_<name>. */
  params?: Record<string, string>;
  maxBytes?: number;
  /** Someone's query: with a read-only profile, it runs only if the profile limits its time (see profileSeconds). */
  query?: boolean;
}

/** The longest time limit of a read-only profile that queries accept (or the query timeout, when that's longer). */
export const PROFILE_MAX_SECONDS = 60;
/** Code 164 (READONLY) because a setting was sent: the user's profile is read-only already. */
const READONLY_SETTING = /^Code: 164\.[\s\S]*Cannot modify '[^']+' setting in readonly mode/;

/**
 * The time limit of read-only profiles, per connection, server and user, read from system.settings once every few
 * minutes (0: none). Exported for tests.
 */
export const readonlyProfiles = new Map<string, { at: number; seconds: number }>();
const PROFILE_TTL_MS = 5 * 60_000;
const profileKey = (c: ConnTarget) => `${c.id}\u0000${c.config.url}\u0000${c.config.user || "default"}`;

/** Whether queries may run on a read-only profile with this time limit. */
const profileLimitOk = (seconds: number, timeoutMs: number) => seconds > 0 && seconds <= Math.max(PROFILE_MAX_SECONDS, Math.ceil(timeoutMs / 1000));

/** Why a read-only profile can't take queries, for the error and for Test. */
function profileProblem(seconds: number, timeoutMs: number): string {
  const most = Math.max(PROFILE_MAX_SECONDS, Math.ceil(timeoutMs / 1000));
  return (
    `this ClickHouse user's profile is read-only (readonly=1), so queries can't be sent a time limit, and the profile's own ` +
    `max_execution_time is ${seconds > 0 ? `${seconds} seconds` : "not set"}. Queries are refused: a query that outlives ` +
    `the request would keep running on the server. Give the user a profile with readonly=2, or a max_execution_time of at most ${most} seconds`
  );
}

/** The read-only profile's time limit this connection last reported, if it has one (for Test). */
export function readonlyProfileOf(c: ConnTarget): number | null {
  return readonlyProfiles.get(profileKey(c))?.seconds ?? null;
}

export interface ChResult<T> {
  meta?: { name: string; type: string }[];
  data: T[];
  rows: number;
  /** The response stopped at maxBytes (someone's query): `data` holds the rows that arrived whole. */
  cut?: boolean;
}

/** A ClickHouse Array(String) query parameter: ['a', 'b'] with quotes and backslashes escaped. */
export function chArray(values: string[]): string {
  return `[${values.map((v) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}]`;
}

function answeredLikeClickhouse(res: PinnedResponse): boolean {
  return Object.keys(res.headers).some((h) => h.startsWith("x-clickhouse-")) || /^Code: \d+\./.test(res.text);
}

function refuse(res: PinnedResponse): never {
  const reason = reasonOf(res);
  const hint = res.status === 401 || res.status === 403 ? " Check the credentials and their permissions." : "";
  const message = `ClickHouse answered HTTP ${res.status}${reason ? `: ${reason}` : ""}.${hint}`;
  const code = /^Code: (\d+)\./.exec(res.text)?.[1];
  throw new DatabaseError(message, res.status, `ClickHouse error ${code ?? `HTTP ${res.status}`}`);
}

export async function chQuery<T = Record<string, unknown>>(c: ConnTarget, env: DriverEnv, sql: string, opts: ChOptions = {}): Promise<ChResult<T>> {
  const send = (limits: boolean, text = sql) => {
    // Always the server's root: a configured path (or query, or fragment) is ignored.
    const url = new URL("/", c.config.url!);
    const params: [string, string][] = [
      ["database", c.config.database || "default"],
      ["default_format", opts.format ?? "JSON"],
    ];
    for (const [k, v] of Object.entries(opts.params ?? {})) params.push([`param_${k}`, v]);
    if (limits) {
      params.push(["max_execution_time", String(Math.max(1, Math.ceil(env.timeoutMs / 1000)))]);
      // The server stops a read-only query when the client goes away (a timeout here), instead of finishing it.
      params.push(["cancel_http_readonly_queries_on_client_close", "1"]);
      for (const [k, v] of Object.entries(opts.settings ?? {})) params.push([k, v]);
      // Last: from here on nothing in the session (or the query) can change a setting.
      params.push(["readonly", "1"]);
    }
    params.push(["query", text]);
    for (const [k, v] of params) url.searchParams.append(k, v);
    return call(url.toString(), "database", env, {
      headers: { "X-ClickHouse-User": c.config.user || "default", ...(c.secret.password ? { "X-ClickHouse-Key": c.secret.password } : {}) },
      ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
      // Someone's query that outgrows the cap comes back cut, with the rows read so far.
      ...(opts.query ? { truncate: true } : {}),
    });
  };
  let res = await send(true);
  // Databases may be on private networks, so only a server that answers like ClickHouse gets its words repeated:
  // anything else could be an internal service whose response shouldn't be read back through an error message.
  // Not even its status code: that would tell one internal service from another.
  if (!answeredLikeClickhouse(res)) throw new ValidationError("that address didn't answer like a ClickHouse server");
  // Code 164 (READONLY) about a setting: the user's profile is read-only already, so it can't be sent settings. It
  // stays read-only, but only its own limits hold: someone's query runs only if the profile limits its time.
  if (res.status !== 200 && READONLY_SETTING.test(res.text)) {
    const key = profileKey(c);
    let known = readonlyProfiles.get(key);
    if (!known || Date.now() - known.at > PROFILE_TTL_MS) {
      const r = await send(false, "SELECT value FROM system.settings WHERE name = 'max_execution_time'");
      if (!answeredLikeClickhouse(r)) throw new ValidationError("that address didn't answer like a ClickHouse server");
      if (r.status !== 200) refuse(r);
      let seconds = 0;
      try {
        seconds = Number((JSON.parse(r.text) as ChResult<{ value: string }>).data[0]?.value ?? 0) || 0;
      } catch {
        throw new ValidationError("ClickHouse didn't answer with JSON");
      }
      known = { at: Date.now(), seconds };
      readonlyProfiles.set(key, known);
    }
    if (opts.query && !profileLimitOk(known.seconds, env.timeoutMs)) throw new ValidationError(profileProblem(known.seconds, env.timeoutMs));
    res = await send(false);
    if (!answeredLikeClickhouse(res)) throw new ValidationError("that address didn't answer like a ClickHouse server");
  } else if (res.status === 200) {
    readonlyProfiles.delete(profileKey(c));
  }
  if (res.status !== 200) refuse(res);
  if (res.cut) {
    // ClickHouse writes "meta" before "data", so the columns arrived whole.
    const part = jsonPrefix(res.text);
    if (!part || !Array.isArray(part.meta) || !Array.isArray(part.data)) throw new ValidationError("the result is too large to read; select fewer columns or rows");
    return { meta: part.meta as ChResult<T>["meta"], data: part.data as T[], rows: part.data.length, cut: true };
  }
  try {
    return JSON.parse(res.text) as ChResult<T>;
  } catch {
    throw new ValidationError("ClickHouse didn't answer with JSON");
  }
}

export async function testClickhouse(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const r = await chQuery<{ version: string; who: string }>(c, env, "SELECT version() AS version, currentUser() AS who");
  const row = r.data[0]!;
  const detail = `Connected to ClickHouse ${row.version} as ${row.who}.`;
  const seconds = readonlyProfileOf(c);
  if (c.options.allow_query && seconds !== null && !profileLimitOk(seconds, env.timeoutMs)) {
    const why = profileProblem(seconds, env.timeoutMs);
    return { detail, warning: `${why[0]!.toUpperCase()}${why.slice(1)}.` };
  }
  return { detail };
}

// ---- Schema sync ---------------------------------------------------------------------------------------------------

const SYSTEM_DATABASES = ["system", "information_schema"];
const VIEW_ENGINES = /^(View|MaterializedView|LiveView|WindowView)$/;

/**
 * Tables and views, from system.tables and system.columns. In ClickHouse a schema is a database: the connection's own
 * database by default, or the databases its "schemas to sync" name (never the system ones).
 */
export async function introspectClickhouse(c: ConnTarget, env: DriverEnv, f: IntrospectFilter): Promise<TableDef[]> {
  let dbs: string[];
  if (f.include?.length) {
    const r = await chQuery<{ name: string }>(c, env, "SELECT name FROM system.databases ORDER BY name");
    dbs = r.data.map((d) => d.name).filter((d) => !SYSTEM_DATABASES.includes(d.toLowerCase()) && schemaWanted(d, f));
  } else {
    dbs = [c.config.database || "default"].filter((d) => schemaWanted(d, f));
  }
  if (!dbs.length) return [];
  const params = { dbs: chArray(dbs), max: String(f.maxObjects + 1) };
  const tables = await chQuery<{ database: string; name: string; engine: string; total_rows: string | number | null; comment: string | null; as_select: string | null }>(
    c,
    env,
    `SELECT database, name, engine, total_rows, comment, as_select FROM system.tables
      WHERE has({dbs:Array(String)}, database) AND NOT is_temporary ORDER BY database, name LIMIT {max:UInt32}`,
    { params },
  );
  if (!tables.data.length) return [];
  const cols = await chQuery<{ database: string; table: string; name: string; type: string; default_kind: string; default_expression: string; is_in_primary_key: number | string; comment: string }>(
    c,
    env,
    `SELECT database, table, name, type, default_kind, default_expression, is_in_primary_key, comment FROM system.columns
      WHERE has({dbs:Array(String)}, database) ORDER BY database, table, position`,
    { params, maxBytes: 16 * 1024 * 1024 },
  );
  const byTable = new Map<string, ColumnDef[]>();
  for (const col of cols.data) {
    const key = `${col.database}.${col.table}`;
    const list = byTable.get(key) ?? [];
    const nullable = /^Nullable\(/.test(col.type);
    list.push({
      name: col.name,
      type: col.type,
      nullable,
      default: col.default_kind ? (col.default_kind === "DEFAULT" ? col.default_expression : `${col.default_kind} ${col.default_expression}`) : null,
      pk: Number(col.is_in_primary_key) === 1 || undefined,
      comment: col.comment || null,
    });
    byTable.set(key, list);
  }
  // What each view reads: the synced tables its SELECT names (ClickHouse keeps no dependency list for plain views).
  const usesOf = (key: string, select: string | null) => {
    const words = new Set((select ?? "").toLowerCase().split(/[^a-z0-9_$]+/));
    return tables.data.filter((o) => `${o.database}.${o.name}` !== key && words.has(o.name.toLowerCase())).map((o) => `${o.database}.${o.name}`).sort();
  };
  return tables.data.map((t) => {
    const view = VIEW_ENGINES.test(t.engine);
    const key = `${t.database}.${t.name}`;
    return {
      schema: t.database,
      name: t.name,
      kind: view ? "view" : "table",
      rows: view || t.total_rows === null || t.total_rows === undefined ? null : Number(t.total_rows),
      comment: t.comment || null,
      columns: byTable.get(key) ?? [],
      ...(view ? { uses: usesOf(key, t.as_select) } : {}),
    };
  });
}

// ---- Read-only queries -------------------------------------------------------------------------------------------

/** Number and boolean types: they can't carry a row's text. */
const CH_SCALAR = /^(Nullable\()?(U?Int(8|16|32|64|128|256)|Float(32|64)|BFloat16|Decimal(32|64|128|256)?|Bool)\b/;

/**
 * Runs a guarded statement read-only (readonly=1), with the server's execution timeout. SELECT and WITH are wrapped
 * in `SELECT * FROM (…) LIMIT cap+1`, so the server stops at the row cap; the result is also capped on the server
 * (max_result_rows, max_result_bytes, breaking rather than failing), and read at most to twice RESULT_MAX_CHARS here: a
 * larger response comes back cut, with the rows that arrived whole.
 */
export async function queryClickhouse(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult> {
  const sql = q.verb === "SELECT" || q.verb === "WITH" ? `SELECT * FROM (${q.sql}) LIMIT ${limits.maxRows + 1}` : q.sql;
  const r = await chQuery<unknown[]>(c, { ...env, timeoutMs: limits.timeoutMs }, sql, {
    format: "JSONCompact",
    settings: { max_result_rows: String(limits.maxRows + 1), max_result_bytes: String(RESULT_MAX_CHARS), result_overflow_mode: "break" },
    maxBytes: RESULT_MAX_CHARS * 2,
    query: true,
  });
  const all: unknown[][] = [];
  let used = 0;
  let bytes = !!r.cut;
  for (const row of r.data ?? []) {
    if (!Array.isArray(row)) continue;
    used += rowChars(row);
    if (used > RESULT_MAX_CHARS) {
      bytes = true;
      break;
    }
    all.push(row);
    if (all.length > limits.maxRows) break;
  }
  return {
    fields: (r.meta ?? []).map((m) => ({ name: m.name, origin: null, scalar: CH_SCALAR.test(m.type) && !/^(Nullable\()?Array/.test(m.type) })),
    rows: all.slice(0, limits.maxRows),
    truncated: bytes || all.length > limits.maxRows,
    ...(bytes ? { cut: "size" as const } : {}),
  };
}
