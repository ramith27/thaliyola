import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { redact } from "../redaction.js";
import { ownerRights, seesCatalogue, skillById, skillByName, visibleOwnerSql } from "./access.js";
import { assignedSkills } from "./delivery.js";
import { peopleWith, tellSkill } from "./notify.js";

/**
 * "This skill was wrong": anyone the skill is delivered to (or who manages it) reports a problem, from the web or from
 * Claude (report_skill_problem). Reports are redacted like any write and land in Review › Skills.
 */

export async function reportSkillProblem(ctx: RequestContext, ref: { id?: string; name?: string }, input: { body: string; version?: number }, via: "web" | "mcp") {
  const skill = ref.id ? await skillById(ctx.db, ref.id) : await skillByName(ctx.db, ref.name?.trim() ?? "");
  const missing = () => new NotFoundError("skill", ref.name ? `no skill named '${ref.name.slice(0, 80)}' is available to you; list_skills shows yours` : "skill not found");
  if (!skill) throw missing();
  const rights = await ownerRights(ctx, skill.owner_scope_id);
  const assigned = (await assignedSkills(ctx)).find((s) => s.id === skill.id);
  if (!rights.see && !assigned) throw missing();
  const text = input.body?.trim() ?? "";
  if (!text) throw new ValidationError("say what was wrong");
  if (text.length > 4000) throw new ValidationError("a problem report is at most 4000 characters");
  const r = redact(text);
  const version = input.version ?? assigned?.version ?? (skill.current_version_id ? (await ctx.db.query<{ version: number }>("SELECT version FROM skill_versions WHERE id = $1", [skill.current_version_id])).rows[0]?.version : null) ?? null;
  const { rows } = await ctx.db.query<{ id: string }>("INSERT INTO skill_feedback (skill_id, version, author_id, body, redactions, via) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
    skill.id,
    version,
    ctx.actor.id,
    r.text.slice(0, 4000),
    JSON.stringify(r.redactions),
    via,
  ]);
  await audit(ctx.db, ctx.actor.id, "report_skill_problem", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, version, via } });
  const managers = await peopleWith(ctx.db, ctx.settings, "manage_skills", skill.owner_scope_id);
  await tellSkill(ctx.db, ctx.settings, managers, { title: `Skill ${skill.name}: a problem was reported`, body: r.text.slice(0, 500), link: `#/skills/${skill.id}`, targetId: skill.id }, ctx.actor.id);
  return { feedback_id: rows[0]!.id, id: rows[0]!.id, state: "open", redactions: r.redactions };
}

export async function listSkillFeedback(ctx: RequestContext, f: { state?: "open" | "resolved" | "dismissed"; skill?: string } = {}) {
  const params: unknown[] = [];
  const managed = await seesCatalogue(ctx);
  const where: string[] = [];
  if (managed) where.push(`(${await visibleOwnerSql(ctx, "sk", params)} OR f.author_id = $${params.push(ctx.actor.id)})`);
  else where.push(`f.author_id = $${params.push(ctx.actor.id)}`);
  if (f.state) where.push(`f.state = $${params.push(f.state)}`);
  if (f.skill) where.push(`f.skill_id = $${params.push(f.skill)}`);
  const { rows } = await ctx.db.query(
    `SELECT f.id, f.skill_id, sk.name, f.version, f.body, f.redactions, f.via, f.state, f.resolution, f.created_at, f.resolved_at,
            coalesce(nullif(a.display_name, ''), a.email) AS author, f.author_id = $${params.push(ctx.actor.id)} AS mine,
            coalesce(nullif(r.display_name, ''), r.email) AS resolved_by
       FROM skill_feedback f JOIN skills sk ON sk.id = f.skill_id JOIN users a ON a.id = f.author_id LEFT JOIN users r ON r.id = f.resolved_by
      WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC LIMIT 500`,
    params,
  );
  return { feedback: rows };
}

export async function resolveSkillFeedback(ctx: RequestContext, id: string, input: { state: "resolved" | "dismissed" | "open"; resolution?: string }) {
  const row = (await ctx.db.query<{ id: string; skill_id: string; author_id: string; state: string }>("SELECT id, skill_id, author_id, state FROM skill_feedback WHERE id = $1", [id])).rows[0];
  if (!row) throw new NotFoundError("problem report");
  const skill = (await skillById(ctx.db, row.skill_id))!;
  const rights = await ownerRights(ctx, skill.owner_scope_id);
  if (!rights.see) throw new NotFoundError("problem report");
  if (!rights.manage && !rights.review) throw new ForbiddenError("resolving problem reports needs Manage skills or Review skills");
  await ctx.db.query("UPDATE skill_feedback SET state = $2, resolution = $3, resolved_by = $4, resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END WHERE id = $1", [
    id,
    input.state,
    input.resolution ? redact(input.resolution.trim()).text.slice(0, 2000) : null,
    input.state === "open" ? null : ctx.actor.id,
  ]);
  await audit(ctx.db, ctx.actor.id, "resolve_skill_feedback", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, state: input.state } });
  if (input.state !== "open" && row.author_id !== ctx.actor.id) {
    await tellSkill(ctx.db, ctx.settings, [row.author_id], { title: `Skill ${skill.name}: your problem report was ${input.state}`, body: input.resolution?.slice(0, 500), link: `#/skills/${skill.id}`, targetId: skill.id });
  }
  return { id, state: input.state };
}
