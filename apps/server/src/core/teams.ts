import { withTx } from "../db/pool.js";
import { accountNote, accountStatus, type AccountStatus } from "./accounts.js";
import { createProject, userForIdentifier, type NewProject } from "./admin.js";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { assertCanManage, can, canManage, effectiveFrom, isAdmin, openToEveryone, readableScopes, roleIn, rolesIn } from "./permissions.js";
import { keepingProjectAdmins } from "./project-admins.js";
import { applyRoleChange, assertMayGrant, assertCan, canSeeAccess, inRoleOrder, listRoles, namesOf, permissionsIn, resolveRoles, type Role, type RoleChange } from "./roles.js";
import { getReadableScope } from "./scopes.js";

/**
 * Teams are groups of people. A team gets project roles (Viewer, Contributor, Reviewer, …) on any number of projects,
 * like a person does, and everyone in it gets them on each. Being in a team is membership, not a role: someone is a
 * Member or a Lead, and leads choose the team's members and can start projects for it. Team managers create teams.
 * Changing a team's members or leads, or deleting it, needs the team's project roles yourself (leads always have them)
 * or Administrator: nobody gives or takes away access they don't hold. A project's Project admins decide which teams
 * (and which people) have access to it.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface TeamChange {
  scope: string;
  project_name: string;
  team: string;
  team_name: string;
  roles: string[];
  role_names: string[];
  /** Keys; the *_names fields are the same roles by display name. */
  before: string[];
  added: string[];
  removed: string[];
  before_names: string[];
  added_names: string[];
  removed_names: string[];
  role?: string | null;
}

export interface TeamMemberChange {
  team: string;
  email: string;
  /** Their display name, if they have one. */
  name: string | null;
  member: boolean;
  role: "member" | "lead" | null;
  before_role: "member" | "lead" | null;
  account: AccountStatus;
  note: string | null;
}

type Team = { id: string; slug: string; name: string; description: string };

/** Administrators, Team managers, and leads of this team. */
async function canManageTeam(ctx: RequestContext, teamId: string) {
  if (can(ctx, "manage_teams")) return true;
  if (ctx.actor.kind !== "human") return false;
  const { rowCount } = await ctx.db.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'lead'", [teamId, ctx.actor.id]);
  return !!rowCount;
}

async function assertCanManageTeam(ctx: RequestContext, teamId: string) {
  if (!(await canManageTeam(ctx, teamId))) throw new ForbiddenError("only this team's leads, team managers and admins can do that");
}

/** A team by slug, or by its name in any case ("Platform team" finds platform-eng when that's its name). */
async function teamBySlug(ctx: RequestContext, slug: string): Promise<Team> {
  const raw = (slug ?? "").trim();
  const { rows } = await ctx.db.query<Team>(
    "SELECT id, slug, name, description FROM teams WHERE slug = $1 OR lower(name) = lower($1) OR lower(name) = lower(regexp_replace($1, '\\s+team$', '', 'i')) ORDER BY slug = $1 DESC, name",
    [raw],
  );
  if (rows.length > 1 && rows[0]!.slug !== raw) {
    throw new ValidationError(`'${raw}' matches several teams: ${rows.map((t) => `${t.name} (${t.slug})`).join(", ")}; use the slug`);
  }
  if (!rows[0]) throw new NotFoundError(`team '${raw}'`, `there's no team '${raw}'; list_teams shows the teams`);
  return rows[0];
}

/** The projects a team has roles on (where its members' access comes from). */
async function teamGrantScopeIds(ctx: RequestContext, teamId: string): Promise<string[]> {
  const { rows } = await ctx.db.query<{ scope_id: string }>("SELECT DISTINCT scope_id FROM scope_team_roles WHERE team_id = $1", [teamId]);
  return rows.map((r) => r.scope_id);
}

/**
 * Why the caller may not change who is in a team (or delete it), or null when they may: the team's roles in each of
 * its projects must be roles the caller could give there. Administrators and Manage every project holders may; leads
 * always may (they hold the team's roles through it). A project the caller can't read is never named.
 */
async function teamAccessRefusal(ctx: RequestContext, team: Team, action: "change who is in" | "delete"): Promise<string | null> {
  if (isAdmin(ctx) || can(ctx, "manage_all_projects")) return null;
  const { rows } = await ctx.db.query<{ scope_id: string; name: string; roles: string[] }>(
    `SELECT r.scope_id, s.name, array_agg(r.role ORDER BY ro.position) AS roles
       FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id JOIN roles ro ON ro.key = r.role
      WHERE r.team_id = $1 GROUP BY r.scope_id, s.name ORDER BY s.name`,
    [team.id],
  );
  if (!rows.length) return null;
  const all = await listRoles(ctx.db, "project");
  const readable = await readableScopes(ctx);
  const ask = action === "delete" ? "Ask an Administrator." : "Ask one of its leads or an Administrator.";
  for (const g of rows) {
    const roles = all.filter((r) => g.roles.includes(r.key));
    let missing: string[] = [];
    try {
      await assertMayGrant(ctx, roles, g.scope_id, (_r, labels) => {
        missing = labels;
        return "";
      });
    } catch (err) {
      if (!(err instanceof ForbiddenError)) throw err;
      return readable === null || readable.includes(g.scope_id)
        ? `${team.name} holds ${namesOf(all, g.roles).join(", ")} in ${g.name}, which includes permissions you don't have there (${missing.join(", ")}), so you can't ${action} ${team.name}. ${ask}`
        : `${team.name} holds roles in a project you can't see, so you can't ${action} ${team.name}. ${ask}`;
    }
  }
  return null;
}

async function assertMayChangeTeamAccess(ctx: RequestContext, team: Team, action: "change who is in" | "delete") {
  const refusal = await teamAccessRefusal(ctx, team, action);
  if (refusal) throw new ForbiddenError(refusal);
}

export async function listTeams(ctx: RequestContext) {
  const readable = await readableScopes(ctx);
  const roles = await listRoles(ctx.db, "project");
  const { rows } = await ctx.db.query<{
    slug: string;
    name: string;
    description: string;
    members: number;
    mine: boolean;
    my_role: "member" | "lead" | null;
    can_manage: boolean;
    projects: { slug: string; name: string; role: string; roles: string[] }[];
  }>(
    `SELECT t.slug, t.name, t.description,
            (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)::int AS members,
            EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) AS mine,
            (SELECT m.role FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) AS my_role,
            ($3 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2 AND m.role = 'lead')) AS can_manage,
            coalesce((SELECT json_agg(json_build_object('slug', x.slug, 'name', x.name, 'role', x.roles[1], 'roles', x.roles) ORDER BY x.name)
                        FROM (SELECT s.slug, s.name, array_agg(r.role ORDER BY ro.position) AS roles
                                FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id JOIN roles ro ON ro.key = r.role
                               WHERE r.team_id = t.id AND ($1::uuid[] IS NULL OR s.id = ANY($1)) GROUP BY s.slug, s.name) x), '[]') AS projects
       FROM teams t ORDER BY t.name`,
    [readable, ctx.actor.id, can(ctx, "manage_teams")],
  );
  return rows.map((t) => ({ ...t, projects: t.projects.map((p) => ({ ...p, role_names: namesOf(roles, p.roles) })) }));
}

export async function getTeam(ctx: RequestContext, slug: string) {
  const team = await teamBySlug(ctx, slug);
  const readable = await readableScopes(ctx);
  const roles = await listRoles(ctx.db, "project");
  const members = await ctx.db.query<{
    id: string;
    email: string;
    name: string | null;
    role: "member" | "lead";
    added_at: string;
    pending: boolean;
    subject: string;
    approved_at: unknown;
    disabled_at: unknown;
  }>(
    `SELECT u.id, coalesce(u.email, u.subject) AS email, u.display_name AS name, m.role, m.added_at, u.subject LIKE 'pending:%' AS pending,
            u.subject, u.approved_at, u.disabled_at
       FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1
      ORDER BY m.role = 'lead' DESC, lower(coalesce(u.display_name, u.email))`,
    [team.id],
  );
  const projects = await ctx.db.query<{ slug: string; name: string; kind: string; role: string; roles: string[] }>(
    `SELECT s.slug, s.name, s.kind, (array_agg(r.role ORDER BY ro.position))[1] AS role, array_agg(r.role ORDER BY ro.position) AS roles
       FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id JOIN roles ro ON ro.key = r.role
      WHERE r.team_id = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2)) GROUP BY s.id ORDER BY s.name`,
    [team.id, readable],
  );
  const manage = await canManageTeam(ctx, team.id);
  const refusal = manage ? await teamAccessRefusal(ctx, team, "change who is in") : null;
  return {
    ...team,
    id: undefined,
    members: members.rows.map(({ subject, approved_at, disabled_at, ...m }) => ({ ...m, status: accountStatus({ subject, approved_at, disabled_at }) })),
    leads: members.rows.filter((m) => m.role === "lead").length,
    projects: projects.rows.map((p) => ({ ...p, role_names: namesOf(roles, p.roles) })),
    can_manage: manage,
    can_change_members: manage && !refusal,
    change_members_note: refusal,
    can_edit_team: can(ctx, "manage_teams"),
  };
}

export async function createTeam(ctx: RequestContext, input: { slug: string; name: string; description?: string }) {
  assertCan(ctx, "manage_teams", "only admins and team managers create teams");
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  if (!input.name.trim()) throw new ValidationError("name is required");
  const exists = await ctx.db.query("SELECT 1 FROM teams WHERE slug = $1", [input.slug]);
  if (exists.rowCount) throw new ValidationError(`team '${input.slug}' already exists`);
  const description = input.description?.trim() ?? "";
  const { rows } = await ctx.db.query<{ id: string }>("INSERT INTO teams (slug, name, description) VALUES ($1, $2, $3) RETURNING id", [input.slug, input.name.trim(), description]);
  await audit(ctx.db, ctx.actor.id, "create_team", rows[0]!.id, { targetKind: "team", targetLabel: input.name.trim(), details: { team: input.slug } });
  return { slug: input.slug, name: input.name.trim(), description };
}

export async function updateTeam(ctx: RequestContext, slug: string, patch: { name?: string; description?: string }) {
  assertCan(ctx, "manage_teams", "only admins and team managers rename teams");
  const team = await teamBySlug(ctx, slug);
  const { rows } = await ctx.db.query<{ slug: string; name: string; description: string }>(
    "UPDATE teams SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1 RETURNING slug, name, description",
    [team.id, patch.name?.trim() || null, patch.description ?? null],
  );
  const after = rows[0]!;
  await audit(ctx.db, ctx.actor.id, "update_team", team.id, {
    targetKind: "team",
    targetLabel: after.name,
    details: {
      team: team.slug,
      ...(after.name !== team.name ? { name_before: team.name, name_after: after.name } : {}),
      ...(after.description !== team.description ? { description_changed: true } : {}),
    },
  });
  return after;
}

/**
 * Deleting a team removes the access it gave; projects keep their direct members. Needs Manage teams, and the team's
 * project roles yourself (or Administrator); refused when a project would be left without a Project admin.
 */
export async function deleteTeam(ctx: RequestContext, slug: string) {
  assertCan(ctx, "manage_teams", "only admins and team managers delete teams");
  const team = await teamBySlug(ctx, slug);
  await assertMayChangeTeamAccess(ctx, team, "delete");
  const scopes = await teamGrantScopeIds(ctx, team.id);
  const readable = await readableScopes(ctx);
  const out = await withTx(ctx.db, (tx) =>
    keepingProjectAdmins(tx, scopes, () => tx.query("DELETE FROM teams WHERE id = $1", [team.id]), { refuse: !can(ctx, "manage_all_projects"), readable }),
  );
  await audit(ctx.db, ctx.actor.id, "delete_team", team.id, {
    targetKind: "team",
    targetLabel: team.name,
    details: { team: team.slug, projects_left_without_admin: out.projects_without_admin.map((p) => p.slug) },
  });
  return { slug: team.slug, deleted: true as const, projects_without_admin: out.projects_without_admin, other_projects_without_admin: out.other_projects_without_admin };
}

/**
 * Adds or removes a member, or makes them a lead or a member (an omitted role keeps the current one). Leads,
 * Team managers and Administrators; any change needs the team's project roles yourself (leads have them), since it
 * changes who gets them. Removing someone can't leave a project without a Project admin.
 */
export async function setTeamMember(ctx: RequestContext, slug: string, who: string, member: boolean, role?: "member" | "lead"): Promise<TeamMemberChange> {
  const team = await teamBySlug(ctx, slug);
  await assertCanManageTeam(ctx, team.id);
  const existing = await userForIdentifier(ctx, who, { create: false });
  const before = existing
    ? ((await ctx.db.query<{ role: "member" | "lead" }>("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2", [team.id, existing])).rows[0]?.role ?? null)
    : null;
  if (!member && !before) throw new NotFoundError(who, `${who.trim()} isn't in ${team.name}`);
  const next = member ? (role ?? before ?? "member") : null;
  const changes = next !== before;
  if (changes) await assertMayChangeTeamAccess(ctx, team, "change who is in");
  const leadsBefore = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'lead'", [team.id])).rows[0]!.n;
  const userId = existing ?? (await userForIdentifier(ctx, who, { create: true }))!;
  if (changes && next) {
    await ctx.db.query(
      "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [team.id, userId, next],
    );
  } else if (changes) {
    const scopes = await teamGrantScopeIds(ctx, team.id);
    const readable = await readableScopes(ctx);
    await withTx(ctx.db, (tx) =>
      keepingProjectAdmins(tx, scopes, () => tx.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [team.id, userId]), {
        refuse: !can(ctx, "manage_all_projects"),
        readable,
      }),
    );
  }
  const u = (
    await ctx.db.query<{ email: string | null; name: string | null; subject: string; approved_at: unknown; disabled_at: unknown }>(
      "SELECT email, display_name AS name, subject, approved_at, disabled_at FROM users WHERE id = $1",
      [userId],
    )
  ).rows[0]!;
  // Team membership gives the team's project roles, so who was added, removed or made a lead is recorded.
  if (changes) {
    await audit(ctx.db, ctx.actor.id, "set_team_member", team.id, {
      targetKind: "team",
      targetLabel: team.name,
      details: { team: team.slug, person: u.email ?? u.subject, person_id: userId, member: !next ? "removed" : !before ? "added" : "role changed", role: next, before_role: before },
    });
  }
  const leadsAfter = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'lead'", [team.id])).rows[0]!.n;
  const notes: string[] = [];
  if (member) {
    const n = accountNote(u, ctx.settings, "the team's access");
    if (n) notes.push(n);
  }
  if (leadsBefore > 0 && leadsAfter === 0) {
    const holdsRoles = (await teamGrantScopeIds(ctx, team.id)).length > 0;
    notes.push(`${team.name} has no leads now, so only ${holdsRoles ? "Team managers who hold its project roles" : "Team managers"} and Administrators can change its members.`);
  }
  const normalized = who.trim().toLowerCase();
  return {
    team: team.slug,
    email: /^[^\s@]+@[^\s@]+$/.test(normalized) ? normalized : (u.email ?? u.subject),
    name: u.name,
    member,
    role: next,
    before_role: before,
    account: accountStatus(u),
    note: notes.join(" ") || null,
  };
}

/**
 * Creates a project that belongs to this team: the team gets `team_roles` on it (Contributor by default) and the chosen
 * people are its Project admins. Team leads, Team managers and Administrators. A lead who creates it is always one of
 * its Project admins, so they can manage it.
 */
export async function createTeamProject(
  ctx: RequestContext,
  slug: string,
  input: NewProject & { team_roles?: string[]; team_role?: string; owners?: string[] },
) {
  const team = await teamBySlug(ctx, slug);
  await assertCanManageTeam(ctx, team.id);
  if (input.team_roles && !input.team_roles.some((r) => r.trim())) throw new ValidationError("give the team at least one role on its project, e.g. team_roles: ['Contributor']");
  const roles = await resolveRoles(ctx.db, "project", input.team_roles ?? (input.team_role ? [input.team_role] : ["writer"]));
  const owners = [...(input.owners ?? [])];
  if (!can(ctx, "manage_teams") || !owners.length) {
    if (!ctx.actor.email) throw new ValidationError("pick at least one owner");
    owners.push(ctx.actor.email);
  }
  const keys = roles.map((r) => r.key);
  const res = await createProject(ctx, input, { owners, team: { id: team.id, roles: keys } });
  // The team's roles there are access, so they're recorded with the project (as set_team_role records later changes).
  await audit(ctx.db, ctx.actor.id, "create_team_project", res.id, {
    targetKind: "project",
    targetLabel: input.name.trim(),
    details: { project: res.slug, team: team.slug, team_roles: keys, owners, visibility: res.visibility, parent: res.parent },
  });
  return { ...res, team: team.slug, team_name: team.name, team_roles: keys, team_role_names: roles.map((r) => r.name) };
}

/**
 * Gives, changes or takes away a team's roles on a project: `set` replaces them all ([] removes the team's access),
 * `add` / `remove` change only those. Needs Manage access there; no escalation; keeps at least one Project admin.
 */
export async function changeTeamRoles(ctx: RequestContext, scopeSlug: string, teamSlug: string, change: RoleChange): Promise<TeamChange> {
  const scope = await getReadableScope(ctx, scopeSlug);
  await assertCanManage(ctx, scope, "manage_members");
  const team = await teamBySlug(ctx, teamSlug);
  const all = await listRoles(ctx.db, "project");
  const set = change.set ? await resolveRoles(ctx.db, "project", change.set) : undefined;
  const add = await resolveRoles(ctx.db, "project", change.add ?? []);
  const remove = await resolveRoles(ctx.db, "project", change.remove ?? []);
  const current = inRoleOrder(
    all,
    (await ctx.db.query<{ role: string }>("SELECT role FROM scope_team_roles WHERE scope_id = $1 AND team_id = $2", [scope.id, team.id])).rows.map((r) => r.role),
  );
  const keys = (rs: Role[]) => rs.map((r) => r.key);
  const { desired, added, removed } = applyRoleChange(current, { set: set ? keys(set) : undefined, add: keys(add), remove: keys(remove) });
  await assertMayGrant(
    ctx,
    all.filter((r) => added.includes(r.key) || removed.includes(r.key)),
    scope.id,
  );
  if (added.length || removed.length) {
    const readable = await readableScopes(ctx);
    await withTx(ctx.db, (tx) =>
      keepingProjectAdmins(
        tx,
        [scope.id],
        async () => {
          if (removed.length) await tx.query("DELETE FROM scope_team_roles WHERE scope_id = $1 AND team_id = $2 AND role = ANY ($3::text[])", [scope.id, team.id, removed]);
          for (const k of added) await tx.query("INSERT INTO scope_team_roles (scope_id, team_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [scope.id, team.id, k]);
        },
        { refuse: !can(ctx, "manage_all_projects"), readable },
      ),
    );
    await audit(ctx.db, ctx.actor.id, "set_team_role", scope.id, {
      targetKind: "project",
      targetLabel: scope.name,
      details: { team: team.slug, before: current, after: desired, added, removed },
    });
  }
  const roles = inRoleOrder(all, desired);
  return {
    scope: scope.slug,
    project_name: scope.name,
    team: team.slug,
    team_name: team.name,
    roles,
    role_names: namesOf(all, roles),
    before: current,
    added: inRoleOrder(all, added),
    removed: inRoleOrder(all, removed),
    before_names: namesOf(all, current),
    added_names: namesOf(all, inRoleOrder(all, added)),
    removed_names: namesOf(all, inRoleOrder(all, removed)),
  };
}

/** Sets a team's roles on a project (empty: no access through the team). */
export async function setTeamRoles(ctx: RequestContext, scopeSlug: string, teamSlug: string, keys: string[]) {
  return changeTeamRoles(ctx, scopeSlug, teamSlug, { set: keys });
}

/** @deprecated use changeTeamRoles. Gives a team one role on a project, replacing its others (or removes them all with null). */
export async function setTeamRole(ctx: RequestContext, scopeSlug: string, teamSlug: string, role: string | null) {
  const res = await changeTeamRoles(ctx, scopeSlug, teamSlug, { set: role === null ? [] : [role] });
  return { ...res, role };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Who has access to a scope and how: people directly, teams (with their members), roles from projects above, who
 * else can see it (members-only projects), what's open to everyone, and the caller's own roles and what they can do.
 */
export async function listAccess(ctx: RequestContext, scopeSlug: string) {
  const scope = await getReadableScope(ctx, scopeSlug);
  const roles = await listRoles(ctx.db, "project");
  const names = (keys: string[]) => namesOf(roles, keys);
  // `role` is each one's most powerful role (as before); `roles` all of them.
  const people = await ctx.db.query<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    roles: string[];
    pending: boolean;
    kind: "human" | "service";
    subject: string;
    approved_at: unknown;
    disabled_at: unknown;
  }>(
    `SELECT u.id, coalesce(u.email, u.subject) AS email, u.display_name AS name, (array_agg(m.role ORDER BY r.position))[1] AS role,
            array_agg(m.role ORDER BY r.position) AS roles, u.subject LIKE 'pending:%' AS pending, u.kind,
            u.subject, u.approved_at, u.disabled_at
       FROM scope_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.key = m.role WHERE m.scope_id = $1
      GROUP BY u.id ORDER BY min(r.position), 1`,
    [scope.id],
  );
  const teams = await ctx.db.query<{
    slug: string;
    name: string;
    role: string;
    roles: string[];
    members: string[];
    member_list: { id: string; email: string; name: string | null; team_role: "member" | "lead" }[];
  }>(
    `SELECT t.slug, t.name, (array_agg(r.role ORDER BY ro.position))[1] AS role, array_agg(r.role ORDER BY ro.position) AS roles,
            coalesce((SELECT json_agg(coalesce(u.display_name, u.email) ORDER BY u.email) FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id), '[]') AS members,
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'email', coalesce(u.email, u.subject), 'name', u.display_name, 'team_role', m.role) ORDER BY m.role = 'lead' DESC, u.email)
                        FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id), '[]') AS member_list
       FROM scope_team_roles r JOIN teams t ON t.id = r.team_id JOIN roles ro ON ro.key = r.role WHERE r.scope_id = $1
      GROUP BY t.id ORDER BY min(ro.position), t.name`,
    [scope.id],
  );
  // Roles held in the projects above this one apply here too.
  const inherited = await ctx.db.query<{ id: string; email: string; name: string | null; roles: string[]; sources: { slug: string; name: string; team: string | null }[] }>(
    `SELECT u.id, coalesce(u.email, u.subject) AS email, u.display_name AS name,
            array_agg(DISTINCT r.role) AS roles,
            json_agg(DISTINCT jsonb_build_object('slug', a.slug, 'name', a.name, 'team', t.name)) AS sources
       FROM scope_roles r JOIN users u ON u.id = r.user_id JOIN scopes a ON a.id = r.inherited_from LEFT JOIN teams t ON t.id = r.team_id
      WHERE r.scope_id = $1 AND r.inherited_from IS NOT NULL
      GROUP BY u.id ORDER BY 1`,
    [scope.id],
  );
  const counts = (
    await ctx.db.query<{ total: number; direct: number; via_teams: number; from_above: number }>(
      `SELECT count(DISTINCT user_id)::int AS total,
              (SELECT count(DISTINCT user_id) FROM scope_members WHERE scope_id = $1)::int AS direct,
              count(DISTINCT user_id) FILTER (WHERE team_id IS NOT NULL AND inherited_from IS NULL)::int AS via_teams,
              count(DISTINCT user_id) FILTER (WHERE inherited_from IS NOT NULL)::int AS from_above
         FROM scope_roles WHERE scope_id = $1`,
      [scope.id],
    )
  ).rows[0]!;
  const myRoles = await rolesIn(ctx.db, scope.id, ctx.actor.id);
  const myPermissions = [...(await permissionsIn(ctx.db, scope.id, ctx.actor.id))].sort();
  const open = await openToEveryone(ctx.db, scope);
  const ownPersonal = scope.kind === "personal";
  const effective = effectiveFrom(ctx, { kind: scope.kind, ownPersonal, readable: true, rolePermissions: myPermissions, open });
  const canManageMembers = await canManage(ctx, scope, "manage_members");

  // Members-only projects can also be seen by people who can see every project (Administrators, Auditors, …).
  let orgWide: { count: number; people: { email: string; name: string | null; why: string[] }[] | null } | null = null;
  if (scope.kind === "project" && scope.visibility === "members") {
    const { rows } = await ctx.db.query<{ email: string; name: string | null; admin: boolean; role_names: string[] }>(
      `SELECT coalesce(u.email, u.subject) AS email, u.display_name AS name,
              (u.is_admin OR lower(coalesce(u.email, '')) = ANY ($2::text[])) AS admin,
              ARRAY(SELECT r.name FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org'
                     WHERE ur.user_id = u.id AND r.permissions && ARRAY['read_all_projects', 'manage_all_projects']::text[] ORDER BY r.position) AS role_names
         FROM users u
        WHERE u.kind = 'human' AND u.disabled_at IS NULL AND u.approved_at IS NOT NULL
          AND (u.is_admin OR lower(coalesce(u.email, '')) = ANY ($2::text[])
               OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org'
                           WHERE ur.user_id = u.id AND r.permissions && ARRAY['read_all_projects', 'manage_all_projects']::text[]))
          AND NOT EXISTS (SELECT 1 FROM scope_roles x WHERE x.scope_id = $1 AND x.user_id = u.id)
        ORDER BY lower(coalesce(u.display_name, u.email))`,
      [scope.id, ctx.settings.adminEmails],
    );
    const show = canManageMembers || canSeeAccess(ctx);
    orgWide = {
      count: rows.length,
      people: show ? rows.map((p) => ({ email: p.email, name: p.name, why: [...(p.admin ? ["Administrator"] : []), ...p.role_names] })) : null,
    };
  }

  const vis =
    scope.kind === "personal"
      ? "Only you can see your personal space."
      : scope.visibility === "members"
        ? "Members only: only people with a role here, and people who can see every project, can see it."
        : "Everyone signed in can read it.";
  const parts = [
    counts.direct ? `${counts.direct} directly` : "",
    counts.via_teams ? `${counts.via_teams} through teams` : "",
    counts.from_above ? `${counts.from_above} from projects above` : "",
  ].filter(Boolean);
  const summary = `${vis} ${plural(counts.total, "person has", "people have")} a role here${parts.length ? ` (${parts.join(", ")})` : ""}.`;

  return {
    scope: scope.slug,
    project_name: scope.name,
    kind: scope.kind,
    visibility: scope.visibility,
    summary,
    people: people.rows.map(({ subject, approved_at, disabled_at, ...p }) => ({
      ...p,
      role_names: names(p.roles),
      account: accountStatus({ subject, approved_at, disabled_at }),
    })),
    teams: teams.rows.map((t) => ({ ...t, role_names: names(t.roles) })),
    inherited: inherited.rows.map((i) => {
      const ordered = inRoleOrder(roles, i.roles);
      return { ...i, roles: ordered, role_names: names(ordered) };
    }),
    total_people: counts.total,
    my_role: (await roleIn(ctx.db, scope.id, ctx.actor.id)) ?? null,
    my_roles: myRoles,
    my_role_names: names(myRoles),
    my_permissions: myPermissions,
    effective_permissions: effective,
    can_manage: canManageMembers,
    can_manage_members: canManageMembers,
    can_manage_settings: await canManage(ctx, scope),
    open_to_everyone: open,
    org_wide: orgWide,
  };
}
