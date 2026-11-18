import { createHash } from "node:crypto";
import { redact } from "../redaction.js";
import { describeEndpointChange } from "./openapi.js";

/**
 * What a database sync finds, in one shape for every driver: tables and views with their columns. Hashing, comparing
 * two syncs (the schema history) and the generated "Columns (synced)" block of a table article live here.
 */

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  /** Part of the primary key. */
  pk?: boolean;
  /** The column it references, "schema.table.column". */
  fk?: string | null;
  comment?: string | null;
}

export interface TableDef {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: ColumnDef[];
  /** The database's own estimate, if it keeps one. */
  rows?: number | null;
  comment?: string | null;
  /** Views: the tables and views it reads ("schema.table"), so personal data masking follows it through the view. */
  uses?: string[];
}

/** Filters a sync applies: schema names or globs (orders_*), and how many tables to keep. */
export interface IntrospectFilter {
  include?: string[];
  exclude?: string[];
  /** One more than this is fetched, so a sync can tell the list was cut. */
  maxObjects: number;
}

export interface ColumnNote {
  column: string;
  description: string;
  pii: boolean;
}

export type ChangeKind = "added" | "removed" | "column_added" | "column_removed" | "type_changed" | "changed";
export interface SchemaChange {
  change: ChangeKind;
  detail: Record<string, unknown>;
}

export const tableKey = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;

/** A glob (orders_*) as a SQL LIKE pattern. */
export function likePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%");
}

export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  return re.test(value);
}

/** Whether a schema passes a sync's include and exclude lists. */
export function schemaWanted(schema: string, f: Pick<IntrospectFilter, "include" | "exclude">): boolean {
  if (f.include?.length && !f.include.some((g) => globMatch(g, schema))) return false;
  if (f.exclude?.some((g) => globMatch(g, schema))) return false;
  return true;
}

/** What a sync compares: the shape, not the row estimate (which changes all the time). */
export function definitionHash(t: TableDef): string {
  const shape = {
    kind: t.kind,
    comment: t.comment ?? null,
    columns: t.columns.map((c) => [c.name, c.type, c.nullable, c.default ?? null, !!c.pk, c.fk ?? null, c.comment ?? null]),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

const typeText = (c: ColumnDef) => `${c.type}${c.nullable ? "" : " not null"}`;

/** The differences between the last sync's definition of a table and this one's. */
export function diffTable(before: TableDef, after: TableDef): SchemaChange[] {
  const out: SchemaChange[] = [];
  const old = new Map(before.columns.map((c) => [c.name, c]));
  const now = new Map(after.columns.map((c) => [c.name, c]));
  for (const c of after.columns) if (!old.has(c.name)) out.push({ change: "column_added", detail: { column: c.name, type: typeText(c) } });
  for (const c of before.columns) if (!now.has(c.name)) out.push({ change: "column_removed", detail: { column: c.name, type: typeText(c) } });
  for (const c of after.columns) {
    const o = old.get(c.name);
    if (o && typeText(o) !== typeText(c)) out.push({ change: "type_changed", detail: { column: c.name, from: typeText(o), to: typeText(c) } });
  }
  return out;
}

/** Changes that can break code reading the table: a column or the table gone, or a column's type changed. */
export const BREAKING: ChangeKind[] = ["removed", "column_removed", "type_changed"];

/** One line per change, for history, notices and notifications. */
export function describeChange(key: string, c: { change: string; detail: Record<string, unknown> }): string {
  const d = c.detail as { column?: string; from?: string; to?: string; type?: string; kind?: string };
  switch (c.change) {
    case "added":
      return `${key}: new ${d.kind ?? "table"}`;
    case "removed":
      return `${key}: ${d.kind ?? "table"} removed`;
    case "column_added":
      return `${key}: column ${d.column} added (${d.type})`;
    case "column_removed":
      return `${key}: column ${d.column} removed`;
    case "type_changed":
      return `${key}: column ${d.column} changed from ${d.from} to ${d.to}`;
    case "changed":
      return describeEndpointChange(key, c.detail);
    default:
      return `${key}: ${c.change}`;
  }
}

// ---- The table article ----------------------------------------------------------------------------------------

export const SYNC_START = "<!-- thaliyola:sync -->";
export const SYNC_END = "<!-- /thaliyola:sync -->";
export const SYNC_HEADING = "## Columns (synced)";

/** Sections people and agents write; the synced block never touches them. */
export const WRITTEN_SECTIONS: [string, string][] = [
  ["Grain", "What one row represents."],
  ["Freshness and retention", "How often it updates, how late data can be, and how long it's kept."],
  ["Standard joins", "Which tables it joins to, and on which keys."],
  ["Gotchas", "Things that trip people up: duplicates, nulls, timezones, soft deletes."],
  ["Example queries", "Queries that answer common questions, in code blocks."],
];

/** Text in a Markdown table cell: one line, no pipes breaking the table. */
export function cell(s: string | null | undefined, max = 300): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  const cut = t.length > max ? `${t.slice(0, max)}…` : t;
  return cut.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

/** The generated block: where it comes from, then one row per column with the data dictionary's notes. */
export function renderSyncedBlock(
  t: TableDef,
  notes: Map<string, ColumnNote>,
  source: { connection: string; kind: string; removedAt?: string | null },
): string {
  const lines: string[] = [SYNC_START];
  // No row count: it changes all the time, and the article only changes when the schema does.
  lines.push([`Synced from **${cell(source.connection)}** (${source.kind})`, `\`${cell(tableKey(t))}\``, t.kind === "view" ? "view" : "table"].join(" · "));
  if (source.removedAt) lines.push("", `> **Removed:** the sync on ${source.removedAt.slice(0, 10)} didn't find this ${t.kind}. The columns below are as last seen.`);
  // Free text from the database or the dictionary goes through the redaction rules, like any other write.
  const free = (s: string | null | undefined, max?: number) => cell(s ? redact(s).text : s, max);
  if (t.comment) lines.push("", free(t.comment, 1000));
  lines.push("", "| Column | Type | Null | Key | Description |", "| --- | --- | --- | --- | --- |");
  for (const c of t.columns) {
    const note = notes.get(c.name);
    const key = [c.pk ? "PK" : "", c.fk ? `FK → ${cell(c.fk)}` : ""].filter(Boolean).join(", ");
    const desc = [note?.pii ? "**PII**" : "", free(note?.description || c.comment || "")].filter(Boolean).join(" ");
    lines.push(`| \`${cell(c.name)}\` | ${cell(c.type)} | ${c.nullable ? "yes" : "no"} | ${key} | ${desc} |`);
  }
  if (!t.columns.length) lines.push("| | | | | |");
  lines.push(SYNC_END);
  return lines.join("\n");
}

/** A new table article: the synced block, then the sections people and agents fill in (with writing hints). */
export function newTableBody(block: string): string {
  const written = WRITTEN_SECTIONS.map(([h, hint]) => `## ${h}\n\n<!-- Hint: ${hint} -->\n`).join("\n");
  return `${SYNC_HEADING}\n\n${block}\n\n${written}`;
}

/**
 * Puts a new synced block into an article, leaving everything else as it is: between the markers when they're there;
 * otherwise in place of the "Columns (synced)" section; otherwise at the top.
 */
export function replaceSyncedBlock(body: string, block: string, heading = SYNC_HEADING): string {
  const start = body.indexOf(SYNC_START);
  const end = body.indexOf(SYNC_END, start + 1);
  if (start >= 0 && end > start) return body.slice(0, start) + block + body.slice(end + SYNC_END.length);
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (at >= 0) {
    let next = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l));
    if (next < 0) next = lines.length;
    return [...lines.slice(0, at + 1), "", block, "", ...lines.slice(next)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return `${heading}\n\n${block}\n\n${body.trimStart()}`;
}

/** The synced block currently in an article (to compare before writing). */
export function currentSyncedBlock(body: string): string | null {
  const start = body.indexOf(SYNC_START);
  const end = body.indexOf(SYNC_END, start + 1);
  return start >= 0 && end > start ? body.slice(start, end + SYNC_END.length) : null;
}
