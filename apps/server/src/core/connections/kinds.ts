import { ValidationError } from "../context.js";
import { introspectBigquery, parseServiceAccount, queryBigquery, testBigquery } from "./bigquery.js";
import { introspectClickhouse, queryClickhouse, testClickhouse } from "./clickhouse.js";
import { testGit } from "./git.js";
import { AUTH_TYPES, testHttpApi } from "./http-api.js";
import { introspectMysql, queryMysql, testMysql } from "./mysql.js";
import { canonicalIp, type NetMode } from "./network.js";
import { introspectPg, queryPg, testPg } from "./pg-family.js";
import type { IntrospectFilter, TableDef } from "./schema.js";
import type { Dialect, GuardedSql } from "./sql-guard.js";
import { SLACK_WEBHOOK, testSlack } from "./slack.js";
import { introspectSnowflake, querySnowflake, testSnowflake } from "./snowflake.js";
import { testTrello } from "./trello.js";
import { JIRA_SITE, testJira, testClickup, testLinear } from "./trackers.js";
import { CONNECTION_KINDS, DATABASE_KINDS, type ConnectionKind, type ConnectionOptions, type ConnTarget, type DriverEnv, type QueryLimits, type RawResult, type TestResult } from "./types.js";

/**
 * What each kind of connection needs and how it's tested, for validation and for the UI (modelled on the sources'
 * SOURCE_FIELDS). Non-secret fields are stored as they are; secret fields are sealed (core/secrets.ts) and only ever
 * opened by the driver that uses them.
 */

export interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  /** "select" shows `options`; "number" a numeric input; "url" a URL input. */
  type?: "text" | "number" | "url" | "select";
  options?: { value: string; label: string }[];
  default?: string;
  /** Shown only when another field has one of these values, e.g. the header name for header auth. */
  when?: { key: string; values: string[] };
  pattern?: RegExp;
  patternMessage?: string;
}

export interface SecretSpec {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  multiline?: boolean;
  when?: { key: string; values: string[] };
  /**
   * The UI may show the last characters of a long stored value, so people can tell which one is stored. Only for
   * random tokens and keys: never for passwords, passphrases or key files, where the tail is part of what's secret.
   */
  showTail?: boolean | ((config: Record<string, string>) => boolean);
}

export interface KindSpec {
  label: string;
  group: "database" | "api" | "git" | "notify" | "tracker";
  description: string;
  /** Database kinds may reach private networks; HTTP kinds only public addresses (unless allowed). */
  network: NetMode;
  /** Checked on a schedule (health, and sync). Slack and Trello aren't: they're delivery targets (deliveries set their health). */
  scheduled: boolean;
  /**
   * Fields that say where secrets are sent, and how (a database's encryption). When one changes, stored secrets aren't
   * reused: they must be entered again, so someone who can edit a connection can't send its stored password to a
   * server of their choosing, or over a connection whose certificate isn't checked.
   */
  targetFields: string[];
  fields: FieldSpec[];
  secretFields: SecretSpec[];
  /** Cross-field rules: config is validated; `has` says whether a secret field is (or will be) stored. */
  check?(config: Record<string, string>, has: (key: string) => boolean): void;
  /** Checks a secret value's shape before it's sealed (e.g. that a key file is a key). */
  checkSecret?(key: string, value: string): void;
  test(c: ConnTarget, env: DriverEnv): Promise<TestResult>;
  /** Databases with schema sync: their tables and views. */
  introspect?(c: ConnTarget, env: DriverEnv, filter: IntrospectFilter): Promise<TableDef[]>;
  /** Databases with read-only queries: the SQL dialect the guard checks, and how a guarded statement runs. */
  dialect?: Dialect;
  query?(c: ConnTarget, env: DriverEnv, q: GuardedSql, limits: QueryLimits): Promise<RawResult>;
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]+\]?)$/;
const NAME = /^[^\s'";\\`]{1,128}$/;
const IDENT = /^[A-Za-z0-9_$."-]{1,255}$/;
const HTTP_URL = /^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i;
const ORIGIN_URL = /^https?:\/\/[^\s/?#@]+\/?$/i;
const HTTPS_URL = /^https:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i;

const SSL_OPTIONS = [
  { value: "verify-full", label: "Encrypted, certificate checked" },
  { value: "require", label: "Encrypted, certificate not checked" },
  { value: "disable", label: "Not encrypted" },
];

const hostField: FieldSpec = { key: "host", label: "Host", required: true, placeholder: "db.internal.example.com", pattern: HOST, patternMessage: "Host is a host name or IP address, without a scheme or port" };
const portField = (port: string): FieldSpec => ({ key: "port", label: "Port", type: "number", default: port, pattern: /^\d{1,5}$/, patternMessage: "Port is a number" });
const databaseField: FieldSpec = { key: "database", label: "Database", required: true, pattern: NAME, patternMessage: "Database is a name without spaces or quotes" };
const userField: FieldSpec = {
  key: "user",
  label: "User",
  required: true,
  hint: "Use a read-only user: Thaliyola only reads schemas and runs SELECT queries.",
  pattern: NAME,
  patternMessage: "User is a name without spaces or quotes",
};
const sslField: FieldSpec = { key: "sslmode", label: "Encryption", type: "select", options: SSL_OPTIONS, default: "verify-full" };
const password: SecretSpec = { key: "password", label: "Password", required: true };

export const KINDS: Record<ConnectionKind, KindSpec> = {
  postgres: {
    label: "PostgreSQL",
    group: "database",
    description: "Tables and views from a PostgreSQL database (RDS, Aurora, Cloud SQL or your own).",
    network: "database",
    scheduled: true,
    targetFields: ["host", "port", "sslmode"],
    fields: [hostField, portField("5432"), databaseField, userField, sslField],
    secretFields: [password],
    test: testPg,
    introspect: introspectPg,
    dialect: "postgres",
    query: queryPg,
  },
  redshift: {
    label: "Amazon Redshift",
    group: "database",
    description: "Tables and views from a Redshift cluster or Serverless workgroup.",
    network: "database",
    scheduled: true,
    targetFields: ["host", "port", "sslmode"],
    fields: [{ ...hostField, placeholder: "cluster.abc123.eu-west-1.redshift.amazonaws.com" }, portField("5439"), databaseField, userField, sslField],
    secretFields: [password],
    test: testPg,
    introspect: introspectPg,
    dialect: "postgres",
    query: queryPg,
  },
  mysql: {
    label: "MySQL",
    group: "database",
    description: "Tables and views from MySQL or MariaDB (RDS, Aurora or your own).",
    network: "database",
    scheduled: true,
    targetFields: ["host", "port", "sslmode"],
    fields: [hostField, portField("3306"), databaseField, userField, sslField],
    secretFields: [password],
    test: testMysql,
    introspect: introspectMysql,
    dialect: "mysql",
    query: queryMysql,
  },
  clickhouse: {
    label: "ClickHouse",
    group: "database",
    description: "Tables and views from ClickHouse, through its HTTP interface.",
    network: "database",
    scheduled: true,
    targetFields: ["url"],
    fields: [
      // Just the server: requests always go to its root, so the address can't name another path on an internal host.
      { key: "url", label: "HTTP(S) address", required: true, type: "url", placeholder: "https://clickhouse.example.com:8443", pattern: ORIGIN_URL, patternMessage: "Address is https:// (or http://), the host and the port, without a path" },
      { key: "database", label: "Database", default: "default", pattern: IDENT, patternMessage: "Database is a name" },
      { key: "user", label: "User", default: "default", hint: "Use a read-only user.", pattern: NAME, patternMessage: "User is a name without spaces or quotes" },
    ],
    secretFields: [{ key: "password", label: "Password" }],
    test: testClickhouse,
    introspect: introspectClickhouse,
    dialect: "clickhouse",
    query: queryClickhouse,
  },
  snowflake: {
    label: "Snowflake",
    group: "database",
    description: "Tables and views from Snowflake, with key-pair authentication.",
    network: "database",
    scheduled: true,
    targetFields: ["account"],
    fields: [
      { key: "account", label: "Account identifier", required: true, placeholder: "myorg-myaccount", hint: "From your Snowflake URL: <account>.snowflakecomputing.com", pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{1,100}$/, patternMessage: "Account identifier looks like myorg-myaccount" },
      { key: "user", label: "User", required: true, hint: "A user with a read-only role and the public key set (RSA_PUBLIC_KEY).", pattern: IDENT, patternMessage: "User is a Snowflake identifier" },
      { key: "warehouse", label: "Warehouse", pattern: IDENT, patternMessage: "Warehouse is a Snowflake identifier" },
      { key: "database", label: "Database", pattern: IDENT, patternMessage: "Database is a Snowflake identifier" },
      { key: "schema", label: "Schema", pattern: IDENT, patternMessage: "Schema is a Snowflake identifier" },
      { key: "role", label: "Role", pattern: IDENT, patternMessage: "Role is a Snowflake identifier" },
    ],
    secretFields: [
      { key: "private_key", label: "Private key (PEM)", required: true, multiline: true, hint: "-----BEGIN PRIVATE KEY----- …" },
      { key: "private_key_passphrase", label: "Private key passphrase", hint: "Only for an encrypted key." },
    ],
    checkSecret(key, value) {
      if (key === "private_key" && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) throw new ValidationError("the private key must be in PEM format (-----BEGIN PRIVATE KEY-----)");
    },
    test: testSnowflake,
    introspect: introspectSnowflake,
    dialect: "snowflake",
    query: querySnowflake,
  },
  bigquery: {
    label: "BigQuery",
    group: "database",
    description: "Datasets and tables from Google BigQuery, with a service account key.",
    network: "database",
    scheduled: true,
    targetFields: [],
    fields: [
      { key: "project_id", label: "Project ID", hint: "Leave empty to use the key's project.", pattern: /^[a-z][a-z0-9.:-]{3,62}$/, patternMessage: "Project ID looks like my-project-123" },
      { key: "location", label: "Location", placeholder: "EU or europe-west2", pattern: /^[A-Za-z0-9-]{2,40}$/, patternMessage: "Location looks like EU or europe-west2" },
      {
        key: "max_gb_billed",
        label: "Most a query may bill (GB)",
        type: "number",
        default: "10",
        hint: "A query that would scan more is refused by BigQuery before it runs.",
        pattern: /^\d{1,5}(\.\d{1,3})?$/,
        patternMessage: "Most a query may bill is a number of gigabytes",
      },
    ],
    secretFields: [{ key: "service_account_json", label: "Service account key (JSON)", required: true, multiline: true, hint: "Give the account BigQuery Data Viewer and Job User." }],
    checkSecret(key, value) {
      if (key === "service_account_json") parseServiceAccount(value);
    },
    test: testBigquery,
    introspect: introspectBigquery,
    dialect: "bigquery",
    query: queryBigquery,
  },
  http_api: {
    label: "HTTP API",
    group: "api",
    description: "An internal or external REST API, optionally with an OpenAPI (Swagger) spec.",
    network: "http",
    scheduled: true,
    targetFields: ["base_url"],
    fields: [
      { key: "base_url", label: "Base URL", required: true, type: "url", placeholder: "https://api.example.com/v1", pattern: HTTP_URL, patternMessage: "Base URL starts with https:// (or http://)" },
      { key: "spec_url", label: "OpenAPI spec URL", type: "url", placeholder: "https://api.example.com/openapi.json", pattern: HTTP_URL, patternMessage: "Spec URL starts with https:// (or http://)" },
      {
        key: "auth_type",
        label: "Authentication",
        type: "select",
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "bearer", label: "Bearer token" },
          { value: "header", label: "API key in a header" },
          { value: "query", label: "API key in the query string" },
          { value: "basic", label: "User name and password" },
        ],
      },
      { key: "auth_name", label: "Header or parameter name", placeholder: "X-API-Key", when: { key: "auth_type", values: ["header", "query"] }, pattern: /^[A-Za-z0-9_.-]{1,100}$/, patternMessage: "Use letters, digits, dashes and underscores" },
      { key: "username", label: "User name", when: { key: "auth_type", values: ["basic"] }, pattern: /^[^\s:]{1,200}$/, patternMessage: "User name can't contain spaces or colons" },
    ],
    secretFields: [
      // A token or key may show its tail; a basic-auth password doesn't.
      { key: "auth_value", label: "Token, key or password", when: { key: "auth_type", values: ["bearer", "header", "query", "basic"] }, showTail: (config) => config.auth_type !== "basic" },
    ],
    check(config, has) {
      if (!(AUTH_TYPES as readonly string[]).includes(config.auth_type ?? "none")) throw new ValidationError("Authentication is one of none, bearer, header, query or basic");
      if ((config.auth_type === "header" || config.auth_type === "query") && !config.auth_name) throw new ValidationError("Header or parameter name is required for this authentication");
      if (config.auth_type === "header" && /^(host|content-length|transfer-encoding|connection)$/i.test(config.auth_name ?? "")) throw new ValidationError("That header can't carry the key");
      if (config.auth_type === "basic" && !config.username) throw new ValidationError("User name is required for user name and password authentication");
      if (config.auth_type && config.auth_type !== "none" && !has("auth_value")) throw new ValidationError("Token, key or password is required for this authentication");
    },
    test: testHttpApi,
  },
  git: {
    label: "GitHub or GitLab",
    group: "git",
    description: "A token for this project's (or the Team space's) repositories, so private ones can be read; skill imports can use it.",
    network: "http",
    scheduled: true,
    targetFields: ["provider", "api_url"],
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "github",
        options: [
          { value: "github", label: "GitHub" },
          { value: "gitlab", label: "GitLab" },
        ],
      },
      { key: "api_url", label: "API URL", type: "url", hint: "Only for GitHub Enterprise or self-hosted GitLab, e.g. https://git.example.com/api/v4", pattern: HTTPS_URL, patternMessage: "API URL starts with https://" },
    ],
    secretFields: [{ key: "token", label: "Access token", required: true, hint: "Read-only: GitHub fine-grained (Contents and Metadata: read) or GitLab read_api.", showTail: true }],
    test: testGit,
  },
  slack: {
    label: "Slack",
    group: "notify",
    description: "A Slack channel that notifications and project digests can go to. Test posts a test message.",
    network: "http",
    scheduled: false,
    targetFields: [],
    fields: [{ key: "channel", label: "Channel ID", placeholder: "C0123ABCD", hint: "Needed with a bot token; invite the bot to the channel.", pattern: /^([CGD][A-Z0-9]{6,}|#[a-z0-9._-]{1,80})$/, patternMessage: "Channel ID looks like C0123ABCD" }],
    secretFields: [
      { key: "bot_token", label: "Bot token", hint: "xoxb-…, with chat:write. Or use an incoming webhook instead.", showTail: true },
      { key: "webhook_url", label: "Incoming webhook URL", hint: "https://hooks.slack.com/services/…", showTail: true },
    ],
    check(config, has) {
      if (!has("bot_token") && !has("webhook_url")) throw new ValidationError("add a bot token or an incoming webhook URL");
      if (has("bot_token") && !config.channel) throw new ValidationError("Channel ID is required with a bot token");
    },
    checkSecret(key, value) {
      if (key === "bot_token" && !/^xox[bp]-/.test(value)) throw new ValidationError("a Slack bot token starts with xoxb-");
      if (key === "webhook_url" && !SLACK_WEBHOOK.test(value)) throw new ValidationError("a Slack incoming webhook starts with https://hooks.slack.com/");
    },
    test: testSlack,
  },
  trello: {
    label: "Trello",
    group: "notify",
    description: "A Trello list that notifications can go to, one card each. Test adds a test card.",
    network: "http",
    scheduled: false,
    targetFields: [],
    fields: [{ key: "list_id", label: "List ID", required: true, hint: "Open a card on the list, add .json to its URL and copy idList.", pattern: /^[0-9a-f]{24}$/, patternMessage: "List ID is 24 letters and digits" }],
    secretFields: [
      { key: "api_key", label: "API key", required: true, showTail: true },
      { key: "token", label: "Token", required: true, showTail: true },
    ],
    test: testTrello,
  },
  jira: {
    label: "Jira",
    group: "tracker",
    description: "A Jira Cloud site where findings and articles can open issues, and whose linked issues show their status.",
    network: "http",
    scheduled: true,
    // The token goes to the site, as the account: changing either means entering the token again.
    targetFields: ["site_url", "email"],
    fields: [
      { key: "site_url", label: "Site URL", required: true, type: "url", placeholder: "https://your-team.atlassian.net", hint: "Jira Cloud: https://<site>.atlassian.net", pattern: JIRA_SITE, patternMessage: "Site URL is your Jira Cloud address, https://<site>.atlassian.net" },
      { key: "email", label: "Account email", required: true, hint: "The Atlassian account the API token belongs to. Issues are created as this account.", pattern: /^[^\s@]{1,100}@[^\s@]{1,200}$/, patternMessage: "Account email is an email address" },
      { key: "project_key", label: "Project key", required: true, placeholder: "OPS", hint: "Where new issues go: the prefix of the project's issues, as in OPS-123.", pattern: /^[A-Z][A-Z0-9_]{0,19}$/, patternMessage: "Project key is capital letters and digits, as in OPS" },
      { key: "issue_type", label: "Issue type", default: "Task", hint: "Task, Bug, Story… as the project names it.", pattern: /^[^\n\r"\\]{1,60}$/, patternMessage: "Issue type is a name, as in Task" },
    ],
    secretFields: [{ key: "api_token", label: "API token", required: true, hint: "From id.atlassian.com › Security › API tokens.", showTail: true }],
    test: testJira,
  },
  linear: {
    label: "Linear",
    group: "tracker",
    description: "A Linear team where findings and articles can open issues, and whose linked issues show their status.",
    network: "http",
    scheduled: true,
    targetFields: [],
    fields: [{ key: "team", label: "Team key", required: true, placeholder: "ENG", hint: "Where new issues go: the prefix of the team's issues, as in ENG-123.", pattern: /^[A-Z0-9][A-Z0-9_]{0,9}$/, patternMessage: "Team key is capital letters and digits, as in ENG" }],
    secretFields: [{ key: "api_key", label: "API key", required: true, hint: "Linear › Settings › Security & access › Personal API keys (lin_api_…).", showTail: true }],
    checkSecret(key, value) {
      if (key === "api_key" && /\s/.test(value)) throw new ValidationError("a Linear API key has no spaces");
    },
    test: testLinear,
  },
  clickup: {
    label: "ClickUp",
    group: "tracker",
    description: "A ClickUp list where findings and articles can open tasks, and whose linked tasks show their status.",
    network: "http",
    scheduled: true,
    targetFields: [],
    fields: [
      { key: "list_id", label: "List ID", required: true, placeholder: "901234567890", hint: "Where new tasks go: the number in the list's link (…/li/901234567890).", pattern: /^\d{1,20}$/, patternMessage: "List ID is the number in the list's link" },
      { key: "team_id", label: "Workspace ID", hint: "Only if the Workspace uses custom task IDs (ENG-42): the first number in any ClickUp link.", pattern: /^\d{1,20}$/, patternMessage: "Workspace ID is a number" },
    ],
    secretFields: [{ key: "api_token", label: "API token", required: true, hint: "ClickUp › Settings › Apps › API token (pk_…). Tasks are created as its account.", showTail: true }],
    checkSecret(key, value) {
      if (key === "api_token" && !/^pk_[A-Za-z0-9_]+$/.test(value.trim())) throw new ValidationError("a ClickUp personal API token starts with pk_");
    },
    test: testClickup,
  },
};

export function isKind(kind: string): kind is ConnectionKind {
  return (CONNECTION_KINDS as readonly string[]).includes(kind);
}

export function kindSpec(kind: string): KindSpec {
  if (!isKind(kind)) throw new ValidationError(`kind must be one of ${CONNECTION_KINDS.join(", ")}`);
  return KINDS[kind];
}

const applies = (when: { key: string; values: string[] } | undefined, config: Record<string, string>) => !when || when.values.includes(config[when.key] ?? "");

/** Validates and normalises non-secret fields; unknown keys are dropped, defaults filled in. */
export function validateConfig(kind: ConnectionKind, input: Record<string, unknown>): Record<string, string> {
  const spec = KINDS[kind];
  const raw: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = input[f.key];
    raw[f.key] = v === undefined || v === null ? "" : String(v).trim();
  }
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    let s = raw[f.key]!.slice(0, 500);
    if (!s && f.default) s = f.default;
    if (!applies(f.when, { ...raw, ...out })) continue;
    if (!s) {
      if (f.required) throw new ValidationError(`${f.label} is required`);
      continue;
    }
    if (f.options && !f.options.some((o) => o.value === s)) throw new ValidationError(`${f.label} is one of ${f.options.map((o) => o.value).join(", ")}`);
    if (f.pattern && !f.pattern.test(s)) throw new ValidationError(f.patternMessage ?? `${f.label} isn't valid`);
    if (f.key === "port" && (Number(s) < 1 || Number(s) > 65535)) throw new ValidationError("Port is between 1 and 65535");
    if (f.key === "host") {
      // IP addresses are kept in one spelling (e.g. 0:0:0:0:0:ffff:a00:9 → 10.0.0.9), so they compare as they route.
      const bare = s.replace(/^\[|\]$/g, "");
      if (/^[0-9A-Fa-f:.]+$/.test(bare) && bare.includes(":") && !canonicalIp(bare)) throw new ValidationError(f.patternMessage ?? `${f.label} isn't valid`);
      s = canonicalIp(bare) ?? bare.toLowerCase();
    }
    out[f.key] = s;
  }
  return out;
}

/**
 * Secret input: a value replaces the stored one, null removes it, a missing or empty value keeps it. Unknown keys
 * are refused (so a typo doesn't silently drop a secret).
 */
export function validateSecretInput(kind: ConnectionKind, input: Record<string, unknown> | undefined): Record<string, string | null> {
  const spec = KINDS[kind];
  const out: Record<string, string | null> = {};
  for (const [key, v] of Object.entries(input ?? {})) {
    const f = spec.secretFields.find((s) => s.key === key);
    if (!f) throw new ValidationError(`${spec.label} has no secret field ${key}`);
    if (v === null) out[key] = null;
    else if (typeof v === "string" && v.trim()) {
      const value = v.trim();
      if (value.length > 20_000) throw new ValidationError(`${f.label} is too long`);
      spec.checkSecret?.(key, value);
      out[key] = value;
    } else if (v !== undefined && typeof v !== "string") throw new ValidationError(`${f.label} must be text`);
  }
  return out;
}

/** Whether a complete connection has every secret it needs (and passes the kind's cross-field rules). */
export function checkComplete(kind: ConnectionKind, config: Record<string, string>, secretKeys: Set<string>) {
  const spec = KINDS[kind];
  for (const f of spec.secretFields) if (f.required && applies(f.when, config) && !secretKeys.has(f.key)) throw new ValidationError(`${f.label} is required`);
  spec.check?.(config, (k) => secretKeys.has(k));
}

const METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const list = (v: unknown, max = 50) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : undefined);

/** Options that apply to the kind; everything else is dropped. */
export function validateOptions(kind: ConnectionKind, input: Record<string, unknown> | undefined): ConnectionOptions {
  const o = input ?? {};
  const out: ConnectionOptions = {};
  const maxObjects = o.max_objects;
  if (maxObjects !== undefined && maxObjects !== null) {
    const n = Number(maxObjects);
    if (!Number.isInteger(n) || n < 1 || n > 5000) throw new ValidationError("max_objects is between 1 and 5000");
    out.max_objects = n;
  }
  if (DATABASE_KINDS.includes(kind)) {
    if (o.allow_query !== undefined) out.allow_query = o.allow_query === true;
    for (const k of ["schemas_include", "schemas_exclude"] as const) {
      const l = list(o[k]);
      if (l?.some((s) => !/^[A-Za-z0-9_$.*-]{1,128}$/.test(s))) throw new ValidationError(`${k} lists schema names`);
      if (l?.length) out[k] = l;
    }
  }
  if (kind === "http_api") {
    // call_api is on unless a Project admin turns it off (GET and HEAD only, unless writes are allowed below).
    if (o.allow_calls !== undefined) out.allow_calls = o.allow_calls !== false;
    const methods = list(o.allow_write_methods)?.map((m) => m.toUpperCase());
    if (methods?.some((m) => !METHODS.includes(m))) throw new ValidationError(`allow_write_methods lists ${METHODS.join(", ")}`);
    if (methods?.length) out.allow_write_methods = [...new Set(methods)];
    const prefixes = list(o.path_prefixes);
    if (prefixes?.some((p) => !/^\/[^\s?#]*$/.test(p) || p.includes(".."))) throw new ValidationError("path_prefixes start with / (e.g. /v1/orders)");
    if (prefixes?.length) out.path_prefixes = prefixes;
  }
  if (kind === "clickup") {
    const ids = list(o.allowed_lists);
    if (ids?.some((x) => !/^(\*|\d{1,20})$/.test(x))) throw new ValidationError("allowed_lists lists ClickUp list IDs (or * for any)");
    if (ids?.length) out.allowed_lists = [...new Set(ids)];
  }
  if (kind === "jira" || kind === "linear") {
    const k = kind === "jira" ? "allowed_projects" : "allowed_teams";
    const keys = list(o[k])?.map((x) => x.toUpperCase());
    const shape = kind === "jira" ? /^(\*|[A-Z][A-Z0-9_]{0,19})$/ : /^(\*|[A-Z0-9][A-Z0-9_]{0,9})$/;
    if (keys?.some((x) => !shape.test(x))) throw new ValidationError(`${k} lists ${kind === "jira" ? "Jira project keys, as in OPS" : "Linear team keys, as in ENG"} (or * for any)`);
    if (keys?.length) out[k] = [...new Set(keys)];
  }
  return out;
}

/** Whether a config change moves where secrets would be sent (see targetFields). */
export function targetChanged(kind: ConnectionKind, before: Record<string, string>, after: Record<string, string>): boolean {
  return KINDS[kind].targetFields.some((k) => (before[k] ?? "") !== (after[k] ?? ""));
}

/** A default name from the config, e.g. "PostgreSQL: orders". */
export function defaultName(kind: ConnectionKind, config: Record<string, string>): string {
  const label = KINDS[kind].label;
  const what = config.database && config.database !== "default" ? config.database : config.base_url ? new URL(config.base_url).host : config.account || config.project_id || config.channel || config.project_key || config.team || config.list_id || "";
  return what ? `${label}: ${what}` : label;
}

/** Whether the UI may see the tail of a stored secret field (see SecretSpec.showTail). */
export function showsTail(kind: ConnectionKind, key: string, config: Record<string, string>): boolean {
  const f = KINDS[kind].secretFields.find((s) => s.key === key);
  return typeof f?.showTail === "function" ? f.showTail(config) : !!f?.showTail;
}
