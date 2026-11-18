import type { Queryable } from "../../db/pool.js";
import { ForbiddenError, NotFoundError, type RequestContext } from "../context.js";
import { can, canReadScope, hasPermission, readableScopes } from "../permissions.js";

/**
 * Who may do what with a skill.
 * - Organisation-wide skill (owner_scope_id null): manage = Manage skills; review = Review skills.
 * - Skill owned by a project P: nobody who can't read P has any right (the skill doesn't exist for them); manage =
 *   (Manage skills and reads P) or Manage settings in P; review = (Review skills and reads P) or Manage settings in P.
 * - Auditors (Read every project + See usage) see every skill, its usage and feedback, read-only.
 * Service identities never manage or review (can() is false for them); they only receive skills.
 */

export interface SkillRow {
  id: string;
  name: string;
  collection_id: string | null;
  owner_scope_id: string | null;
  status: "active" | "disabled" | "retired" | "archived";
  current_version_id: string | null;
  source_id: string | null;
  source_path: string | null;
  source_detached: boolean;
  held_at_version: number | null;
  held_by: string | null;
  pending_collection_id: string | null;
  pending_collection_import_id: string | null;
  pending_collection_by: string | null;
  declined_collection_id: string | null;
  as_prompt: boolean;
  status_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillRights {
  see: boolean;
  manage: boolean;
  review: boolean;
  usage: boolean;
}

export const isAuditor = (ctx: RequestContext) => can(ctx, "read_all_projects") && can(ctx, "view_metrics");

/** Manage settings in a project (Project admins; Manage every project counts through hasPermission). */
async function managesProject(ctx: RequestContext, scopeId: string): Promise<boolean> {
  return ctx.actor.kind === "human" && (await hasPermission(ctx, scopeId, "manage_settings"));
}

export async function ownerRights(ctx: RequestContext, ownerScopeId: string | null): Promise<SkillRights> {
  if (ctx.actor.kind !== "human") return { see: false, manage: false, review: false, usage: false };
  if (!ownerScopeId) {
    const manage = can(ctx, "manage_skills");
    const review = can(ctx, "review_skills");
    const auditor = isAuditor(ctx);
    return { see: manage || review || auditor, manage, review, usage: manage || auditor };
  }
  if (!(await canReadScope(ctx, ownerScopeId))) return { see: false, manage: false, review: false, usage: false };
  const admin = await managesProject(ctx, ownerScopeId);
  const manage = can(ctx, "manage_skills") || admin;
  const review = can(ctx, "review_skills") || admin;
  const auditor = isAuditor(ctx);
  return { see: manage || review || auditor, manage, review, usage: manage || auditor };
}

export function skillRights(ctx: RequestContext, skill: Pick<SkillRow, "owner_scope_id">): Promise<SkillRights> {
  return ownerRights(ctx, skill.owner_scope_id);
}

export const SKILL_COLUMNS = `sk.id, sk.name, sk.collection_id, sk.owner_scope_id, sk.status, sk.current_version_id, sk.source_id, sk.source_path,
  sk.source_detached, sk.held_at_version, sk.held_by, sk.pending_collection_id, sk.pending_collection_import_id, sk.pending_collection_by,
  sk.declined_collection_id, sk.as_prompt, sk.status_reason, sk.created_by, sk.created_at, sk.updated_at`;

export async function skillById(db: Queryable, id: string, lock = false): Promise<SkillRow | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const { rows } = await db.query<SkillRow>(`SELECT ${SKILL_COLUMNS} FROM skills sk WHERE sk.id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  return rows[0];
}

export async function skillByName(db: Queryable, name: string): Promise<SkillRow | undefined> {
  const { rows } = await db.query<SkillRow>(`SELECT ${SKILL_COLUMNS} FROM skills sk WHERE sk.name = $1`, [name]);
  return rows[0];
}

/** A skill the caller has `need` on; anything else is "not found" (owned skills never leak their existence). */
export async function assertSkillRight(ctx: RequestContext, id: string, need: keyof SkillRights, db: Queryable = ctx.db, lock = false): Promise<{ skill: SkillRow; rights: SkillRights }> {
  const skill = await skillById(db, id, lock);
  if (!skill) throw new NotFoundError("skill");
  const rights = await skillRights(ctx, skill);
  if (!rights.see) throw new NotFoundError("skill");
  if (!rights[need]) {
    throw new ForbiddenError(
      need === "manage"
        ? "changing this skill needs Manage skills (Skills managers and Administrators) or, for a project's own skill, Manage settings there"
        : need === "review"
          ? "approving skill versions needs Review skills (Skills managers and Administrators) or, for a project's own skill, Manage settings there"
          : "seeing who uses this skill needs Manage skills, or Read every project and See usage (Auditors)",
    );
  }
  return { skill, rights };
}

/**
 * SQL (with the params it appends) limiting a skills query (alias `sk`, or another alias for a table with
 * owner_scope_id) to what the caller sees in the catalogue: organisation-wide skills if they manage, review or audit
 * skills, and owned skills of projects they can read and manage (or read, with those organisation permissions).
 */
export async function visibleOwnerSql(ctx: RequestContext, alias: string, params: unknown[]): Promise<string> {
  if (ctx.actor.kind !== "human") return "false";
  const orgWide = can(ctx, "manage_skills") || can(ctx, "review_skills") || isAuditor(ctx);
  const readable = await readableScopes(ctx);
  const parts: string[] = [];
  if (orgWide) {
    parts.push(`${alias}.owner_scope_id IS NULL`);
    if (readable === null) parts.push(`${alias}.owner_scope_id IS NOT NULL`);
    else {
      params.push(readable);
      parts.push(`${alias}.owner_scope_id = ANY($${params.length}::uuid[])`);
    }
  }
  // Project admins: their projects' own skills.
  if (can(ctx, "manage_all_projects")) parts.push(`${alias}.owner_scope_id IS NOT NULL`);
  else {
    params.push(ctx.actor.id);
    parts.push(`${alias}.owner_scope_id IN (SELECT scope_id FROM scope_permissions WHERE user_id = $${params.length} AND permission = 'manage_settings')`);
  }
  return `(${parts.join(" OR ")})`;
}

/**
 * Where the caller may create skills: organisation-wide ones need Manage skills; a project's own ones need Manage
 * skills (and reading the project) or Manage settings there. `projects` says whether there's at least one such project.
 */
export async function createRights(ctx: RequestContext): Promise<{ org: boolean; projects: boolean }> {
  if (ctx.actor.kind !== "human") return { org: false, projects: false };
  if (can(ctx, "manage_skills")) return { org: true, projects: true };
  if (can(ctx, "manage_all_projects")) return { org: false, projects: true };
  // Projects only: everyone manages their own personal space, which can't own skills.
  const { rowCount } = await ctx.db.query(
    "SELECT 1 FROM scope_permissions sp JOIN scopes s ON s.id = sp.scope_id WHERE sp.user_id = $1 AND sp.permission = 'manage_settings' AND s.kind = 'project' AND s.status = 'active' LIMIT 1",
    [ctx.actor.id],
  );
  return { org: false, projects: !!rowCount };
}

/** Whether the caller sees the skills catalogue at all (managers, reviewers, auditors, Project admins). */
export async function seesCatalogue(ctx: RequestContext): Promise<boolean> {
  if (ctx.actor.kind !== "human") return false;
  if (can(ctx, "manage_skills") || can(ctx, "review_skills") || isAuditor(ctx) || can(ctx, "manage_all_projects")) return true;
  // Project admins of an active project (as createRights counts them): everyone manages their own personal space,
  // which owns no skills, so it doesn't count.
  return (await createRights(ctx)).projects;
}
