import { describe, expect, it } from "vitest";
import { cellValue, MASK } from "../src/core/connections/query.js";
import {
  currentSyncedBlock,
  definitionHash,
  describeChange,
  diffTable,
  newTableBody,
  renderSyncedBlock,
  replaceSyncedBlock,
  schemaWanted,
  SYNC_END,
  SYNC_START,
  type TableDef,
} from "../src/core/connections/schema.js";
import { columnsByTable, maskedColumns, touchesPii, type PiiCatalog } from "../src/core/connections/masking.js";
import { guardSql } from "../src/core/connections/sql-guard.js";
import type { RawResult } from "../src/core/connections/types.js";

describe("the SQL guard", () => {
  const ok = (sql: string, dialect: "postgres" | "mysql" = "postgres") => guardSql(sql, dialect);
  const no = (sql: string, dialect: "postgres" | "mysql" = "postgres") => () => guardSql(sql, dialect);

  it("allows one read statement and strips comments from what runs", () => {
    expect(ok("SELECT 1").sql).toBe("SELECT 1");
    expect(ok("  select id from orders limit 5;  ").sql).toBe("select id from orders limit 5");
    expect(ok("WITH x AS (SELECT 1 AS n) SELECT * FROM x").verb).toBe("WITH");
    expect(ok("SHOW search_path").verb).toBe("SHOW");
    expect(ok("DESCRIBE orders", "mysql").verb).toBe("DESCRIBE");
    expect(ok("EXPLAIN SELECT * FROM orders").verb).toBe("EXPLAIN");
    expect(ok("EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1").verb).toBe("EXPLAIN");
    expect(ok("-- why\nSELECT /* the total */ sum(total) FROM orders").sql).toBe("SELECT sum(total) FROM orders");
    // Words inside strings and quoted names don't count.
    expect(ok("SELECT 'DELETE FROM x; DROP TABLE y' AS t").sql).toContain("DROP TABLE y");
    expect(ok('SELECT "update", "delete" FROM t').identifiers).toEqual(new Set(["update", "delete"]));
    expect(ok("SELECT `insert` FROM t", "mysql").identifiers).toEqual(new Set(["insert"]));
    expect(ok("SELECT $$; DELETE$$ AS s").sql).toBe("SELECT $$; DELETE$$ AS s");
    expect(ok("SELECT 'it''s'").sql).toBe("SELECT 'it''s'");
    // Ordinary column names that are also statement words elsewhere.
    expect(ok("SELECT start, release, \"set\", load FROM jobs").words.has("start")).toBe(true);
  });

  it("refuses anything that isn't one read statement", () => {
    expect(no("")).toThrow(/empty/);
    expect(no("DELETE FROM orders")).toThrow(/must start with SELECT/);
    expect(no("UPDATE orders SET total = 0")).toThrow(/must start with SELECT/);
    expect(no("SELECT 1; SELECT 2")).toThrow(/one statement/);
    expect(no("SELECT 1; DROP TABLE orders")).toThrow(/one statement/);
    expect(no("SELECT 1 -- ok\n; DELETE FROM x")).toThrow(/one statement/);
    expect(no("/* hidden */ DELETE FROM orders")).toThrow(/must start/);
    expect(no("WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d")).toThrow(/DELETE isn't allowed/);
    expect(no("SELECT * INTO backup FROM orders")).toThrow(/INTO isn't allowed/);
    expect(no("SELECT * FROM orders INTO OUTFILE '/tmp/x'", "mysql")).toThrow(/INTO isn't allowed/);
    expect(no("SELECT * FROM orders FOR UPDATE")).toThrow(/UPDATE isn't allowed/);
    expect(no("SELECT * FROM orders FOR SHARE")).toThrow(/row locks/);
    expect(no("SELECT * FROM orders LOCK IN SHARE MODE", "mysql")).toThrow(/row locks/);
    expect(no("EXPLAIN ANALYZE DELETE FROM orders")).toThrow(/DELETE isn't allowed/);
    expect(no("EXPLAIN ANALYZE INSERT INTO t VALUES (1)")).toThrow(/INSERT isn't allowed/);
    expect(no("SELECT pg_read_file('/etc/passwd')")).toThrow(/pg_read_file\(\) isn't allowed/);
    expect(no("SELECT dblink_exec('host=x', 'drop table y')")).toThrow(/dblink_exec/);
    expect(no("SELECT set_config('transaction_read_only', 'off', true)")).toThrow(/set_config/);
    expect(no("SELECT pg_terminate_backend(123)")).toThrow(/pg_terminate_backend/);
    expect(no("SELECT LOAD_FILE('/etc/passwd')", "mysql")).toThrow(/load_file/);
    expect(no('SELECT "pg_read_file"(\'x\')')).toThrow(/pg_read_file/);
    // MySQL runs the inside of /*! … */: it's a comment here, so the database never sees it (and the rest must pass).
    expect(ok("SELECT 1 /*! , SLEEP(10) */", "mysql").sql).toBe("SELECT 1");
    expect(no("SELECT 1 /*! ; DELETE FROM x */ ; DELETE FROM y", "mysql")).toThrow(/one statement/);
    // Quotes and comments must be closed; a backslash in a string could end it differently on the server.
    expect(no("SELECT 'abc")).toThrow(/isn't closed/);
    expect(no("SELECT 1 /* open")).toThrow(/isn't closed/);
    expect(no("SELECT 'a\\'; DELETE FROM x; --'", "mysql")).toThrow(/backslashes/);
    expect(no("SELECT 'a\\'' , 1 --'")).toThrow(/backslashes/);
    expect(no("SELECT 1 \\g")).toThrow(/backslash/);
    expect(no("SELECT 1\u0000")).toThrow(/NUL/);
    expect(no(`SELECT ${"x".repeat(20_001)}`)).toThrow(/20,000/);
    // Nested comments (Postgres) are understood, so nothing hides after an inner close.
    expect(ok("SELECT /* a /* b */ c */ 1").sql).toBe("SELECT 1");
    expect(no("SELECT /* a /* b */ 1; DELETE */ 2; DELETE FROM x")).toThrow(/one statement/);
  });
});

describe("the SQL guard against disguised SQL", () => {
  const ok = (sql: string, dialect: "postgres" | "mysql" = "postgres") => guardSql(sql, dialect);
  const no = (sql: string, dialect: "postgres" | "mysql" = "postgres") => () => guardSql(sql, dialect);

  it("reads dollar quotes the way Postgres does, tags beyond ASCII included", () => {
    expect(no("SELECT $é$'$é$ AS a; COMMIT; CREATE TABLE x (i int); SELECT $é$'$é$ AS b")).toThrow(/one statement/);
    expect(no("SELECT $é$'$é$ AS a, pg_ls_dir($$.$$) AS b, $é$'$é$ AS c")).toThrow(/pg_ls_dir/);
    expect(no("SELECT $日本$ x $日本$; DELETE FROM t")).toThrow(/one statement/);
    expect(ok("SELECT $é$it's$é$ AS s").sql).toBe("SELECT $é$it's$é$ AS s");
    expect(ok("SELECT $_t1$a$_t1$").sql).toBe("SELECT $_t1$a$_t1$");
    // Any other $ is refused: parameters, and anything the server could read differently.
    expect(no("SELECT $1")).toThrow(/\$ outside/);
    expect(no("SELECT $ 1")).toThrow(/\$ outside/);
    expect(no("SELECT $é")).toThrow(/\$ outside/);
    // Inside a name, $ is a letter (Postgres and MySQL).
    expect(ok("SELECT a$b FROM t").words.has("a$b")).toBe(true);
    expect(ok("SELECT $1", "mysql").sql).toBe("SELECT $1");
  });

  it("refuses Unicode escapes, which spell names without writing them", () => {
    expect(no(`SELECT U&"pg_read_fil\\0065"('/etc/hosts') AS f`)).toThrow(/Unicode escapes/);
    expect(no(`SELECT lower(U&"\\0065mail") AS x FROM U&"\\0063ustomers"`)).toThrow(/Unicode escapes/);
    expect(no("SELECT u&'d\\0061t\\+000061'")).toThrow(/Unicode escapes/);
    expect(no(`SELECT U&"d!0061t" UESCAPE '!' FROM t`)).toThrow(/Unicode escapes/);
    // A & between a column and a name is just an operator.
    expect(ok('SELECT u & "flags" FROM t').sql).toBe('SELECT u & "flags" FROM t');
  });

  it("refuses functions that run SQL from text, dump tables or change server state", () => {
    for (const f of [
      "ts_rewrite('a'::tsquery, 'SELECT 1')",
      "ts_stat('SELECT 1')",
      "table_to_xml('customers', true, false, '')",
      "table_to_xmlschema('customers', true, false, '')",
      "table_to_xml_and_xmlschema('customers', true, false, '')",
      "schema_to_xml('public', true, false, '')",
      "schema_to_xmlschema('public', true, false, '')",
      "database_to_xml(true, false, '')",
      "database_to_xml_and_xmlschema(true, false, '')",
      "cursor_to_xmlschema('c', true, false, '')",
      "query_to_xml('SELECT 1', true, false, '')",
      "pg_create_physical_replication_slot('x', true)",
      "pg_create_logical_replication_slot('x', 'pgoutput')",
      "pg_drop_replication_slot('x')",
      "pg_replication_origin_create('x')",
      "lo_creat(-1)",
      "lo_create(0)",
      "pg_stat_reset()",
      "pg_stat_reset_shared('bgwriter')",
      "pg_ls_waldir()",
      "pg_ls_archive_statusdir()",
      "pg_ls_logicalsnapdir()",
      "dblink_open('c', 'SELECT 1')",
      "dblink_fetch('c', 1)",
      "pg_catalog.pg_read_file('/etc/hosts')",
    ]) {
      expect(no(`SELECT ${f}`), f).toThrow(/isn't allowed/);
    }
    // Ordinary functions and columns that merely start alike are fine.
    expect(ok("SELECT lower(name), log(2, 8), pg_size_pretty(1024), ts_rank(v, q) FROM t").verb).toBe("SELECT");
  });

  it("refuses unbalanced parentheses, which could reshape the driver's wrapper", () => {
    expect(no("SELECT 1) t, (SELECT 2")).toThrow(/no opening one/);
    expect(no("SELECT (1")).toThrow(/isn't closed/);
    expect(ok("SELECT ((1)), ')(' AS p").sql).toBe("SELECT ((1)), ')(' AS p");
  });

  it("collects the words of string literals, so a table named in one is still named", () => {
    const g = ok("SELECT 'public.Customers'::regclass::oid AS o");
    expect(g.literalWords).toEqual(new Set(["public", "customers"]));
    expect(g.words.has("customers")).toBe(false);
  });
});

describe("masking personal data in results", () => {
  const pii: PiiCatalog = {
    at: new Set(["public.customers.email", "public.customers.name"]),
    names: new Set(["email", "name"]),
    views: new Set(["public.contacts"]),
    tables: new Set(["customers", "contacts"]),
    columns: columnsByTable([
      { name: "customers", columns: ["id", "email", "name", "venue", "status"] },
      { name: "orders", columns: ["id", "total", "status"] },
      { name: "contacts", columns: ["id", "venue", "addr"] },
      { name: "notes", columns: ["id", "row_to_json"] },
      { name: "Notes", columns: ["ID", "Row_To_Json", "extra"] },
    ]),
  };
  type F = RawResult["fields"][number];
  const computed = (name: string, scalar = false): F => ({ name, origin: null, scalar });
  const col = (name: string, table: string, column = name, scalar = false): F => ({ name, origin: { schema: "public", table, column }, scalar });
  const mask = (sql: string, fields: F[], dialect: "postgres" | "mysql" = "postgres") => {
    const g = guardSql(sql, dialect);
    return maskedColumns(fields, g, pii, touchesPii(g, pii));
  };

  it("tells which queries touch personal data, string literals and views included", () => {
    const t = (sql: string) => touchesPii(guardSql(sql, "postgres"), pii);
    expect(t("SELECT count(*) FROM orders")).toBe(false);
    expect(t("SELECT * FROM customers")).toBe(true);
    expect(t('SELECT * FROM "Customers"')).toBe(true);
    expect(t("SELECT 'customers'::regclass")).toBe(true);
    expect(t("SELECT id FROM orders WHERE email IS NULL")).toBe(true);
    expect(t("SELECT * FROM contacts")).toBe(true);
  });

  it("masks every computed column of such a query, numbers too", () => {
    expect(mask("SELECT ascii(substr(c::text, n, 1)) AS code FROM customers c, generate_series(1, 30) n WHERE c.id = 1 ORDER BY n", [computed("code", true)])).toEqual([true]);
    expect(mask("SELECT length(email) AS n FROM customers", [computed("n", true)])).toEqual([true]);
    expect(mask("SELECT email = 'a@b.c' AS hit FROM customers", [computed("hit", true)])).toEqual([true]);
    expect(mask("SELECT count(*) OVER () AS n FROM customers", [computed("n", true)])).toEqual([true]);
    expect(mask("SELECT sum(ascii(name)) AS s FROM customers", [computed("s", true)])).toEqual([true]);
    // An unnamed expression could be called anything: it takes every computed column with it.
    expect(mask("SELECT count(*), ascii(name) FROM customers", [computed("count", true), computed("ascii", true)])).toEqual([true, true]);
    // A FROM that computes rows (a function, a subquery) or a set operation: no exceptions at all.
    expect(mask("SELECT sum(n) AS s FROM customers c, generate_series(0, 255) n WHERE ascii(c.name) = n", [computed("s", true)])).toEqual([true]);
    expect(mask("SELECT count(*) AS n FROM (SELECT ascii(name) AS n FROM customers) t", [computed("n", true)])).toEqual([true]);
    expect(mask("SELECT count(*) AS n FROM orders UNION ALL SELECT ascii(name) FROM customers", [computed("n", true)])).toEqual([true]);
    expect(mask("SELECT count(*) AS n FROM customers c LEFT JOIN orders o ON (o.id = c.id)", [computed("n", true)])).toEqual([true]);
  });

  it("leaves literals, counts and sums of other columns readable, whatever the filter mentions", () => {
    expect(mask("SELECT count(*) FROM customers WHERE email IS NULL", [computed("count", true)])).toEqual([false]);
    expect(mask("SELECT 1 FROM customers WHERE name = 'Ann'", [computed("?column?", true)])).toEqual([false]);
    expect(mask("SELECT count(DISTINCT email) AS n, max(id) AS top, sum(total) total FROM customers JOIN orders USING (id)", [computed("n", true), computed("top", true), computed("total", true)])).toEqual([false, false, false]);
    expect(mask("SELECT COUNT(*) FROM customers", [computed("COUNT(*)", true)], "mysql")).toEqual([false]);
    // Not of personal data, nor of something that isn't a synced column.
    expect(mask("SELECT max(email) AS m, max(c) AS r FROM customers c", [computed("m"), computed("r")])).toEqual([true, true]);
    // Columns with an origin are judged by it.
    expect(mask("SELECT id, email AS e, status FROM customers", [col("id", "customers", "id", true), col("e", "customers", "email"), col("status", "customers")])).toEqual([false, true, false]);
    expect(mask("SELECT id, addr FROM contacts", [col("id", "contacts", "id", true), col("addr", "contacts")])).toEqual([false, true]);
    // A column named like a flagged one is masked anywhere.
    expect(mask("SELECT 'x' AS email", [computed("email")])).toEqual([true]);
  });

  it("judges plain columns by name when the database doesn't say where they come from (Redshift)", () => {
    expect(mask("SELECT id, venue, email FROM customers", [computed("id", true), computed("venue"), computed("email")])).toEqual([false, false, true]);
    expect(mask("SELECT * FROM customers", [computed("id", true), computed("venue"), computed("other")])).toEqual([false, false, true]);
    // A whole-row reference, or a name that isn't a synced column, is masked.
    expect(mask("SELECT c FROM customers c", [computed("c")])).toEqual([true]);
    expect(mask("SELECT customers FROM customers", [computed("customers")])).toEqual([true]);
    expect(mask("SELECT c.text FROM customers c", [computed("text")])).toEqual([true]);
    // Only a column of the table the name refers to: in Postgres c.f is f(c) when customers has no column f, so
    // c.row_to_json is the whole row (another table's column of that name doesn't count).
    expect(mask("SELECT c.row_to_json FROM customers c JOIN notes n ON n.id = c.id", [computed("row_to_json")])).toEqual([true]);
    expect(mask("SELECT max(c.row_to_json) AS m FROM customers c JOIN notes n ON n.id = c.id", [computed("m")])).toEqual([true]);
    expect(mask("SELECT n.row_to_json, row_to_json FROM customers c JOIN notes n USING (id)", [computed("row_to_json"), computed("row_to_json")])).toEqual([false, false]);
    expect(mask("SELECT public.notes.row_to_json FROM customers, public.notes", [computed("row_to_json")])).toEqual([false]);
    // A name that could mean two tables, and a column only some schemas' tables of that name have, aren't trusted.
    expect(mask("SELECT orders.total AS t FROM customers orders, orders x", [computed("t", true)])).toEqual([true]);
    expect(mask("SELECT n.extra FROM customers c, notes n", [computed("extra")])).toEqual([true]);
    expect(mask("SELECT sum(total) AS s FROM customers", [computed("s", true)])).toEqual([true]);
    // Text from a view over personal data is masked; its numbers aren't.
    expect(mask("SELECT id, venue FROM contacts", [computed("id", true), computed("venue")])).toEqual([false, true]);
  });
});

describe("the SQL guard and masking in warehouse dialects", () => {
  const pii: PiiCatalog = {
    at: new Set(["sales.customers.email"]),
    names: new Set(["email"]),
    views: new Set(),
    tables: new Set(["customers"]),
    columns: columnsByTable([
      { name: "customers", columns: ["id", "email", "country"] },
      { name: "orders", columns: ["id", "total"] },
    ]),
  };
  const touches = (sql: string, dialect: "bigquery" | "clickhouse" | "snowflake") => touchesPii(guardSql(sql, dialect), pii);

  it("reads BigQuery's `project.dataset.table` names and wildcard tables as naming their tables", () => {
    expect(touches("SELECT TO_JSON_STRING(t) FROM `acme.sales.customers` t", "bigquery")).toBe(true);
    expect(touches("SELECT TO_JSON_STRING(t) FROM `acme.sales.cust*` t", "bigquery")).toBe(true);
    expect(touches("SELECT TO_JSON_STRING(t) FROM `acme.sales.*` t", "bigquery")).toBe(true);
    expect(touches("SELECT count(*) FROM `acme.sales.orders`", "bigquery")).toBe(false);
    expect(touches("SELECT count(*) FROM `acme.sales.ord*`", "bigquery")).toBe(false);
    // A plain column of the table is judged by its name, the table being the last part of the quoted name.
    const g = guardSql("SELECT id, country, email FROM `acme.sales.customers`", "bigquery");
    const f = (name: string, scalar = false) => ({ name, origin: null, scalar });
    expect(maskedColumns([f("id", true), f("country"), f("email")], g, pii, touchesPii(g, pii))).toEqual([false, false, true]);
  });

  it("knows each dialect's quotes and comments", () => {
    // BigQuery: "…" is a string, # starts a comment, and doubled quotes mean something else.
    expect(guardSql('SELECT "customers" AS s # note', "bigquery").literalWords).toContain("customers");
    expect(() => guardSql("SELECT 'a''b'", "bigquery")).toThrow(/doubled quote/);
    expect(() => guardSql('SELECT """x"""', "bigquery")).toThrow(/doubled quote/);
    expect(guardSql("SELECT ''", "bigquery").sql).toBe("SELECT ''");
    // ClickHouse: "…" and `…` are names; # is a comment; doubled quotes are fine, backslashes aren't.
    expect(guardSql('SELECT "a""b", `c` FROM t # x', "clickhouse").identifiers).toEqual(new Set(['a"b', "c"]));
    expect(() => guardSql("SELECT 'a\\'b'", "clickhouse")).toThrow(/backslashes/);
    // Snowflake: $$…$$ strings and // comments; IDENTIFIER() and TABLE('name') name tables by expression.
    expect(guardSql("SELECT $$it's$$ // why\n", "snowflake").sql).toBe("SELECT $$it's$$");
    expect(() => guardSql("SELECT * FROM identifier($t)", "snowflake")).toThrow(/\$ outside/);
    expect(() => guardSql("SELECT * FROM TABLE(:t)", "snowflake")).toThrow(/TABLE\(…\)/);
    expect(() => guardSql("SELECT * FROM t AT(OFFSET => -60)", "snowflake")).not.toThrow();
    // Words that are blocked keywords elsewhere stay blocked.
    expect(() => guardSql("SELECT * FROM t INTO OUTFILE 'x'", "clickhouse")).toThrow(/INTO/);
    // ClickHouse nests /* */ comments, as Postgres does: nothing inside one reaches the server.
    expect(guardSql("SELECT 1 /* a /* b */ c */", "clickhouse").sql).toBe("SELECT 1");
    expect(() => guardSql("SELECT 1 /* a /* b */ c", "clickhouse")).toThrow(/comment isn't closed/);
  });

  it("makes ClickHouse name dictionaries and Join tables as one string, so masking sees the name", () => {
    const ch = { ...pii, tables: new Set(["customers", "customers_dict"]) };
    const refused = [
      "SELECT * FROM dictionary(concat('cust', 'omers_dict'))",
      "SELECT * FROM dictionary(reverse('tcid_sremotsuc'))",
      "SELECT dictGet(concat('cust', 'omers_dict'), concat('em', 'ail'), toUInt64(1))",
      "SELECT dictGetOrDefault(lower('CUSTOMERS_DICT'), 'email', 1, '')",
      "SELECT dictHas(concat('a', 'b'), 1)",
      "SELECT joinGet(concat('cust', 'omers'), 'email', 1)",
    ];
    for (const sql of refused) expect(() => guardSql(sql, "clickhouse"), sql).toThrow(/must name its dictionary or table as one string/);
    // Other functions that take a table's name as an expression, or reach other hosts, aren't allowed at all.
    expect(() => guardSql("SELECT * FROM mergeTreeAnalyzeIndexes(currentDatabase(), concat('cust', 'omers'), 1)", "clickhouse")).toThrow(/mergetreeanalyzeindexes\(\) isn't allowed/);
    expect(() => guardSql("SELECT * FROM timeSeriesData(db, concat('a', 'b'))", "clickhouse")).toThrow(/timeseriesdata\(\) isn't allowed/);
    expect(() => guardSql("SELECT hasColumnInTable('h', 'u', 'p', 'db', 't', 'c')", "clickhouse")).toThrow(/hascolumnintable\(\) isn't allowed/);
    // Written out, the name is read, and the query counts as touching personal data.
    expect(touchesPii(guardSql("SELECT * FROM dictionary('analytics.customers_dict')", "clickhouse"), ch)).toBe(true);
    expect(touchesPii(guardSql("SELECT dictGet('customers_dict', 'country', toUInt64(1))", "clickhouse"), ch)).toBe(true);
    expect(touchesPii(guardSql("SELECT * FROM dictionary(analytics.customers_dict)", "clickhouse"), ch)).toBe(true);
    expect(touchesPii(guardSql("SELECT joinGet('orders_join', 'total', 1)", "clickhouse"), ch)).toBe(false);
    // Column names that merely start with "dict" are fine.
    expect(() => guardSql("SELECT dict_col, dictionary_id FROM t", "clickhouse")).not.toThrow();
  });

  it("refuses query history views: other callers' query text can quote personal data", () => {
    const refused: [string, "clickhouse" | "snowflake" | "bigquery"][] = [
      ["SELECT query FROM system.query_log", "clickhouse"],
      ["SELECT query FROM query_log", "clickhouse"],
      ["SELECT query FROM \"system\".\"processes\"", "clickhouse"],
      ["SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())", "snowflake"],
      ["SELECT query_text FROM snowflake.account_usage.query_history", "snowflake"],
      ["SELECT * FROM TABLE(information_schema.query_history_by_user())", "snowflake"],
      ["SELECT query FROM `region-us`.INFORMATION_SCHEMA.JOBS", "bigquery"],
      ["SELECT query FROM `region-us.INFORMATION_SCHEMA.JOBS_BY_USER`", "bigquery"],
      ["SELECT query FROM `acme`.`region-eu`.INFORMATION_SCHEMA.JOBS_TIMELINE", "bigquery"],
    ];
    for (const [sql, d] of refused) expect(() => guardSql(sql, d), sql).toThrow(/query history isn't allowed/);
    // Tables that only share a word are fine.
    expect(() => guardSql("SELECT * FROM sales.jobs", "bigquery")).not.toThrow();
    expect(() => guardSql("SELECT processes FROM analytics.events", "clickhouse")).not.toThrow();
  });
});

describe("schema sync helpers", () => {
  const orders: TableDef = {
    schema: "public",
    name: "orders",
    kind: "table",
    rows: 1200,
    columns: [
      { name: "id", type: "integer", nullable: false, pk: true },
      { name: "customer_id", type: "integer", nullable: false, fk: "public.customers.id" },
      { name: "total", type: "numeric(10,2)", nullable: true, comment: "Gross | incl. VAT" },
      { name: "note", type: "text", nullable: true },
    ],
  };

  it("hashes the shape, not the row estimate, and lists differences", () => {
    expect(definitionHash({ ...orders, rows: 5 })).toBe(definitionHash(orders));
    const after: TableDef = {
      ...orders,
      columns: [
        { name: "id", type: "bigint", nullable: false, pk: true },
        { name: "customer_id", type: "integer", nullable: true, fk: "public.customers.id" },
        { name: "total", type: "numeric(10,2)", nullable: true, comment: "Gross | incl. VAT" },
        { name: "status", type: "text", nullable: false },
      ],
    };
    expect(definitionHash(after)).not.toBe(definitionHash(orders));
    const changes = diffTable(orders, after);
    expect(changes).toEqual([
      { change: "column_added", detail: { column: "status", type: "text not null" } },
      { change: "column_removed", detail: { column: "note", type: "text" } },
      { change: "type_changed", detail: { column: "id", from: "integer not null", to: "bigint not null" } },
      { change: "type_changed", detail: { column: "customer_id", from: "integer not null", to: "integer" } },
    ]);
    expect(describeChange("public.orders", changes[1]!)).toBe("public.orders: column note removed");
    expect(describeChange("public.orders", changes[2]!)).toBe("public.orders: column id changed from integer not null to bigint not null");
  });

  it("renders the synced block with notes, and replaces only that block", () => {
    const notes = new Map([["customer_id", { column: "customer_id", description: "Who placed it; mail ops@example.com", pii: true }]]);
    const block = renderSyncedBlock(orders, notes, { connection: "Orders DB", kind: "PostgreSQL" });
    expect(block.startsWith(SYNC_START) && block.endsWith(SYNC_END)).toBe(true);
    expect(block).toContain("| `id` | integer | no | PK |  |");
    expect(block).toContain("| `customer_id` | integer | no | FK → public.customers.id | **PII** Who placed it; mail [REDACTED:email] |");
    // A pipe in a comment doesn't break the table; the row estimate isn't in the article.
    expect(block).toContain("Gross \\| incl. VAT");
    expect(block).not.toContain("1200");

    const body = newTableBody(block);
    expect(body).toMatch(/^## Columns \(synced\)\n\n<!-- thaliyola:sync -->/);
    expect(body).toContain("## Gotchas\n\n<!-- Hint:");
    const edited = body.replace("## Gotchas\n\n<!-- Hint: Things that trip people up: duplicates, nulls, timezones, soft deletes. -->", "## Gotchas\n\nRefunds are negative rows.");
    const next = renderSyncedBlock({ ...orders, columns: orders.columns.slice(0, 2) }, new Map(), { connection: "Orders DB", kind: "PostgreSQL" });
    const replaced = replaceSyncedBlock(edited, next);
    expect(currentSyncedBlock(replaced)).toBe(next);
    expect(replaced).toContain("Refunds are negative rows.");
    expect(replaced).not.toContain("`note`");
    // Markers removed by hand: the heading's section is replaced; no heading either: the block goes on top.
    const noMarkers = "## Columns (synced)\n\nold table\n\n## Grain\n\nOne row per order.";
    expect(replaceSyncedBlock(noMarkers, next)).toBe(`## Columns (synced)\n\n${next}\n\n## Grain\n\nOne row per order.`);
    expect(replaceSyncedBlock("## Grain\n\nOne row per order.", next)).toBe(`## Columns (synced)\n\n${next}\n\n## Grain\n\nOne row per order.`);
    // A removed table says so.
    expect(renderSyncedBlock(orders, new Map(), { connection: "Orders DB", kind: "PostgreSQL", removedAt: "2026-11-13T10:00:00Z" })).toContain("**Removed:** the sync on 2026-11-13");
  });

  it("filters schemas by name or glob", () => {
    expect(schemaWanted("public", {})).toBe(true);
    expect(schemaWanted("public", { include: ["sales_*"] })).toBe(false);
    expect(schemaWanted("sales_eu", { include: ["sales_*"] })).toBe(true);
    expect(schemaWanted("sales_tmp", { include: ["sales_*"], exclude: ["*_tmp"] })).toBe(false);
  });

  it("makes cells JSON-safe, short and redacted", () => {
    expect(cellValue(null)).toBeNull();
    expect(cellValue(12n)).toBe("12");
    expect(cellValue(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(cellValue(Buffer.from("abc"))).toBe("<3 bytes>");
    expect(cellValue({ a: 1 })).toBe('{"a":1}');
    expect((cellValue("x".repeat(3000)) as string).length).toBe(2049);
    expect(cellValue("contact ann@example.com")).toBe("contact [REDACTED:email]");
    expect(MASK).toBe("[masked]");
  });
});
