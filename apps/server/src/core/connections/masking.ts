import type { GuardedSql, Token } from "./sql-guard.js";
import type { RawResult } from "./types.js";

/**
 * Which result columns of query_database to mask, from the data dictionary's personal-data flags.
 *
 * A query "touches personal data" when it names, anywhere (as a word, a quoted name, or inside a string literal such
 * as 'customers'::regclass), a flagged column, a table that has one, or a view that reads one. Then:
 * - a column the database says comes from a flagged column is masked; one that comes from a view over personal data is
 *   masked unless it's a number or boolean; one that comes from any other table column is shown;
 * - a computed column (no origin) is masked whatever its type (ascii(substr(c::text, n, 1)) rebuilds a row from
 *   numbers), except the forms that can't carry a value out: a literal, count(*), count(col), and sum/avg/min/max of a
 *   synced, unflagged column of a table in FROM, in a plain query (one SELECT, no UNION, no function or subquery in
 *   FROM). Without column origins (Redshift), a plain column of such a query is judged by its name the same way.
 *   "Of a table in FROM" matters: in Postgres c.f is f(c) when c's table has no column f, so c.row_to_json is the
 *   whole row even when another table has a column of that name.
 * A column named like a flagged column is always masked. Filters (WHERE) aren't judged: count(*) … WHERE email IS NULL
 * stays readable. Masking hides values; it isn't access control (use a read-only database user without access to what
 * agents shouldn't read).
 */

export interface PiiCatalog {
  /** Flagged columns, "schema.table.column" (lower case). */
  at: Set<string>;
  /** Flagged column names (lower case). */
  names: Set<string>;
  /** Views that read a table with personal data, directly or through other views: "schema.view" (lower case). */
  views: Set<string>;
  /** Bare names of tables with personal data and of those views (lower case). */
  tables: Set<string>;
  /**
   * Synced columns by bare table or view name (lower case). A name synced in several schemas has the columns they all
   * share, since the query may mean any of them.
   */
  columns: Map<string, Set<string>>;
}

/** Bare table names to their columns, keeping only what every schema's table of that name has. */
export function columnsByTable(tables: { name: string; columns: string[] }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const name = lower(t.name);
    const cols = new Set(t.columns.map(lower));
    const had = out.get(name);
    out.set(name, had ? new Set([...had].filter((c) => cols.has(c))) : cols);
  }
  return out;
}

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);
const CLAUSE_END = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "WINDOW", "FETCH", "QUALIFY", "FOR", "INTO", "PROCEDURE"]);
const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);
const JOIN_WORDS = new Set(["ON", "USING", "NATURAL", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "OUTER"]);

const lower = (s: string) => s.toLowerCase();

/** Whether the query names personal data: a flagged column, a table that has one, or a view over one. */
export function touchesPii(g: GuardedSql, pii: PiiCatalog): boolean {
  const said = (n: string) => g.words.has(n) || g.identifiers.has(n) || !!g.literalWords?.has(n);
  if ([...pii.names].some(said) || [...pii.tables].some(said)) return true;
  // BigQuery wildcard tables: `dataset.cust*` reads every table whose name starts with "cust".
  const prefixes = [...g.identifiers].filter((i) => i.endsWith("*")).map((i) => i.slice(i.lastIndexOf(".") + 1, -1));
  return prefixes.some((p) => [...pii.tables].some((t) => t.startsWith(p)));
}

type Item =
  | { kind: "exempt"; names: Set<string> | null }
  | { kind: "column"; col: string; names: Set<string> | null }
  | { kind: "star"; cols: Set<string> }
  | { kind: "other"; names: Set<string> | null };

const isIdent = (t: Token | undefined) => !!t && (t.kind === "word" || t.kind === "quoted_ident");
const isSym = (t: Token | undefined, s: string) => !!t && t.kind === "symbol" && t.text === s;
const isWord = (t: Token | undefined, w: string) => !!t && t.kind === "word" && t.text.toUpperCase() === w;
const textOf = (ts: Token[]) => ts.map((t) => t.sql ?? t.text).join("").trim();

/** a, t.a, s.t.a (the column's name and the table or alias before it), or *, t.* (star). */
function columnRef(ts: Token[]): { col: string; qual: string | null } | { star: true } | null {
  if (ts.length === 1 && isSym(ts[0], "*")) return { star: true };
  if (!ts.length || !isIdent(ts[0])) return null;
  let k = 0;
  for (;;) {
    if (k === ts.length - 1) return { col: lower(ts[k]!.text), qual: k > 0 ? lower(ts[k - 2]!.text) : null };
    if (!isSym(ts[k + 1], ".")) return null;
    if (k + 2 === ts.length - 1 && isSym(ts[k + 2], "*")) return { star: true };
    if (!isIdent(ts[k + 2])) return null;
    k += 2;
  }
}

function literal(ts: Token[]): string | null {
  if (ts.length === 1 && (ts[0]!.kind === "number" || ts[0]!.kind === "string")) return ts[0]!.kind === "string" ? ts[0]!.text.replace(/^'|'$/g, "").replace(/''/g, "'") : ts[0]!.text;
  if (ts.length === 1 && ["TRUE", "FALSE", "NULL"].includes(ts[0]!.text.toUpperCase()) && ts[0]!.kind === "word") return ts[0]!.text;
  if (ts.length === 2 && isSym(ts[0], "-") && ts[1]!.kind === "number") return `-${ts[1]!.text}`;
  return null;
}

/** count(*), count(1), count([DISTINCT] col), sum/avg/min/max([DISTINCT] col), with nothing after (no FILTER, OVER). */
function aggregate(ts: Token[]): { fn: string; ref: { col: string; qual: string | null } | null } | null {
  if (ts.length < 4 || ts[0]!.kind !== "word" || !AGGREGATES.has(lower(ts[0]!.text)) || !isSym(ts[1], "(") || !isSym(ts[ts.length - 1], ")")) return null;
  const fn = lower(ts[0]!.text);
  let arg = ts.slice(2, -1);
  if (isWord(arg[0], "DISTINCT")) arg = arg.slice(1);
  if (fn === "count" && arg.length === 1 && (isSym(arg[0], "*") || arg[0]!.kind === "number")) return { fn, ref: null };
  const ref = columnRef(arg);
  return ref && "col" in ref ? { fn, ref } : null;
}

/**
 * The tables of a plain FROM: every name the query may use for one (its own name, its alias) to its bare name, or
 * null when a name could mean two tables. Also every word naming a table, schema or alias.
 */
interface FromTables {
  refs: Map<string, string | null>;
  words: Set<string>;
}

/** Whether a column reference is a real, synced, unflagged column of a table in FROM (not t.f, which Postgres reads as f(t) when t has no column f). */
function columnOf(ref: { col: string; qual: string | null }, from: FromTables, pii: PiiCatalog): boolean {
  if (pii.names.has(ref.col)) return false;
  if (ref.qual === null) {
    // A bare name is a column or an error, unless it names a table (a whole row).
    if (from.words.has(ref.col)) return false;
    return [...from.refs.values()].some((t) => t !== null && !!pii.columns.get(t)?.has(ref.col));
  }
  const table = from.refs.get(ref.qual);
  return !!table && !!pii.columns.get(table)?.has(ref.col);
}

function classify(ts: Token[], pii: PiiCatalog, from: FromTables): Item {
  const form = (expr: Token[], alias: string | null): Item | null => {
    const names = (...defaults: string[]) => new Set((alias === null ? defaults : [alias]).map(lower));
    const lit = literal(expr);
    if (lit !== null) return { kind: "exempt", names: names("?column?", textOf(expr), lit) };
    const agg = aggregate(expr);
    if (agg) {
      if (agg.fn === "count") return { kind: "exempt", names: names(agg.fn, textOf(expr)) };
      const ref = agg.ref!;
      return columnOf(ref, from, pii) ? { kind: "column", col: ref.col, names: names(agg.fn, textOf(expr)) } : { kind: "other", names: names(agg.fn, textOf(expr)) };
    }
    const ref = columnRef(expr);
    if (ref && "star" in ref) {
      if (alias !== null) return null;
      // The columns * can bring: those of the synced tables in FROM.
      const cols = new Set<string>();
      for (const t of from.refs.values()) for (const c of (t !== null && pii.columns.get(t)) || []) cols.add(c);
      return { kind: "star", cols };
    }
    if (ref) return columnOf(ref, from, pii) ? { kind: "column", col: ref.col, names: names(ref.col) } : { kind: "other", names: names(ref.col) };
    return null;
  };
  const whole = form(ts, null);
  if (whole) return whole;
  const last = ts[ts.length - 1];
  if (ts.length >= 3 && isWord(ts[ts.length - 2], "AS") && isIdent(last)) {
    return form(ts.slice(0, -2), last!.text) ?? { kind: "other", names: new Set([lower(last!.text)]) };
  }
  if (ts.length >= 2 && isIdent(last)) {
    const implicit = form(ts.slice(0, -1), last!.text);
    if (implicit) return implicit;
  }
  return { kind: "other", names: null };
}

/**
 * The select list of a plain query: SELECT [DISTINCT|ALL] items FROM tables, with no set operation at the top level
 * and nothing computed in FROM (no function, subquery or parenthesised join; USING (…) is fine). Null otherwise.
 */
function plainSelect(g: GuardedSql, pii: PiiCatalog): Item[] | null {
  if (g.verb !== "SELECT" || !g.tokens) return null;
  const ts = g.tokens.filter((t) => t.kind !== "space");
  let depth = 0;
  let listEnd = ts.length;
  let fromEnd = ts.length;
  let from = -1;
  for (let k = 1; k < ts.length; k++) {
    const t = ts[k]!;
    if (isSym(t, "(") || isSym(t, "[")) depth++;
    else if (isSym(t, ")") || isSym(t, "]")) depth--;
    if (depth !== 0 || t.kind !== "word") continue;
    const w = t.text.toUpperCase();
    if (SET_OPS.has(w)) return null;
    if (w === "FROM" && from < 0 && listEnd === ts.length) {
      from = k;
      listEnd = k;
    } else if (CLAUSE_END.has(w)) {
      if (from < 0 && listEnd === ts.length) listEnd = k;
      if (from >= 0 && fromEnd === ts.length) fromEnd = k;
    }
  }
  const fromTokens = from >= 0 ? ts.slice(from + 1, fromEnd) : [];
  for (let k = 0; k < fromTokens.length; k++) {
    if (isSym(fromTokens[k], "(") && !isWord(fromTokens[k - 1], "USING")) return null;
    if (isWord(fromTokens[k], "SELECT") || isWord(fromTokens[k], "LATERAL")) return null;
  }
  // The tables and their aliases (not the columns of ON and USING): [schema.]table [[AS] alias], between commas and
  // joins. A "column" called like one of them is a whole row.
  const tables: FromTables = { refs: new Map(), words: new Set() };
  const name = (n: string, table: string) => {
    tables.words.add(n);
    tables.refs.set(n, tables.refs.has(n) && tables.refs.get(n) !== table ? null : table);
  };
  const joinWord = (t: Token | undefined) => !!t && t.kind === "word" && (JOIN_WORDS.has(t.text.toUpperCase()) || ["JOIN", "STRAIGHT_JOIN"].includes(t.text.toUpperCase()));
  let expectRef = true;
  for (let k = 0; k < fromTokens.length; ) {
    const t = fromTokens[k]!;
    if (isSym(t, ",") || isWord(t, "JOIN") || isWord(t, "STRAIGHT_JOIN")) {
      expectRef = true;
      k++;
      continue;
    }
    if (!expectRef || !isIdent(t) || joinWord(t)) {
      if (joinWord(t)) expectRef = false;
      k++;
      continue;
    }
    // A quoted `project.dataset.table` (BigQuery) is one token: its last part is the table.
    let table = lower(t.text);
    for (const part of table.split(".")) tables.words.add(part);
    table = table.slice(table.lastIndexOf(".") + 1);
    tables.words.add(table);
    k++;
    while (isSym(fromTokens[k], ".") && isIdent(fromTokens[k + 1])) {
      table = lower(fromTokens[k + 1]!.text);
      tables.words.add(table);
      k += 2;
    }
    name(table, table);
    if (isWord(fromTokens[k], "AS")) k++;
    if (isIdent(fromTokens[k]) && !joinWord(fromTokens[k])) {
      name(lower(fromTokens[k]!.text), table);
      k++;
    }
    expectRef = false;
  }
  let start = 1;
  if (isWord(ts[1], "DISTINCT") || isWord(ts[1], "ALL")) {
    if (isWord(ts[2], "ON")) return null;
    start = 2;
  }
  const items: Item[] = [];
  let cur: Token[] = [];
  depth = 0;
  for (const t of ts.slice(start, listEnd)) {
    if (isSym(t, "(") || isSym(t, "[")) depth++;
    else if (isSym(t, ")") || isSym(t, "]")) depth--;
    if (depth === 0 && isSym(t, ",")) {
      items.push(classify(cur, pii, tables));
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) items.push(classify(cur, pii, tables));
  return items;
}

/** Which of a result's columns to mask (true) for a query that touches personal data or not. */
export function maskedColumns(fields: RawResult["fields"], g: GuardedSql, pii: PiiCatalog, touches: boolean): boolean[] {
  const items = touches ? plainSelect(g, pii) : null;
  const viewNamed = [...pii.views].some((v) => {
    const name = v.slice(v.indexOf(".") + 1);
    return g.words.has(name) || g.identifiers.has(name) || !!g.literalWords?.has(name);
  });
  return fields.map((f) => {
    const name = lower(f.name);
    if (pii.names.has(name)) return true;
    if (f.origin) {
      if (pii.at.has(lower(`${f.origin.schema}.${f.origin.table}.${f.origin.column}`))) return true;
      return pii.views.has(lower(`${f.origin.schema}.${f.origin.table}`)) && !f.scalar;
    }
    if (!touches) return false;
    if (!items) return true;
    const candidates = items.filter((it) => it.kind === "star" || it.names === null || it.names.has(name));
    if (!candidates.length) return true;
    return !candidates.every((it) => {
      if (it.kind === "exempt") return true;
      if (it.kind === "other") return false;
      // A plain column of a table in FROM (or an aggregate of one): synced, unflagged, and not text from a view over
      // personal data.
      if (it.kind === "star" && !it.cols.has(name)) return false;
      return !!f.scalar || !viewNamed;
    });
  });
}
