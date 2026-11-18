/**
 * Skills for Claude: shapes the API returns and small pure helpers shared by the Skills pages, Review › Skills, the
 * Connect card and Account. Downloads and uploads go through fetch here because they carry binary bodies.
 *
 * No React in this module.
 */
import { ApiError, getToken, type SkillDeliveryState } from "../api";
import type { Tone } from "./labels";

// ---- Shapes ------------------------------------------------------------------------------------------------------

export interface SkillFlag {
  kind: string;
  path: string;
  line?: number;
  message: string;
  high_risk: boolean;
}

export interface Connector {
  name: string;
  type?: string;
  url: string;
}

export interface Delivery {
  mode: "on" | "off" | "admins";
  state: SkillDeliveryState;
  message: string | null;
  send_to_claude?: boolean;
}

export interface MySkill {
  id: string;
  name: string;
  collection: { slug: string; name: string | null } | null;
  description: string;
  version: number;
  upstream_version: string | null;
  has_scripts: boolean;
  allowed_tools: string | null;
  requires_connectors: Connector[];
  updated_at: string | null;
  downloaded_version: number | null;
  update_available: boolean;
  frequent?: boolean;
}

export interface MySkills {
  delivery: Delivery;
  sync: { last_seen_at: string | null };
  skills: MySkill[];
}

export interface SkillListRow {
  id: string;
  name: string;
  status: string;
  status_reason: string | null;
  detached: boolean;
  held_at_version: number | null;
  as_prompt: boolean;
  collection: { slug: string; name: string } | null;
  owner_project: { slug: string; name: string } | null;
  source: { id: string; name: string } | null;
  current: { version: number; upstream_version: string | null; description: string; published_at: string | null; has_scripts: boolean; allowed_tools: string | null } | null;
  pending: { version: number; created_at: string; author: string | null; high_risk: boolean; stale: boolean; guidance_only: boolean } | null;
  assignments: number;
  last_used_at: string | null;
  uses_30d: number;
  open_feedback: number;
}

export interface SkillFileInfo {
  path: string;
  size: number;
  kind: "text" | "binary";
  script: boolean;
  managed: boolean;
  deliver: boolean;
  sha256?: string;
}

export interface SkillVersionRow {
  version: number;
  state: string;
  summary: string;
  upstream_version: string | null;
  source_commit: string | null;
  import_id: string | null;
  base_version: number | null;
  restored_from: number | null;
  author: string | null;
  mine: boolean;
  reviewer: string | null;
  self_approved: boolean;
  /** Decided through Claude ("mcp") or with an API token ("token"); null in the web app. */
  decided_via?: string | null;
  created_via?: string | null;
  direct: boolean;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  has_scripts: boolean;
  allowed_tools: string | null;
  high_risk_flags: number;
  flags: number;
  guidance_only: boolean;
  stale: boolean;
  file_count: number;
  total_bytes: number;
  rollback?: boolean;
}

export interface SkillDetail {
  id: string;
  name: string;
  status: string;
  view: "assignee" | "manager";
  collection: { slug: string; name: string; description: string } | null;
  requires_connectors: Connector[];
  current: {
    version: number;
    upstream_version: string | null;
    description: string;
    frontmatter: Record<string, unknown>;
    has_scripts: boolean;
    allowed_tools: string | null;
    source_commit: string | null;
    published_at: string | null;
    skill_md: string | null;
    files: SkillFileInfo[];
    flags?: SkillFlag[];
  } | null;
  delivery: Delivery;
  assigned: boolean;
  why: string[];
  owner_project?: { slug: string; name: string } | null;
  source?: { id: string; name: string; kind: string; provider: string | null; repository: string | null; ref: string | null; path: string | null; detached: boolean; edit_hint: string | null } | null;
  held_at_version?: number | null;
  status_reason?: string | null;
  as_prompt?: boolean;
  pending_move?: { collection: { slug: string; name: string }; gains: { people: number; audiences: string[] }; can_decide: boolean } | null;
  versions?: SkillVersionRow[];
  can: { manage: boolean; review: boolean; approve: boolean; approve_hint?: string | null; usage: boolean; report: boolean; edit?: boolean; rollback?: boolean; publish_directly?: boolean };
}

export interface FileDiff {
  path: string;
  change: "added" | "removed" | "changed" | "same";
  kind: "text" | "binary";
  managed: boolean;
  deliver: boolean;
  before?: string | null;
  after?: string | null;
}

export interface SkillVersionDetail {
  skill: { id: string; name: string };
  version: number;
  state: string;
  summary: string;
  author: string | null;
  mine: boolean;
  reviewer: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  upstream_version: string | null;
  source_commit: string | null;
  source_ref: string | null;
  import_id: string | null;
  base_version: number | null;
  restored_from: number | null;
  stale: boolean;
  has_scripts: boolean;
  allowed_tools: string | null;
  flags: SkillFlag[];
  guidance_hash: string | null;
  files: SkillFileInfo[];
  diff: FileDiff[];
  diff_against_current: FileDiff[] | null;
  can: { approve: boolean; reject: boolean; rollback: boolean; needs_checked_tools: boolean; needs_checked_flags: boolean };
}

export interface Assignment {
  id: string;
  on: "skill" | "collection";
  audience: string;
  role: { key: string; name: string } | null;
  team: { slug: string; name: string } | null;
  project: { slug: string | null; name: string } | null;
  label: string;
  created_at: string;
  created_by: string | null;
}

export interface Collection {
  id: string;
  slug: string;
  name: string;
  description: string;
  connectors: Connector[];
  upstream_version: string | null;
  removed_at: string | null;
  owner_project: { slug: string; name: string } | null;
  source: { id: string; name: string } | null;
  skills: number;
  assignments: number;
}

export interface ImportReport {
  source?: string | null;
  commit?: string | null;
  ref?: string | null;
  layout?: string | null;
  dry_run?: boolean;
  forced?: boolean;
  unchanged_all?: boolean;
  message?: string;
  collections?: { slug: string; name: string; created: boolean; skills: number; connectors: Connector[]; renamed_from?: string; removed?: boolean; not_imported?: boolean; pending_change?: boolean }[];
  added?: { name: string; collection?: string; version: number; state?: string; upstream_version?: string | null; flags?: number; high_risk_flags?: number }[];
  changed?: { name: string; from?: number | null; to?: number; version?: number; state?: string; files_changed?: number; guidance_only?: boolean; high_risk_flags?: number; superseded?: number }[];
  unchanged?: { name: string; version?: number | null }[];
  withdrawn?: { name: string; version: number; reason: string }[];
  delivery_narrowed?: { name: string; version: number; withheld: string[] }[];
  rejected_before?: { name: string; version: number; reason: string | null }[];
  held?: { name: string; at: number; upstream_changed: boolean }[];
  detached?: { name: string; upstream_changed: boolean }[];
  adoptable?: { name: string; skill_id: string; path: string }[];
  moved?: { name: string; from: string | null; to: string; pending: boolean; declined?: boolean; gains: { people: number; audiences: string[] } }[];
  rejected?: { path?: string; name?: string; title?: string; reasons: string[] }[];
  removed?: { name: string }[];
  reactivated?: { name: string }[];
  not_covered?: { name: string; skill_id: string; path: string | null }[];
  excluded?: { path: string; suggested: boolean }[];
  suggested_excludes?: string[];
  ignored?: string[];
  stamped?: { name: string; files: string[] }[];
  warnings?: { path?: string; message: string }[];
  counts?: Record<string, number>;
}

export interface SkillImport {
  id: string;
  kind: "git" | "upload" | "articles";
  status: "running" | "done" | "failed";
  dry_run: boolean;
  scheduled: boolean;
  forced?: boolean;
  ref: string | null;
  commit: string | null;
  filename: string | null;
  layout: string | null;
  report?: ImportReport;
  counts?: Record<string, number> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  source: { id: string; name: string } | null;
  started_by: string | null;
}

export interface SkillSource {
  id: string;
  name: string;
  kind: "git" | "upload";
  provider: "gitlab" | "github" | null;
  repository: string | null;
  ref: string | null;
  path: string;
  exclude: string[];
  no_deliver: string[];
  api_url: string | null;
  owner_project: { slug: string; name: string } | null;
  connection: { id: string; name: string; enabled: boolean; space: string | null; space_name: string } | null;
  token: { set: boolean; hint: string | null };
  publish_directly: boolean;
  interval_minutes: number | null;
  enabled: boolean;
  run_as: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_commit: string | null;
  last_error: string | null;
  failures: number;
  skills: number;
  last_import: { id: string; status: string; started_at: string; finished_at: string | null; commit: string | null; error: string | null; dry_run: boolean; counts: Record<string, number> | null } | null;
  created_at: string;
  /** A git source's push webhook: where GitLab or GitHub sends pushes, and whether its secret is set. */
  webhook: { path: string; url: string | null; secret: { set: boolean; hint: string | null }; last_at: string | null; queued_at: string | null } | null;
}

export interface SkillSources {
  sources: SkillSource[];
  git_connections: { id: string; name: string; provider: string | null; enabled: boolean; space: string; space_name: string }[];
  can: { create: boolean; publish_directly: boolean; store_tokens: boolean };
  git_hosts: string[];
  suggested_no_deliver: string[];
}

export interface SkillFeedback {
  id: string;
  skill_id: string;
  name: string;
  version: number | null;
  body: string;
  via: "web" | "mcp";
  state: "open" | "resolved" | "dismissed";
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
  author: string | null;
  mine: boolean;
  resolved_by: string | null;
}

export interface SkillReviewVersion {
  skill_id: string;
  name: string;
  collection: string | null;
  version: number;
  summary: string;
  author: string | null;
  mine: boolean;
  created_at: string;
  base_version: number | null;
  stale: boolean;
  source: string | null;
  source_commit: string | null;
  has_scripts: boolean;
  allowed_tools: string | null;
  flags: SkillFlag[];
  high_risk_flags: number;
  guidance_hash: string | null;
  import_id: string | null;
  can_approve: boolean;
  can_reject: boolean;
}

export interface CollectionMeta {
  name: string;
  description: string;
  connectors: Connector[];
}

export interface SkillCollectionChange {
  slug: string;
  source: string | null;
  started_by: string | null;
  at: string;
  from: CollectionMeta;
  to: CollectionMeta;
  new_hosts: string[];
  can_decide: boolean;
}

export interface SkillReview {
  versions: SkillReviewVersion[];
  guidance_groups: { guidance_hash: string; skills: { skill_id: string; name: string; version: number; mine: boolean }[] }[];
  import_groups: { import_id: string; source: string | null; source_commit: string | null; versions: number; approvable: number }[];
  audience_changes: { skill_id: string; name: string; from: string | null; to: string; started_by: string | null; gains: { people: number; audiences: string[] }; can_decide: boolean }[];
  collection_changes: SkillCollectionChange[];
  feedback: SkillFeedback[];
  counts: { to_review: number; pending: number; feedback: number };
}

/** The Connect page's skills block (/connect-info). */
export interface SkillsConnect {
  delivery: "on" | "off" | "admins";
  state: SkillDeliveryState;
  message: string | null;
  send_to_claude: boolean;
  script_url: string;
  sync_command: string;
  run_command: string;
  hook_snippet: unknown;
  folder_example: string;
  last_sync_at: string | null;
}

// ---- Helpers -----------------------------------------------------------------------------------------------------

/**
 * Invisible and direction-changing characters a reviewer can't see in rendered text (zero-width, bidi controls, soft
 * hyphen, word joiners, BOM and the Unicode tag block), shown as visible ⟨U+200B⟩ tokens.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

export function showInvisible(text: string): string {
  return text.replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

export const hasInvisible = (text: string) => new RegExp(INVISIBLE.source, "u").test(text);

/** "v7 · 3.11.0 upstream". */
export function versionLine(version: number | null | undefined, upstream?: string | null): string {
  if (version == null) return "Not published yet";
  return upstream ? `v${version} · ${upstream} upstream` : `v${version}`;
}

/** An upstream version worth showing: "0.0.0" placeholders (plugins that never set one) are dropped. */
export const upstreamLabel = (v: string | null | undefined): string | null => (v && !/^0+(\.0+)*$/.test(v.trim()) ? v : null);

/** The status badge's meaning: a skill whose first version isn't published yet reaches nobody, whatever its own state. */
export function skillStatusKey(status: string, published: boolean): string {
  return published || status !== "active" ? status : "unpublished";
}

/** A short commit for display. */
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

/** High-risk flags first, then by file and line. */
export function sortFlags(flags: SkillFlag[]): SkillFlag[] {
  return [...flags].sort((a, b) => Number(b.high_risk) - Number(a.high_risk) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** The banner for a delivery state other than "on" (null when skills reach Claude). */
export function deliveryNotice(state: SkillDeliveryState | undefined, isAdmin = false): { tone: Tone & ("warning" | "neutral"); title: string; body: string; action?: "account" | "system" } | null {
  switch (state) {
    case "off":
      return {
        tone: "warning",
        title: "Skills are switched off by an Administrator",
        body: isAdmin
          ? "Claude gets no skills from Thaliyola: the skill tools say they're switched off, downloads are refused and the Claude Code sync removes the skills it installed. You can still write, import and review skills."
          : "Claude gets no skills from Thaliyola for now. Your skills are listed here so you know what you'll get when they're back.",
        action: isAdmin ? "system" : undefined,
      };
    case "admins_only":
      return { tone: "neutral", title: "Skills are being piloted by Administrators", body: "Only Administrators get their skills for now. These are the ones you'll get when the pilot ends." };
    case "opted_out":
      return { tone: "neutral", title: "You switched off sending your skills to Claude", body: "Claude doesn't get your skills, and the Claude Code sync removes the ones it installed. Turn it back on in Account › Skills for Claude.", action: "account" };
    default:
      return null;
  }
}

/** Why the Approve button isn't offered to this person (the second-person rule), or null. */
export function approveBlockReason(v: { state: string; mine: boolean; can: { approve: boolean } }): string | null {
  if (v.state !== "pending" || v.can.approve) return null;
  return v.mine ? "Someone else must approve this (you proposed it)." : null;
}

/** Human size: 12 KB, 1.4 MB. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Globs typed one per line or comma-separated: trimmed, deduplicated, empty ones dropped. */
export function parseGlobs(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((g) => g.trim()).filter(Boolean))];
}

/** A file list as an indented tree: folders first at each level, then files, all sorted. */
export function fileTree<T extends { path: string }>(files: T[]): ({ kind: "folder"; path: string; name: string; depth: number } | { kind: "file"; file: T; name: string; depth: number })[] {
  const out: ({ kind: "folder"; path: string; name: string; depth: number } | { kind: "file"; file: T; name: string; depth: number })[] = [];
  const walk = (prefix: string, depth: number) => {
    const here = files.filter((f) => f.path.startsWith(prefix));
    const folders = [...new Set(here.map((f) => f.path.slice(prefix.length)).filter((r) => r.includes("/")).map((r) => r.split("/")[0]!))].sort();
    const direct = here.filter((f) => !f.path.slice(prefix.length).includes("/")).sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
    for (const f of direct) out.push({ kind: "file", file: f, name: f.path.slice(prefix.length), depth });
    for (const d of folders) {
      out.push({ kind: "folder", path: `${prefix}${d}`, name: d, depth });
      walk(`${prefix}${d}/`, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function failFrom(res: Response): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new ApiError(res.status, body?.error ?? res.statusText, body);
}

/** Fetches a binary answer and hands it to the browser as a download. */
export async function downloadFrom(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: authHeaders(), credentials: "same-origin" });
  if (!res.ok) await failFrom(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "Add to my Claude": the skill's published version as <name>.zip. */
export const downloadSkill = (id: string, name: string) => downloadFrom(`/skills/${id}/download`, `${name}.zip`);

/** Uploads a .zip or .tar.gz to the importer (raw body). */
export async function uploadSkillArchive(file: File, query: Record<string, string | undefined>): Promise<{ import_id: string; status: "done" | "failed"; report: ImportReport; error?: string }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, filename: file.name })) if (v) params.set(k, v);
  const res = await fetch(`/api/skills/import/upload?${params}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/octet-stream", accept: "application/json" },
    body: file,
    credentials: "same-origin",
  });
  if (!res.ok) await failFrom(res);
  return res.json();
}

/** The counts row of an import report, in the report's section order. */
export function reportCounts(r: ImportReport): { key: string; n: number }[] {
  const keys = ["added", "changed", "unchanged", "rejected", "rejected_before", "moved", "held", "removed"] as const;
  return keys.map((k) => ({ key: k, n: r.counts?.[k] ?? (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0) }));
}
