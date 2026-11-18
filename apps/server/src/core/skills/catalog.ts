import { withTx, type Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { viaClaude } from "../approvals.js";
import { can, canPublishOwn, canReadScope } from "../permissions.js";
import { redact } from "../redaction.js";
import { assertSkillRight, createRights, isAuditor, ownerRights, seesCatalogue, skillById, skillByName, visibleOwnerSql, type SkillRights, type SkillRow } from "./access.js";
import { audienceGain, collectionBySlug, whyYouHaveIt } from "./assignments.js";
import { assignedSkills, deliveryState } from "./delivery.js";
import { peopleWith, tellSkill } from "./notify.js";
import { publishDirectly } from "./review.js";
import { baseInfo, insertVersion, prepareSkill, versionFiles, type PreparedSkill } from "./prepare.js";
import { NAME_RE, textOf, type SkillFile, type SkillFlag } from "./types.js";

/**
 * The skills catalogue: what managers, reviewers and auditors see (owned skills only for readers of their project),
 * each skill's detail shaped for its viewer, and the hand-made side: creating a skill, proposing a new version,
 * changing its status or collection, detaching it from (or adopting it into) a source.
 */

const enc = new TextEncoder();

export interface SkillFilters {
  status?: string;
  collection?: string;
  q?: string;
  pending?: boolean;
  project?: string;
}

export async function listAllSkills(ctx: RequestContext, f: SkillFilters = {}) {
  if (!(await seesCatalogue(ctx))) throw new ForbiddenError("the skills catalogue is for people who manage or review skills (Skills managers, Administrators, Auditors and Project admins for their projects' own skills)");
  const params: unknown[] = [];
  const where = [await visibleOwnerSql(ctx, "sk", params)];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.status) where.push(`sk.status = ${p(f.status)}`);
  if (f.collection) where.push(`c.slug = ${p(f.collection)}`);
  if (f.q?.trim()) where.push(`(sk.name ILIKE ${p(`%${f.q.trim()}%`)} OR cv.description ILIKE $${params.length})`);
  if (f.pending) where.push("pv.id IS NOT NULL");
  if (f.project) {
    const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [f.project]);
    if (!rows[0] || !(await canReadScope(ctx, rows[0].id))) throw new NotFoundError(`project '${f.project}'`);
    where.push(`sk.owner_scope_id = ${p(rows[0].id)}`);
  }
  const { rows } = await ctx.db.query(
    `SELECT sk.id, sk.name, sk.status, sk.status_reason, sk.source_detached AS detached, sk.held_at_version, sk.as_prompt,
            CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('slug', c.slug, 'name', c.name) END AS collection,
            CASE WHEN os.id IS NULL THEN NULL ELSE json_build_object('slug', os.slug, 'name', os.name) END AS owner_project,
            CASE WHEN src.id IS NULL THEN NULL ELSE json_build_object('id', src.id, 'name', src.name) END AS source,
            CASE WHEN cv.id IS NULL THEN NULL ELSE json_build_object('version', cv.version, 'upstream_version', cv.upstream_version, 'description', cv.description,
                 'published_at', cv.decided_at, 'has_scripts', cv.has_scripts, 'allowed_tools', cv.allowed_tools) END AS current,
            CASE WHEN pv.id IS NULL THEN NULL ELSE json_build_object('version', pv.version, 'created_at', pv.created_at, 'author', coalesce(nullif(pu.display_name, ''), pu.email),
                 'high_risk', EXISTS (SELECT 1 FROM jsonb_array_elements(pv.flags) fl WHERE (fl->>'high_risk')::boolean),
                 'stale', pv.base_version_id IS DISTINCT FROM sk.current_version_id, 'guidance_only', pv.guidance_hash IS NOT NULL) END AS pending,
            (SELECT count(*)::int FROM skill_assignments a WHERE a.skill_id = sk.id OR a.collection_id = sk.collection_id) AS assignments,
            (SELECT max(at) FROM skill_usage u WHERE u.skill_id = sk.id) AS last_used_at,
            (SELECT count(*)::int FROM skill_usage u WHERE u.skill_id = sk.id AND u.at > now() - interval '30 days') AS uses_30d,
            (SELECT count(*)::int FROM skill_feedback fb WHERE fb.skill_id = sk.id AND fb.state = 'open') AS open_feedback,
            sk.updated_at
       FROM skills sk
       LEFT JOIN skill_collections c ON c.id = sk.collection_id
       LEFT JOIN scopes os ON os.id = sk.owner_scope_id
       LEFT JOIN skill_sources src ON src.id = sk.source_id
       LEFT JOIN skill_versions cv ON cv.id = sk.current_version_id
       LEFT JOIN skill_versions pv ON pv.skill_id = sk.id AND pv.state = 'pending'
       LEFT JOIN users pu ON pu.id = pv.author_id
      WHERE ${where.join(" AND ")}
      ORDER BY sk.name LIMIT 1000`,
    params,
  );
  // create: organisation-wide skills (Manage skills) or a project's own ones (Manage settings there); create_org: the former.
  const cr = await createRights(ctx);
  return { skills: rows, can: { create: cr.org || cr.projects, create_org: cr.org, import: can(ctx, "manage_skills"), publish_directly_projects: await directPublishProjects(ctx) } };
}

/** The projects (slugs) where the caller's new skills publish at once (directPublish, before any high-risk check). */
export async function directPublishProjects(ctx: RequestContext): Promise<string[]> {
  if (ctx.actor.kind !== "human" || !ctx.settings.directPublish || !(await skillsDirectPublishOn(ctx))) return [];
  const { rows } = await ctx.db.query<{ slug: string }>(
    `SELECT s.slug FROM scope_permissions p JOIN scopes s ON s.id = p.scope_id
      WHERE p.user_id = $1 AND p.permission = 'publish' AND s.kind = 'project' AND s.status = 'active' ORDER BY s.slug`,
    [ctx.actor.id],
  );
  return rows.map((r) => r.slug);
}

// ---- detail --------------------------------------------------------------------------------------------------------

async function versionRows(db: Queryable, skillId: string) {
  return (
    await db.query<{
      id: string;
      version: number;
      state: string;
      summary: string;
      upstream_version: string | null;
      source_commit: string | null;
      source_ref: string | null;
      import_id: string | null;
      base_version: number | null;
      restored_from: number | null;
      author_id: string | null;
      author: string | null;
      reviewer: string | null;
      reason: string | null;
      created_at: string;
      decided_at: string | null;
      self_approved: boolean;
      direct: boolean;
      has_scripts: boolean;
      allowed_tools: string | null;
      flags: SkillFlag[];
      guidance_hash: string | null;
      base_version_id: string | null;
      file_count: number;
      total_bytes: number;
      created_via: string | null;
      decided_via: string | null;
    }>(
      `SELECT v.id, v.version, v.state, v.summary, v.upstream_version, v.source_commit, v.source_ref, v.import_id, b.version AS base_version, v.restored_from,
              v.author_id, coalesce(nullif(au.display_name, ''), au.email) AS author, coalesce(nullif(ru.display_name, ''), ru.email) AS reviewer,
              v.reason, v.created_at, v.decided_at, v.self_approved, v.direct, v.has_scripts, v.allowed_tools, v.flags, v.guidance_hash, v.base_version_id,
              v.file_count, v.total_bytes, v.created_via, v.decided_via
         FROM skill_versions v LEFT JOIN skill_versions b ON b.id = v.base_version_id
         LEFT JOIN users au ON au.id = v.author_id LEFT JOIN users ru ON ru.id = v.reviewer_id
        WHERE v.skill_id = $1 ORDER BY v.version DESC`,
      [skillId],
    )
  ).rows;
}

/** "Project admins publish their own skills", read fresh like self-approval, falling back to the environment (on). */
export async function skillsDirectPublishOn(ctx: RequestContext): Promise<boolean> {
  const { rows } = await ctx.db.query<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'skills_direct_publish'");
  return rows[0] ? rows[0].value === true : ctx.settings.skillsDirectPublish ?? true;
}

/**
 * Whether a new skill or version by the caller publishes at once, like an article: the skill belongs to an active
 * project, the caller may publish their own writes there (canPublishOwn: a person, not a service account, whose role
 * there includes Publish; DIRECT_PUBLISH on; no request_review), "Project admins publish their own skills" is on, and
 * the version has no high-risk content. `held` says why a version that would otherwise publish waits for a reviewer.
 */
export async function directPublish(ctx: RequestContext, ownerScopeId: string | null, prepared?: Pick<PreparedSkill, "flags">): Promise<{ direct: boolean; held?: string }> {
  if (!ownerScopeId) return { direct: false };
  const scope = (await ctx.db.query<{ kind: string; status: string }>("SELECT kind, status FROM scopes WHERE id = $1", [ownerScopeId])).rows[0];
  if (scope?.kind !== "project" || scope.status !== "active") return { direct: false };
  if (!(await skillsDirectPublishOn(ctx))) return { direct: false };
  if (!(await canPublishOwn(ctx, ownerScopeId))) return { direct: false };
  const high = (prepared?.flags ?? []).filter((f) => f.high_risk);
  if (high.length) {
    const kinds = [...new Set(high.map((f) => skillFlagWords(f.kind)))].join(", ");
    return { direct: false, held: `has high-risk content (${kinds}), so a second person reviews it` };
  }
  return { direct: true };
}

const FLAG_WORDS: Record<string, string> = {
  hidden_text: "hidden text",
  scripts: "a new or changed script",
  admin_tools: "Thaliyola admin tools",
  external_url: "a new external address",
  allowed_tools: "pre-approved tools",
};
const skillFlagWords = (kind: string) => FLAG_WORDS[kind] ?? kind.replace(/_/g, " ");

/** Self-approval, read fresh (like the delivery mode), falling back to the environment. */
export async function selfApprovalOn(ctx: RequestContext): Promise<boolean> {
  const { rows } = await ctx.db.query<{ value: unknown }>("SELECT value FROM system_settings WHERE key = 'skills_self_approval'");
  return rows[0] ? rows[0].value === true : !!ctx.settings.skillsSelfApproval;
}

export async function getSkillDetail(ctx: RequestContext, id: string) {
  const skill = await skillById(ctx.db, id);
  if (!skill) throw new NotFoundError("skill");
  const rights = await ownerRights(ctx, skill.owner_scope_id);
  const assigned = (await assignedSkills(ctx)).find((s) => s.id === skill.id);
  if (!rights.see && !assigned) throw new NotFoundError("skill");
  const collection = skill.collection_id
    ? (await ctx.db.query<{ slug: string; name: string; description: string; connectors: unknown }>("SELECT slug, name, description, connectors FROM skill_collections WHERE id = $1", [skill.collection_id])).rows[0]
    : undefined;
  const current = skill.current_version_id
    ? (await ctx.db.query<{ version: number; upstream_version: string | null; description: string; frontmatter: unknown; has_scripts: boolean; allowed_tools: string | null; flags: SkillFlag[]; source_commit: string | null; decided_at: string | null }>(
        "SELECT version, upstream_version, description, frontmatter, has_scripts, allowed_tools, flags, source_commit, decided_at FROM skill_versions WHERE id = $1",
        [skill.current_version_id],
      )).rows[0]
    : undefined;
  const delivery = await deliveryState(ctx);
  // Assignees read a skill's content only while it's delivered to them (zip downloads follow the same rule).
  const contentShown = rights.see || delivery.state === "on";
  const files = skill.current_version_id && contentShown ? await versionFiles(ctx.db, skill.current_version_id, { deliverOnly: !rights.see }) : [];
  const skillMd = files.find((f) => f.path === "SKILL.md");
  const base = {
    id: skill.id,
    name: skill.name,
    status: skill.status,
    collection: collection ? { slug: collection.slug, name: collection.name, description: collection.description } : null,
    requires_connectors: collection?.connectors ?? [],
    current: current
      ? {
          version: current.version,
          upstream_version: current.upstream_version,
          description: current.description,
          frontmatter: current.frontmatter,
          has_scripts: current.has_scripts,
          allowed_tools: current.allowed_tools,
          source_commit: current.source_commit,
          published_at: current.decided_at,
          skill_md: skillMd ? textOf(skillMd.data) : null,
          files: files.map((f) => ({ path: f.path, size: f.size, kind: f.kind, script: f.is_script, managed: f.managed, deliver: f.deliver })),
          ...(rights.see ? { flags: current.flags } : {}),
        }
      : null,
    delivery: { mode: delivery.mode, state: delivery.state, message: delivery.message },
    assigned: !!assigned,
    why: assigned ? await whyYouHaveIt(ctx, skill) : [],
  };
  if (!rights.see) return { ...base, view: "assignee" as const, can: { manage: false, review: false, approve: false, usage: false, report: true } };
  const versions = await versionRows(ctx.db, skill.id);
  const pending = versions.find((v) => v.state === "pending");
  const selfOk = await selfApprovalOn(ctx);
  // Through Claude a second person always approves (core/skills/review.ts checkApprovable).
  const approve = !!pending && rights.review && (pending.author_id !== ctx.actor.id || (selfOk && !viaClaude(ctx)));
  const owner = skill.owner_scope_id ? (await ctx.db.query<{ slug: string; name: string }>("SELECT slug, name FROM scopes WHERE id = $1", [skill.owner_scope_id])).rows[0] : undefined;
  const source = skill.source_id
    ? (await ctx.db.query<{ id: string; name: string; kind: string; provider: string | null; repository: string | null; ref: string | null }>("SELECT id, name, kind, provider, repository, ref FROM skill_sources WHERE id = $1", [skill.source_id])).rows[0]
    : undefined;
  const pendingMove = skill.pending_collection_id
    ? (await ctx.db.query<{ slug: string; name: string; id: string }>("SELECT id, slug, name FROM skill_collections WHERE id = $1", [skill.pending_collection_id])).rows[0]
    : undefined;
  return {
    ...base,
    view: "manager" as const,
    owner_project: owner ?? null,
    source: source ? { ...source, path: skill.source_path, detached: skill.source_detached, edit_hint: source.repository ? `Edit it in ${source.repository}${skill.source_path ? `@${skill.source_path}` : ""}` : null } : null,
    held_at_version: skill.held_at_version,
    status_reason: skill.status_reason,
    as_prompt: skill.as_prompt,
    pending_move: pendingMove ? { collection: { slug: pendingMove.slug, name: pendingMove.name }, gains: await audienceGain(ctx, skill, pendingMove.id), can_decide: rights.review && skill.pending_collection_by !== ctx.actor.id } : null,
    versions: versions.map((v) => ({
      version: v.version,
      state: v.state,
      summary: v.summary,
      upstream_version: v.upstream_version,
      source_commit: v.source_commit,
      import_id: v.import_id,
      base_version: v.base_version,
      restored_from: v.restored_from,
      author: v.author,
      mine: v.author_id === ctx.actor.id,
      reviewer: v.reviewer,
      self_approved: v.self_approved,
      direct: v.direct,
      reason: v.reason,
      created_at: v.created_at,
      decided_at: v.decided_at,
      created_via: v.created_via,
      decided_via: v.decided_via,
      has_scripts: v.has_scripts,
      allowed_tools: v.allowed_tools,
      high_risk_flags: v.flags.filter((f) => f.high_risk).length,
      flags: v.flags.length,
      guidance_only: !!v.guidance_hash,
      stale: v.state === "pending" && v.base_version_id !== skill.current_version_id,
      file_count: v.file_count,
      total_bytes: v.total_bytes,
    })),
    can: {
      manage: rights.manage,
      review: rights.review,
      approve,
      approve_hint: pending && rights.review && !approve ? "Someone else must approve this (you proposed it)" : null,
      usage: rights.usage,
      report: true,
      edit: rights.manage && (!skill.source_id || skill.source_detached),
      rollback: rights.review,
      // A new version from the caller publishes at once (a Project admin's own project skill), unless high-risk.
      publish_directly: rights.manage && (!skill.source_id || skill.source_detached) && (await directPublish(ctx, skill.owner_scope_id)).direct,
    },
  };
}

// ---- one version, with diffs ---------------------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  change: "added" | "removed" | "changed" | "same";
  kind: "text" | "binary";
  managed: boolean;
  deliver: boolean;
  before?: string | null;
  after?: string | null;
}

const DIFF_TEXT_MAX = 300 * 1024;

export function diffFiles(before: { path: string; sha256: string; kind: string; managed: boolean; deliver: boolean; data: Buffer }[], after: typeof before, withSame = false): FileDiff[] {
  const a = new Map(before.map((f) => [f.path, f]));
  const b = new Map(after.map((f) => [f.path, f]));
  const out: FileDiff[] = [];
  const text = (f?: { kind: string; data: Buffer }) => (f && f.kind === "text" && f.data.length <= DIFF_TEXT_MAX ? textOf(f.data) : null);
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    const change = !x ? "added" : !y ? "removed" : x.sha256 === y.sha256 ? "same" : "changed";
    if (change === "same" && !withSame) continue;
    const f = (y ?? x)!;
    out.push({ path, change, kind: f.kind as "text" | "binary", managed: f.managed, deliver: f.deliver, ...(change === "same" ? {} : { before: text(x), after: text(y) }) });
  }
  return out;
}

export async function getSkillVersion(ctx: RequestContext, id: string, version: number) {
  const { skill, rights } = await assertSkillRight(ctx, id, "see");
  const v = (await versionRows(ctx.db, skill.id)).find((x) => x.version === version);
  if (!v) throw new NotFoundError(`version ${version} of ${skill.name}`);
  const files = await versionFiles(ctx.db, v.id);
  const baseFiles = v.base_version_id ? await versionFiles(ctx.db, v.base_version_id) : [];
  const currentFiles = skill.current_version_id && skill.current_version_id !== v.base_version_id && skill.current_version_id !== v.id ? await versionFiles(ctx.db, skill.current_version_id) : null;
  const selfOk = await selfApprovalOn(ctx);
  return {
    skill: { id: skill.id, name: skill.name },
    version: v.version,
    state: v.state,
    summary: v.summary,
    author: v.author,
    mine: v.author_id === ctx.actor.id,
    reviewer: v.reviewer,
    reason: v.reason,
    created_at: v.created_at,
    decided_at: v.decided_at,
    upstream_version: v.upstream_version,
    source_commit: v.source_commit,
    source_ref: v.source_ref,
    import_id: v.import_id,
    base_version: v.base_version,
    restored_from: v.restored_from,
    stale: v.state === "pending" && v.base_version_id !== skill.current_version_id,
    has_scripts: v.has_scripts,
    allowed_tools: v.allowed_tools,
    flags: v.flags,
    guidance_hash: v.guidance_hash,
    files: files.map((f) => ({ path: f.path, size: f.size, kind: f.kind, script: f.is_script, managed: f.managed, deliver: f.deliver, sha256: f.sha256 })),
    diff: diffFiles(baseFiles, files, false),
    diff_against_current: currentFiles ? diffFiles(currentFiles, files, false) : null,
    can: {
      approve: v.state === "pending" && rights.review && (v.author_id !== ctx.actor.id || (selfOk && !viaClaude(ctx))),
      reject: v.state === "pending" && rights.review,
      rollback: v.state !== "pending" && rights.review && v.decided_at !== null && (v.state === "published" || v.state === "superseded") && skill.current_version_id !== v.id && wasPublished(v),
      needs_checked_tools: !!v.allowed_tools,
      needs_checked_flags: v.flags.some((f) => f.high_risk),
    },
  };
}

const wasPublished = (v: { state: string; reviewer: string | null; direct: boolean; restored_from: number | null }) => v.state === "published";

/** One file of a version: managers any version; assignees the published version's delivered files. */
export async function getSkillFileForViewer(ctx: RequestContext, id: string, path: string, version?: number) {
  const skill = await skillById(ctx.db, id);
  if (!skill) throw new NotFoundError("skill");
  const rights = await ownerRights(ctx, skill.owner_scope_id);
  let versionId = skill.current_version_id;
  if (!rights.see) {
    const assigned = (await assignedSkills(ctx)).find((s) => s.id === skill.id);
    if (!assigned || version !== undefined) throw new NotFoundError("skill");
    const delivery = await deliveryState(ctx);
    if (delivery.state !== "on") throw new ForbiddenError(delivery.message!);
  } else if (version !== undefined) {
    versionId = (await ctx.db.query<{ id: string }>("SELECT id FROM skill_versions WHERE skill_id = $1 AND version = $2", [skill.id, version])).rows[0]?.id ?? null;
  }
  if (!versionId) throw new NotFoundError("file");
  const { rows } = await ctx.db.query<{ path: string; size: number; kind: "text" | "binary"; deliver: boolean; data: Buffer }>(
    "SELECT f.path, f.size, f.kind, f.deliver, b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 WHERE f.version_id = $1 AND f.path = $2",
    [versionId, path],
  );
  const f = rows[0];
  if (!f || (!rights.see && !f.deliver)) throw new NotFoundError("file");
  return { skill: skill.name, path: f.path, size: f.size, kind: f.kind, data: f.data, text: f.kind === "text" ? textOf(f.data) : null };
}

// ---- writing by hand --------------------------------------------------------------------------------------------

/** A file from an editor or from Claude: text, or bytes (binary files pushed over MCP). */
export interface EditorFile {
  path: string;
  text?: string;
  data?: Uint8Array;
}

const bytesOf = (f: EditorFile): Uint8Array => f.data ?? enc.encode(f.text ?? "");

/** The validation errors, worded for a skill rather than an archive. */
export function skillErrors(p: Pick<PreparedSkill, "errors">): string[] {
  // Two scanners (Thaliyola's redaction rules and validate.py's patterns) can report the same line the same way.
  return [...new Set(p.errors.map((e) => e.replace(/ in the archive/g, "").replace(/the archive has/g, "the skill has")))];
}

export class SkillRejected extends ValidationError {
  constructor(readonly errors: string[]) {
    super(`the skill can't be saved: ${errors.slice(0, 8).join("; ")}${errors.length > 8 ? ` (and ${errors.length - 8} more)` : ""}`);
  }
}

function rejectWith(p: PreparedSkill): never {
  throw new SkillRejected(skillErrors(p));
}

/** A version summary, redacted like any write. */
const cleanSummary = (s: string | undefined, fallback: string) => redact(s?.trim() || fallback).text.slice(0, 2000);

async function notifyReviewers(ctx: RequestContext, skill: Pick<SkillRow, "id" | "name" | "owner_scope_id">, version: number, authorId: string | null) {
  const to = await peopleWith(ctx.db, ctx.settings, "review_skills", skill.owner_scope_id);
  await tellSkill(ctx.db, ctx.settings, to, { title: `Skill ${skill.name}: version ${version} waits for review`, link: `#/skills/${skill.id}`, targetId: skill.id }, authorId);
}

export async function notifySuperseded(ctx: RequestContext, skill: Pick<SkillRow, "id" | "name">, old: { version: number; author_id: string | null } | null, by: number) {
  if (!old?.author_id || old.author_id === ctx.actor.id) return;
  await tellSkill(ctx.db, ctx.settings, [old.author_id], { title: `Skill ${skill.name}: your version ${old.version} was replaced by version ${by}`, link: `#/skills/${skill.id}`, targetId: skill.id });
}

/**
 * Creates a skill by hand. Version 1 waits for a second person, except a Project admin's own skill in their project,
 * which publishes at once unless it has high-risk content or `request_review` (directPublish).
 */
export async function createSkill(
  ctx: RequestContext,
  input: { name?: string; collection?: string | null; project?: string | null; skill_md: string; files?: EditorFile[]; summary?: string; request_review?: boolean },
) {
  if (input.request_review) ctx = { ...ctx, requestReview: true };
  let ownerScopeId: string | null = null;
  if (input.project) {
    const { rows } = await ctx.db.query<{ id: string; kind: string }>("SELECT id, kind FROM scopes WHERE slug = $1", [input.project]);
    if (!rows[0] || !(await canReadScope(ctx, rows[0].id))) throw new NotFoundError(`project '${input.project}'`);
    if (rows[0].kind !== "project") throw new ValidationError(`'${input.project}' isn't a project`);
    ownerScopeId = rows[0].id;
  }
  const rights = await ownerRights(ctx, ownerScopeId);
  if (!rights.manage) throw new ForbiddenError(ownerScopeId ? "creating a project's own skill needs Manage settings there, or Manage skills" : "creating skills needs Manage skills (Skills managers and Administrators)");
  const name = (input.name ?? nameFromSkillMd(input.skill_md) ?? "").trim();
  if (!NAME_RE.test(name) || name.length > 64) throw new ValidationError("name must be lowercase letters/digits with single hyphens, at most 64 characters (the frontmatter name)");
  const existing = await skillByName(ctx.db, name);
  if (existing) {
    const r = await ownerRights(ctx, existing.owner_scope_id);
    throw new ValidationError(r.see ? `a skill named ${name} already exists` : "that name isn't available");
  }
  const files: SkillFile[] = [{ path: "SKILL.md", data: enc.encode(input.skill_md) }, ...(input.files ?? []).filter((f) => f.path !== "SKILL.md").map((f) => ({ path: f.path, data: bytesOf(f) }))];
  const prepared = prepareSkill(name, files);
  if (prepared.errors.length) rejectWith(prepared);
  let collectionId: string | null = null;
  if (input.collection) {
    const c = await collectionOrNew(ctx, input.collection, ownerScopeId);
    collectionId = c.id;
  }
  const publish = await directPublish(ctx, ownerScopeId, prepared);
  const out = await withTx(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("INSERT INTO skills (name, collection_id, owner_scope_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [name, collectionId, ownerScopeId, ctx.actor.id]);
    const v = await insertVersion(tx, { skillId: rows[0]!.id, state: "pending", baseVersionId: null, prepared, summary: cleanSummary(input.summary, "New skill"), authorId: ctx.actor.id }, "the editor");
    await audit(tx, ctx.actor.id, "create_skill", rows[0]!.id, {
      targetKind: "skill",
      targetLabel: name,
      details: {
        name,
        collection: input.collection ?? null,
        project: input.project ?? null,
        version: v.version,
        state: publish.direct ? "published" : "pending",
        files: prepared.files.length,
        has_scripts: prepared.hasScripts,
        allowed_tools: prepared.allowedTools,
        high_risk_flags: prepared.flags.filter((f) => f.high_risk).length,
      },
    });
    if (publish.direct) await publishDirectly(ctx, tx, { id: v.id, skill_id: rows[0]!.id, name, version: v.version, from_version: null });
    return { id: rows[0]!.id, version: v.version };
  });
  if (!publish.direct) await notifyReviewers(ctx, { id: out.id, name, owner_scope_id: ownerScopeId }, out.version, ctx.actor.id);
  return {
    id: out.id,
    name,
    version: out.version,
    ...publishedOutcome(publish),
    owner_scope_id: ownerScopeId,
    collection: input.collection ?? null,
    files: prepared.files.map((f) => ({ path: f.path, size: f.size, kind: f.kind, script: f.is_script })),
    flags: prepared.flags,
    warnings: prepared.warnings,
  };
}

function nameFromSkillMd(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const n = m ? /^name\s*:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(m[1]!) : null;
  return n ? n[1]! : null;
}

/** A collection the caller manages, or a new hand-made one with that slug. */
async function collectionOrNew(ctx: RequestContext, slug: string, ownerScopeId: string | null) {
  const s = slug.trim();
  if (!NAME_RE.test(s) || s.length > 64) throw new ValidationError("a collection slug is lowercase letters/digits with single hyphens");
  const { rows } = await ctx.db.query<{ id: string; owner_scope_id: string | null }>("SELECT id, owner_scope_id FROM skill_collections WHERE slug = $1", [s]);
  if (rows[0]) {
    const c = await collectionBySlug(ctx, s, "manage");
    if ((c.owner_scope_id ?? null) !== ownerScopeId) throw new ValidationError(ownerScopeId ? "a project's own skill goes in a collection of that project" : "an organisation-wide skill can't go in a project's own collection");
    return c;
  }
  const ins = await ctx.db.query<{ id: string }>("INSERT INTO skill_collections (slug, name, owner_scope_id, created_by) VALUES ($1, $1, $2, $3) RETURNING id", [s, ownerScopeId, ctx.actor.id]);
  return { id: ins.rows[0]!.id, slug: s, owner_scope_id: ownerScopeId };
}

/** What a hand-made version's result says about publishing: at once, or waiting for review (and why, when held). */
function publishedOutcome(p: { direct: boolean; held?: string }) {
  if (p.direct) return { state: "published", published: true, message: "Published: you may publish your own skills in this project without review." };
  return { state: "pending", published: false, ...(p.held ? { message: `Waiting for review: this version ${p.held}.`, review_reason: p.held } : {}) };
}

/**
 * A new version by hand: edits to SKILL.md and text files, removals. Imported skills are edited at their source. A
 * Project admin's version of their project's own skill publishes at once (directPublish), as createSkill does.
 */
export async function proposeSkillVersion(ctx: RequestContext, id: string, input: { skill_md?: string; files?: EditorFile[]; remove_files?: string[]; summary: string; request_review?: boolean }) {
  if (input.request_review) ctx = { ...ctx, requestReview: true };
  const out = await withTx(ctx.db, async (tx) => {
    const { skill } = await assertSkillRight(ctx, id, "manage", tx, true);
    if (skill.source_id && !skill.source_detached) {
      const src = (await tx.query<{ name: string; repository: string | null }>("SELECT name, repository FROM skill_sources WHERE id = $1", [skill.source_id])).rows[0];
      throw new ConflictError(`This skill comes from ${src?.repository ?? src?.name ?? "a source"}${skill.source_path ? `@${skill.source_path}` : ""}; edit it there, or detach it to change it here`, null);
    }
    const from = skill.current_version_id ?? (await tx.query<{ id: string }>("SELECT id FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT 1", [skill.id])).rows[0]?.id ?? null;
    const old = from ? await versionFiles(tx, from) : [];
    const map = new Map<string, SkillFile>(old.map((f) => [f.path, { path: f.path, data: new Uint8Array(f.data), managed: f.managed, deliver: f.deliver }]));
    if (input.skill_md !== undefined) map.set("SKILL.md", { path: "SKILL.md", data: enc.encode(input.skill_md) });
    for (const f of input.files ?? []) map.set(f.path, { path: f.path, data: bytesOf(f), deliver: map.get(f.path)?.deliver ?? true });
    for (const p of input.remove_files ?? []) {
      if (p === "SKILL.md") throw new ValidationError("SKILL.md can't be removed");
      if (!map.has(p)) throw new ValidationError(`${p} isn't a file of ${skill.name}`);
      map.delete(p);
    }
    const base = await baseInfo(tx, skill.current_version_id);
    const prepared = prepareSkill(skill.name, [...map.values()], base);
    if (prepared.errors.length) rejectWith(prepared);
    const cur = skill.current_version_id ? (await tx.query<{ content_hash: string }>("SELECT content_hash FROM skill_versions WHERE id = $1", [skill.current_version_id])).rows[0] : undefined;
    if (cur?.content_hash === prepared.contentHash) throw new ValidationError("nothing changed: the files are the same as the published version");
    const who = ctx.actor.name || ctx.actor.email || "someone";
    const publish = await directPublish(ctx, skill.owner_scope_id, prepared);
    const v = await insertVersion(tx, { skillId: skill.id, state: "pending", baseVersionId: skill.current_version_id, prepared, summary: cleanSummary(input.summary, "New version"), authorId: ctx.actor.id }, who);
    const baseVersion = skill.current_version_id ? (await tx.query<{ version: number }>("SELECT version FROM skill_versions WHERE id = $1", [skill.current_version_id])).rows[0]?.version : null;
    await audit(tx, ctx.actor.id, "propose_skill_version", skill.id, {
      targetKind: "skill",
      targetLabel: skill.name,
      details: {
        name: skill.name,
        version: v.version,
        base_version: baseVersion ?? null,
        files_changed: diffFiles(old.map((f) => ({ ...f })), prepared.files.map((f) => ({ ...f, data: Buffer.from(f.data) })), false).length,
        has_scripts: prepared.hasScripts,
        allowed_tools: prepared.allowedTools,
        high_risk_flags: prepared.flags.filter((f) => f.high_risk).length,
        ...(publish.direct ? { state: "published" } : {}),
      },
    });
    if (publish.direct) await publishDirectly(ctx, tx, { id: v.id, skill_id: skill.id, name: skill.name, version: v.version, from_version: baseVersion ?? null });
    return { skill, v, prepared, publish };
  });
  await notifySuperseded(ctx, out.skill, out.v.superseded, out.v.version);
  if (!out.publish.direct) await notifyReviewers(ctx, out.skill, out.v.version, ctx.actor.id);
  return {
    id: out.skill.id,
    name: out.skill.name,
    version: out.v.version,
    ...publishedOutcome(out.publish),
    superseded: out.v.superseded?.version ?? null,
    owner_scope_id: out.skill.owner_scope_id,
    files: out.prepared.files.map((f) => ({ path: f.path, size: f.size, kind: f.kind, script: f.is_script })),
    flags: out.prepared.flags,
    warnings: out.prepared.warnings,
  };
}

/** Status, collection (an audience-widening move waits for review) and whether it's offered as a prompt. */
export async function updateSkill(ctx: RequestContext, id: string, patch: { status?: "active" | "disabled" | "archived" | "retired"; collection?: string | null; as_prompt?: boolean }) {
  const { skill, rights } = await assertSkillRight(ctx, id, "manage");
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  let pendingMove: { slug: string; gains: { people: number; audiences: string[] } } | null = null;
  if (patch.status !== undefined && patch.status !== skill.status) {
    await ctx.db.query("UPDATE skills SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1", [skill.id, patch.status, patch.status === "active" ? null : `${patch.status} by ${ctx.actor.name || ctx.actor.email}`]);
    changes.push({ field: "status", from: skill.status, to: patch.status });
  }
  if (patch.as_prompt !== undefined && patch.as_prompt !== skill.as_prompt) {
    await ctx.db.query("UPDATE skills SET as_prompt = $2, updated_at = now() WHERE id = $1", [skill.id, patch.as_prompt]);
    changes.push({ field: "as_prompt", from: skill.as_prompt, to: patch.as_prompt });
  }
  if (patch.collection !== undefined) {
    const to = patch.collection ? await collectionOrNew(ctx, patch.collection, skill.owner_scope_id) : null;
    const fromSlug = skill.collection_id ? (await ctx.db.query<{ slug: string }>("SELECT slug FROM skill_collections WHERE id = $1", [skill.collection_id])).rows[0]?.slug : null;
    if ((to?.id ?? null) !== skill.collection_id) {
      const gains = to ? await audienceGain(ctx, skill, to.id) : { people: 0, audiences: [] };
      if (gains.people > 0) {
        await ctx.db.query("UPDATE skills SET pending_collection_id = $2, pending_collection_by = $3, pending_collection_import_id = NULL, updated_at = now() WHERE id = $1", [skill.id, to!.id, ctx.actor.id]);
        pendingMove = { slug: to!.slug, gains };
        changes.push({ field: "collection", from: fromSlug ?? null, to: `${to!.slug} (waits for review)` });
        const reviewers = await peopleWith(ctx.db, ctx.settings, "review_skills", skill.owner_scope_id);
        await tellSkill(ctx.db, ctx.settings, reviewers, { title: `Skill ${skill.name}: moving to ${to!.slug} would give it to ${gains.people} more people; it waits for review`, link: `#/skills/${skill.id}`, targetId: skill.id }, ctx.actor.id);
      } else {
        await ctx.db.query("UPDATE skills SET collection_id = $2, pending_collection_id = NULL, pending_collection_by = NULL, updated_at = now() WHERE id = $1", [skill.id, to?.id ?? null]);
        changes.push({ field: "collection", from: fromSlug ?? null, to: to?.slug ?? null });
      }
    }
  }
  if (changes.length) await audit(ctx.db, ctx.actor.id, "update_skill", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, changes } });
  void rights;
  return { id: skill.id, name: skill.name, changes, pending_move: pendingMove };
}

/** Local override: imports report the skill as detached and never touch it; it can then be edited here. */
export async function detachSkill(ctx: RequestContext, id: string, detach: boolean) {
  const { skill } = await assertSkillRight(ctx, id, "manage");
  if (!skill.source_id) throw new ValidationError("this skill doesn't come from a source");
  if (skill.source_detached === detach) return { id: skill.id, detached: detach };
  await ctx.db.query("UPDATE skills SET source_detached = $2, updated_at = now() WHERE id = $1", [skill.id, detach]);
  const src = (await ctx.db.query<{ name: string }>("SELECT name FROM skill_sources WHERE id = $1", [skill.source_id])).rows[0];
  await audit(ctx.db, ctx.actor.id, detach ? "detach_skill" : "reattach_skill", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, source: src?.name ?? null, path: skill.source_path } });
  return { id: skill.id, detached: detach };
}

/** Links a hand-made skill to a source (after the caller saw the diff in a dry run); the next run proposes upstream. */
export async function adoptSkill(ctx: RequestContext, id: string, input: { source: string; path: string }) {
  const { skill } = await assertSkillRight(ctx, id, "manage");
  if (skill.source_id) throw new ValidationError("this skill already comes from a source");
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("adopting a skill into a source needs Manage skills");
  const src = (await ctx.db.query<{ id: string; name: string; owner_scope_id: string | null }>("SELECT id, name, owner_scope_id FROM skill_sources WHERE id::text = $1 OR lower(name) = lower($1)", [input.source])).rows[0];
  if (!src || (src.owner_scope_id && !(await canReadScope(ctx, src.owner_scope_id)))) throw new NotFoundError(`skill source '${input.source}'`);
  if ((src.owner_scope_id ?? null) !== (skill.owner_scope_id ?? null)) throw new ValidationError("the skill and the source must belong to the same project (or both to the organisation)");
  const path = input.path.trim().replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some((s) => s === ".." || s === ".")) throw new ValidationError("path is the skill's folder in the repository");
  await ctx.db.query("UPDATE skills SET source_id = $2, source_path = $3, source_detached = false, updated_at = now() WHERE id = $1", [skill.id, src.id, path]);
  await audit(ctx.db, ctx.actor.id, "adopt_skill", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, source: src.name, path } });
  return { id: skill.id, source: { id: src.id, name: src.name }, path };
}

/** "Retire these": skills a narrowed filter no longer covers. */
export async function retireSkills(ctx: RequestContext, ids: string[]) {
  const retired: string[] = [];
  for (const id of ids.slice(0, 500)) {
    const { skill } = await assertSkillRight(ctx, id, "manage");
    if (skill.status === "retired") continue;
    await ctx.db.query("UPDATE skills SET status = 'retired', status_reason = $2, updated_at = now() WHERE id = $1", [skill.id, `retired by ${ctx.actor.name || ctx.actor.email}`]);
    retired.push(skill.name);
  }
  if (retired.length) await audit(ctx.db, ctx.actor.id, "retire_skills", null, { targetKind: "skill", targetLabel: retired.length === 1 ? retired[0] : `${retired.length} skills`, details: { skills: retired, count: retired.length } });
  return { retired };
}

// ---- collections ------------------------------------------------------------------------------------------------

export async function listCollections(ctx: RequestContext) {
  if (!(await seesCatalogue(ctx))) throw new ForbiddenError("skill collections are for people who manage or review skills");
  const params: unknown[] = [];
  const where = await visibleOwnerSql(ctx, "c", params);
  const { rows } = await ctx.db.query(
    `SELECT c.id, c.slug, c.name, c.description, c.connectors, c.upstream_version, c.removed_at,
            CASE WHEN os.id IS NULL THEN NULL ELSE json_build_object('slug', os.slug, 'name', os.name) END AS owner_project,
            CASE WHEN src.id IS NULL THEN NULL ELSE json_build_object('id', src.id, 'name', src.name) END AS source,
            (SELECT count(*)::int FROM skills sk WHERE sk.collection_id = c.id AND sk.status = 'active') AS skills,
            (SELECT count(*)::int FROM skill_assignments a WHERE a.collection_id = c.id) AS assignments
       FROM skill_collections c LEFT JOIN scopes os ON os.id = c.owner_scope_id LEFT JOIN skill_sources src ON src.id = c.source_id
      WHERE ${where} ORDER BY c.name`,
    params,
  );
  return { collections: rows };
}

export async function updateCollection(ctx: RequestContext, slug: string, patch: { name?: string; description?: string }) {
  const c = await collectionBySlug(ctx, slug, "manage");
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  if (patch.name !== undefined && patch.name.trim() !== c.name) changes.push({ field: "name", from: c.name, to: patch.name.trim() });
  if (patch.description !== undefined && patch.description.trim() !== c.description) changes.push({ field: "description", from: c.description, to: patch.description.trim() });
  if (!changes.length) return { slug: c.slug, changes };
  await ctx.db.query("UPDATE skill_collections SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now() WHERE id = $1", [
    c.id,
    patch.name?.trim().slice(0, 200) || null,
    patch.description !== undefined ? patch.description.trim().slice(0, 2000) : null,
  ]);
  await audit(ctx.db, ctx.actor.id, "update_skill_collection", c.id, { targetKind: "skill_collection", targetLabel: c.name, details: { collection: c.slug, changes } });
  return { slug: c.slug, changes };
}

export type { SkillRights };
export { isAuditor };
