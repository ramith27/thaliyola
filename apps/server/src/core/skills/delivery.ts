import { strToU8, zipSync } from "fflate";
import type { Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { isAdmin, readableScopes } from "../permissions.js";
import { versionFiles } from "./prepare.js";
import { splitFrontmatter } from "./stamp.js";
import { contentHash, DELIVERY_MESSAGES, sha256, SKILL_PART_CHARS, syncDirOf, textOf, type DeliveryState } from "./types.js";

/**
 * Which skills reach Claude for whom, and the three routes: the MCP connector (list_skills / get_skill /
 * get_skill_file and skill prompts), the "Add to my Claude" zip, and the Claude Code sync. Only published versions
 * and only files marked for delivery ever leave through here.
 */

export interface Delivery {
  /** The organisation-wide mode (Admin › System). */
  mode: "on" | "off" | "admins";
  /** What it means for the caller. */
  state: DeliveryState;
  message: string | null;
  /** The caller's own preference (Account › Skills for Claude). */
  send_to_claude: boolean;
}

/**
 * Read fresh on every call (one query), so a change takes effect at once on every replica, without waiting for the
 * 30-second settings reload.
 */
export async function deliveryState(ctx: RequestContext): Promise<Delivery> {
  const { rows } = await ctx.db.query<{ mode: unknown; pref: unknown }>(
    "SELECT (SELECT value FROM system_settings WHERE key = 'skills_delivery') AS mode, (SELECT prefs->'skills_to_claude' FROM users WHERE id = $1) AS pref",
    [ctx.actor.id],
  );
  const stored = rows[0]?.mode;
  const mode = stored === "on" || stored === "off" || stored === "admins" ? stored : (ctx.settings.skillsDelivery ?? "on");
  const send = rows[0]?.pref !== false;
  const state: DeliveryState = mode === "off" ? "off" : mode === "admins" && !isAdmin(ctx) ? "admins_only" : !send ? "opted_out" : "on";
  return { mode, state, message: state === "on" ? null : DELIVERY_MESSAGES[state], send_to_claude: send };
}

export interface Deliverable {
  id: string;
  name: string;
  owner_scope_id: string | null;
  collection_slug: string | null;
  collection_name: string | null;
  connectors: { name: string; type: string; url: string }[];
  version_id: string;
  version: number;
  description: string;
  upstream_version: string | null;
  has_scripts: boolean;
  allowed_tools: string | null;
  as_prompt: boolean;
  published_at: string | null;
}

/**
 * SQL matching assignment `a` for one person, with their org roles ($roles), teams ($teams), Administrator flag
 * ($admin) and the projects they reach (the `reach` CTE: each project they hold a role in, and every project above it,
 * active ones only). Assignments flow down: a project assignment reaches people with a role anywhere under it.
 */
const MATCH = (a: string, roles: string, teams: string, admin: string) => `(
       ${a}.audience = 'everyone'
    OR (${a}.audience = 'org_role' AND (${a}.role = ANY (${roles}::text[]) OR (${a}.role = 'admin' AND ${admin})))
    OR (${a}.audience = 'team' AND ${a}.team_id = ANY (${teams}::uuid[]))
    OR (${a}.audience = 'project' AND ${a}.scope_id IN (SELECT ancestor_id FROM reach))
    OR (${a}.audience = 'project_role' AND EXISTS (SELECT 1 FROM reach r WHERE r.role = ${a}.role AND (${a}.scope_id IS NULL OR r.ancestor_id = ${a}.scope_id))))`;

const REACH = (user: string) => `RECURSIVE mine AS (
    SELECT DISTINCT sr.scope_id, sr.role FROM scope_roles sr JOIN scopes s ON s.id = sr.scope_id
     WHERE sr.user_id = ${user} AND s.status = 'active' AND s.kind = 'project'
  ), up (scope_id, role, ancestor_id, depth) AS (
    SELECT scope_id, role, scope_id, 0 FROM mine
    UNION ALL
    SELECT up.scope_id, up.role, s.parent_id, up.depth + 1 FROM up JOIN scopes s ON s.id = up.ancestor_id WHERE s.parent_id IS NOT NULL AND up.depth < 6
  ), reach AS (
    SELECT DISTINCT up.ancestor_id, up.role FROM up JOIN scopes a ON a.id = up.ancestor_id AND a.status = 'active'
  )`;

const cache = new WeakMap<RequestContext, Promise<Deliverable[]>>();

/** The skills assigned to the caller (active, published, readable owner), whatever the delivery mode. */
export function assignedSkills(ctx: RequestContext): Promise<Deliverable[]> {
  let hit = cache.get(ctx);
  if (!hit) {
    hit = load(ctx);
    cache.set(ctx, hit);
    hit.catch(() => cache.delete(ctx));
  }
  return hit;
}

async function load(ctx: RequestContext): Promise<Deliverable[]> {
  const db = ctx.db;
  const roles = (await db.query<{ role: string }>("SELECT role FROM user_roles WHERE user_id = $1", [ctx.actor.id])).rows.map((r) => r.role);
  const teams = (await db.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id = $1", [ctx.actor.id])).rows.map((r) => r.team_id);
  const readable = await readableScopes(ctx);
  const { rows } = await db.query<Deliverable>(
    `WITH ${REACH("$1")}
     SELECT sk.id, sk.name, sk.owner_scope_id, c.slug AS collection_slug, c.name AS collection_name, coalesce(c.connectors, '[]') AS connectors,
            v.id AS version_id, v.version, v.description, v.upstream_version, v.has_scripts, v.allowed_tools, sk.as_prompt, v.decided_at AS published_at
       FROM skills sk
       JOIN skill_versions v ON v.id = sk.current_version_id
       LEFT JOIN skill_collections c ON c.id = sk.collection_id
      WHERE sk.status = 'active'
        AND (sk.owner_scope_id IS NULL OR $5::uuid[] IS NULL OR sk.owner_scope_id = ANY ($5::uuid[]))
        AND EXISTS (SELECT 1 FROM skill_assignments a
                     WHERE (a.skill_id = sk.id OR (sk.collection_id IS NOT NULL AND a.collection_id = sk.collection_id))
                       AND ${MATCH("a", "$2", "$3", "$4")})
      ORDER BY sk.name`,
    [ctx.actor.id, roles, teams, isAdmin(ctx), readable],
  );
  return rows;
}

/** Deliverable skills: assigned ones while delivery is on for the caller, nothing otherwise. */
export async function deliverableSkills(ctx: RequestContext): Promise<{ delivery: Delivery; skills: Deliverable[] }> {
  const delivery = await deliveryState(ctx);
  if (delivery.state !== "on") return { delivery, skills: [] };
  return { delivery, skills: await assignedSkills(ctx) };
}

/**
 * The caller's skills ordered for the server instructions, which have room to describe only the first ones: what
 * they used in the last 90 days, then what everyone used, then by name.
 */
export async function rankedForInstructions(ctx: RequestContext, skills: Deliverable[]): Promise<Deliverable[]> {
  if (skills.length < 2) return skills;
  const { rows } = await ctx.db.query<{ skill_id: string; mine: number; all: number }>(
    `SELECT skill_id, count(*) FILTER (WHERE user_id = $2)::int AS mine, count(*)::int AS all
       FROM skill_usage WHERE skill_id = ANY ($1::uuid[]) AND at > now() - interval '90 days' GROUP BY skill_id`,
    [skills.map((s) => s.id), ctx.actor.id],
  );
  const use = new Map(rows.map((r) => [r.skill_id, r]));
  return [...skills].sort((a, b) => {
    const x = use.get(a.id);
    const y = use.get(b.id);
    return (y?.mine ?? 0) - (x?.mine ?? 0) || (y?.all ?? 0) - (x?.all ?? 0) || a.name.localeCompare(b.name);
  });
}

/** People who match any of the given assignments (for "who gains access" previews). */
export async function peopleMatching(db: Queryable, adminEmails: string[], assignmentIds: string[]): Promise<Set<string>> {
  if (!assignmentIds.length) return new Set();
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.disabled_at IS NULL AND u.subject NOT LIKE 'pending:%'
        AND EXISTS (
          SELECT 1 FROM skill_assignments a
           WHERE a.id = ANY ($1::uuid[]) AND (
                 a.audience = 'everyone'
              OR (a.audience = 'org_role' AND (EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = a.role)
                                             OR (a.role = 'admin' AND u.kind = 'human' AND (u.is_admin OR lower(u.email) = ANY ($2::text[])))))
              OR (a.audience = 'team' AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = u.id AND tm.team_id = a.team_id))
              OR (a.audience = 'project' AND EXISTS (SELECT 1 FROM scope_subtree st JOIN scope_roles sr ON sr.scope_id = st.scope_id
                                                     JOIN scopes ss ON ss.id = st.scope_id AND ss.status = 'active'
                                                    WHERE st.root_id = a.scope_id AND sr.user_id = u.id))
              OR (a.audience = 'project_role' AND EXISTS (SELECT 1 FROM scope_roles sr JOIN scopes ss ON ss.id = sr.scope_id AND ss.status = 'active' AND ss.kind = 'project'
                                                         WHERE sr.user_id = u.id AND sr.role = a.role
                                                           AND (a.scope_id IS NULL OR sr.scope_id IN (SELECT st.scope_id FROM scope_subtree st WHERE st.root_id = a.scope_id))))))`,
    [assignmentIds, adminEmails],
  );
  return new Set(rows.map((r) => r.id));
}

// ---- usage --------------------------------------------------------------------------------------------------------

export type UsageChannel = "mcp" | "file" | "prompt" | "download" | "sync";

export async function recordUsage(db: Queryable, skillId: string, version: number, userId: string, channel: UsageChannel) {
  await db.query("INSERT INTO skill_usage (skill_id, version, user_id, channel) VALUES ($1, $2, $3, $4)", [skillId, version, userId, channel]);
}

// ---- reading published content --------------------------------------------------------------------------------

async function skillMdOf(db: Queryable, versionId: string): Promise<string> {
  const { rows } = await db.query<{ data: Buffer }>("SELECT b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 WHERE f.version_id = $1 AND f.path = 'SKILL.md'", [
    versionId,
  ]);
  return rows[0] ? (textOf(rows[0].data) ?? "") : "";
}

/** Splits text into parts of at most SKILL_PART_CHARS characters, at a line break where there is one. */
export function splitParts(text: string, size = SKILL_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size - 1) + 1;
    if (cut <= 0) cut = size;
    // Never split a surrogate pair.
    if (cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1]!)) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

const notAvailable = (name: string) => new NotFoundError("skill", `no skill named '${name.slice(0, 80)}' is available to you; list_skills shows yours`);

/** One deliverable skill by name; the delivery message (switched off, opted out, pilot) as a ForbiddenError. */
export async function deliveredByName(ctx: RequestContext, name: string): Promise<Deliverable> {
  const { delivery, skills } = await deliverableSkills(ctx);
  if (delivery.state !== "on") throw new ForbiddenError(delivery.message!);
  const hit = skills.find((s) => s.name === name.trim());
  if (!hit) throw notAvailable(name);
  return hit;
}

export interface FileInfo {
  path: string;
  size: number;
  kind: "text" | "binary";
  script: boolean;
}

async function deliveredFiles(db: Queryable, versionId: string): Promise<FileInfo[]> {
  const { rows } = await db.query<{ path: string; size: number; kind: "text" | "binary"; is_script: boolean }>(
    "SELECT path, size, kind, is_script FROM skill_files WHERE version_id = $1 AND deliver AND path <> 'SKILL.md' ORDER BY path COLLATE \"C\"",
    [versionId],
  );
  return rows.map((r) => ({ path: r.path, size: r.size, kind: r.kind, script: r.is_script }));
}

export interface AgentSkill {
  meta: Record<string, unknown>;
  text: string | null;
  already?: string;
}

/** get_skill: metadata plus one part of the raw SKILL.md. Usage is recorded on part 1. */
export async function getSkillForAgent(ctx: RequestContext, name: string, opts: { part?: number; have_version?: number; channel?: UsageChannel } = {}): Promise<AgentSkill> {
  const s = await deliveredByName(ctx, name);
  if (opts.have_version !== undefined && opts.have_version === s.version) {
    return { meta: { name: s.name, version: s.version }, text: null, already: `You already have version ${s.version} of '${s.name}' in this conversation; use it.` };
  }
  const parts = splitParts(await skillMdOf(ctx.db, s.version_id));
  const part = Math.max(1, opts.part ?? 1);
  if (part > parts.length) throw new ValidationError(`'${s.name}' has ${parts.length} part${parts.length === 1 ? "" : "s"}`);
  if (part === 1) await recordUsage(ctx.db, s.id, s.version, ctx.actor.id, opts.channel ?? "mcp");
  return {
    meta: {
      name: s.name,
      version: s.version,
      upstream_version: s.upstream_version,
      collection: s.collection_slug,
      description: s.description,
      requires_connectors: s.connectors,
      files: await deliveredFiles(ctx.db, s.version_id),
      has_scripts: s.has_scripts,
      allowed_tools: s.allowed_tools,
      part,
      parts: parts.length,
      ...(part < parts.length ? { next_part: part + 1 } : {}),
    },
    text: parts[part - 1]!,
  };
}

export type AgentFile =
  | { kind: "text"; meta: Record<string, unknown>; text: string }
  | { kind: "image" | "binary"; meta: Record<string, unknown>; data: Buffer; mimeType: string };

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** get_skill_file: one delivered file of the published version (text in parts from `offset`). */
export async function getSkillFileForAgent(ctx: RequestContext, name: string, path: string, offset = 0): Promise<AgentFile> {
  const s = await deliveredByName(ctx, name);
  const clean = path.trim().replace(/^\.?\/+/, "");
  const { rows } = await ctx.db.query<{ path: string; size: number; kind: "text" | "binary"; data: Buffer }>(
    "SELECT f.path, f.size, f.kind, b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 WHERE f.version_id = $1 AND f.path = $2 AND f.deliver",
    [s.version_id, clean],
  );
  const f = rows[0];
  if (!f) throw new NotFoundError("file", `'${s.name}' has no file '${clean.slice(0, 200)}' available; get_skill lists its files`);
  await recordUsage(ctx.db, s.id, s.version, ctx.actor.id, "file");
  const meta = { name: s.name, version: s.version, path: f.path, size: f.size };
  if (f.kind === "text") {
    const text = textOf(f.data) ?? "";
    const start = Math.max(0, Math.min(offset, text.length));
    let end = Math.min(text.length, start + SKILL_PART_CHARS);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl >= start) end = nl + 1;
    }
    return { kind: "text", meta: { ...meta, offset: start, ...(end < text.length ? { next_offset: end } : {}) }, text: text.slice(start, end) };
  }
  if (f.size > 2 * 1024 * 1024) throw new ValidationError(`${f.path} is too large to send here (${Math.round(f.size / 1024)} KB); download the skill instead`);
  const ext = f.path.slice(f.path.lastIndexOf(".")).toLowerCase();
  const image = IMAGE_TYPES[ext];
  return image ? { kind: "image", meta, data: f.data, mimeType: image } : { kind: "binary", meta, data: f.data, mimeType: "application/octet-stream" };
}

/** list_skills: the caller's skills, optionally narrowed by words or collection. */
export async function listSkillsForAgent(ctx: RequestContext, opts: { query?: string; collection?: string } = {}) {
  const { delivery, skills } = await deliverableSkills(ctx);
  if (delivery.state !== "on") return { delivery: delivery.state, skills: [], message: delivery.message };
  const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const files = await fileCounts(ctx.db, skills.map((s) => s.version_id));
  const list = skills
    .filter((s) => !opts.collection || s.collection_slug === opts.collection.trim())
    .filter((s) => words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)))
    .map((s) => ({
      name: s.name,
      collection: s.collection_slug,
      description: s.description,
      version: s.version,
      upstream_version: s.upstream_version,
      has_scripts: s.has_scripts,
      requires_connectors: s.connectors.map((c) => c.name),
      files: files.get(s.version_id) ?? 0,
    }));
  const seen = (await ctx.db.query<{ at: string }>("SELECT at FROM skill_sync_seen WHERE user_id = $1 AND at > now() - interval '7 days'", [ctx.actor.id])).rows[0];
  return {
    delivery: "on" as const,
    skills: list,
    ...(seen ? { local_copy_hint: `You synced Thaliyola skills to Claude Code on ${new Date(seen.at).toISOString().slice(0, 10)}; prefer the installed thaliyola-<name> skills there.` } : {}),
    next: "Load the matching one with get_skill before starting the task; load each skill once per conversation.",
  };
}

async function fileCounts(db: Queryable, versionIds: string[]): Promise<Map<string, number>> {
  if (!versionIds.length) return new Map();
  const { rows } = await db.query<{ version_id: string; n: number }>(
    "SELECT version_id, count(*)::int AS n FROM skill_files WHERE version_id = ANY ($1::uuid[]) AND deliver AND path <> 'SKILL.md' GROUP BY version_id",
    [versionIds],
  );
  return new Map(rows.map((r) => [r.version_id, r.n]));
}

/**
 * The catalogue line for the list_skills tool description, within `budget` characters: the name and what the skill is
 * for, preferring its "Use when …" / "Use for …" sentence (the trigger phrases Claude matches on), cut at a word.
 */
export function skillCatalogLine(s: { name: string; description: string }, budget = 160): string {
  const d = s.description.replace(/\s+/g, " ").trim();
  const use = /(?:^|[.;!?]\s+)(Use (?:it |this )?(?:when|for|to|if)\b[^.;!?]*)/i.exec(d)?.[1]?.trim();
  let text = use && use.length >= 20 ? use : d.replace(/[.;:]+$/, "");
  const room = budget - s.name.length - 3;
  if (!text || room < 12) return s.name;
  if (text.length <= room) return `${s.name} (${text})`;
  // Short of room: drop the "Use when someone asks …" lead-in, so what's left is the trigger phrase itself.
  if (text === use) text = text.replace(/^Use (?:it |this )?(?:when|for|if|to)\s+(?:(?:someone|the user|a user|you)\s+(?:asks?|says?|wants?|needs?)\s+(?:(?:to|about|for|what|whether|if|how|which)\s+)?)?/i, "") || text;
  if (text.length <= room) return `${s.name} (${text})`;
  const cut = text.slice(0, room - 1);
  const atWord = cut.lastIndexOf(" ") > room / 2 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return `${s.name} (${atWord.replace(/[\s,;:.(–-]+$/, "")}…)`;
}

export const LIST_SKILLS_BASE =
  "List the team skills available to you (published in Thaliyola and assigned to you), with what each is for and the connectors it requires (requires_connectors). Before using a skill, check that you have tools from each required connector; if not, tell the user which connector to add (Settings → Connectors).";
const CATALOG_MAX = 1500;

/** The list_skills tool description for one caller: names their skills, capped at 1 500 characters. */
export function listSkillsDescription(skills: { name: string; description: string }[]): string {
  if (!skills.length) return LIST_SKILLS_BASE;
  const head = "List the team skills available to you. Team skills available to you: ";
  const tail = ". Load the matching one with get_skill before starting the task, and check you have tools from each connector it requires (else tell the user which to add in Settings → Connectors).";
  // What's left after the names is shared evenly, so every skill keeps some of its trigger phrases.
  const names = skills.reduce((n, s) => n + s.name.length + 6, 0);
  const share = Math.floor((CATALOG_MAX - head.length - tail.length - 30 - names) / skills.length);
  const lines = skills.map((s) => skillCatalogLine(s, s.name.length + 3 + Math.max(0, share)));
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const more = lines.length - i - 1;
    const next = `${out ? `${out}, ` : ""}${lines[i]}`;
    const suffix = more ? ` …and ${more} more: call list_skills` : "";
    if (head.length + next.length + suffix.length + tail.length > CATALOG_MAX) {
      return `${head}${out} …and ${lines.length - i} more: call list_skills${tail}`;
    }
    out = next;
  }
  return `${head}${out}${tail}`;
}

/** Skill prompts for the caller: deliverable skills offered as prompts, by name, at most 100. */
export async function skillPromptsFor(ctx: RequestContext): Promise<Deliverable[]> {
  const { skills } = await deliverableSkills(ctx);
  return skills.filter((s) => s.as_prompt).slice(0, 100);
}

// ---- My skills --------------------------------------------------------------------------------------------------

export async function mySkills(ctx: RequestContext) {
  const delivery = await deliveryState(ctx);
  const skills = await assignedSkills(ctx);
  const ids = skills.map((s) => s.id);
  const usage = ids.length
    ? (
        await ctx.db.query<{ skill_id: string; downloaded: number | null; recent_mcp: number }>(
          `SELECT skill_id, max(version) FILTER (WHERE channel = 'download') AS downloaded,
                  count(*) FILTER (WHERE channel = 'mcp' AND at > now() - interval '30 days')::int AS recent_mcp
             FROM skill_usage WHERE user_id = $1 AND skill_id = ANY ($2::uuid[]) GROUP BY skill_id`,
          [ctx.actor.id, ids],
        )
      ).rows
    : [];
  const byId = new Map(usage.map((u) => [u.skill_id, u]));
  const seen = (await ctx.db.query<{ at: string }>("SELECT at FROM skill_sync_seen WHERE user_id = $1", [ctx.actor.id])).rows[0];
  return {
    delivery: { mode: delivery.mode, state: delivery.state, message: delivery.message, send_to_claude: delivery.send_to_claude },
    sync: { last_seen_at: seen?.at ?? null },
    skills: skills.map((s) => {
      const u = byId.get(s.id);
      return {
        id: s.id,
        name: s.name,
        collection: s.collection_slug ? { slug: s.collection_slug, name: s.collection_name } : null,
        description: s.description,
        version: s.version,
        upstream_version: s.upstream_version,
        has_scripts: s.has_scripts,
        allowed_tools: s.allowed_tools,
        requires_connectors: s.connectors,
        updated_at: s.published_at,
        downloaded_version: u?.downloaded ?? null,
        update_available: u?.downloaded != null && u.downloaded < s.version,
        frequent: (u?.recent_mcp ?? 0) >= 3,
      };
    }),
  };
}

/** "Send my skills to Claude" for the caller; audited. */
export async function setSkillPreference(ctx: RequestContext, send: boolean) {
  const before = await deliveryState(ctx);
  await ctx.db.query("UPDATE users SET prefs = prefs || jsonb_build_object('skills_to_claude', $2::boolean) WHERE id = $1", [ctx.actor.id, send]);
  if (before.send_to_claude !== send) {
    await audit(ctx.db, ctx.actor.id, "set_skill_preference", ctx.actor.id, { targetKind: ctx.actor.kind === "service" ? "service_account" : "person", targetLabel: ctx.actor.name || ctx.actor.email, details: { from: before.send_to_claude, to: send } });
  }
  const after = await deliveryState(ctx);
  return { send_to_claude: send, delivery: { mode: after.mode, state: after.state, message: after.message } };
}

// ---- zip ------------------------------------------------------------------------------------------------------------

const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);

/** "Add to my Claude": the published version's delivered files under <name>/, deterministic bytes. */
export async function skillZip(ctx: RequestContext, id: string): Promise<{ name: string; version: number; zip: Uint8Array }> {
  const delivery = await deliveryState(ctx);
  if (delivery.state !== "on") throw new ForbiddenError(delivery.message!);
  const s = (await assignedSkills(ctx)).find((x) => x.id === id);
  if (!s) throw new NotFoundError("skill");
  const files = await versionFiles(ctx.db, s.version_id, { deliverOnly: true });
  const zip = zipSync(Object.fromEntries(files.map((f) => [`${s.name}/${f.path}`, [new Uint8Array(f.data), { mtime: ZIP_TIME, level: 6 }]])), { mtime: ZIP_TIME });
  await recordUsage(ctx.db, s.id, s.version, ctx.actor.id, "download");
  await audit(ctx.db, ctx.actor.id, "download_skill", s.id, { targetKind: "skill", targetLabel: s.name, details: { name: s.name, version: s.version } });
  return { name: s.name, version: s.version, zip };
}

/** A review copy of any version (all files, reviewers-only ones too), for people who manage or review the skill. */
export function zipOf(name: string, files: { path: string; data: Buffer }[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [`${name}/${f.path}`, [new Uint8Array(f.data), { mtime: ZIP_TIME, level: 6 }]])), { mtime: ZIP_TIME });
}

// ---- Claude Code sync -----------------------------------------------------------------------------------------------

/** SKILL.md with its frontmatter `name` set to the synced folder's name (the Agent Skills spec wants them equal). */
export function renameInFrontmatter(text: string, dir: string): string {
  const fm = splitFrontmatter(text);
  if (!fm) return text;
  const [head, rest] = fm;
  const lines = head.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const m = /^name(\s*):(.*?)(\r?)$/.exec(lines[i]!);
    if (m) {
      lines[i] = `name: ${dir}${m[3]}`;
      break;
    }
  }
  return lines.join("\n") + rest;
}

interface Bundle {
  name: string;
  dir: string;
  version: number;
  hash: string;
  files: { path: string; sha256: string; size: number; data: Uint8Array }[];
}

async function bundleOf(db: Queryable, s: Deliverable): Promise<Bundle> {
  const dir = syncDirOf(s.name);
  const rows = await versionFiles(db, s.version_id, { deliverOnly: true });
  const files = rows.map((f) => {
    let data: Uint8Array = new Uint8Array(f.data);
    if (f.path === "SKILL.md") data = strToU8(renameInFrontmatter(textOf(f.data) ?? "", dir));
    return { path: f.path, sha256: sha256(data), size: data.length, data };
  });
  return { name: s.name, dir, version: s.version, hash: contentHash(files), files };
}

/** GET /skills/sync: what the caller's Claude Code should have, or remove_all when delivery isn't on. */
export async function syncManifest(ctx: RequestContext, script?: string) {
  await noteSyncSeen(ctx, script);
  const { delivery, skills } = await deliverableSkills(ctx);
  if (delivery.state !== "on") return { delivery: delivery.state, message: delivery.message, remove_all: true, skills: [] as { name: string; dir: string; version: number; hash: string }[] };
  const list = [];
  for (const s of skills) {
    const b = await bundleOf(ctx.db, s);
    list.push({ name: b.name, dir: b.dir, version: b.version, hash: b.hash });
  }
  return { delivery: "on" as const, message: null, remove_all: false, skills: list };
}

/** GET /skills/sync/:name: one skill's delivered files (base64). Records usage `sync` (the script asks only when it installs). */
export async function syncBundle(ctx: RequestContext, name: string) {
  const s = await deliveredByName(ctx, name).catch((err) => {
    if (err instanceof ForbiddenError) throw new NotFoundError("skill");
    throw err;
  });
  const b = await bundleOf(ctx.db, s);
  await recordUsage(ctx.db, s.id, s.version, ctx.actor.id, "sync");
  return { name: b.name, dir: b.dir, version: b.version, hash: b.hash, files: b.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, b64: Buffer.from(f.data).toString("base64") })) };
}

/** The sync script checked in (at most one write per 10 minutes per person). */
async function noteSyncSeen(ctx: RequestContext, script?: string) {
  await ctx.db.query(
    `INSERT INTO skill_sync_seen (user_id, at, script) VALUES ($1, now(), $2)
     ON CONFLICT (user_id) DO UPDATE SET at = now(), script = EXCLUDED.script WHERE skill_sync_seen.at < now() - interval '10 minutes' OR skill_sync_seen.script IS DISTINCT FROM EXCLUDED.script`,
    [ctx.actor.id, script ? script.slice(0, 40) : null],
  );
}
