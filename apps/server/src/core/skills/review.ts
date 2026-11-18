import { withTx, type Queryable } from "../../db/pool.js";
import { decidedVia, mcpApprovalsOn, MCP_APPROVALS_OFF, viaClaude, viaDetails } from "../approvals.js";
import { audit } from "../audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { assertSkillRight, ownerRights, seesCatalogue, visibleOwnerSql } from "./access.js";
import { audienceGain, collectionBySlug } from "./assignments.js";
import { selfApprovalOn } from "./catalog.js";
import { metaDiff, metaHash } from "./importer.js";
import { tellSkill } from "./notify.js";
import { insertVersion, prepareSkill, versionFiles } from "./prepare.js";
import type { SkillFlag } from "./types.js";

/**
 * Review of skill versions: a second person approves (the author can't, Administrators included, unless
 * "Let people approve their own skill versions" is on), only on top of the version it was proposed against, and with
 * explicit ticks for pre-approved tools and high-risk flags. Rollbacks publish a copy of an older version and hold the
 * skill so imports don't undo them; widening collection moves wait here too.
 */

interface PendingRow {
  id: string;
  skill_id: string;
  name: string;
  owner_scope_id: string | null;
  version: number;
  author_id: string | null;
  base_version_id: string | null;
  current_version_id: string | null;
  allowed_tools: string | null;
  flags: SkillFlag[];
  guidance_hash: string | null;
  import_id: string | null;
  import_started_by: string | null;
}

async function pendingVersion(ctx: RequestContext, skillId: string, version: number, tx = ctx.db as import("../../db/pool.js").Queryable): Promise<PendingRow> {
  const { rows } = await tx.query<PendingRow>(
    `SELECT v.id, v.skill_id, sk.name, sk.owner_scope_id, v.version, v.author_id, v.base_version_id, sk.current_version_id, v.allowed_tools, v.flags, v.guidance_hash,
            v.import_id, i.started_by AS import_started_by
       FROM skill_versions v JOIN skills sk ON sk.id = v.skill_id LEFT JOIN skill_imports i ON i.id = v.import_id
      WHERE v.skill_id = $1 AND v.version = $2 FOR UPDATE OF v, sk`,
    [skillId, version],
  );
  if (!rows[0]) throw new NotFoundError(`version ${version}`);
  return rows[0];
}

/**
 * Review decisions through Claude: an MCP call (ctx.viaAgent) or a REST call made with a personal API token or OAuth
 * token (ctx.viaToken, the credential Claude Code holds) decides with the caller's own permissions while "Approvals
 * from Claude" is on (Admin › System, ALLOW_MCP_APPROVALS). Off, both are refused, as in 1.0.1: a person signed in
 * to the web app decides. Through Claude the second-person rule always holds (checkApprovable).
 */
export async function refuseAgent(ctx: RequestContext) {
  if (!viaClaude(ctx) || (await mcpApprovalsOn(ctx))) return;
  if (ctx.viaAgent) throw new ForbiddenError(`skill reviews are a person's decision in the Thaliyola web app (Review › Skills), not something Claude can do: ${MCP_APPROVALS_OFF}`);
  throw new ForbiddenError(`skill reviews are a person's decision, signed in to the Thaliyola web app (Review › Skills): API and OAuth tokens, which Claude and scripts use, can't approve, reject or roll back skills: ${MCP_APPROVALS_OFF}`);
}

export interface ApproveInput {
  note?: string;
  checked_tools?: boolean;
  checked_flags?: boolean;
}

/** The checks shared by single and group approval; throws with the reason. */
async function checkApprovable(ctx: RequestContext, v: PendingRow, input: ApproveInput, selfOk: boolean) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("service identities can't approve skill versions");
  // Through Claude a second person always approves, whatever "Let people approve their own skill versions" says.
  const self = !selfOk || viaClaude(ctx);
  if (v.author_id === ctx.actor.id && self) throw new ForbiddenError("someone else must approve this version: you proposed it (skills are instructions Claude follows, so a second person checks them)");
  if (v.import_started_by === ctx.actor.id && self) throw new ForbiddenError("someone else must approve this version: you started the import that proposed it (skills are instructions Claude follows, so a second person checks them)");
  if (v.base_version_id !== v.current_version_id) {
    const nums = await ctx.db.query<{ id: string; version: number }>("SELECT id, version FROM skill_versions WHERE id = ANY ($1::uuid[])", [[v.base_version_id, v.current_version_id].filter(Boolean)]);
    const n = (id: string | null) => (id ? `v${nums.rows.find((r) => r.id === id)?.version}` : "none");
    throw new ConflictError(`The published version changed since this was proposed (${n(v.base_version_id)} → ${n(v.current_version_id)}). Reject it and propose again.`, { base: n(v.base_version_id), current: n(v.current_version_id) });
  }
  if (v.allowed_tools && !input.checked_tools) throw new ValidationError("this version pre-approves tools in Claude Code (allowed-tools): tick \"I checked the pre-approved tools\" (checked_tools) to approve it");
  if (v.flags.some((f) => f.high_risk) && !input.checked_flags) throw new ValidationError("this version has high-risk flags (scripts, hidden text, admin tools, new hosts): tick \"I checked the flagged lines\" (checked_flags) to approve it");
}

/**
 * Makes a pending version the published one: the state, who decided and how, and the skill's current version (what
 * Claude, downloads and the sync deliver). Shared by approval and by a Project admin's direct publish (`direct`).
 */
async function publish(ctx: RequestContext, tx: import("pg").PoolClient | Queryable, v: { id: string; skill_id: string }, note: string | undefined, selfApproved: boolean, direct = false) {
  await tx.query("UPDATE skill_versions SET state = 'published', reviewer_id = $2, decided_at = now(), reason = $3, self_approved = $4, decided_via = $5, direct = $6 WHERE id = $1", [
    v.id,
    ctx.actor.id,
    note?.trim() || null,
    selfApproved,
    decidedVia(ctx),
    direct,
  ]);
  await tx.query("UPDATE skills SET current_version_id = $2, updated_at = now() WHERE id = $1", [v.skill_id, v.id]);
}

/**
 * Publishes a version its author just wrote, without a second person: a Project admin's own skill in their own project
 * (core/skills/catalog.ts directPublish decides when). The same publishing as approval, audited as
 * publish_skill_version with direct: true. Callers skip the reviewers' notification.
 */
export async function publishDirectly(
  ctx: RequestContext,
  tx: Queryable,
  v: { id: string; skill_id: string; name: string; version: number; from_version: number | null },
) {
  await publish(ctx, tx, v, undefined, false, true);
  await audit(tx, ctx.actor.id, "publish_skill_version", v.skill_id, {
    targetKind: "skill",
    targetLabel: v.name,
    details: { name: v.name, version: v.version, from_version: v.from_version, direct: true, ...viaDetails(ctx) },
  });
}

export async function approveSkillVersion(ctx: RequestContext, skillId: string, version: number, input: ApproveInput = {}) {
  await refuseAgent(ctx);
  await assertSkillRight(ctx, skillId, "review");
  const selfOk = await selfApprovalOn(ctx);
  const out = await withTx(ctx.db, async (tx) => {
    const v = await pendingVersion(ctx, skillId, version, tx);
    const state = (await tx.query<{ state: string }>("SELECT state FROM skill_versions WHERE id = $1", [v.id])).rows[0]!.state;
    if (state !== "pending") throw new ValidationError(`version ${version} is ${state}, not waiting for review`);
    await checkApprovable(ctx, v, input, selfOk);
    const from = v.current_version_id ? (await tx.query<{ version: number }>("SELECT version FROM skill_versions WHERE id = $1", [v.current_version_id])).rows[0]?.version ?? null : null;
    const self = v.author_id === ctx.actor.id;
    await publish(ctx, tx, v, input.note, self);
    await audit(tx, ctx.actor.id, "publish_skill_version", v.skill_id, {
      targetKind: "skill",
      targetLabel: v.name,
      details: { name: v.name, version: v.version, from_version: from, ...(self ? { self_approved: true } : {}), ...viaDetails(ctx) },
    });
    return v;
  });
  if (out.author_id) await tellSkill(ctx.db, ctx.settings, [out.author_id], { title: `Skill ${out.name}: version ${out.version} was published`, link: `#/skills/${out.skill_id}`, targetId: out.skill_id }, ctx.actor.id);
  return { id: out.skill_id, name: out.name, version: out.version, state: "published" };
}

export async function rejectSkillVersion(ctx: RequestContext, skillId: string, version: number, reason: string) {
  await refuseAgent(ctx);
  await assertSkillRight(ctx, skillId, "review");
  if (!reason?.trim()) throw new ValidationError("a reason is required");
  const out = await withTx(ctx.db, async (tx) => {
    const v = await pendingVersion(ctx, skillId, version, tx);
    const state = (await tx.query<{ state: string }>("SELECT state FROM skill_versions WHERE id = $1", [v.id])).rows[0]!.state;
    if (state !== "pending") throw new ValidationError(`version ${version} is ${state}, not waiting for review`);
    await tx.query("UPDATE skill_versions SET state = 'rejected', reviewer_id = $2, decided_at = now(), reason = $3, decided_via = $4 WHERE id = $1", [v.id, ctx.actor.id, reason.trim().slice(0, 2000), decidedVia(ctx)]);
    await audit(tx, ctx.actor.id, "reject_skill_version", v.skill_id, { targetKind: "skill", targetLabel: v.name, details: { name: v.name, version: v.version, reason: reason.trim().slice(0, 300), ...viaDetails(ctx) } });
    return v;
  });
  if (out.author_id) await tellSkill(ctx.db, ctx.settings, [out.author_id], { title: `Skill ${out.name}: version ${out.version} was rejected`, body: reason.trim().slice(0, 500), link: `#/skills/${out.skill_id}`, targetId: out.skill_id }, ctx.actor.id);
  return { id: out.skill_id, name: out.name, version: out.version, state: "rejected" };
}

/** Approves every pending guidance-only version with this hash that the caller may approve (same checks each). */
export async function approveGuidanceGroup(ctx: RequestContext, guidanceHash: string, input: ApproveInput = {}) {
  await refuseAgent(ctx);
  if (!/^[0-9a-f]{64}$/.test(guidanceHash)) throw new NotFoundError("shared guidance update");
  const { rows } = await ctx.db.query<{ skill_id: string; version: number; name: string; owner_scope_id: string | null }>(
    "SELECT v.skill_id, v.version, sk.name, sk.owner_scope_id FROM skill_versions v JOIN skills sk ON sk.id = v.skill_id WHERE v.state = 'pending' AND v.guidance_hash = $1 ORDER BY sk.name",
    [guidanceHash],
  );
  const approved: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const r of rows) {
    const rights = await ownerRights(ctx, r.owner_scope_id);
    if (!rights.see) continue;
    if (!rights.review) {
      skipped.push({ name: r.name, reason: "you can't review this skill" });
      continue;
    }
    try {
      await approveSkillVersion(ctx, r.skill_id, r.version, { ...input, checked_tools: input.checked_tools, checked_flags: input.checked_flags });
      approved.push(r.name);
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof ValidationError || err instanceof ConflictError) skipped.push({ name: r.name, reason: err.message });
      else throw err;
    }
  }
  if (!approved.length && !skipped.length) throw new NotFoundError("shared guidance update");
  if (approved.length) await audit(ctx.db, ctx.actor.id, "publish_skill_versions_guidance", null, { targetKind: "skill", targetLabel: `${approved.length} skills`, details: { guidance_hash: guidanceHash, skills: approved, count: approved.length } });
  return { approved, skipped };
}

/** Publishes a copy of an older published version as a new version, supersedes what's pending, and holds the skill. */
export async function rollbackSkill(ctx: RequestContext, skillId: string, version: number) {
  await refuseAgent(ctx);
  const { skill } = await assertSkillRight(ctx, skillId, "review");
  const out = await withTx(ctx.db, async (tx) => {
    await tx.query("SELECT id FROM skills WHERE id = $1 FOR UPDATE", [skill.id]);
    const src = (await tx.query<{ id: string; state: string; summary: string; source_commit: string | null }>("SELECT id, state, summary, source_commit FROM skill_versions WHERE skill_id = $1 AND version = $2", [skill.id, version])).rows[0];
    if (!src) throw new NotFoundError(`version ${version}`);
    if (src.state !== "published") throw new ValidationError(`only versions that were published can be restored (v${version} is ${src.state})`);
    const cur = (await tx.query<{ current_version_id: string | null }>("SELECT current_version_id FROM skills WHERE id = $1", [skill.id])).rows[0]!.current_version_id;
    if (cur === src.id) throw new ValidationError(`v${version} is already the published version`);
    const files = await versionFiles(tx, src.id);
    const prepared = prepareSkill(skill.name, files.map((f) => ({ path: f.path, data: new Uint8Array(f.data), managed: f.managed, deliver: f.deliver })));
    // Restoring content that was already reviewed: its files are checked again and never refused for flags, but what
    // today's rules reject (a secret pattern added since, say) isn't published again.
    if (prepared.errors.length) throw new ValidationError(`v${version} can't be restored: ${prepared.errors.slice(0, 5).join("; ")}`);
    const v = await insertVersion(tx, { skillId: skill.id, state: "published", baseVersionId: cur, prepared, summary: `Restored v${version}`, authorId: ctx.actor.id, restoredFrom: version, sourceCommit: src.source_commit }, `a rollback to v${version}`);
    await tx.query("UPDATE skill_versions SET reviewer_id = $2 WHERE id = $1", [v.id, ctx.actor.id]);
    await tx.query("UPDATE skills SET held_at_version = $2, held_by = $3, updated_at = now() WHERE id = $1", [skill.id, v.version, ctx.actor.id]);
    await audit(tx, ctx.actor.id, "rollback_skill", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, to_version: version, restored_from: version, new_version: v.version, held: true } });
    return v;
  });
  if (out.superseded?.author_id && out.superseded.author_id !== ctx.actor.id) {
    await tellSkill(ctx.db, ctx.settings, [out.superseded.author_id], { title: `Skill ${skill.name}: your version ${out.superseded.version} was replaced by a rollback to v${version}`, link: `#/skills/${skill.id}`, targetId: skill.id });
  }
  return { id: skill.id, name: skill.name, version: out.version, restored_from: version, held_at_version: out.version };
}

export async function releaseHold(ctx: RequestContext, skillId: string) {
  await refuseAgent(ctx);
  const { skill } = await assertSkillRight(ctx, skillId, "review");
  if (skill.held_at_version === null) throw new ValidationError("this skill isn't held");
  await ctx.db.query("UPDATE skills SET held_at_version = NULL, held_by = NULL, updated_at = now() WHERE id = $1", [skill.id]);
  await audit(ctx.db, ctx.actor.id, "release_skill_hold", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, held_at: skill.held_at_version } });
  return { id: skill.id, held_at_version: null };
}

/** Confirms or declines a collection move that would give the skill to more people (not by whoever started it). */
export async function decideAudienceChange(ctx: RequestContext, skillId: string, decision: "confirm" | "decline") {
  await refuseAgent(ctx);
  const { skill } = await assertSkillRight(ctx, skillId, "review");
  if (!skill.pending_collection_id) throw new ValidationError("no move waits for review on this skill");
  if (skill.pending_collection_by === ctx.actor.id) throw new ForbiddenError("someone else must confirm this move: you started it");
  const slugs = await ctx.db.query<{ id: string; slug: string }>("SELECT id, slug FROM skill_collections WHERE id = ANY ($1::uuid[])", [[skill.collection_id, skill.pending_collection_id].filter(Boolean)]);
  const slug = (id: string | null) => slugs.rows.find((r) => r.id === id)?.slug ?? null;
  const gains = await audienceGain(ctx, skill, skill.pending_collection_id);
  if (decision === "confirm") {
    await ctx.db.query("UPDATE skills SET collection_id = pending_collection_id, pending_collection_id = NULL, pending_collection_by = NULL, pending_collection_import_id = NULL, declined_collection_id = NULL, updated_at = now() WHERE id = $1", [skill.id]);
  } else {
    await ctx.db.query("UPDATE skills SET declined_collection_id = pending_collection_id, pending_collection_id = NULL, pending_collection_by = NULL, pending_collection_import_id = NULL, updated_at = now() WHERE id = $1", [skill.id]);
  }
  await audit(ctx.db, ctx.actor.id, "decide_skill_audience_change", skill.id, {
    targetKind: "skill",
    targetLabel: skill.name,
    details: { name: skill.name, from: slug(skill.collection_id), to: slug(skill.pending_collection_id), decision, gains },
  });
  return { id: skill.id, decision, collection: decision === "confirm" ? slug(skill.pending_collection_id) : slug(skill.collection_id) };
}

/**
 * "Review this import": approves every version an import proposed that the caller may approve and that has no
 * high-risk flags and pre-approves no tools (those still need their own "I checked" on the skill). Each version is
 * approved and audited on its own, with the same checks as one by one.
 */
export async function approveImportVersions(ctx: RequestContext, importId: string, input: { note?: string } = {}) {
  await refuseAgent(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new NotFoundError("import");
  const imp = (await ctx.db.query<{ owner_scope_id: string | null }>("SELECT owner_scope_id FROM skill_imports WHERE id = $1", [importId])).rows[0];
  if (!imp || !(await ownerRights(ctx, imp.owner_scope_id)).see) throw new NotFoundError("import");
  const { rows } = await ctx.db.query<{ skill_id: string; version: number; name: string; owner_scope_id: string | null; flags: SkillFlag[]; allowed_tools: string | null }>(
    `SELECT v.skill_id, v.version, sk.name, sk.owner_scope_id, v.flags, v.allowed_tools FROM skill_versions v JOIN skills sk ON sk.id = v.skill_id
      WHERE v.import_id = $1 AND v.state = 'pending' ORDER BY sk.name`,
    [importId],
  );
  const approved: string[] = [];
  const skipped: { name: string; skill_id: string; version: number; reason: string }[] = [];
  for (const r of rows) {
    const rights = await ownerRights(ctx, r.owner_scope_id);
    if (!rights.see) continue;
    const skip = (reason: string) => skipped.push({ name: r.name, skill_id: r.skill_id, version: r.version, reason });
    if (!rights.review) skip("you can't review this skill");
    else if (r.flags.some((f) => f.high_risk)) skip("has high-risk flags: open it and tick \"I checked the flagged lines\"");
    else if (r.allowed_tools) skip("pre-approves tools in Claude Code: open it and tick \"I checked the pre-approved tools\"");
    else {
      try {
        await approveSkillVersion(ctx, r.skill_id, r.version, { note: input.note });
        approved.push(r.name);
      } catch (err) {
        if (err instanceof ForbiddenError || err instanceof ValidationError || err instanceof ConflictError || err instanceof NotFoundError) skip(err.message);
        else throw err;
      }
    }
  }
  if (approved.length) await audit(ctx.db, ctx.actor.id, "publish_skill_versions_import", importId, { targetKind: "skill", targetLabel: `${approved.length} skills`, details: { import_id: importId, skills: approved, count: approved.length, skipped: skipped.length, ...viaDetails(ctx) } });
  return { approved, skipped };
}

/** Approves or declines an upstream change to a collection's name, description or connectors. */
export async function decideCollectionChange(ctx: RequestContext, slug: string, decision: "approve" | "decline") {
  await refuseAgent(ctx);
  const c = await collectionBySlug(ctx, slug, "see");
  const rights = await ownerRights(ctx, c.owner_scope_id);
  if (!rights.review) throw new ForbiddenError("approving a collection change needs Review skills (or, for a project's own collection, Manage settings there)");
  const row = (
    await ctx.db.query<{ pending_meta: { name: string; description: string; connectors: { name: string; type: string; url: string }[] } | null; pending_meta_by: string | null }>(
      "SELECT pending_meta, pending_meta_by FROM skill_collections WHERE id = $1 FOR UPDATE",
      [c.id],
    )
  ).rows[0];
  if (!row?.pending_meta) throw new ValidationError("no change waits for review on this collection");
  if (row.pending_meta_by === ctx.actor.id && !(await selfApprovalOn(ctx))) throw new ForbiddenError("someone else must decide on this change: you imported it");
  const from = { name: c.name, description: c.description, connectors: c.connectors ?? [] };
  const to = row.pending_meta;
  if (decision === "approve") {
    await ctx.db.query(
      `UPDATE skill_collections SET name = $2, description = $3, connectors = $4, declined_meta_hash = NULL,
              pending_meta = NULL, pending_meta_by = NULL, pending_meta_import_id = NULL, pending_meta_at = NULL, updated_at = now() WHERE id = $1`,
      [c.id, to.name, to.description, JSON.stringify(to.connectors ?? [])],
    );
  } else {
    await ctx.db.query(
      "UPDATE skill_collections SET declined_meta_hash = $2, pending_meta = NULL, pending_meta_by = NULL, pending_meta_import_id = NULL, pending_meta_at = NULL, updated_at = now() WHERE id = $1",
      [c.id, metaHash(to)],
    );
  }
  await audit(ctx.db, ctx.actor.id, decision === "approve" ? "approve_skill_collection_change" : "decline_skill_collection_change", c.id, {
    targetKind: "skill_collection",
    targetLabel: c.name,
    details: { collection: c.slug, ...metaDiff(from, to) },
  });
  return { slug: c.slug, decision, connectors: decision === "approve" ? to.connectors : from.connectors };
}

// ---- the queue ------------------------------------------------------------------------------------------------------

/** Review › Skills: pending versions, shared-guidance groups, audience changes and problem reports. */
export async function listSkillReview(ctx: RequestContext) {
  if (!(await seesCatalogue(ctx))) throw new ForbiddenError("skill review is for people who manage or review skills");
  const params: unknown[] = [];
  const where = await visibleOwnerSql(ctx, "sk", params);
  const selfOk = await selfApprovalOn(ctx);
  const { rows } = await ctx.db.query<{
    skill_id: string;
    name: string;
    owner_scope_id: string | null;
    version: number;
    summary: string;
    author_id: string | null;
    author: string | null;
    created_at: string;
    flags: SkillFlag[];
    allowed_tools: string | null;
    has_scripts: boolean;
    guidance_hash: string | null;
    stale: boolean;
    base_version: number | null;
    source: string | null;
    source_commit: string | null;
    collection: string | null;
    import_id: string | null;
    import_started_by: string | null;
    created_via: string | null;
  }>(
    `SELECT sk.id AS skill_id, sk.name, sk.owner_scope_id, v.version, v.summary, v.author_id, coalesce(nullif(u.display_name, ''), u.email) AS author, v.created_at,
            v.flags, v.allowed_tools, v.has_scripts, v.guidance_hash, v.base_version_id IS DISTINCT FROM sk.current_version_id AS stale, v.import_id,
            imp.started_by AS import_started_by, v.created_via,
            b.version AS base_version, src.name AS source, v.source_commit, c.slug AS collection
       FROM skill_versions v JOIN skills sk ON sk.id = v.skill_id
       LEFT JOIN users u ON u.id = v.author_id LEFT JOIN skill_versions b ON b.id = v.base_version_id
       LEFT JOIN skill_sources src ON src.id = sk.source_id LEFT JOIN skill_collections c ON c.id = sk.collection_id
       LEFT JOIN skill_imports imp ON imp.id = v.import_id
      WHERE v.state = 'pending' AND ${where}
      ORDER BY v.created_at`,
    params,
  );
  const versions = [];
  // Through Claude a second person always approves (checkApprovable).
  const ownOk = selfOk && !viaClaude(ctx);
  for (const r of rows) {
    const rights = await ownerRights(ctx, r.owner_scope_id);
    const high = r.flags.filter((f) => f.high_risk);
    versions.push({
      skill_id: r.skill_id,
      name: r.name,
      collection: r.collection,
      version: r.version,
      summary: r.summary,
      author: r.author,
      mine: r.author_id === ctx.actor.id,
      created_at: r.created_at,
      base_version: r.base_version,
      stale: r.stale,
      source: r.source,
      source_commit: r.source_commit,
      has_scripts: r.has_scripts,
      allowed_tools: r.allowed_tools,
      flags: [...high, ...r.flags.filter((f) => !f.high_risk)].slice(0, 50),
      high_risk_flags: high.length,
      guidance_hash: r.guidance_hash,
      import_id: r.import_id,
      created_via: r.created_via,
      can_approve: rights.review && ((r.author_id !== ctx.actor.id && r.import_started_by !== ctx.actor.id) || ownOk) && !r.stale,
      can_reject: rights.review,
    });
  }
  const groups = new Map<string, { guidance_hash: string; skills: { skill_id: string; name: string; version: number; mine: boolean }[] }>();
  for (const v of versions) {
    if (!v.guidance_hash || v.stale) continue;
    const g = groups.get(v.guidance_hash) ?? { guidance_hash: v.guidance_hash, skills: [] };
    g.skills.push({ skill_id: v.skill_id, name: v.name, version: v.version, mine: v.mine });
    groups.set(v.guidance_hash, g);
  }
  const moves = (
    await ctx.db.query<{ id: string; name: string; owner_scope_id: string | null; collection_id: string | null; pending_collection_id: string; pending_collection_by: string | null; from_slug: string | null; to_slug: string; by_name: string | null }>(
      `SELECT sk.id, sk.name, sk.owner_scope_id, sk.collection_id, sk.pending_collection_id, sk.pending_collection_by, f.slug AS from_slug, t.slug AS to_slug,
              coalesce(nullif(u.display_name, ''), u.email) AS by_name
         FROM skills sk JOIN skill_collections t ON t.id = sk.pending_collection_id LEFT JOIN skill_collections f ON f.id = sk.collection_id
         LEFT JOIN users u ON u.id = sk.pending_collection_by
        WHERE ${where.replace(/\$(\d+)/g, (_m, n) => `$${n}`)} ORDER BY sk.name`,
      params,
    )
  ).rows;
  const audience_changes = [];
  for (const m of moves) {
    const rights = await ownerRights(ctx, m.owner_scope_id);
    audience_changes.push({
      skill_id: m.id,
      name: m.name,
      from: m.from_slug,
      to: m.to_slug,
      started_by: m.by_name,
      gains: await audienceGain(ctx, { id: m.id, collection_id: m.collection_id }, m.pending_collection_id),
      can_decide: rights.review && m.pending_collection_by !== ctx.actor.id,
    });
  }
  // Versions from one import that can be approved together (no high-risk flags, no pre-approved tools).
  const imports = new Map<string, { import_id: string; source: string | null; source_commit: string | null; versions: number; approvable: number }>();
  for (const v of versions) {
    if (!v.import_id) continue;
    const g = imports.get(v.import_id) ?? { import_id: v.import_id, source: v.source, source_commit: v.source_commit, versions: 0, approvable: 0 };
    g.versions++;
    if (v.can_approve && !v.high_risk_flags && !v.allowed_tools) g.approvable++;
    imports.set(v.import_id, g);
  }
  const collection_changes = await collectionChanges(ctx, selfOk);
  const { listSkillFeedback } = await import("./feedback.js");
  const feedback = (await listSkillFeedback(ctx, { state: "open" })).feedback;
  return {
    versions,
    guidance_groups: [...groups.values()].filter((g) => g.skills.length > 1),
    import_groups: [...imports.values()].filter((g) => g.approvable > 1),
    audience_changes,
    collection_changes,
    feedback,
    counts: {
      to_review: versions.filter((v) => v.can_approve).length + audience_changes.filter((a) => a.can_decide).length + collection_changes.filter((c) => c.can_decide).length,
      pending: versions.length,
      feedback: feedback.length,
    },
  };
}

/** Upstream changes to collections' names, descriptions and connectors the caller sees. */
async function collectionChanges(ctx: RequestContext, selfOk: boolean) {
  const { rows } = await ctx.db.query<{
    slug: string;
    name: string;
    description: string;
    owner_scope_id: string | null;
    connectors: { name: string; type: string; url: string }[];
    pending_meta: { name: string; description: string; connectors: { name: string; type: string; url: string }[] };
    pending_meta_by: string | null;
    pending_meta_at: string;
    by_name: string | null;
    source: string | null;
  }>(
    `SELECT c.slug, c.name, c.description, c.owner_scope_id, c.connectors, c.pending_meta, c.pending_meta_by, c.pending_meta_at,
            coalesce(nullif(u.display_name, ''), u.email) AS by_name, s.name AS source
       FROM skill_collections c LEFT JOIN users u ON u.id = c.pending_meta_by LEFT JOIN skill_sources s ON s.id = c.source_id
      WHERE c.pending_meta IS NOT NULL ORDER BY c.pending_meta_at`,
  );
  const out = [];
  for (const r of rows) {
    const rights = await ownerRights(ctx, r.owner_scope_id);
    if (!rights.see) continue;
    const before = new Set((r.connectors ?? []).map((x) => x.url));
    out.push({
      slug: r.slug,
      source: r.source,
      started_by: r.by_name,
      at: r.pending_meta_at,
      from: { name: r.name, description: r.description, connectors: r.connectors ?? [] },
      to: r.pending_meta,
      new_hosts: [...new Set((r.pending_meta.connectors ?? []).filter((x) => !before.has(x.url)).map((x) => hostOf(x.url)))],
      can_decide: rights.review && (r.pending_meta_by !== ctx.actor.id || selfOk),
    });
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The sidebar badge: versions the caller may approve (not their own) plus audience changes; all pending; open reports. */
export async function skillReviewCounts(ctx: RequestContext) {
  if (!(await seesCatalogue(ctx))) return { to_review: 0, pending: 0, feedback: 0 };
  const params: unknown[] = [];
  const where = await visibleOwnerSql(ctx, "sk", params);
  const selfOk = (await selfApprovalOn(ctx)) && !viaClaude(ctx);
  params.push(ctx.actor.id);
  const me = params.length;
  const { rows } = await ctx.db.query<{ owner_scope_id: string | null; mine: boolean; stale: boolean; kind: string }>(
    `SELECT sk.owner_scope_id, (v.author_id = $${me}) AS mine, v.base_version_id IS DISTINCT FROM sk.current_version_id AS stale, 'version' AS kind
       FROM skill_versions v JOIN skills sk ON sk.id = v.skill_id WHERE v.state = 'pending' AND ${where}
     UNION ALL
     SELECT sk.owner_scope_id, (sk.pending_collection_by = $${me}), false, 'move' FROM skills sk WHERE sk.pending_collection_id IS NOT NULL AND ${where}
     UNION ALL
     SELECT sk.owner_scope_id, false, false, 'feedback' FROM skill_feedback f JOIN skills sk ON sk.id = f.skill_id WHERE f.state = 'open' AND ${where}
     UNION ALL
     SELECT sk.owner_scope_id, (sk.pending_meta_by = $${me}), false, 'collection' FROM skill_collections sk WHERE sk.pending_meta IS NOT NULL AND ${where}`,
    params,
  );
  let toReview = 0;
  let pending = 0;
  let feedback = 0;
  const rightsCache = new Map<string, boolean>();
  for (const r of rows) {
    if (r.kind === "feedback") {
      feedback++;
      continue;
    }
    if (r.kind === "version") pending++;
    const key = r.owner_scope_id ?? "";
    if (!rightsCache.has(key)) rightsCache.set(key, (await ownerRights(ctx, r.owner_scope_id)).review);
    if (rightsCache.get(key) && !r.stale && (!r.mine || ((r.kind === "version" || r.kind === "collection") && selfOk))) toReview++;
  }
  return { to_review: toReview, pending, feedback };
}
