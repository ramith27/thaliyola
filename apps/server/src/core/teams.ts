import { withTx } from "../db/pool.js";
import { assertOwnerRemains } from "./admin.js";
import { audit } from "./audit.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { assertAdmin, assertCanManage, canManage, isAdmin, readableScopes, roleIn } from "./permissions.js";
import { getReadableScope, getScopeBySlug } from "./scopes.js";

/**
 * Teams are groups of people. A team can be given a role (reader, writer,
 * owner) on any number of projects, and its members get that role on each.
 * Admins create teams and manage their members; a project's owners decide
 * which teams (and which people) have access to it.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
type Role = "reader" | "writer" | "owner";

async function teamBySlug(ctx: RequestContext, slug: string) {
  const { rows } = await ctx.db.query<{ id: string; slug: string; name: string; description: string }>("SELECT id, slug, name, description FROM teams WHERE slug = $1", [slug]);
  if (!rows[0]) throw new NotFoundError(`team '${slug}'`);
  return rows[0];
}

export async function listTeams(ctx: RequestContext) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query(
    `SELECT t.slug, t.name, t.description,
            (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)::int AS members,
            EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) AS mine,
            coalesce((SELECT json_agg(json_build_object('slug', s.slug, 'name', s.name, 'role', r.role) ORDER BY s.name)
                        FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id
                       WHERE r.team_id = t.id AND ($1::uuid[] IS NULL OR s.id = ANY($1))), '[]') AS projects
       FROM teams t ORDER BY t.name`,
    [readable, ctx.actor.id],
  );
  return rows;
}

export async function getTeam(ctx: RequestContext, slug: string) {
  const team = await teamBySlug(ctx, slug);
  const readable = await readableScopes(ctx);
  const members = await ctx.db.query(
    `SELECT u.id, coalesce(u.email, u.subject) AS email, u.display_name AS name, m.added_at
       FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY lower(coalesce(u.display_name, u.email))`,
    [team.id],
  );
  const projects = await ctx.db.query(
    `SELECT s.slug, s.name, s.kind, r.role FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id
      WHERE r.team_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2)) ORDER BY s.name`,
    [team.id, readable],
  );
  return { ...team, id: undefined, members: members.rows, projects: projects.rows, can_manage: isAdmin(ctx) };
}

export async function createTeam(ctx: RequestContext, input: { slug: string; name: string; description?: string }) {
  assertAdmin(ctx);
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  if (!input.name.trim()) throw new ValidationError("name is required");
  const exists = await ctx.db.query("SELECT 1 FROM teams WHERE slug = $1", [input.slug]);
  if (exists.rowCount) throw new ValidationError(`team '${input.slug}' already exists`);
  await ctx.db.query("INSERT INTO teams (slug, name, description) VALUES ($1, $2, $3)", [input.slug, input.name.trim(), input.description?.trim() ?? ""]);
  await audit(ctx.db, ctx.actor.id, "create_team", null);
  return { slug: input.slug, name: input.name.trim() };
}

export async function updateTeam(ctx: RequestContext, slug: string, patch: { name?: string; description?: string }) {
  assertAdmin(ctx);
  const team = await teamBySlug(ctx, slug);
  const { rows } = await ctx.db.query("UPDATE teams SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1 RETURNING slug, name, description", [
    team.id,
    patch.name?.trim() || null,
    patch.description ?? null,
  ]);
  return rows[0];
}

/** Deleting a team removes the access it gave; projects keep their direct members. */
export async function deleteTeam(ctx: RequestContext, slug: string) {
  assertAdmin(ctx);
  const team = await teamBySlug(ctx, slug);
  await ctx.db.query("DELETE FROM teams WHERE id = $1", [team.id]);
  await audit(ctx.db, ctx.actor.id, "delete_team", null);
  return { slug, deleted: true };
}

async function userByEmail(ctx: RequestContext, email: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new ValidationError("invalid email");
  // People who haven't signed in yet get a placeholder that their first sign-in claims.
  return (
    (await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1", [normalized])).rows[0] ??
    (await ctx.db.query<{ id: string }>("INSERT INTO users (subject, email) VALUES ($1, $2) RETURNING id", [`pending:${normalized}`, normalized])).rows[0]!
  );
}

export async function setTeamMember(ctx: RequestContext, slug: string, email: string, member: boolean) {
  assertAdmin(ctx);
  const team = await teamBySlug(ctx, slug);
  const user = await userByEmail(ctx, email);
  if (member) await ctx.db.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [team.id, user.id]);
  else await ctx.db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [team.id, user.id]);
  return { team: slug, email: email.trim().toLowerCase(), member };
}

/** Gives a team a role on a project (or removes it with null). Project owners and admins. */
export async function setTeamRole(ctx: RequestContext, scopeSlug: string, teamSlug: string, role: Role | null) {
  const scope = await getScopeBySlug(ctx.db, scopeSlug);
  await assertCanManage(ctx, scope);
  const team = await teamBySlug(ctx, teamSlug);
  await withTx(ctx.db, async (tx) => {
    if (role === null) await tx.query("DELETE FROM scope_team_roles WHERE scope_id = $1 AND team_id = $2", [scope.id, team.id]);
    else
      await tx.query(
        `INSERT INTO scope_team_roles (scope_id, team_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (scope_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
        [scope.id, team.id, role],
      );
    await assertOwnerRemains(ctx, tx, scope);
  });
  await audit(ctx.db, ctx.actor.id, "set_team_role", scope.id);
  return { scope: scopeSlug, team: teamSlug, role };
}

/** Who has access to a scope: people directly, teams (with their members), and the caller's own role. */
export async function listAccess(ctx: RequestContext, scopeSlug: string) {
  const scope = await getReadableScope(ctx, scopeSlug);
  const people = await ctx.db.query(
    `SELECT coalesce(u.email, u.subject) AS email, u.display_name AS name, m.role, u.subject LIKE 'pending:%' AS pending
       FROM scope_members m JOIN users u ON u.id = m.user_id WHERE m.scope_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END, email`,
    [scope.id],
  );
  const teams = await ctx.db.query(
    `SELECT t.slug, t.name, r.role,
            coalesce((SELECT json_agg(coalesce(u.display_name, u.email) ORDER BY u.email) FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id), '[]') AS members
       FROM scope_team_roles r JOIN teams t ON t.id = r.team_id WHERE r.scope_id = $1
      ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END, t.name`,
    [scope.id],
  );
  const total = (await ctx.db.query<{ n: number }>("SELECT count(DISTINCT user_id)::int AS n FROM scope_roles WHERE scope_id = $1", [scope.id])).rows[0]!.n;
  return {
    scope: scope.slug,
    kind: scope.kind,
    visibility: scope.visibility,
    people: people.rows,
    teams: teams.rows,
    total_people: total,
    my_role: (await roleIn(ctx.db, scope.id, ctx.actor.id)) ?? null,
    can_manage: await canManage(ctx, scope),
  };
}
