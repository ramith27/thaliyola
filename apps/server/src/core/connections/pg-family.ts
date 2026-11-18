import { isIP } from "node:net";
import pg from "pg";
import { resolveTarget } from "./network.js";
import { likePattern, schemaWanted, type ColumnDef, type IntrospectFilter, type TableDef } from "./schema.js";
import { RESULT_MAX_CHARS, rowChars } from "./result-size.js";
import type { GuardedSql } from "./sql-guard.js";
import type { ConnTarget, DriverEnv, FieldOrigin, QueryLimits, RawResult, TestResult } from "./types.js";

/**
 * Postgres and Redshift through `pg`. The host is resolved and checked once, and the client connects to that address
 * (TLS still verifies the certificate against the host name: `servername`).
 */

export function tlsFor(mode: string | undefined, host: string): false | { rejectUnauthorized: boolean; servername?: string } {
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode !== "require", servername: isIP(host) ? undefined : host };
}

export async function withPg<T>(c: ConnTarget, env: DriverEnv, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const target = await resolveTarget(c.config.host!, "database", env.net);
  const client = new pg.Client({
    host: target.address,
    port: Number(c.config.port) || (c.kind === "redshift" ? 5439 : 5432),
    database: c.config.database,
    user: c.config.user,
    password: c.secret.password ?? "",
    ssl: tlsFor(c.config.sslmode, target.host),
    connectionTimeoutMillis: Math.min(env.timeoutMs, 10_000),
    statement_timeout: env.timeoutMs,
    query_timeout: env.timeoutMs + 2_000,
    application_name: "thaliyola",
    // Every transaction starts read-only (Postgres; Redshift doesn't take startup options): even a COMMIT that got
    // through couldn't start one that writes.
    ...(c.kind === "postgres" ? { options: "-c default_transaction_read_only=on" } : {}),
  });
  // A dropped connection after the work is done must not crash the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function testPg(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  return withPg(c, env, async (client) => {
    const { rows } = await client.query<{ version: string; who: string }>("SELECT version() AS version, current_user AS who");
    const version = rows[0]!.version;
    const product = version.match(/Redshift [\d.]+/)?.[0] ?? version.match(/^PostgreSQL [\d.]+/)?.[0] ?? version.split(" ").slice(0, 2).join(" ");
    let warning: string | undefined;
    if (c.kind === "postgres") {
      const su = await client.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").catch(() => ({ rows: [] as { rolsuper: boolean }[] }));
      if (su.rows[0]?.rolsuper) warning = `${rows[0]!.who} is a superuser. Use a read-only user for connections.`;
    }
    return { detail: `Connected to ${product} as ${rows[0]!.who}.`, warning };
  });
}

// ---- Schema sync ---------------------------------------------------------------------------------------------------

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_internal", "pg_automv", "catalog_history"];

/** Tables and views of the connected database, read in a read-only transaction. (OIDs come back as numbers.) */
export async function introspectPg(c: ConnTarget, env: DriverEnv, f: IntrospectFilter): Promise<TableDef[]> {
  return withPg(c, env, async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      return c.kind === "redshift" ? await redshiftTables(client, f) : await postgresTables(client, f);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  });
}

async function postgresTables(client: pg.Client, f: IntrospectFilter): Promise<TableDef[]> {
  const inc = f.include?.length ? f.include.map(likePattern) : null;
  const exc = f.exclude?.length ? f.exclude.map(likePattern) : null;
  const { rows: tables } = await client.query<{ oid: number; schema: string; name: string; relkind: string; n_rows: number | null; comment: string | null }>(
    `SELECT c.oid AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 THEN c.reltuples::float8 END AS n_rows,
            obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
        AND n.nspname <> ALL($1::text[]) AND n.nspname !~ '^pg_(toast|temp_)'
        AND ($2::text[] IS NULL OR n.nspname LIKE ANY($2::text[]))
        AND ($3::text[] IS NULL OR NOT (n.nspname LIKE ANY($3::text[])))
      ORDER BY n.nspname, c.relname LIMIT $4`,
    [SYSTEM_SCHEMAS, inc, exc, f.maxObjects + 1],
  );
  if (!tables.length) return [];
  const oids = tables.map((t) => t.oid);
  const { rows: cols } = await client.query<{ oid: number; name: string; type: string; nullable: boolean; def: string | null; comment: string | null }>(
    `SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS def, col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
    [oids],
  );
  const { rows: keys } = await client.query<{ oid: number; contype: string; col: string; fschema: string | null; ftable: string | null; fcol: string | null }>(
    `SELECT con.conrelid AS oid, con.contype::text AS contype, a.attname AS col, fn.nspname AS fschema, fc.relname AS ftable, fa.attname AS fcol
       FROM pg_constraint con
       CROSS JOIN LATERAL unnest(con.conkey, coalesce(con.confkey, con.conkey)) AS k(attnum, fattnum)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       LEFT JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum
      WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p', 'f')`,
    [oids],
  );
  const byOid = new Map<number, ColumnDef[]>();
  for (const col of cols) {
    const list = byOid.get(col.oid) ?? [];
    list.push({ name: col.name, type: col.type, nullable: col.nullable, default: col.def, comment: col.comment });
    byOid.set(col.oid, list);
  }
  for (const k of keys) {
    const col = byOid.get(k.oid)?.find((x) => x.name === k.col);
    if (!col) continue;
    if (k.contype === "p") col.pk = true;
    else if (k.ftable && !col.fk) col.fk = `${k.fschema}.${k.ftable}.${k.fcol}`;
  }
  // What each view reads: the relations its rewrite rule depends on.
  const views = tables.filter((t) => t.relkind === "v" || t.relkind === "m").map((t) => t.oid);
  const uses = new Map<number, string[]>();
  if (views.length) {
    const { rows } = await client.query<{ oid: number; schema: string; name: string }>(
      `SELECT DISTINCT rw.ev_class AS oid, rn.nspname AS schema, r.relname AS name
         FROM pg_rewrite rw JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid AND d.refclassid = 'pg_class'::regclass
         JOIN pg_class r ON r.oid = d.refobjid AND r.oid <> rw.ev_class JOIN pg_namespace rn ON rn.oid = r.relnamespace
        WHERE rw.ev_class = ANY($1::oid[])`,
      [views],
    );
    for (const r of rows) uses.set(r.oid, [...(uses.get(r.oid) ?? []), `${r.schema}.${r.name}`]);
  }
  return tables.map((t) => {
    const view = t.relkind === "v" || t.relkind === "m";
    return {
      schema: t.schema,
      name: t.name,
      kind: view ? "view" : "table",
      rows: t.n_rows === null ? null : Math.round(Number(t.n_rows)),
      comment: t.comment,
      columns: byOid.get(t.oid) ?? [],
      ...(view ? { uses: (uses.get(t.oid) ?? []).sort() } : {}),
    };
  });
}

/** Redshift: its system views (svv_*) also cover external tables and late-binding views; filters are applied here. */
async function redshiftTables(client: pg.Client, f: IntrospectFilter): Promise<TableDef[]> {
  const { rows: all } = await client.query<{ schema: string; name: string; type: string; comment: string | null }>(
    `SELECT table_schema AS schema, table_name AS name, table_type AS type, remarks AS comment FROM svv_tables
      WHERE table_catalog = current_database() ORDER BY table_schema, table_name`,
  );
  const tables = all.filter((t) => !SYSTEM_SCHEMAS.includes(t.schema) && !/^pg_(toast|temp_)/.test(t.schema) && schemaWanted(t.schema, f)).slice(0, f.maxObjects + 1);
  if (!tables.length) return [];
  const schemas = [...new Set(tables.map((t) => t.schema))];
  const { rows: cols } = await client.query<{
    schema: string;
    tname: string;
    name: string;
    data_type: string;
    len: number | null;
    precision: number | null;
    scale: number | null;
    nullable: string;
    def: string | null;
    comment: string | null;
  }>(
    `SELECT table_schema AS schema, table_name AS tname, column_name AS name, data_type, character_maximum_length AS len,
            numeric_precision AS precision, numeric_scale AS scale, is_nullable AS nullable, column_default AS def, remarks AS comment
       FROM svv_columns WHERE table_catalog = current_database() AND table_schema IN (${schemas.map((_, i) => `$${i + 1}`).join(", ")})
      ORDER BY table_schema, table_name, ordinal_position`,
    schemas,
  );
  const rowsOf = new Map<string, number>();
  await client
    .query<{ schema: string; name: string; n_rows: string }>(`SELECT "schema" AS schema, "table" AS name, tbl_rows AS n_rows FROM svv_table_info`)
    .then((r) => r.rows.forEach((x) => rowsOf.set(`${x.schema}.${x.name}`, Number(x.n_rows))))
    .catch(() => undefined);
  const pks = new Set<string>();
  await client
    .query<{ schema: string; tname: string; col: string }>(
      `SELECT k.table_schema AS schema, k.table_name AS tname, k.column_name AS col
         FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k
           ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
        WHERE c.constraint_type = 'PRIMARY KEY'`,
    )
    .then((r) => r.rows.forEach((x) => pks.add(`${x.schema}.${x.tname}.${x.col}`)))
    .catch(() => undefined);
  const typeOf = (c: (typeof cols)[number]) =>
    c.len ? `${c.data_type}(${c.len})` : c.data_type === "numeric" && c.precision ? `numeric(${c.precision},${c.scale ?? 0})` : c.data_type;
  const byTable = new Map<string, ColumnDef[]>();
  for (const c of cols) {
    const key = `${c.schema}.${c.tname}`;
    const list = byTable.get(key) ?? [];
    list.push({ name: c.name, type: typeOf(c), nullable: c.nullable !== "NO", default: c.def, comment: c.comment, pk: pks.has(`${key}.${c.name}`) || undefined });
    byTable.set(key, list);
  }
  // What each view reads, from its definition: the synced tables and views it names (Redshift has no dependency
  // catalogue that covers late-binding views).
  const defs = new Map<string, string>();
  await client
    .query<{ schema: string; name: string; definition: string | null }>(`SELECT schemaname AS schema, viewname AS name, definition FROM pg_views`)
    .then((r) => r.rows.forEach((x) => defs.set(`${x.schema}.${x.name}`, (x.definition ?? "").toLowerCase())))
    .catch(() => undefined);
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
      rows: rowsOf.has(key) ? rowsOf.get(key)! : null,
      comment: t.comment,
      columns: byTable.get(key) ?? [],
      ...(view ? { uses: usesOf(key) } : {}),
    };
  });
}

// ---- Read-only queries -------------------------------------------------------------------------------------------

/** Number and boolean type OIDs: bool, int8, int2, int4, oid, float4, float8, money, numeric. */
const PG_SCALAR = new Set([16, 20, 21, 23, 26, 700, 701, 790, 1700]);
/** Cells longer than this are cut in the database, before they're sent. */
const CELL_CUT = 2049;
const NUMERIC = 1700;
const BYTEA = 17;
/** Redshift: the text types it can cut with left() (other variable-length types are left as they are). */
const REDSHIFT_TEXT = new Set([25, 1042, 1043]);

/**
 * Runs a guarded statement in a read-only transaction with the statement timeout, through the extended protocol (one
 * statement only: the server refuses a second). SELECT and WITH go through a cursor: the columns are read first
 * (`LIMIT 0`), then the cursor cuts long cells to 2 KB in the database and rows come in batches until the row cap or
 * RESULT_MAX_CHARS, so neither many rows nor huge cells reach this process. The transaction is always rolled back.
 */
export async function queryPg(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult> {
  return withPg(c, { ...env, timeoutMs: limits.timeoutMs }, async (client) => {
    const run = (text: string) => client.query<unknown[]>({ text, rowMode: "array", queryMode: "extended" } as pg.QueryConfig & { rowMode: "array" });
    await client.query("BEGIN READ ONLY");
    try {
      let fields: pg.FieldDef[];
      let all: unknown[][] = [];
      let bytes = false;
      if (q.verb === "SELECT" || q.verb === "WITH") {
        fields = (await run(`SELECT * FROM (${q.sql}) AS thaliyola_t LIMIT 0`)).fields ?? [];
        const cols = fields.map((_, i) => `c${i + 1}`);
        const exprs = fields.map((f, i) => {
          const col = `thaliyola_t.${cols[i]}`;
          if (f.dataTypeID === BYTEA && c.kind === "postgres") return `'<' || octet_length(${col}) || ' bytes>'`;
          const cut = c.kind === "redshift" ? REDSHIFT_TEXT.has(f.dataTypeID) : f.dataTypeSize < 0 && f.dataTypeID !== NUMERIC;
          return cut ? `left(${col}::text, ${CELL_CUT})` : col;
        });
        await run(`DECLARE thaliyola_q NO SCROLL CURSOR FOR SELECT ${exprs.join(", ") || "*"} FROM (${q.sql}) AS thaliyola_t${cols.length ? `(${cols.join(", ")})` : ""}`);
        // The widest a row can be after the cut: how many rows one batch may fetch within the budget.
        const widest = 16 + fields.reduce((n, f) => n + (f.dataTypeSize > 0 ? 24 : CELL_CUT * 2), 0);
        let used = 0;
        for (;;) {
          const want = Math.max(1, Math.min(limits.maxRows + 1 - all.length, Math.floor((RESULT_MAX_CHARS - used) / widest), 500));
          const batch = (await run(`FETCH FORWARD ${want} FROM thaliyola_q`)).rows ?? [];
          for (const r of batch) {
            used += rowChars(r);
            if (used > RESULT_MAX_CHARS) {
              bytes = true;
              break;
            }
            all.push(r);
          }
          if (bytes || batch.length < want || all.length > limits.maxRows) break;
        }
      } else {
        const res = await run(q.sql);
        fields = res.fields ?? [];
        let used = 0;
        for (const r of res.rows ?? []) {
          used += rowChars(r);
          if (used > RESULT_MAX_CHARS) {
            bytes = true;
            break;
          }
          all.push(r);
        }
      }
      const origins = new Map<string, FieldOrigin>();
      const tableIds = [...new Set(fields.map((f) => f.tableID).filter((id) => id > 0))];
      if (tableIds.length && c.kind === "postgres") {
        const { rows } = await client.query<{ oid: number; attnum: number; schema: string; tname: string; col: string }>(
          `SELECT c.oid AS oid, a.attnum::int AS attnum, n.nspname AS schema, c.relname AS tname, a.attname AS col
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE c.oid = ANY($1::oid[]) AND a.attnum > 0`,
          [tableIds],
        );
        for (const r of rows) origins.set(`${r.oid}:${r.attnum}`, { schema: r.schema, table: r.tname, column: r.col });
      }
      return {
        fields: fields.map((f) => ({ name: f.name, origin: origins.get(`${f.tableID}:${f.columnID}`) ?? null, scalar: PG_SCALAR.has(f.dataTypeID) })),
        rows: all.slice(0, limits.maxRows),
        truncated: bytes || all.length > limits.maxRows,
        ...(bytes ? { cut: "size" as const } : {}),
      };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  });
}
