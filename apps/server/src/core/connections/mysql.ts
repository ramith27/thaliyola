import net from "node:net";
import mysql from "mysql2/promise";
import { resolveTarget } from "./network.js";
import { schemaWanted, type ColumnDef, type IntrospectFilter, type TableDef } from "./schema.js";
import type { GuardedSql } from "./sql-guard.js";
import { RESULT_MAX_CHARS, rowChars } from "./result-size.js";
import type { ConnTarget, DriverEnv, QueryLimits, RawResult, TestResult } from "./types.js";

/**
 * MySQL through `mysql2`. The socket goes to the checked address (the `stream` option) while the client keeps the
 * host name, so TLS verifies the certificate for it.
 */

export async function withMysql<T>(c: ConnTarget, env: DriverEnv, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const target = await resolveTarget(c.config.host!, "database", env.net);
  const port = Number(c.config.port) || 3306;
  const mode = c.config.sslmode;
  const conn = await mysql.createConnection({
    host: target.host,
    port,
    user: c.config.user,
    password: c.secret.password ?? "",
    database: c.config.database,
    ssl: mode === "disable" ? undefined : { rejectUnauthorized: mode !== "require", verifyIdentity: mode !== "require" },
    connectTimeout: Math.min(env.timeoutMs, 10_000),
    stream: () => net.connect(port, target.address),
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  conn.on("error", () => undefined);
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => conn.destroy());
  }
}

/** Privileges that mean the user can change data or schema. */
const WRITES = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/;

export async function testMysql(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  return withMysql(c, env, async (conn) => {
    const [rows] = await conn.query("SELECT VERSION() AS version, CURRENT_USER() AS who");
    const r = (rows as { version: string; who: string }[])[0]!;
    const [grants] = await conn.query("SHOW GRANTS").catch(() => [[]] as const);
    const writes = (grants as Record<string, string>[]).some((g) => WRITES.test(Object.values(g)[0] ?? ""));
    return {
      detail: `Connected to MySQL ${r.version} as ${r.who}.`,
      warning: writes ? `${r.who} can change data or tables. Use a read-only user (SELECT and SHOW VIEW only) for connections.` : undefined,
    };
  });
}

// ---- Schema sync ---------------------------------------------------------------------------------------------------

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

/**
 * Tables and views. In MySQL a schema is a database: the connection's own database by default, or the databases its
 * "schemas to sync" name (never the system ones).
 */
export async function introspectMysql(c: ConnTarget, env: DriverEnv, f: IntrospectFilter): Promise<TableDef[]> {
  return withMysql(c, env, async (conn) => {
    await conn.query("START TRANSACTION READ ONLY");
    try {
      let schemas: string[];
      if (f.include?.length) {
        const [rows] = await conn.query("SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME");
        schemas = (rows as { s: string }[]).map((r) => r.s).filter((s) => !SYSTEM_SCHEMAS.includes(s.toLowerCase()) && schemaWanted(s, f));
      } else {
        const [rows] = await conn.query("SELECT DATABASE() AS s");
        schemas = (rows as { s: string | null }[]).map((r) => r.s).filter((s): s is string => !!s && schemaWanted(s, f));
      }
      if (!schemas.length) return [];
      const [tables] = await conn.query(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t, TABLE_ROWS AS r, TABLE_COMMENT AS c
           FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT ?`,
        [schemas, f.maxObjects + 1],
      );
      const list = tables as { s: string; n: string; t: string; r: string | number | null; c: string | null }[];
      if (!list.length) return [];
      const [cols] = await conn.query(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS def, COLUMN_KEY AS ckey, COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        [schemas],
      );
      const [fks] = await conn.query(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS fs, REFERENCED_TABLE_NAME AS ft, REFERENCED_COLUMN_NAME AS fc
           FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA IN (?) AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [schemas],
      );
      const fk = new Map((fks as { s: string; n: string; col: string; fs: string; ft: string; fc: string }[]).map((k) => [`${k.s}.${k.n}.${k.col}`, `${k.fs}.${k.ft}.${k.fc}`]));
      const byTable = new Map<string, ColumnDef[]>();
      for (const col of cols as { s: string; n: string; name: string; type: string; nullable: string; def: string | null; ckey: string; comment: string }[]) {
        const key = `${col.s}.${col.n}`;
        const l = byTable.get(key) ?? [];
        l.push({
          name: col.name,
          type: String(col.type),
          nullable: col.nullable === "YES",
          default: col.def,
          pk: col.ckey === "PRI" || undefined,
          fk: fk.get(`${key}.${col.name}`) ?? null,
          comment: col.comment || null,
        });
        byTable.set(key, l);
      }
      // What each view reads (MySQL 8.0.13 and later).
      const uses = new Map<string, string[]>();
      if (list.some((t) => /VIEW/i.test(t.t))) {
        const [vu] = await conn
          .query(`SELECT VIEW_SCHEMA AS s, VIEW_NAME AS n, TABLE_SCHEMA AS ts, TABLE_NAME AS tn FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA IN (?)`, [schemas])
          .catch(() => [[]] as const);
        for (const u of vu as { s: string; n: string; ts: string; tn: string }[]) uses.set(`${u.s}.${u.n}`, [...(uses.get(`${u.s}.${u.n}`) ?? []), `${u.ts}.${u.tn}`]);
      }
      return list.map((t) => {
        const view = /VIEW/i.test(t.t);
        return {
          schema: t.s,
          name: t.n,
          kind: view ? "view" : "table",
          rows: t.r === null || t.r === undefined || view ? null : Number(t.r),
          comment: t.c || null,
          columns: byTable.get(`${t.s}.${t.n}`) ?? [],
          ...(view ? { uses: (uses.get(`${t.s}.${t.n}`) ?? []).sort() } : {}),
        };
      });
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
    }
  });
}

// ---- Read-only queries -------------------------------------------------------------------------------------------

/** Number types (mysql2 column types): DECIMAL, TINY, SHORT, LONG, FLOAT, DOUBLE, LONGLONG, INT24, NEWDECIMAL. */
const MYSQL_SCALAR = new Set([0, 1, 2, 3, 4, 5, 8, 9, 246]);

type Meta = { name: string; orgName?: string; orgTable?: string; schema?: string; columnType?: number; type?: number };

/**
 * Runs a guarded statement in a read-only transaction. max_execution_time stops a slow SELECT on the server,
 * sql_select_limit keeps it from sending more than one row over the cap (unless the query has its own LIMIT), and the
 * rows are read one by one: at the row cap or RESULT_MAX_CHARS the connection is dropped, so a LIMIT higher than the
 * cap or huge cells never pile up here. The client gives up shortly after the timeout whatever the statement.
 */
export async function queryMysql(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult> {
  return withMysql(c, { ...env, timeoutMs: limits.timeoutMs }, async (conn) => {
    await conn.query("SET SESSION max_execution_time = ?", [limits.timeoutMs]);
    await conn.query("SET SESSION sql_select_limit = ?", [limits.maxRows + 1]);
    await conn.query("START TRANSACTION READ ONLY");
    try {
      const core = (conn as unknown as { connection: CoreConnection }).connection;
      const all: unknown[][] = [];
      let meta: Meta[] = [];
      let bytes = false;
      await new Promise<void>((resolve, reject) => {
        let done = false;
        let used = 0;
        const finish = (err?: unknown) => {
          if (done) return;
          done = true;
          if (err) reject(err);
          else resolve();
        };
        const query = core.query({ sql: q.sql, rowsAsArray: true, timeout: limits.timeoutMs + 1_000 });
        query.on("fields", (f: Meta[]) => {
          if (!meta.length) meta = f ?? [];
        });
        query.on("result", (row: unknown) => {
          if (done || !Array.isArray(row)) return;
          used += rowChars(row);
          if (used > RESULT_MAX_CHARS) bytes = true;
          else all.push(row);
          if (bytes || all.length > limits.maxRows) {
            // Enough: the rest stays on the server. Dropping the connection is the only way to stop reading.
            finish();
            core.destroy();
          }
        });
        query.on("error", (err: unknown) => finish(err));
        query.on("end", () => finish());
      });
      return {
        fields: meta.map((f) => ({
          name: f.name,
          origin: f.orgTable && f.orgName && f.schema ? { schema: f.schema, table: f.orgTable, column: f.orgName } : null,
          scalar: MYSQL_SCALAR.has(f.columnType ?? f.type ?? -1),
        })),
        rows: all.slice(0, limits.maxRows),
        truncated: bytes || all.length > limits.maxRows,
        ...(bytes ? { cut: "size" as const } : {}),
      };
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
    }
  });
}

/** The callback connection under mysql2's promise wrapper: its queries emit rows one at a time. */
interface CoreConnection {
  query(opts: { sql: string; rowsAsArray: boolean; timeout: number }): NodeJS.EventEmitter;
  destroy(): void;
}
