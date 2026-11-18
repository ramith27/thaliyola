import { ValidationError } from "../context.js";

/**
 * The SQL guard for query_database: one read-only statement. The text is tokenised (quotes, identifiers, dollar
 * quoting and comments are understood), comments are removed (MySQL runs the inside of a "/*! … *\/" comment, so the
 * database only ever gets the stripped text), and the statement must be a SELECT, WITH, SHOW, DESCRIBE or EXPLAIN with
 * no second statement, no writing keyword and none of the functions that reach outside the database.
 *
 * This is one layer: the query also runs in a read-only transaction, with a timeout and a row cap, and the connection
 * should use a read-only database user.
 */

export type Dialect = "postgres" | "mysql" | "clickhouse" | "snowflake" | "bigquery";

export interface GuardedSql {
  /** What to run: the statement without comments or a trailing semicolon. */
  sql: string;
  /** The first keyword, upper case (SELECT, WITH, SHOW, DESCRIBE, DESC, EXPLAIN). */
  verb: string;
  /** Words outside quotes and literals, lower case (identifiers as written, unquoted ones too). */
  words: Set<string>;
  /** Quoted identifiers ("col", `col`), lower case: they name columns as much as plain words do. */
  identifiers: Set<string>;
  /** Words inside string literals, lower case: 'customers'::regclass names a table without a plain word. */
  literalWords?: Set<string>;
  /** The tokens of `sql` (comments gone, runs of space as one), for the masking rules. */
  tokens?: Token[];
}

const VERBS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);

/**
 * Keywords that write or leave the database. Only words that can appear inside a SELECT: statement-level ones (SET,
 * BEGIN, CALL…) can't, because the statement must start with a read verb and there is only one; blocking them would
 * also block ordinary column names like "start" or "release".
 */
const BLOCKED_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "DROP", "ALTER", "CREATE", "TRUNCATE", "GRANT", "REVOKE", "COPY",
  "INTO", "OUTFILE", "DUMPFILE", "VACUUM", "PREPARE", "EXECUTE", "DEALLOCATE", "HANDLER",
]);

/**
 * Functions that read server files, talk to other servers, run SQL from a string, dump whole tables, change settings
 * or server state, or stop other sessions. A read-only transaction stops most writes, not these.
 */
const BLOCKED_FUNCTIONS = new Set([
  // Postgres and Redshift
  "pg_read_file", "pg_read_binary_file", "pg_stat_file", "dblink", "set_config", "pg_terminate_backend",
  "pg_cancel_backend", "pg_signal_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_promote", "pg_switch_wal",
  "pg_switch_xlog", "pg_create_restore_point", "pg_notify", "ts_stat", "ts_rewrite", "pg_import_system_collations",
  "txid_current", "pg_current_xact_id", "nextval", "setval", "loread", "lowrite", "pg_start_backup",
  "pg_stop_backup", "pg_backup_start", "pg_backup_stop", "pg_drop_replication_slot", "pg_replication_slot_advance",
  "pg_log_backend_memory_contexts", "pg_wal_replay_pause", "pg_wal_replay_resume", "pg_xlog_replay_pause",
  "pg_xlog_replay_resume", "brin_summarize_new_values", "brin_summarize_range",
  "brin_desummarize_range", "gin_clean_pending_list", "pg_prewarm", "pg_stat_statements_reset",
  "pg_truncate_visibility_map", "pg_relation_check_pages", "lo_compat_privileges",
  // MySQL
  "load_file", "sys_exec", "sys_eval", "get_lock", "release_lock", "release_all_locks", "benchmark", "master_pos_wait",
  "source_pos_wait", "uuid_short", "wait_for_executed_gtid_set", "wait_until_sql_thread_after_gtids",
]);

/** Families of such functions, by prefix: every pg_ls_*, lo_*, dblink*, *_to_xml* and so on. */
const BLOCKED_PREFIXES = [
  "pg_ls_", "pg_read_", "pg_file_", "lo_", "dblink", "pg_advisory_", "pg_try_advisory_", "pg_stat_reset",
  "pg_create_", "pg_copy_", "pg_replication_origin_", "pg_logical_", "query_to_xml", "cursor_to_xml", "table_to_xml",
  "schema_to_xml", "database_to_xml", "pg_terminate_", "pg_cancel_", "pg_reload_", "pg_stat_clear_", "xact_commit",
];

/**
 * Per dialect: table functions and functions that reach other servers, files or the cloud (ClickHouse url(), s3(),
 * remote(); BigQuery EXTERNAL_QUERY), control the warehouse (Snowflake SYSTEM$…), or read other queries' results.
 */
const DIALECT_FUNCTIONS: Partial<Record<Dialect, { names: Set<string>; prefixes: string[] }>> = {
  clickhouse: {
    names: new Set([
      "url", "urlcluster", "s3", "s3cluster", "gcs", "cos", "oss", "remote", "remotesecure", "cluster", "clusterallreplicas",
      "file", "filecluster", "hdfs", "hdfscluster", "mysql", "postgresql", "jdbc", "odbc", "mongodb", "redis", "sqlite",
      "executable", "input", "hive",
      // merge(db, 'regex') reads every table whose name matches, and loop(), mergeTree*() and timeSeries*() take a
      // table's name as an expression: none has to write the name out. hasColumnInTable() can also reach other hosts.
      "merge", "loop", "hascolumnintable",
    ]),
    prefixes: [
      "azureblobstorage", "iceberg", "deltalake", "hudi", "s3", "hdfs", "remote", "arrowflight", "ytsaurus", "paimon", "postgresql", "mysql", "executable",
      "mergetree", "timeseries", "prometheus",
    ],
  },
  snowflake: {
    names: new Set(["result_scan", "get_presigned_url", "build_scoped_file_url", "build_stage_file_url", "get_stage_location", "infer_schema", "validate", "external_table_files", "system_function",
      // identifier('cust' || 'omers') names a table without writing its name out.
      "identifier"]),
    prefixes: ["system$"],
  },
  bigquery: {
    names: new Set(["external_query", "external_object_transform"]),
    prefixes: [],
  },
};

export function blockedFunction(name: string, dialect?: Dialect): boolean {
  const n = name.toLowerCase();
  if (BLOCKED_FUNCTIONS.has(n) || BLOCKED_PREFIXES.some((p) => n.startsWith(p))) return true;
  const d = dialect ? DIALECT_FUNCTIONS[dialect] : undefined;
  return !!d && (d.names.has(n) || d.prefixes.some((p) => n.startsWith(p)));
}

/**
 * ClickHouse functions whose first argument names a dictionary or a Join table (dictionary(), dictGet*(), dictHas(),
 * joinGet*()…). The server folds a constant expression there, so concat('cust', 'omers') would name a table without
 * writing it out: the name must be written as one string or name.
 */
const CH_NAMED_BY_ARGUMENT = ["dict", "joinget"];

/**
 * Views of other people's queries: their text can quote personal data, and the queries run as the connection's one
 * user. Per dialect, as a name part, or a part after another (INFORMATION_SCHEMA.JOBS…, system.processes).
 */
const QUERY_HISTORY: Partial<Record<Dialect, { anywhere: string[]; prefixes: string[]; after: [string, string[]][] }>> = {
  clickhouse: {
    anywhere: ["query_log", "query_thread_log", "query_views_log", "processors_profile_log", "asynchronous_insert_log", "session_log", "text_log", "query_metric_log"],
    prefixes: [],
    after: [["system", ["processes", "query_cache", "query_log", "part_log", "opentelemetry_span_log"]]],
  },
  snowflake: { anywhere: [], prefixes: ["query_history"], after: [] },
  bigquery: { anywhere: [], prefixes: [], after: [["information_schema", ["jobs"]]] },
};

/** Dotted names in the statement (a.b.c), as lower-case parts; a quoted name with dots in it is split too. */
function dottedNames(body: Token[]): string[][] {
  const ts = body.filter((t) => t.kind !== "space");
  const out: string[][] = [];
  for (let k = 0; k < ts.length; k++) {
    if (ts[k]!.kind !== "word" && ts[k]!.kind !== "quoted_ident") continue;
    const parts: string[] = [];
    let n = k;
    for (;;) {
      parts.push(...ts[n]!.text.toLowerCase().split("."));
      if (ts[n + 1]?.kind === "symbol" && ts[n + 1]!.text === "." && (ts[n + 2]?.kind === "word" || ts[n + 2]?.kind === "quoted_ident")) n += 2;
      else break;
    }
    out.push(parts);
    k = n;
  }
  return out;
}

/** Dialects where a quoted name can hold escapes (a backslash), which this guard doesn't read the way the server does. */
const ESCAPING_IDENTIFIERS: Dialect[] = ["clickhouse", "bigquery", "snowflake"];
/** Dialects where "…" is a string, not a name. */
const DOUBLE_QUOTED_STRINGS: Dialect[] = ["mysql", "bigquery"];
/** Dialects with # comments, and // comments. */
const HASH_COMMENTS: Dialect[] = ["mysql", "clickhouse", "bigquery"];

export interface Token {
  kind: "word" | "quoted_ident" | "string" | "number" | "symbol" | "space";
  /** The token; a quoted name without its quotes. */
  text: string;
  /** As it's sent to the database (a quoted name with its quotes). */
  sql?: string;
}

function fail(message: string): never {
  throw new ValidationError(`query_database runs one read-only statement: ${message}`);
}

/** Splits SQL into tokens, dropping comments. Unterminated quotes or comments are refused. */
export function tokenize(input: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  const s = input;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    // Comments: -- to the end of the line, # (MySQL, ClickHouse, BigQuery) to the end of the line, /* … */ (nested in
    // Postgres and ClickHouse).
    if ((c === "-" && next === "-") || (c === "#" && HASH_COMMENTS.includes(dialect)) || (c === "/" && next === "/" && dialect === "snowflake")) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end + 1;
      out.push({ kind: "space", text: " " });
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "*" && s[j + 1] === "/") {
          depth--;
          j += 2;
        } else if ((dialect === "postgres" || dialect === "clickhouse") && s[j] === "/" && s[j + 1] === "*") {
          depth++;
          j += 2;
        } else j++;
      }
      if (depth > 0) fail("a comment isn't closed");
      i = j;
      out.push({ kind: "space", text: " " });
      continue;
    }
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      out.push({ kind: "space", text: " " });
      i = j;
      continue;
    }
    // String literals: '…' with '' for a quote. Whether a backslash escapes the next character depends on server
    // settings (MySQL's NO_BACKSLASH_ESCAPES, Postgres' standard_conforming_strings, Redshift), so where a string ends
    // could differ between this check and the database: backslashes in strings are refused.
    if (c === "'" || (c === '"' && DOUBLE_QUOTED_STRINGS.includes(dialect))) {
      const quote = c;
      let j = i + 1;
      for (;;) {
        if (j >= s.length) fail("a quoted string isn't closed");
        if (s[j] === "\\") fail("backslashes inside quoted strings aren't allowed (their meaning depends on server settings)");
        if (s[j] === quote) {
          if (s[j + 1] === quote) {
            // BigQuery has no doubled-quote escape: there two quotes are an empty string, and three start a
            // triple-quoted one, so where the string ends would differ.
            if (dialect === "bigquery") fail("BigQuery strings can't hold a doubled quote, and triple-quoted strings aren't allowed: use the other quote character");
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: "string", text: s.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // Dollar quoting (Postgres): $$…$$ or $tag$…$tag$, where a tag is anything Postgres takes as an identifier (letters
    // beyond ASCII too: $é$). Any other "$" (a $1 parameter, or something read differently) is refused: where a
    // string starts and ends must be the same here and on the server.
    if (c === "$" && dialect === "postgres") {
      const m = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(s.slice(i, i + 200));
      if (!m) fail("a $ outside a dollar-quoted string isn't allowed (no $1 parameters either)");
      const tag = m[0];
      const end = s.indexOf(tag, i + tag.length);
      if (end < 0) fail("a dollar-quoted string isn't closed");
      out.push({ kind: "string", text: s.slice(i, end + tag.length) });
      i = end + tag.length;
      continue;
    }
    // Snowflake: $$…$$ strings only. ClickHouse: no $ at all (its $tag$ heredocs would be read differently here).
    if (c === "$" && dialect === "snowflake") {
      if (next !== "$") fail("a $ outside a $$-quoted string isn't allowed (no $1 or $variables either)");
      const end = s.indexOf("$$", i + 2);
      if (end < 0) fail("a $$-quoted string isn't closed");
      out.push({ kind: "string", text: s.slice(i, end + 2) });
      i = end + 2;
      continue;
    }
    if (c === "$" && dialect === "clickhouse") fail("a $ outside a quoted string isn't allowed");
    // Snowflake stages (@stage, @~) are files, not tables; BigQuery @parameters aren't sent.
    if (c === "@" && (dialect === "snowflake" || dialect === "bigquery")) fail(dialect === "snowflake" ? "reading stages (@stage) isn't allowed" : "@parameters and @@variables aren't allowed");
    // Unicode escapes (Postgres U&'…' and U&"…"): they spell a name or string without writing it out.
    if ((c === "u" || c === "U") && next === "&" && dialect === "postgres" && (s[i + 2] === "'" || s[i + 2] === '"')) {
      fail("Unicode escapes (U&'…', U&\"…\") aren't allowed: write the name or text out");
    }
    // Quoted identifiers: "…" (Postgres, ClickHouse, Snowflake) and `…` (MySQL, ClickHouse, BigQuery).
    if ((c === '"' && !DOUBLE_QUOTED_STRINGS.includes(dialect)) || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) fail("a quoted name isn't closed");
        if (s[j] === "\\" && ESCAPING_IDENTIFIERS.includes(dialect)) fail("backslashes inside quoted names aren't allowed");
        if (s[j] === c) {
          if (s[j + 1] === c) {
            // BigQuery reads `a``b` as two names, not one with a backtick in it.
            if (dialect === "bigquery") fail("a quoted name can't hold a doubled backtick");
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ kind: "quoted_ident", text: s.slice(i + 1, j).split(c + c).join(c) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_$\u0080-￿]/.test(s[j]!)) j++;
      out.push({ kind: "word", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE_]/.test(s[j]!)) j++;
      out.push({ kind: "number", text: s.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ kind: "symbol", text: c });
    i++;
  }
  return out;
}

/** Checks a query and returns what to run. Throws a ValidationError saying what isn't allowed. */
export function guardSql(input: string, dialect: Dialect): GuardedSql {
  if (typeof input !== "string" || !input.trim()) fail("the query is empty");
  if (input.length > 20_000) fail("the query is longer than 20,000 characters");
  if (input.includes("\u0000")) fail("the query contains a NUL character");
  const tokens = tokenize(input, dialect);
  // One statement: a semicolon may only end it.
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.kind === "space") last--;
  if (last >= 0 && tokens[last]!.kind === "symbol" && tokens[last]!.text === ";") last--;
  const body = tokens.slice(0, last + 1);
  if (body.some((t) => t.kind === "symbol" && t.text === ";")) fail("send one statement at a time (no semicolons inside)");
  // Balanced parentheses: the driver may wrap the statement (SELECT … FROM (<statement>) t), and an unbalanced one
  // could reshape that wrapper.
  let depth = 0;
  for (const t of body) {
    if (t.kind !== "symbol") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")" && --depth < 0) fail("a closing parenthesis has no opening one");
  }
  if (depth !== 0) fail("a parenthesis isn't closed");
  // MySQL "\G" and psql meta-commands aren't SQL.
  if (body.some((t) => t.kind === "symbol" && t.text === "\\")) fail("backslash commands aren't SQL");
  const words = body.filter((t) => t.kind === "word");
  const verb = words[0]?.text.toUpperCase() ?? "";
  if (!VERBS.has(verb) || body.find((t) => t.kind !== "space") !== words[0]) fail("it must start with SELECT, WITH, SHOW, DESCRIBE or EXPLAIN");
  for (const w of words) {
    const upper = w.text.toUpperCase();
    if (BLOCKED_WORDS.has(upper)) fail(`${upper} isn't allowed`);
    if (upper === "UESCAPE") fail("Unicode escapes (UESCAPE) aren't allowed");
    // ClickHouse: a query's own SETTINGS could lift the limits (and readonly, where the server allows it).
    if (upper === "SETTINGS" && dialect === "clickhouse") fail("SETTINGS isn't allowed: the server's limits apply");
  }
  for (let k = 0; k < body.length; k++) {
    const t = body[k]!;
    if (t.kind !== "word" && t.kind !== "quoted_ident") continue;
    let n = k + 1;
    while (body[n]?.kind === "space") n++;
    if (body[n]?.kind === "symbol" && body[n]!.text === "(" && blockedFunction(t.text, dialect)) fail(`the function ${t.text.toLowerCase()}() isn't allowed`);
  }
  // ClickHouse: dictionary('name'), dictGet('name', …), joinGet('name', …): the name written out, as one string or name.
  if (dialect === "clickhouse") {
    const ts = body.filter((t) => t.kind !== "space");
    for (let k = 0; k < ts.length - 1; k++) {
      const name = ts[k]!.text.toLowerCase();
      if (!((ts[k]!.kind === "word" || ts[k]!.kind === "quoted_ident") && CH_NAMED_BY_ARGUMENT.some((p) => name.startsWith(p)))) continue;
      if (!(ts[k + 1]!.kind === "symbol" && ts[k + 1]!.text === "(")) continue;
      let n = k + 2;
      if (ts[n]?.kind === "string") n++;
      else {
        if (!(ts[n]?.kind === "word" || ts[n]?.kind === "quoted_ident")) n = -1;
        else {
          n++;
          while (ts[n]?.kind === "symbol" && ts[n]!.text === "." && (ts[n + 1]?.kind === "word" || ts[n + 1]?.kind === "quoted_ident")) n += 2;
        }
      }
      const end = n >= 0 ? ts[n] : undefined;
      const fn = ts[k]!.text;
      if (!(end?.kind === "symbol" && (end.text === "," || end.text === ")"))) fail(`${fn}() must name its dictionary or table as one string, like ${fn}('db.name'${name === "dictionary" ? "" : ", …"})`);
    }
  }
  // Other people's queries (query history views).
  const history = QUERY_HISTORY[dialect];
  if (history) {
    for (const parts of dottedNames(body)) {
      const hit = parts.some(
        (p, i) =>
          history.anywhere.includes(p) ||
          history.prefixes.some((x) => p.startsWith(x)) ||
          history.after.some(([before, names]) => i > 0 && parts[i - 1] === before && names.some((x) => (dialect === "bigquery" ? p.startsWith(x) : p === x))),
      );
      if (hit) fail("query history isn't allowed: it shows other people's queries, whose text can quote personal data");
    }
  }
  // Snowflake: TABLE('name') is a table named by an expression; TABLE(…) may only wrap a table function, TABLE(f(…)).
  if (dialect === "snowflake") {
    const ts = body.filter((t) => t.kind !== "space");
    for (let k = 0; k < ts.length - 1; k++) {
      if (!(ts[k]!.kind === "word" && ts[k]!.text.toUpperCase() === "TABLE" && ts[k + 1]!.kind === "symbol" && ts[k + 1]!.text === "(")) continue;
      let n = k + 2;
      while ((ts[n]?.kind === "word" || ts[n]?.kind === "quoted_ident") && ts[n + 1]?.kind === "symbol" && ts[n + 1]!.text === ".") n += 2;
      if (!(ts[n]?.kind === "word" || ts[n]?.kind === "quoted_ident") || !(ts[n + 1]?.kind === "symbol" && ts[n + 1]!.text === "(")) fail("TABLE(…) may only wrap a table function here: name tables directly");
    }
  }
  // Row locks (FOR UPDATE is caught by UPDATE above; FOR SHARE / FOR KEY SHARE / LOCK IN SHARE MODE here).
  for (let k = 0; k < words.length - 1; k++) {
    const [a, b] = [words[k]!.text.toUpperCase(), words[k + 1]!.text.toUpperCase()];
    if ((a === "FOR" && ["SHARE", "KEY", "NO"].includes(b)) || (a === "LOCK" && b === "IN")) fail("row locks (FOR SHARE) aren't allowed");
  }
  // EXPLAIN ANALYZE runs the statement it explains; only of a SELECT or WITH.
  if (verb === "EXPLAIN") {
    const inner = words.slice(1).find((w) => !["ANALYZE", "ANALYSE", "VERBOSE", "FORMAT", "COSTS", "BUFFERS", "TIMING", "SUMMARY", "SETTINGS", "WAL", "TEXT", "JSON", "TREE", "YAML", "XML", "TRUE", "FALSE", "ON", "OFF", "AST", "SYNTAX", "PLAN", "PIPELINE", "ESTIMATE", "QUERY", "TREE", "HEADER", "ACTIONS", "INDEXES", "DESCRIPTION", "GRAPH", "COMPACT", "USING", "TABULAR"].includes(w.text.toUpperCase()));
    if (inner && !["SELECT", "WITH", "TABLE", "VALUES"].includes(inner.text.toUpperCase())) fail("EXPLAIN only explains a SELECT");
  }
  let from = 0;
  let to = body.length;
  while (from < to && body[from]!.kind === "space") from++;
  while (to > from && body[to - 1]!.kind === "space") to--;
  const parts = body
    .slice(from, to)
    .filter((t, k, all) => !(t.kind === "space" && all[k - 1]?.kind === "space"))
    .map((t) => (t.kind === "quoted_ident" ? { ...t, sql: dialect === "mysql" || dialect === "bigquery" ? `\`${t.text.split("`").join("``")}\`` : `"${t.text.split('"').join('""')}"` } : { ...t, sql: t.text }));
  const sql = parts.map((t) => t.sql).join("");
  const literalWords = new Set<string>();
  for (const t of body) {
    if (t.kind !== "string") continue;
    for (const w of t.text.toLowerCase().split(/[^a-z0-9_$\u0080-\uffff]+/)) if (w) literalWords.add(w);
  }
  return {
    sql,
    verb,
    words: new Set(words.map((w) => w.text.toLowerCase())),
    // A BigQuery name like `project.dataset.table` is one quoted name: each part names something too.
    identifiers: new Set(body.filter((t) => t.kind === "quoted_ident").flatMap((t) => [t.text.toLowerCase(), ...(t.text.includes(".") ? t.text.toLowerCase().split(".") : [])])),
    literalWords,
    tokens: parts.map((t) => ({ kind: t.kind, text: t.text, sql: t.sql })),
  };
}
