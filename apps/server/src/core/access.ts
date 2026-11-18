import { accountStatus, needsApproval, type AccountStatus } from "./accounts.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { readableScopes } from "./permissions.js";
import { ADMIN_ROLE, canSeeAccess, findRole, listRoles, ORG_KEYS, orgRolesOf, PROJECT_KEYS } from "./roles.js";

/**
 * Access from a person's side: everything one person can reach and why (Administrator or not, organisation roles,
 * teams, and each project with their roles and where each comes from), and who holds a role. Anyone sees their own;
 * someone else's needs Manage people, Manage roles, Read every project or Manage every project. Projects the caller
 * can't read are only counted.
 */

export interface PersonAccess {
  person: { id: string; email: string | null; name: string | null; kind: "human" | "service"; status: AccountStatus; needs_approval: boolean };
  administrator: { is: boolean; source: "account" | "ADMIN_EMAILS" | null };
  org_roles: { key: string; name: string; permissions: string[] }[];
  org_permissions: string[];
  reads_every_project: boolean;
  manages_every_project: boolean;
  teams: { slug: string; name: string; team_role: "member" | "lead" }[];
  projects: {
    slug: string;
    name: string;
    kind: "project" | "team" | "library";
    visibility: "team" | "members";
    status: string;
    parent: string | null;
    roles: {
      key: string;
      name: string;
      via: "direct" | "team" | "inherited";
      team: { slug: string; name: string } | null;
      from: { slug: string; name: string } | null;
    }[];
    permissions: string[];
  }[];
  other_projects: number;
}

export interface RoleHolders {
  role: { key: string; name: string; kind: "org" | "project" };
  people: { id: string; email: string | null; name: string | null; status: AccountStatus; via?: "account" | "ADMIN_EMAILS" }[];
  projects: { slug: string; name: string; people: { id: string; email: string; name: string | null }[]; teams: { slug: string; name: string }[] }[];
  other_projects: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * A person by 'me', email or name. An email finds any account, placeholders included (people first, then signed in,
 * enabled, oldest); a name needs an exact match (any case) of a name set by a manager or the sign-in, else (for reads
 * only) a unique part of a name or email among enabled people. A name people chose themselves never identifies them on
 * its own: anyone can choose any free name, so it could be meant for someone else. With `exact` (every write), a partial
 * match or a self-chosen name is never used: the error names the candidates so the caller can pass an email.
 */
export async function resolvePerson(ctx: RequestContext, who: string, opts: { exact?: boolean } = {}): Promise<{ id: string; email: string | null }> {
  const raw = (who ?? "").trim();
  if (!raw || raw.toLowerCase() === "me") return { id: ctx.actor.id, email: ctx.actor.email };
  const missing = () =>
    new NotFoundError(raw, `no account for ${raw}; add them first (add_person, or the Users page) or have them sign in once`);
  const person = await findPersonByEmailOrName(ctx, raw);
  if (person) return person;
  if (EMAIL.test(raw)) throw missing();
  const candidates = await partialMatches(ctx, raw);
  if (opts.exact) {
    const chosen = (
      await ctx.db.query<Candidate>(
        "SELECT id, email, display_name AS name FROM users WHERE name_self_set AND lower(display_name) = lower($1) ORDER BY created_at LIMIT 5",
        [raw],
      )
    ).rows;
    if (chosen.length) {
      const others = candidates.filter((c) => !chosen.some((x) => x.id === c.id));
      throw new ValidationError(
        `'${raw}' is a name ${chosen.length > 1 ? "people" : "someone"} chose for themselves, so it can't say who gets access: ` +
          `pass the email of the person you mean (${[...chosen, ...others].slice(0, 5).map(personText).join(", ")})`,
      );
    }
    throw new ValidationError(
      candidates.length
        ? `'${raw}' isn't an email or anyone's full name; did you mean ${candidates.slice(0, 5).map(personText).join(", ")}? Pass their email`
        : `'${raw}' isn't an email or a known person; use find_people to get their email`,
    );
  }
  if (candidates.length > 1) throw several(raw, candidates);
  if (!candidates[0]) throw missing();
  return { id: candidates[0].id, email: candidates[0].email };
}

type Candidate = { id: string; email: string | null; name: string | null };
const personText = (r: Candidate) => `${r.name ?? r.email} <${r.email ?? "no email"}>`;
const several = (raw: string, rows: Candidate[]) =>
  new ValidationError(`'${raw}' matches several people: ${rows.slice(0, 5).map(personText).join(", ")}${rows.length > 5 ? ", …" : ""}; use their email`);

/**
 * An account by email (any account, placeholders included) or by exact identifier or name (any case); null when none.
 * Only names set by a manager or the sign-in count (see resolvePerson). Several people with that exact name are refused
 * with their emails.
 */
export async function findPersonByEmailOrName(ctx: RequestContext, raw: string): Promise<{ id: string; email: string | null } | null> {
  if (EMAIL.test(raw)) {
    const { rows } = await ctx.db.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM users WHERE lower(email) = lower($1)
        ORDER BY kind = 'human' DESC, subject LIKE 'pending:%', disabled_at IS NOT NULL, created_at LIMIT 1`,
      [raw],
    );
    return rows[0] ?? null;
  }
  const exact = await ctx.db.query<Candidate & { by_subject: boolean }>(
    `SELECT id, email, display_name AS name, subject = $1 AS by_subject FROM users WHERE (lower(display_name) = lower($1) AND NOT name_self_set) OR subject = $1
      ORDER BY subject = $1 DESC, disabled_at IS NOT NULL, created_at`,
    [raw],
  );
  const first = exact.rows[0];
  if (!first) return null;
  // An exact account identifier wins over names; several people with the same name need an email.
  if (exact.rows.length > 1 && !first.by_subject) throw several(raw, exact.rows);
  return { id: first.id, email: first.email };
}

/** Enabled people whose name or email contains the text (most recently seen first, up to 6). */
async function partialMatches(ctx: RequestContext, raw: string): Promise<Candidate[]> {
  const q = raw.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await ctx.db.query<Candidate>(
    `SELECT id, email, display_name AS name FROM users
      WHERE disabled_at IS NULL AND kind = 'human'
        AND (lower(coalesce(display_name, '')) LIKE '%' || $1 || '%' OR lower(coalesce(email, '')) LIKE '%' || $1 || '%')
      ORDER BY last_seen_at DESC NULLS LAST, email LIMIT 6`,
    [q],
  );
  return rows;
}

/** Everything one person can reach and why. */
export async function personAccess(ctx: RequestContext, userId: string): Promise<PersonAccess> {
  if (userId !== ctx.actor.id && !canSeeAccess(ctx)) {
    throw new ForbiddenError("seeing someone else's access needs Manage people, Manage roles or Read every project (User managers, Auditors and Administrators)");
  }
  const u = (
    await ctx.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      kind: "human" | "service";
      subject: string;
      is_admin: boolean;
      approved_at: unknown;
      disabled_at: unknown;
    }>("SELECT id, email, display_name AS name, kind, subject, is_admin, approved_at, disabled_at FROM users WHERE id = $1", [userId])
  ).rows[0];
  if (!u) throw new NotFoundError(`user ${userId}`);
  const roles = await listRoles(ctx.db);
  const byKey = new Map(roles.map((r) => [r.key, r]));
  const human = u.kind === "human";
  const byConfig = human && !!u.email && ctx.settings.adminEmails.includes(u.email.toLowerCase());
  const admin = human && (u.is_admin || byConfig);
  const orgKeys = await orgRolesOf(ctx.db, ctx.settings, userId);
  const orgRoles = orgKeys.map((k) => ({ key: k, name: byKey.get(k)?.name ?? k, permissions: byKey.get(k)?.permissions ?? [] }));
  const orgPermissions = admin ? [...ORG_KEYS] : ORG_KEYS.filter((p) => orgRoles.some((r) => r.permissions.includes(p)));

  const teams = await ctx.db.query<{ slug: string; name: string; team_role: "member" | "lead" }>(
    "SELECT t.slug, t.name, m.role AS team_role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.name",
    [userId],
  );
  const grants = await ctx.db.query<{
    scope_id: string;
    slug: string;
    name: string;
    kind: "project" | "team" | "library";
    visibility: "team" | "members";
    status: string;
    parent: string | null;
    role: string;
    team_slug: string | null;
    team_name: string | null;
    from_slug: string | null;
    from_name: string | null;
    inherited: boolean;
  }>(
    `SELECT s.id AS scope_id, s.slug, s.name, s.kind, s.visibility, s.status, (SELECT p.slug FROM scopes p WHERE p.id = s.parent_id) AS parent,
            r.role, t.slug AS team_slug, t.name AS team_name, a.slug AS from_slug, a.name AS from_name, r.inherited_from IS NOT NULL AS inherited
       FROM scope_roles r
       JOIN scopes s ON s.id = r.scope_id
       JOIN roles ro ON ro.key = r.role AND ro.kind = 'project'
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN scopes a ON a.id = r.inherited_from
      WHERE r.user_id = $1 AND s.kind <> 'personal' AND s.status <> 'deleted'
      ORDER BY CASE s.kind WHEN 'team' THEN 0 WHEN 'library' THEN 1 ELSE 2 END, s.name, ro.position, r.inherited_from IS NOT NULL, t.name`,
    [userId],
  );
  const readable = await readableScopes(ctx);
  const hidden = new Set<string>();
  const projects = new Map<string, PersonAccess["projects"][number]>();
  for (const g of grants.rows) {
    if (readable !== null && !readable.includes(g.scope_id)) {
      hidden.add(g.scope_id);
      continue;
    }
    let p = projects.get(g.scope_id);
    if (!p) {
      p = { slug: g.slug, name: g.name, kind: g.kind, visibility: g.visibility, status: g.status, parent: g.parent, roles: [], permissions: [] };
      projects.set(g.scope_id, p);
    }
    const via = g.inherited ? "inherited" : g.team_slug ? "team" : "direct";
    const team = g.team_slug ? { slug: g.team_slug, name: g.team_name ?? g.team_slug } : null;
    const from = g.from_slug ? { slug: g.from_slug, name: g.from_name ?? g.from_slug } : null;
    if (!p.roles.some((r) => r.key === g.role && r.via === via && r.team?.slug === team?.slug && r.from?.slug === from?.slug)) {
      p.roles.push({ key: g.role, name: byKey.get(g.role)?.name ?? g.role, via, team, from });
    }
  }
  for (const p of projects.values()) {
    const held = new Set(p.roles.flatMap((r) => byKey.get(r.key)?.permissions ?? []));
    p.permissions = PROJECT_KEYS.filter((k) => held.has(k));
  }
  return {
    person: { id: u.id, email: u.email, name: u.name, kind: u.kind, status: accountStatus(u), needs_approval: needsApproval(u, ctx.settings) },
    administrator: { is: admin, source: byConfig ? "ADMIN_EMAILS" : admin ? "account" : null },
    org_roles: orgRoles,
    org_permissions: orgPermissions,
    reads_every_project: admin || orgPermissions.includes("read_all_projects") || orgPermissions.includes("manage_all_projects"),
    manages_every_project: admin || orgPermissions.includes("manage_all_projects"),
    teams: teams.rows,
    projects: [...projects.values()],
    other_projects: hidden.size,
  };
}

/** Who holds a role: people for organisation roles; per project, the people and teams given it there for project roles. */
export async function roleHolders(ctx: RequestContext, keyOrName: string): Promise<RoleHolders> {
  if (!canSeeAccess(ctx)) throw new ForbiddenError("seeing who holds a role needs Manage people, Manage roles or Read every project");
  const role = await findRole(ctx.db, keyOrName);
  const head = { key: role.key, name: role.name, kind: role.kind };
  type Person = { id: string; email: string | null; name: string | null; subject: string; approved_at: unknown; disabled_at: unknown; by_config: boolean };
  const person = (p: Person, admin: boolean) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    status: accountStatus(p),
    ...(admin ? { via: p.by_config ? ("ADMIN_EMAILS" as const) : ("account" as const) } : {}),
  });
  if (role.kind === "org") {
    const { rows } = await ctx.db.query<Person>(
      role.key === ADMIN_ROLE
        ? `SELECT id, email, display_name AS name, subject, approved_at, disabled_at, lower(coalesce(email, '')) = ANY ($1::text[]) AS by_config
             FROM users WHERE kind = 'human' AND (is_admin OR lower(coalesce(email, '')) = ANY ($1::text[])) ORDER BY lower(coalesce(display_name, email))`
        : `SELECT u.id, u.email, u.display_name AS name, u.subject, u.approved_at, u.disabled_at, false AS by_config
             FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role = $1 ORDER BY lower(coalesce(u.display_name, u.email))`,
      [role.key === ADMIN_ROLE ? ctx.settings.adminEmails : role.key],
    );
    return { role: head, people: rows.map((p) => person(p, role.key === ADMIN_ROLE)), projects: [], other_projects: 0 };
  }
  const { rows } = await ctx.db.query<{
    scope_id: string;
    slug: string;
    name: string;
    user_id: string | null;
    email: string | null;
    person: string | null;
    team_slug: string | null;
    team_name: string | null;
  }>(
    `SELECT s.id AS scope_id, s.slug, s.name, u.id AS user_id, coalesce(u.email, u.subject) AS email, u.display_name AS person, NULL AS team_slug, NULL AS team_name
       FROM scope_members m JOIN scopes s ON s.id = m.scope_id JOIN users u ON u.id = m.user_id
      WHERE m.role = $1 AND s.kind <> 'personal' AND s.status <> 'deleted'
     UNION ALL
     SELECT s.id, s.slug, s.name, NULL, NULL, NULL, t.slug, t.name
       FROM scope_team_roles r JOIN scopes s ON s.id = r.scope_id JOIN teams t ON t.id = r.team_id
      WHERE r.role = $1 AND s.status <> 'deleted'
     ORDER BY 3, 5, 8`,
    [role.key],
  );
  const readable = await readableScopes(ctx);
  const hidden = new Set<string>();
  const projects = new Map<string, RoleHolders["projects"][number]>();
  for (const r of rows) {
    if (readable !== null && !readable.includes(r.scope_id)) {
      hidden.add(r.scope_id);
      continue;
    }
    let p = projects.get(r.scope_id);
    if (!p) {
      p = { slug: r.slug, name: r.name, people: [], teams: [] };
      projects.set(r.scope_id, p);
    }
    if (r.team_slug) p.teams.push({ slug: r.team_slug, name: r.team_name ?? r.team_slug });
    else if (r.email && r.user_id) p.people.push({ id: r.user_id, email: r.email, name: r.person });
  }
  return { role: head, people: [], projects: [...projects.values()], other_projects: hidden.size };
}
