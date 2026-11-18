import type { NetPolicy } from "./network.js";

export const CONNECTION_KINDS = ["postgres", "redshift", "mysql", "clickhouse", "snowflake", "bigquery", "http_api", "git", "slack", "trello", "jira", "linear"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const DATABASE_KINDS: readonly ConnectionKind[] = ["postgres", "redshift", "mysql", "clickhouse", "snowflake", "bigquery"];

export interface ConnectionOptions {
  /** Databases: people and agents who write in the project may run read-only queries. */
  allow_query?: boolean;
  /** APIs: whether call_api may use the connection at all (on unless false). */
  allow_calls?: boolean;
  /** APIs: methods besides GET and HEAD that call_api may use. */
  allow_write_methods?: string[];
  /** APIs: call_api may only reach paths under these prefixes. */
  path_prefixes?: string[];
  /** Databases: schemas to sync (all when empty), and schemas to skip. */
  schemas_include?: string[];
  schemas_exclude?: string[];
  /** Most tables or endpoints one sync keeps (default 500). */
  max_objects?: number;
  /**
   * Issue trackers: besides its own project (Jira) or team (Linear), the ones whose linked issues the connection reads
   * ("*": any its account can see). Issues of other projects stay plain links, without a title or status.
   */
  allowed_projects?: string[];
  allowed_teams?: string[];
}

/** A connection as a driver sees it: config, opened secret and options. Never sent anywhere. */
export interface ConnTarget {
  id: string;
  kind: ConnectionKind;
  config: Record<string, string>;
  secret: Record<string, string>;
  options: ConnectionOptions;
}

export interface DriverEnv {
  net: NetPolicy;
  /** Per statement or request. */
  timeoutMs: number;
  /** Tests only: API base URLs. */
  endpoints?: Partial<Record<string, string>>;
}

export interface TestResult {
  /** One sentence for people: what was reached and as whom. */
  detail: string;
  /** Something to fix even though it works (e.g. a database user that can write). */
  warning?: string;
}

/** A query's limits: rows kept (one more is fetched to tell the result was cut) and time allowed. */
export interface QueryLimits {
  maxRows: number;
  timeoutMs: number;
}

/** Where a result column comes from, when the database says (a plain column of a table). */
export interface FieldOrigin {
  schema: string;
  table: string;
  column: string;
}

/** A driver's raw query result: column names, their origins if known, rows as arrays, and whether it was cut. */
export interface RawResult {
  /** `scalar`: a number or boolean type, which can't carry a row's text (a count of a table with personal data). */
  fields: { name: string; origin: FieldOrigin | null; scalar?: boolean }[];
  rows: unknown[][];
  truncated: boolean;
  /** Why it was cut, when it wasn't the row cap: the result grew past the size limit. */
  cut?: "size";
}
