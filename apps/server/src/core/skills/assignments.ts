import type { Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { canReadScope, isAdmin } from "../permissions.js";
import { listRoles, resolveRoles } from "../roles.js";
import { assertSkillRight, ownerRights, type SkillRow } from "./access.js";
import { peopleMatching } from "./delivery.js";

/**
 * Who gets a skill: assignments on the skill or on its collection (which reach skills added to it later too), to
 * everyone, an organisation role, a team, a project (and the projects under it) or a project role (in one project or
 * any). A project's own skills go only to that project and the projects under it. Projects a viewer can't read are
 * never named: "A members-only project".
 */

export type Audience = "everyone" | "org_role" | "team" | "project" | "project_role";
export const AUDIENCES: Audience[] = ["everyone", "org_role", "team", "project", "project_role"];

export interface AssignmentInput {
  audience: Audience;
  role?: string | null;
  team?: string | null;
  project?: string | null;
}

interface AssignmentRow {
  id: string;
  skill_id: string | null;
  collection_id: string | null;
  audience: Audience;
  role: string | null;
  role_name: string | null;
  team_id: string | null;
  team_slug: string | null;
  team_name: string | null;
  scope_id: string | null;
  scope_slug: string | null;
  scope_name: string | null;
  created_at: string;
  created_by_name: string | null;
}

const ROW_SQL = `SELECT a.id, a.skill_id, a.collection_id, a.audience, a.role, r.name AS role_name, a.team_id, t.slug AS team_slug, t.name AS team_name,
         a.scope_id, s.slug AS scope_slug, s.name AS scope_name, a.created_at, coalesce(nullif(u.display_name, ''), u.email) AS created_by_name
    FROM skill_assignments a LEFT JOIN roles r ON r.key = a.role LEFT JOIN teams t ON t.id = a.team_id
    LEFT JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.created_by`;

/** How an assignment reads for one viewer; a project they can't read is "A members-only project". */
export async function viewOf(ctx: RequestContext, a: AssignmentRow) {
  const readable = a.scope_id ? await canReadScope(ctx, a.scope_id) : true;
  const project = a.scope_id ? (readable ? { slug: a.scope_slug, name: a.scope_name } : { slug: null, name: "A members-only project" }) : null;
  return {
    id: a.id,
    on: a.skill_id ? ("skill" as const) : ("collection" as const),
    audience: a.audience,
    role: a.role ? { key: a.role, name: a.role_name ?? a.role } : null,
    team: a.team_id ? { slug: a.team_slug, name: a.team_name } : null,
    project,
    label: labelOf(a, project?.name ?? null),
    created_at: a.created_at,
    created_by: a.created_by_name,
  };
}

export function labelOf(a: Pick<AssignmentRow, "audience" | "role" | "role_name" | "team_name">, projectName: string | null): string {
  switch (a.audience) {
    case "everyone":
      return "Everyone";
    case "org_role":
      return `${a.role_name ?? a.role} (organisation role)`;
    case "team":
      return `The ${a.team_name} team`;
    case "project":
      return `${projectName} (and the projects under it)`;
    case "project_role":
      return projectName ? `${a.role_name ?? a.role} in ${projectName}` : `${a.role_name ?? a.role} in any project`;
  }
}

async function rowsFor(db: Queryable, where: string, params: unknown[]): Promise<AssignmentRow[]> {
  return (await db.query<AssignmentRow>(`${ROW_SQL} WHERE ${where} ORDER BY a.created_at`, params)).rows;
}

/** A skill's own assignments and its collection's (read-only here), for people who manage it. */
export async function listAssignments(ctx: RequestContext, skillId: string) {
  const { skill } = await assertSkillRight(ctx, skillId, "see");
  const own = await rowsFor(ctx.db, "a.skill_id = $1", [skill.id]);
  const coll = skill.collection_id ? await rowsFor(ctx.db, "a.collection_id = $1", [skill.collection_id]) : [];
  const collection = skill.collection_id ? (await ctx.db.query<{ slug: string; name: string }>("SELECT slug, name FROM skill_collections WHERE id = $1", [skill.collection_id])).rows[0] : undefined;
  return {
    skill: { id: skill.id, name: skill.name },
    assignments: await Promise.all(own.map((a) => viewOf(ctx, a))),
    collection: collection ? { slug: collection.slug, name: collection.name, assignments: await Promise.all(coll.map((a) => viewOf(ctx, a))) } : null,
  };
}

interface Resolved {
  audience: Audience;
  role: string | null;
  role_name: string | null;
  team_id: string | null;
  team_name: string | null;
  scope_id: string | null;
  scope_name: string | null;
}

/** Turns names into ids, with friendly errors; an owned target only takes its own project's subtree. */
async function resolve(ctx: RequestContext, input: AssignmentInput, ownerScopeId: string | null): Promise<Resolved> {
  if (!AUDIENCES.includes(input.audience)) throw new ValidationError(`audience is one of ${AUDIENCES.join(", ")}`);
  const out: Resolved = { audience: input.audience, role: null, role_name: null, team_id: null, team_name: null, scope_id: null, scope_name: null };
  if (ownerScopeId && input.audience !== "project" && input.audience !== "project_role") {
    throw new ValidationError("a project's own skills go only to that project and the projects under it (audience project or project_role)");
  }
  if (input.audience === "org_role" || input.audience === "project_role") {
    if (!input.role?.trim()) throw new ValidationError(`audience ${input.audience} needs a role`);
    const [role] = await resolveRoles(ctx.db, input.audience === "org_role" ? "org" : "project", [input.role]);
    out.role = role!.key;
    out.role_name = role!.name;
  }
  if (input.audience === "team") {
    const t = input.team?.trim();
    if (!t) throw new ValidationError("audience team needs a team");
    const { rows } = await ctx.db.query<{ id: string; name: string }>("SELECT id, name FROM teams WHERE slug = $1 OR lower(name) = lower($1) OR id::text = $1 LIMIT 1", [t]);
    if (!rows[0]) throw new NotFoundError(`team '${t}'`);
    out.team_id = rows[0].id;
    out.team_name = rows[0].name;
  }
  if (input.audience === "project" || (input.audience === "project_role" && input.project?.trim())) {
    const p = input.project?.trim();
    if (!p) throw new ValidationError("audience project needs a project");
    const { rows } = await ctx.db.query<{ id: string; name: string; kind: string }>("SELECT id, name, kind FROM scopes WHERE slug = $1", [p]);
    const scope = rows[0];
    if (!scope || !(await canReadScope(ctx, scope.id))) throw new NotFoundError(`project '${p}'`, `project '${p}' not found; list_projects shows the projects you can see`);
    if (scope.kind !== "project") throw new ValidationError(`'${p}' isn't a project`);
    out.scope_id = scope.id;
    out.scope_name = scope.name;
  }
  if (ownerScopeId) {
    out.scope_id ??= ownerScopeId;
    const inside = await ctx.db.query("SELECT 1 FROM scope_subtree WHERE root_id = $1 AND scope_id = $2", [ownerScopeId, out.scope_id]);
    if (!inside.rowCount) throw new ValidationError("a project's own skills go only to that project and the projects under it");
    if (!out.scope_name) out.scope_name = (await ctx.db.query<{ name: string }>("SELECT name FROM scopes WHERE id = $1", [out.scope_id])).rows[0]?.name ?? null;
  }
  return out;
}

async function insert(ctx: RequestContext, on: { skill_id?: string; collection_id?: string }, r: Resolved): Promise<{ id: string; created: boolean }> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO skill_assignments (skill_id, collection_id, audience, role, team_id, scope_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING RETURNING id`,
    [on.skill_id ?? null, on.collection_id ?? null, r.audience, r.role, r.team_id, r.scope_id, ctx.actor.id],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await ctx.db.query<{ id: string }>(
    `SELECT id FROM skill_assignments WHERE coalesce(skill_id, collection_id) = $1 AND audience = $2 AND coalesce(role, '') = coalesce($3, '')
        AND coalesce(team_id::text, '') = coalesce($4::text, '') AND coalesce(scope_id::text, '') = coalesce($5::text, '')`,
    [on.skill_id ?? on.collection_id, r.audience, r.role, r.team_id, r.scope_id],
  );
  return { id: existing.rows[0]!.id, created: false };
}

const details = (r: Resolved) => ({ audience: r.audience, role: r.role, team: r.team_name, project: r.scope_name });

export async function addAssignment(ctx: RequestContext, skillId: string, input: AssignmentInput) {
  const { skill } = await assertSkillRight(ctx, skillId, "manage");
  const r = await resolve(ctx, input, skill.owner_scope_id);
  const { id, created } = await insert(ctx, { skill_id: skill.id }, r);
  if (created) await audit(ctx.db, ctx.actor.id, "assign_skill", skill.id, { targetKind: "skill", targetLabel: skill.name, details: { name: skill.name, ...details(r) } });
  const row = (await rowsFor(ctx.db, "a.id = $1", [id]))[0]!;
  return { created, assignment: await viewOf(ctx, row) };
}

export async function removeAssignment(ctx: RequestContext, assignmentId: string) {
  const row = (await rowsFor(ctx.db, "a.id = $1", [assignmentId]))[0];
  if (!row) throw new NotFoundError("assignment");
  let label: string;
  let target: string;
  let kind: "skill" | "skill_collection";
  if (row.skill_id) {
    const { skill } = await assertSkillRight(ctx, row.skill_id, "manage");
    label = skill.name;
    target = skill.id;
    kind = "skill";
  } else {
    const c = await collectionRow(ctx.db, row.collection_id!);
    if (!c) throw new NotFoundError("assignment");
    const rights = await ownerRights(ctx, c.owner_scope_id);
    if (!rights.see) throw new NotFoundError("assignment");
    if (!rights.manage) throw new ValidationError("changing who gets this collection needs Manage skills");
    label = c.name;
    target = c.id;
    kind = "skill_collection";
  }
  await ctx.db.query("DELETE FROM skill_assignments WHERE id = $1", [assignmentId]);
  const view = await viewOf(ctx, row);
  await audit(ctx.db, ctx.actor.id, "unassign_skill", target, { targetKind: kind, targetLabel: label, details: { name: label, audience: row.audience, role: row.role, team: row.team_name, project: view.project?.name ?? null } });
  return { removed: true, assignment: view };
}

/** One row of a preview: the assignment's label for the caller, whether it exists already, and who it newly reaches. */
export interface PreviewRow {
  label: string;
  already: boolean;
  gains: { people: number; audiences: string[] };
}

/**
 * Who would newly get a skill from several more assignments, without saving them (inserted inside a transaction
 * that's rolled back), labelled for the caller: a project they can't read is "A members-only project". Each row counts
 * the people it adds on top of what they have now and the rows before it, so `people` (their sum) counts everyone
 * once, however many of the roles or teams they match.
 */
export async function previewSkillAssignments(ctx: RequestContext, skillId: string, inputs: AssignmentInput[]) {
  const { skill } = await assertSkillRight(ctx, skillId, "manage");
  const resolved: { r: Resolved; label: string }[] = [];
  for (const input of inputs) {
    const r = await resolve(ctx, input, skill.owner_scope_id);
    resolved.push({ r, label: await labelFor(ctx, r, r.scope_name) });
  }
  const client = await (ctx.db as import("pg").Pool).connect();
  try {
    await client.query("BEGIN");
    const now = (await client.query<{ id: string }>("SELECT id FROM skill_assignments WHERE skill_id = $1 OR ($2::uuid IS NOT NULL AND collection_id = $2)", [skill.id, skill.collection_id])).rows.map((x) => x.id);
    const has = await peopleMatching(client, ctx.settings.adminEmails, now);
    const rows: PreviewRow[] = [];
    for (const { r, label } of resolved) {
      const tmp = await insert({ ...ctx, db: client as never }, { skill_id: skill.id }, r);
      let people = 0;
      if (tmp.created) {
        for (const p of await peopleMatching(client, ctx.settings.adminEmails, [tmp.id])) {
          if (!has.has(p)) (has.add(p), people++);
        }
      }
      rows.push({ label, already: !tmp.created, gains: { people, audiences: tmp.created ? [label] : [] } });
    }
    return { dry_run: true as const, skill: { id: skill.id, name: skill.name }, rows, people: rows.reduce((n, x) => n + x.gains.people, 0) };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** The id of the assignment `input` describes on a skill or a collection, or null when there's none. */
export async function findAssignment(ctx: RequestContext, on: { skill_id: string } | { collection_id: string }, ownerScopeId: string | null, input: AssignmentInput): Promise<string | null> {
  const r = await resolve(ctx, input, ownerScopeId);
  const target = "skill_id" in on ? on.skill_id : on.collection_id;
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM skill_assignments WHERE ${"skill_id" in on ? "skill_id" : "collection_id"} = $1 AND audience = $2 AND coalesce(role, '') = coalesce($3, '')
        AND coalesce(team_id::text, '') = coalesce($4::text, '') AND coalesce(scope_id::text, '') = coalesce($5::text, '')`,
    [target, r.audience, r.role, r.team_id, r.scope_id],
  );
  return rows[0]?.id ?? null;
}

/** A collection's assignments, labelled for the caller (members-only projects they can't read aren't named). */
export async function listCollectionAssignments(ctx: RequestContext, collectionId: string) {
  return Promise.all((await rowsFor(ctx.db, "a.collection_id = $1", [collectionId])).map((a) => viewOf(ctx, a)));
}

export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  source_id: string | null;
  owner_scope_id: string | null;
  connectors: { name: string; type: string; url: string }[];
  upstream_version: string | null;
  removed_at: string | null;
}

export async function collectionRow(db: Queryable, id: string): Promise<CollectionRow | undefined> {
  return (await db.query<CollectionRow>("SELECT id, slug, name, description, source_id, owner_scope_id, connectors, upstream_version, removed_at FROM skill_collections WHERE id = $1", [id])).rows[0];
}

export async function collectionBySlug(ctx: RequestContext, slug: string, need: "see" | "manage" = "see"): Promise<CollectionRow> {
  const c = (await ctx.db.query<CollectionRow>("SELECT id, slug, name, description, source_id, owner_scope_id, connectors, upstream_version, removed_at FROM skill_collections WHERE slug = $1", [slug])).rows[0];
  if (!c) throw new NotFoundError(`skill collection '${slug}'`);
  const rights = await ownerRights(ctx, c.owner_scope_id);
  if (!rights.see) throw new NotFoundError(`skill collection '${slug}'`);
  if (need === "manage" && !rights.manage) throw new ValidationError("changing a skill collection needs Manage skills (or, for a project's own collection, Manage settings there)");
  return c;
}

/**
 * People who'd gain at least one of the collection's active skills from the assignments `added`: each skill's own
 * assignments plus the collection's count as what they have now.
 */
async function collectionGainers(db: Queryable, adminEmails: string[], collectionId: string, added: string[]): Promise<number> {
  if (!added.length) return 0;
  const reach = await peopleMatching(db, adminEmails, added);
  if (!reach.size) return 0;
  const coll = (await db.query<{ id: string }>("SELECT id FROM skill_assignments WHERE collection_id = $1 AND NOT (id = ANY ($2::uuid[]))", [collectionId, added])).rows.map((x) => x.id);
  const skills = (await db.query<{ id: string }>("SELECT id FROM skills WHERE collection_id = $1 AND status = 'active'", [collectionId])).rows;
  const gainers = new Set<string>();
  for (const s of skills) {
    const own = (await db.query<{ id: string }>("SELECT id FROM skill_assignments WHERE skill_id = $1", [s.id])).rows.map((x) => x.id);
    const has = await peopleMatching(db, adminEmails, [...own, ...coll]);
    for (const p of reach) if (!has.has(p)) gainers.add(p);
    if (gainers.size === reach.size) break;
  }
  return gainers.size;
}

/** "Give all im-analytics skills to role X in project Y": one collection-level assignment, with who gains access. */
export async function mapCollection(ctx: RequestContext, slug: string, input: AssignmentInput & { dry_run?: boolean }) {
  const c = await collectionBySlug(ctx, slug, "manage");
  const r = await resolve(ctx, input, c.owner_scope_id);
  const skills = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM skills WHERE collection_id = $1 AND status = 'active'", [c.id])).rows[0]!.n;
  const label = await labelFor(ctx, r, r.scope_name);
  if (input.dry_run) {
    // Who would gain, without writing: insert inside a transaction that's rolled back.
    const client = await (ctx.db as import("pg").Pool).connect();
    try {
      await client.query("BEGIN");
      const tmp = await insert({ ...ctx, db: client as never }, { collection_id: c.id }, r);
      const people = tmp.created ? await collectionGainers(client, ctx.settings.adminEmails, c.id, [tmp.id]) : 0;
      return { dry_run: true, collection: { slug: c.slug, name: c.name }, skills, gains: { people, audiences: [label] } };
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  const { id, created } = await insert(ctx, { collection_id: c.id }, r);
  const gains = { people: created ? await collectionGainers(ctx.db, ctx.settings.adminEmails, c.id, [id]) : 0, audiences: created ? [label] : [] };
  if (created) await audit(ctx.db, ctx.actor.id, "map_skill_collection", c.id, { targetKind: "skill_collection", targetLabel: c.name, details: { collection: c.slug, ...details(r), skills, gains } });
  const row = (await rowsFor(ctx.db, "a.id = $1", [id]))[0]!;
  return { created, collection: { slug: c.slug, name: c.name }, skills, assignment: await viewOf(ctx, row), gains };
}

/**
 * mapCollection's dry run for several assignments at once: each row counts the people it adds on top of what they
 * have now and the rows before it, so `people` counts everyone once. Nothing is saved.
 */
export async function previewCollectionMappings(ctx: RequestContext, slug: string, inputs: AssignmentInput[]) {
  const c = await collectionBySlug(ctx, slug, "manage");
  const resolved: { r: Resolved; label: string }[] = [];
  for (const input of inputs) {
    const r = await resolve(ctx, input, c.owner_scope_id);
    resolved.push({ r, label: await labelFor(ctx, r, r.scope_name) });
  }
  const skills = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM skills WHERE collection_id = $1 AND status = 'active'", [c.id])).rows[0]!.n;
  const client = await (ctx.db as import("pg").Pool).connect();
  try {
    await client.query("BEGIN");
    const rows: PreviewRow[] = [];
    for (const { r, label } of resolved) {
      const tmp = await insert({ ...ctx, db: client as never }, { collection_id: c.id }, r);
      // The rows inserted before this one count as what people have (collectionGainers leaves out only `added`).
      const people = tmp.created ? await collectionGainers(client, ctx.settings.adminEmails, c.id, [tmp.id]) : 0;
      rows.push({ label, already: !tmp.created, gains: { people, audiences: tmp.created ? [label] : [] } });
    }
    return { dry_run: true as const, collection: { slug: c.slug, name: c.name }, skills, rows, people: rows.reduce((n, x) => n + x.gains.people, 0) };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** An assignment's label for the viewer: a project they can't read is "A members-only project". */
async function labelFor(ctx: RequestContext, a: Pick<AssignmentRow, "audience" | "role" | "role_name" | "team_name"> & { scope_id: string | null }, scopeName: string | null): Promise<string> {
  const readable = a.scope_id ? await canReadScope(ctx, a.scope_id) : true;
  return labelOf(a, a.scope_id ? (readable ? scopeName : "A members-only project") : null);
}

/**
 * Who would newly receive `skill` if it moved to `toCollection` (its own and current collection's audiences don't
 * count), labelled for the viewer (`ctx`), so a members-only project's name never shows to someone who can't read it.
 */
export async function audienceGain(ctx: RequestContext, skill: Pick<SkillRow, "id" | "collection_id">, toCollectionId: string, db: Queryable = ctx.db): Promise<{ people: number; audiences: string[] }> {
  const adminEmails = ctx.settings.adminEmails;
  const now = (
    await db.query<{ id: string }>("SELECT id FROM skill_assignments WHERE skill_id = $1 OR ($2::uuid IS NOT NULL AND collection_id = $2)", [skill.id, skill.collection_id])
  ).rows.map((r) => r.id);
  const target = await rowsFor(db, "a.collection_id = $1", [toCollectionId]);
  if (!target.length) return { people: 0, audiences: [] };
  const before = await peopleMatching(db, adminEmails, now);
  const after = await peopleMatching(db, adminEmails, target.map((t) => t.id));
  const people = [...after].filter((x) => !before.has(x)).length;
  const audiences: string[] = [];
  if (people) for (const t of target) audiences.push(await labelFor(ctx, t, t.scope_name));
  return { people, audiences: [...new Set(audiences)] };
}

/**
 * Why the caller has a skill, in terms of their own memberships only ("through the Platform team", "as Contributor in
 * Billing"), so it never names a project they can't read.
 */
export async function whyYouHaveIt(ctx: RequestContext, skill: Pick<SkillRow, "id" | "collection_id">): Promise<string[]> {
  const rows = await rowsFor(ctx.db, "a.skill_id = $1 OR ($2::uuid IS NOT NULL AND a.collection_id = $2)", [skill.id, skill.collection_id]);
  const db = ctx.db;
  const myRoles = new Set((await db.query<{ role: string }>("SELECT role FROM user_roles WHERE user_id = $1", [ctx.actor.id])).rows.map((r) => r.role));
  const myTeams = new Map((await db.query<{ team_id: string; name: string }>("SELECT tm.team_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1", [ctx.actor.id])).rows.map((r) => [r.team_id, r.name]));
  const reach = (
    await db.query<{ scope_name: string; role: string; ancestor_id: string }>(
      `WITH RECURSIVE mine AS (
         SELECT DISTINCT sr.scope_id, sr.role FROM scope_roles sr JOIN scopes s ON s.id = sr.scope_id WHERE sr.user_id = $1 AND s.status = 'active' AND s.kind = 'project'
       ), up (scope_id, role, ancestor_id, depth) AS (
         SELECT scope_id, role, scope_id, 0 FROM mine
         UNION ALL SELECT up.scope_id, up.role, s.parent_id, up.depth + 1 FROM up JOIN scopes s ON s.id = up.ancestor_id WHERE s.parent_id IS NOT NULL AND up.depth < 6
       ) SELECT s.name AS scope_name, up.role, up.ancestor_id FROM up JOIN scopes s ON s.id = up.scope_id`,
      [ctx.actor.id],
    )
  ).rows;
  const roleNames = new Map((await listRoles(db)).map((r) => [r.key, r.name]));
  const out = new Set<string>();
  for (const a of rows) {
    if (a.audience === "everyone") out.add("Everyone has it");
    else if (a.audience === "org_role" && (myRoles.has(a.role!) || (a.role === "admin" && isAdmin(ctx)))) out.add(`Through your organisation role ${roleNames.get(a.role!) ?? a.role}`);
    else if (a.audience === "team" && myTeams.has(a.team_id!)) out.add(`Through the ${myTeams.get(a.team_id!)} team`);
    else if (a.audience === "project") {
      const hit = reach.find((r) => r.ancestor_id === a.scope_id);
      if (hit) out.add(`As ${roleNames.get(hit.role) ?? hit.role} in ${hit.scope_name}`);
    } else if (a.audience === "project_role") {
      const hit = reach.find((r) => r.role === a.role && (!a.scope_id || r.ancestor_id === a.scope_id));
      if (hit) out.add(`As ${roleNames.get(hit.role) ?? hit.role} in ${hit.scope_name}`);
    }
  }
  return [...out];
}
