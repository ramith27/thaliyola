import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SignJWT } from "jose";
import { ValidationError } from "../context.js";
import type { PinnedResponse } from "./network.js";
import { base, call, DatabaseError, failWith, reasonOf } from "./remote.js";
import { jsonPrefix, RESULT_MAX_CHARS, rowChars } from "./result-size.js";
import { schemaWanted, type ColumnDef, type IntrospectFilter, type TableDef } from "./schema.js";
import type { GuardedSql } from "./sql-guard.js";
import type { ConnTarget, DriverEnv, QueryLimits, RawResult, TestResult } from "./types.js";

/**
 * Snowflake through the SQL API with key-pair authentication: a JWT signed with the user's private key (RS256, via
 * jose). Only the account identifier is configurable, so requests always go to <account>.snowflakecomputing.com.
 *
 * Snowflake has no read-only session: each request runs one statement (MULTI_STATEMENT_COUNT=1), queries run inside
 * `SELECT * FROM (…)` (so only a query fits), the SQL guard checks the text, and the connection should use a role
 * that can only read.
 */

export function privateKeyOf(c: ConnTarget): KeyObject {
  try {
    return createPrivateKey({ key: c.secret.private_key ?? "", format: "pem", passphrase: c.secret.private_key_passphrase || undefined });
  } catch {
    throw new ValidationError("the private key isn't a PEM private key (or its passphrase is wrong)");
  }
}

/** "myorg-myaccount" → "MYORG-MYACCOUNT"; "xy12345.us-east-1" → "XY12345" (the JWT uses the account without region). */
export function jwtAccount(account: string): string {
  return account.split(".")[0]!.toUpperCase();
}

export async function snowflakeJwt(c: ConnTarget, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = privateKeyOf(c);
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  const fingerprint = `SHA256:${createHash("sha256").update(der).digest("base64")}`;
  const qualified = `${jwtAccount(c.config.account!)}.${c.config.user!.toUpperCase()}`;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(`${qualified}.${fingerprint}`)
    .setSubject(qualified)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

export function snowflakeBase(c: ConnTarget, env: DriverEnv): string {
  return base(env, "snowflake", `https://${c.config.account!.toLowerCase().replace(/_/g, "-")}.snowflakecomputing.com`);
}

export interface RowType {
  name: string;
  type: string;
  scale?: number | null;
}

export interface SnowflakeResult {
  code?: string;
  message?: string;
  sqlState?: string;
  data?: (string | null)[][];
  resultSetMetaData?: { numRows?: number; rowType?: RowType[]; partitionInfo?: { rowCount?: number }[] };
  statementHandle?: string;
  /** The response stopped at maxBytes: `data` holds the rows that arrived whole. */
  cut?: boolean;
}

export interface StatementOptions {
  /** Server-side statement timeout; the client waits a little longer. Default: the driver timeout. */
  timeoutMs?: number;
  /** Positional bindings (?) as text. */
  bindings?: string[];
  /** Most rows the server returns (ROWS_PER_RESULTSET). */
  maxRows?: number;
  maxBytes?: number;
  /** Past maxBytes, keep the rows that arrived whole (marked `cut`) instead of failing. */
  truncate?: boolean;
}

/** A failed statement: Snowflake's own code and SQLSTATE, so a message quoting data can be hidden. */
function refuse(res: PinnedResponse, body: SnowflakeResult | null): never {
  if (res.status === 422 && body && (body.sqlState || body.code)) {
    const err = new DatabaseError(`Snowflake refused the statement: ${reasonOf(res)}`, res.status, `Snowflake error ${body.code ?? ""}`.trim());
    if (body.sqlState && /^[0-9A-Z]{5}$/.test(body.sqlState)) Object.assign(err, { sqlState: body.sqlState });
    throw err;
  }
  failWith(res, "Snowflake");
}

function parse(res: PinnedResponse): SnowflakeResult | null {
  if (res.cut) {
    // Snowflake writes resultSetMetaData before data; what follows the rows (the handle too) was cut off.
    const part = jsonPrefix(res.text) as SnowflakeResult | null;
    if (res.status !== 200 || !part || !Array.isArray(part.data)) throw new ValidationError("the result is too large to read; select fewer columns or rows");
    return { ...part, cut: true };
  }
  try {
    return JSON.parse(res.text) as SnowflakeResult;
  } catch {
    return null;
  }
}

/**
 * Runs one statement and waits for it: Snowflake answers 202 while a statement runs, and the result is fetched from
 * its handle until it's done or the time is up (then the statement is cancelled).
 */
export async function snowflakeStatement(c: ConnTarget, env: DriverEnv, statement: string, opts: StatementOptions = {}): Promise<SnowflakeResult> {
  const timeoutMs = opts.timeoutMs ?? env.timeoutMs;
  const body: Record<string, unknown> = {
    statement,
    timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    parameters: { multi_statement_count: "1", query_tag: "thaliyola", ...(opts.maxRows ? { rows_per_resultset: String(opts.maxRows) } : {}) },
  };
  for (const k of ["warehouse", "database", "schema", "role"]) if (c.config[k]) body[k] = c.config[k];
  if (opts.bindings?.length) body.bindings = Object.fromEntries(opts.bindings.map((v, i) => [String(i + 1), { type: "TEXT", value: v }]));
  const api = snowflakeBase(c, env);
  const headers = async () => ({
    authorization: `Bearer ${await snowflakeJwt(c)}`,
    "x-snowflake-authorization-token-type": "KEYPAIR_JWT",
    accept: "application/json",
  });
  const deadline = Date.now() + timeoutMs + 5_000;
  const req = { maxBytes: opts.maxBytes, timeoutMs: timeoutMs + 5_000, ...(opts.truncate ? { truncate: true } : {}) };
  let res = await call(`${api}/api/v2/statements`, "database", env, { ...req, method: "POST", headers: { ...(await headers()), "content-type": "application/json" }, body: JSON.stringify(body) });
  let parsed = parse(res);
  for (let wait = 250; res.status === 202; wait = Math.min(wait * 2, 2_000)) {
    const handle = parsed?.statementHandle;
    if (!handle || !/^[0-9a-f-]{20,64}$/i.test(handle)) throw new ValidationError("Snowflake didn't say where the statement's result will be");
    if (Date.now() + wait > deadline) {
      await call(`${api}/api/v2/statements/${handle}/cancel`, "database", env, { method: "POST", headers: await headers(), timeoutMs: 5_000 }).catch(() => undefined);
      throw Object.assign(new Error("the statement took longer than the time allowed"), { name: "TimeoutError" });
    }
    await sleep(wait);
    res = await call(`${api}/api/v2/statements/${handle}`, "database", env, { ...req, headers: await headers(), timeoutMs: Math.max(1_000, deadline - Date.now()) });
    parsed = parse(res);
  }
  if (res.status !== 200 || !parsed) refuse(res, parsed);
  return parsed;
}

/** One more partition of a result (partition 0 comes with the statement). */
async function snowflakePartition(c: ConnTarget, env: DriverEnv, handle: string, partition: number, maxBytes?: number, truncate = false): Promise<{ rows: (string | null)[][]; cut: boolean }> {
  if (!/^[0-9a-f-]{20,64}$/i.test(handle)) throw new ValidationError("Snowflake didn't say where the statement's result is");
  const res = await call(`${snowflakeBase(c, env)}/api/v2/statements/${handle}?partition=${partition}`, "database", env, {
    headers: { authorization: `Bearer ${await snowflakeJwt(c)}`, "x-snowflake-authorization-token-type": "KEYPAIR_JWT", accept: "application/json" },
    ...(maxBytes ? { maxBytes } : {}),
    ...(truncate ? { truncate: true } : {}),
  });
  const parsed = parse(res);
  if (res.status !== 200 || !parsed) refuse(res, parsed);
  return { rows: parsed.data ?? [], cut: !!parsed.cut };
}

/** Rows as objects by lower-case column name, across partitions, up to `max` rows. */
async function rowsOf(c: ConnTarget, env: DriverEnv, statement: string, opts: StatementOptions & { max?: number } = {}): Promise<Record<string, string | null>[]> {
  const r = await snowflakeStatement(c, env, statement, opts);
  const names = (r.resultSetMetaData?.rowType ?? []).map((t) => t.name.toLowerCase());
  const max = opts.max ?? 200_000;
  const rows = [...(r.data ?? [])];
  const parts = r.resultSetMetaData?.partitionInfo?.length ?? 1;
  for (let p = 1; p < parts && rows.length < max && r.statementHandle; p++) rows.push(...(await snowflakePartition(c, env, r.statementHandle, p, 16 * 1024 * 1024)).rows);
  return rows.slice(0, max).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null])));
}

export async function testSnowflake(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const r = await snowflakeStatement(c, env, "SELECT CURRENT_VERSION(), CURRENT_USER(), CURRENT_ROLE()");
  const row = r.data?.[0];
  if (!row) return { detail: "Connected to Snowflake (the test query is still running)." };
  return { detail: `Connected to Snowflake ${row[0]} as ${row[1]}${row[2] ? ` (role ${row[2]})` : ""}.` };
}

// ---- Schema sync ---------------------------------------------------------------------------------------------------

/** "NUMBER(38,0)", "TEXT(255)", "TIMESTAMP_NTZ". */
function typeText(r: Record<string, string | null>): string {
  const t = r.data_type ?? "";
  if (t === "TEXT" && r.character_maximum_length && r.character_maximum_length !== "16777216") return `VARCHAR(${r.character_maximum_length})`;
  if (t === "NUMBER" && r.numeric_precision) return `NUMBER(${r.numeric_precision},${r.numeric_scale ?? 0})`;
  return t;
}

/**
 * Tables and views of the connection's database (its configured one, else the user's default), from
 * INFORMATION_SCHEMA. Without "schemas to sync", a configured schema limits the sync to that schema.
 */
export async function introspectSnowflake(c: ConnTarget, env: DriverEnv, f: IntrospectFilter): Promise<TableDef[]> {
  const filter = { include: f.include?.length ? f.include : c.config.schema ? [c.config.schema.replace(/^"|"$/g, "")] : undefined, exclude: f.exclude };
  const all = await rowsOf(c, env, "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ROW_COUNT, COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY TABLE_SCHEMA, TABLE_NAME");
  const tables = all.filter((t) => t.table_schema && t.table_name && schemaWanted(t.table_schema, filter)).slice(0, f.maxObjects + 1);
  if (!tables.length) return [];
  const schemas = [...new Set(tables.map((t) => t.table_schema!))];
  const inList = schemas.map(() => "?").join(", ");
  const cols = await rowsOf(
    c,
    env,
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT, COMMENT
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA IN (${inList}) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    { bindings: schemas, maxBytes: 16 * 1024 * 1024 },
  );
  // Keys and view definitions are extras: a role that can't read them still syncs.
  const pks = new Set<string>();
  const fks = new Map<string, string>();
  await rowsOf(c, env, "SHOW PRIMARY KEYS IN DATABASE")
    .then((rows) => rows.forEach((k) => pks.add(`${k.schema_name}.${k.table_name}.${k.column_name}`)))
    .catch(() => undefined);
  await rowsOf(c, env, "SHOW IMPORTED KEYS IN DATABASE")
    .then((rows) => rows.forEach((k) => fks.set(`${k.fk_schema_name}.${k.fk_table_name}.${k.fk_column_name}`, `${k.pk_schema_name}.${k.pk_table_name}.${k.pk_column_name}`)))
    .catch(() => undefined);
  const defs = new Map<string, string>();
  if (tables.some((t) => /VIEW/i.test(t.table_type ?? ""))) {
    await rowsOf(c, env, `SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA IN (${inList})`, { bindings: schemas, maxBytes: 16 * 1024 * 1024 })
      .then((rows) => rows.forEach((v) => defs.set(`${v.table_schema}.${v.table_name}`, (v.view_definition ?? "").toLowerCase())))
      .catch(() => undefined);
  }
  const byTable = new Map<string, ColumnDef[]>();
  for (const col of cols) {
    const key = `${col.table_schema}.${col.table_name}`;
    const list = byTable.get(key) ?? [];
    list.push({
      name: col.column_name!,
      type: typeText(col),
      nullable: col.is_nullable !== "NO",
      default: col.column_default,
      pk: pks.has(`${key}.${col.column_name}`) || undefined,
      fk: fks.get(`${key}.${col.column_name}`) ?? null,
      comment: col.comment || null,
    });
    byTable.set(key, list);
  }
  const usesOf = (key: string) => {
    const words = new Set((defs.get(key) ?? "").split(/[^a-z0-9_$]+/));
    return tables
      .filter((o) => `${o.table_schema}.${o.table_name}` !== key && words.has(o.table_name!.toLowerCase()))
      .map((o) => `${o.table_schema}.${o.table_name}`)
      .sort();
  };
  return tables.map((t) => {
    const view = /VIEW/i.test(t.table_type ?? "");
    const key = `${t.table_schema}.${t.table_name}`;
    return {
      schema: t.table_schema!,
      name: t.table_name!,
      kind: view ? "view" : "table",
      rows: view || t.row_count === null || t.row_count === undefined ? null : Number(t.row_count),
      comment: t.comment || null,
      columns: byTable.get(key) ?? [],
      ...(view ? { uses: usesOf(key) } : {}),
    };
  });
}

// ---- Read-only queries -------------------------------------------------------------------------------------------

const SCALAR = new Set(["fixed", "real", "boolean"]);

/** Snowflake's JSON cells are text: numbers, booleans, dates and timestamps are turned into what they are. */
export function snowflakeCell(v: string | null, t: RowType): unknown {
  if (v === null) return null;
  const type = t.type.toLowerCase();
  if (type === "fixed") {
    if ((t.scale ?? 0) === 0 && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
    return v;
  }
  if (type === "real") return Number.isFinite(Number(v)) ? Number(v) : v;
  if (type === "boolean") return v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v;
  if (type === "date" && /^-?\d+$/.test(v)) return new Date(Number(v) * 86_400_000).toISOString().slice(0, 10);
  if (type.startsWith("timestamp")) {
    const secs = Number(v.split(" ")[0]);
    return Number.isFinite(secs) ? new Date(Math.round(secs * 1000)).toISOString() : v;
  }
  if (type === "time" && Number.isFinite(Number(v))) return new Date(Math.round(Number(v) * 1000)).toISOString().slice(11, 23);
  return v;
}

/**
 * Runs a guarded statement: SELECT and WITH inside `SELECT * FROM (…) LIMIT cap+1`, everything with the server's
 * statement timeout and a row cap (ROWS_PER_RESULTSET); partitions are read until the cap or RESULT_MAX_CHARS.
 */
export async function querySnowflake(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult> {
  const sql = q.verb === "SELECT" || q.verb === "WITH" ? `SELECT * FROM (${q.sql}) LIMIT ${limits.maxRows + 1}` : q.sql;
  const opts = { timeoutMs: limits.timeoutMs, maxRows: limits.maxRows + 1, maxBytes: RESULT_MAX_CHARS * 2, truncate: true };
  const r = await snowflakeStatement(c, env, sql, opts);
  const types = r.resultSetMetaData?.rowType ?? [];
  if (r.cut && !types.length) throw new ValidationError("the result is too large to read; select fewer columns or rows");
  const all: unknown[][] = [];
  let used = 0;
  let bytes = false;
  const take = (rows: (string | null)[][]) => {
    for (const row of rows) {
      used += rowChars(row);
      if (used > RESULT_MAX_CHARS) {
        bytes = true;
        return;
      }
      all.push(row.map((v, i) => snowflakeCell(v, types[i] ?? { name: "", type: "text" })));
      if (all.length > limits.maxRows) return;
    }
  };
  take(r.data ?? []);
  // A response cut at the size cap: the rows that arrived whole are kept, and nothing more is read.
  if (r.cut) bytes = true;
  const parts = r.resultSetMetaData?.partitionInfo?.length ?? 1;
  for (let p = 1; p < parts && !bytes && all.length <= limits.maxRows && r.statementHandle; p++) {
    const part = await snowflakePartition(c, env, r.statementHandle, p, RESULT_MAX_CHARS * 2, true);
    take(part.rows);
    if (part.cut) bytes = true;
  }
  return {
    fields: types.map((t) => ({ name: t.name, origin: null, scalar: SCALAR.has(t.type.toLowerCase()) })),
    rows: all.slice(0, limits.maxRows),
    truncated: bytes || all.length > limits.maxRows,
    ...(bytes ? { cut: "size" as const } : {}),
  };
}
