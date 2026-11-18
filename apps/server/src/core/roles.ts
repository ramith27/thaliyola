import type { Settings } from "../config.js";
import { withTx, type Queryable } from "../db/pool.js";
import { accountStatus, type AccountStatus } from "./accounts.js";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { joinAnd, keepingProjectAdmins, type ProjectsWithoutAdmin } from "./project-admins.js";

/**
 * Two kinds of roles, plus teams.
 * - Project roles (Viewer, Stakeholder, QA, Contributor, Reviewer, Moderator, Project admin, and custom ones) decide what
 *   someone can do inside one project and the projects under it. They're given per project, to people directly or to
 *   teams (whose members get them).
 * - Organisation roles (Administrator, User manager, Project creator, Team manager, Security lead, Auditor, and custom
 *   ones) are jobs across all of Thaliyola. Administrator can do everything; it is held through the account flag
 *   (users.is_admin) or ADMIN_EMAILS, never through user_roles.
 * Anyone can hold several roles and their permissions add up. Nobody gives or takes away permissions they don't hold.
 * Every role input accepts the key, the display name or a common alias ("writer", "Contributor", "project admins").
 */

export const PROJECT_PERMISSIONS = {
  read: "See the project and everything in it",
  comment: "Comment on proposals",
  propose: "Suggest new articles, findings, edits and moves; they wait for review",
  verify: "Confirm entries are still right, or flag them as out of date",
  review: "Approve or reject proposals, and move entries in or out of the project",
  publish: "Their own new entries and edits go live without review, from Claude too",
  moderate: "Delete entries and restore deleted ones",
  security: "See and update the project's vulnerabilities",
  manage_members: "Give people and teams roles here, change them and take them away",
  manage_settings: "Change the name, visibility, repositories, sources and sub-projects",
} as const;

export const ORG_PERMISSIONS = {
  manage_users: "Approve and add people, disable accounts, and give organisation roles",
  create_projects: "Create projects and approve project requests",
  manage_teams: "Create, rename and delete teams, and choose their members and leads",
  manage_roles: "Create custom roles and change what roles allow",
  manage_all_projects: "Everything a Project admin can do, in every project (their own writes still need Publish directly to skip review)",
  read_all_projects: "Read every project, members-only ones included",
  security_admin: "See every project's vulnerabilities and publish security alerts",
  purge: "Empty the trash and delete content for good",
  view_metrics: "See usage numbers and what people searched for",
  manage_releases: "Write release notes and the feature catalog on What's new, and publish them",
  manage_skills: "Create, import, edit and assign Claude skills, manage skill sources, and see who uses them",
  review_skills: "Approve or reject other people's new skill versions, roll skills back and confirm audience changes",
} as const;

export type ProjectPermission = keyof typeof PROJECT_PERMISSIONS;
export type OrgPermission = keyof typeof ORG_PERMISSIONS;
export type RoleKind = "org" | "project";

export const PROJECT_KEYS = Object.keys(PROJECT_PERMISSIONS) as ProjectPermission[];
export const ORG_KEYS = Object.keys(ORG_PERMISSIONS) as OrgPermission[];

export const PERMISSION_LABELS: Record<ProjectPermission | OrgPermission, string> = {
  read: "Read",
  comment: "Comment",
  propose: "Propose",
  verify: "Verify",
  review: "Review",
  publish: "Publish directly",
  moderate: "Moderate",
  security: "Security",
  manage_members: "Manage access",
  manage_settings: "Manage settings",
  manage_users: "Manage people",
  create_projects: "Create projects",
  manage_teams: "Manage teams",
  manage_roles: "Manage roles",
  manage_all_projects: "Manage every project",
  read_all_projects: "Read every project",
  security_admin: "Security everywhere",
  purge: "Delete permanently",
  view_metrics: "See usage",
  manage_releases: "Manage releases",
  manage_skills: "Manage skills",
  review_skills: "Review skills",
};

/** The access model in plain words, shown by the Roles page, list_roles and the docs. */
export const ACCESS_MODEL = {
  project:
    "Project roles decide what someone can do inside one project and the projects under it. They're given per project, to people or to teams, and someone with several roles has all their permissions.",
  org: "Organisation roles are jobs across all of Thaliyola: managing people, creating projects, managing teams, security, auditing. They don't open a project's content unless they include Read every project or Manage every project.",
  admin:
    "Administrator is the organisation role that can do everything: every organisation permission (so they read and manage every project), system settings, and making other Administrators.",
  team: "A team is a group of people that gets project roles like a person does; everyone in it gets them too. Its leads choose its members and can start projects for it. Being a lead gives no extra access.",
  inherit: "Roles flow down: a role in a project also applies in every project under it.",
  grant: "Nobody can give or take away permissions they don't have, whether by giving roles, changing a team's members, moving a project or changing what a role allows.",
};

/** How someone is in a team: member or lead. Team membership is not a role; leads choose the members. */
export const TEAM_ROLES = { member: "Member", lead: "Lead (chooses the team's members)" };

/** The Administrator organisation role: held through users.is_admin or ADMIN_EMAILS, never stored in user_roles. */
export const ADMIN_ROLE = "admin";

export interface Role {
  key: string;
  kind: RoleKind;
  name: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  position: number;
}

export interface RoleHolderCounts {
  people: number;
  teams: number;
  projects: number;
  invitations: number;
}

export interface CatalogRole extends Role {
  kind_name: "Project role" | "Organisation role";
  admin?: true;
  /** "Label: description" per permission. */
  allows: string[];
  /** Null unless the caller can see access (canSeeAccess). */
  holders: RoleHolderCounts | null;
  /** Permission keys the caller may switch on or off on this role ([] = they can't change its permissions). */
  editable_permissions: string[];
  /** May change its name and description. */
  can_edit: boolean;
  can_delete: boolean;
  /** Why permissions are locked or limited for the caller. */
  permissions_note: string | null;
}

export interface Catalog {
  roles: CatalogRole[];
  project_permissions: Record<string, string>;
  org_permissions: Record<string, string>;
  permission_labels: Record<string, string>;
  model: typeof ACCESS_MODEL;
  team_roles: typeof TEAM_ROLES;
  can_manage_roles: boolean;
  can_see_holders: boolean;
}

/** A change to someone's (or a team's) roles: replace them all (set), or add / remove some. Values are keys or names. */
export type RoleChange = { set?: string[]; add?: string[]; remove?: string[] };

export interface OrgRoleChange {
  user_id: string;
  email: string | null;
  roles: string[];
  role_names: string[];
  /** Keys; the *_names fields are the same roles by display name. */
  before: string[];
  added: string[];
  removed: string[];
  before_names: string[];
  added_names: string[];
  removed_names: string[];
  account: AccountStatus;
}

// ---- Who holds what ----------------------------------------------------------------------------------------------

/** Administrator: the account flag or ADMIN_EMAILS. Only people. */
export function isAdmin(ctx: RequestContext): boolean {
  if (ctx.actor.kind !== "human") return false;
  return !!ctx.actor.isAdmin || (!!ctx.actor.email && ctx.settings.adminEmails.includes(ctx.actor.email.toLowerCase()));
}

/** An organisation permission: Administrators have them all; others through their organisation roles (loaded with the actor). */
export function can(ctx: RequestContext, permission: OrgPermission): boolean {
  if (ctx.actor.kind !== "human") return false;
  return isAdmin(ctx) || !!ctx.actor.permissions?.includes(permission);
}

export function assertCan(ctx: RequestContext, permission: OrgPermission, message?: string) {
  if (!can(ctx, permission)) throw new ForbiddenError(message ?? `you need ${PERMISSION_LABELS[permission]} ('${permission}'): ${ORG_PERMISSIONS[permission]}`);
}

/** Administrators and holders of Manage every project: exempt from per-project grant limits. */
function exempt(ctx: RequestContext) {
  return isAdmin(ctx) || can(ctx, "manage_all_projects");
}

/** Who may see other people's access and who holds a role: Manage people, Manage roles, Read every project or Manage every project. */
export function canSeeAccess(ctx: RequestContext): boolean {
  return can(ctx, "manage_users") || can(ctx, "manage_roles") || can(ctx, "read_all_projects") || can(ctx, "manage_all_projects");
}

/** The caller's permissions in a scope, from all their project roles (direct, through teams and from projects above). */
export async function permissionsIn(db: Queryable, scopeId: string, userId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ permission: string }>("SELECT permission FROM scope_permissions WHERE scope_id = $1 AND user_id = $2", [scopeId, userId]);
  return new Set(rows.map((r) => r.permission));
}

/** People holding an organisation permission: Administrators and holders of an organisation role that includes it. */
export async function idsWithPermission(db: Queryable, settings: Settings, permission: OrgPermission): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM users u WHERE kind = 'human' AND disabled_at IS NULL AND approved_at IS NOT NULL
        AND (is_admin OR lower(email) = ANY($1::text[])
             OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org' WHERE ur.user_id = u.id AND $2 = ANY(r.permissions)))`,
    [settings.adminEmails, permission],
  );
  return rows.map((r) => r.id);
}

export async function projectMembersWith(db: Queryable, scopeId: string, permission: ProjectPermission): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM scope_permissions WHERE scope_id = $1 AND permission = $2", [
    scopeId,
    permission,
  ]);
  return rows.map((r) => r.user_id);
}

// ---- Roles --------------------------------------------------------------------------------------------------

/** Project roles first, then organisation roles (Administrator first); most powerful first within each. */
export async function listRoles(db: Queryable, kind?: RoleKind): Promise<Role[]> {
  const { rows } = await db.query<Role>(
    "SELECT key, kind, name, description, permissions, builtin, position FROM roles WHERE $1::text IS NULL OR kind = $1 ORDER BY kind DESC, position, name",
    [kind ?? null],
  );
  return rows.map((r) => (r.key === ADMIN_ROLE ? { ...r, permissions: [...ORG_KEYS] } : r));
}

/** Display names for role keys (unknown keys stay as they are). */
export function namesOf(roles: Pick<Role, "key" | "name">[], keys: string[]): string[] {
  return keys.map((k) => roles.find((r) => r.key === k)?.name ?? k);
}

/** Keys in catalogue order (most powerful first). */
export function inRoleOrder(roles: Pick<Role, "key">[], keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  const known = roles.filter((r) => wanted.has(r.key)).map((r) => r.key);
  return [...known, ...[...wanted].filter((k) => !known.includes(k))];
}

const label = (r: Pick<Role, "key" | "name">) => `${r.name} (${r.key})`;
const permissionLabel = (p: string) => PERMISSION_LABELS[p as ProjectPermission] ?? p;

/** How role inputs are compared: trimmed, lowercase, anything but letters and digits as one underscore. */
export function norm(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Common names for built-in roles, per kind (normalized → key). */
const ALIASES: Record<RoleKind, Record<string, string>> = {
  project: { viewer: "reader", read_only: "reader", contributor: "writer", project_admin: "owner", project_owner: "owner", admin: "owner" },
  org: { administrator: "admin" },
};

/** Roles matching one normalized input, stopping at the first step that matches: key, name, alias. */
function matchStep(roles: Role[], n: string): Role[] {
  const byKey = roles.filter((r) => r.key === n);
  if (byKey.length) return byKey;
  const byName = roles.filter((r) => norm(r.name) === n);
  if (byName.length) return byName;
  return roles.filter((r) => ALIASES[r.kind][n] === r.key);
}

/** Like matchStep, then once more without a plural 's' ("reviewers", "project admins"). */
function matchRoles(roles: Role[], n: string): Role[] {
  const hit = matchStep(roles, n);
  if (hit.length || n.length < 3 || !n.endsWith("s")) return hit;
  return matchStep(roles, n.slice(0, -1));
}

const KIND_TEXT = { project: "project role", org: "organisation role" } as const;
const KIND_PLURAL = { project: "Project roles", org: "Organisation roles" } as const;

/**
 * Turns role inputs (keys, names or aliases, in any case, singular or plural) into roles of one kind, in catalogue order.
 * Empty inputs are ignored and duplicates removed. A role of the other kind, an ambiguous input or an unknown one is
 * refused with a message that lists the roles there are.
 */
export async function resolveRoles(db: Queryable, kind: RoleKind, inputs: string[]): Promise<Role[]> {
  if (!inputs.some((x) => norm(x))) return [];
  const all = await listRoles(db);
  const mine = all.filter((r) => r.kind === kind);
  const other = all.filter((r) => r.kind !== kind);
  const found = new Set<string>();
  for (const raw of inputs) {
    const n = norm(raw);
    if (!n) continue;
    const hit = matchRoles(mine, n);
    if (hit.length > 1) throw new ValidationError(`'${raw}' matches several roles: ${hit.map(label).join(", ")}; use the key`);
    if (hit.length === 1) {
      found.add(hit[0]!.key);
      continue;
    }
    const list = mine.map(label).join(", ");
    if (matchRoles(other, n).length) {
      throw new ValidationError(
        kind === "project"
          ? `'${raw}' is an organisation role, not a project role: organisation roles apply across all of Thaliyola and are given with set_user_roles (the Users page). Project roles: ${list}`
          : `'${raw}' is a project role, not an organisation role: give it in a project with set_project_access (project settings → Members and access). Organisation roles: ${list}`,
      );
    }
    throw new ValidationError(`no ${KIND_TEXT[kind]} called '${raw}'. ${KIND_PLURAL[kind]}: ${list}`);
  }
  return mine.filter((r) => found.has(r.key));
}

/** @deprecated use resolveRoles */
export const checkRoles = resolveRoles;

/** One role of either kind, by key, name or alias. */
export async function findRole(db: Queryable, keyOrName: string): Promise<Role> {
  const n = norm(keyOrName);
  const hit = n ? matchRoles(await listRoles(db), n) : [];
  if (hit.length > 1) throw new ValidationError(`'${keyOrName}' matches several roles: ${hit.map(label).join(", ")}; use the key`);
  if (!hit[0]) throw new NotFoundError(`role '${keyOrName}'`);
  return hit[0];
}

/**
 * The one place the older single-role inputs are read: `roles` replaces them all (and wins over `role`); `role` is one
 * role ('none', '' or null take them all away); otherwise `add` / `remove`.
 */
export function roleChangeFrom(body: { roles?: string[] | null; role?: string | null; add?: string[] | null; remove?: string[] | null }): RoleChange {
  const add = body.add ?? [];
  const remove = body.remove ?? [];
  const partial = add.length > 0 || remove.length > 0;
  const replacing = (body.roles !== undefined && body.roles !== null) || body.role !== undefined;
  if (replacing && partial) throw new ValidationError("pass roles (to replace them all) or add / remove, not both");
  if (body.roles !== undefined && body.roles !== null) return { set: body.roles };
  if (body.role !== undefined) {
    const r = body.role;
    return { set: r === null || !r.trim() || r.trim().toLowerCase() === "none" ? [] : [r] };
  }
  if (partial) return { add, remove };
  throw new ValidationError("pass roles (e.g. ['Reviewer']) or add / remove");
}

/** What a change does to a list of keys: desired = set ?? (current ∪ add) − remove. */
export function applyRoleChange(current: string[], change: { set?: string[]; add?: string[]; remove?: string[] }) {
  const desired = change.set
    ? [...new Set(change.set)]
    : [...new Set([...current, ...(change.add ?? [])])].filter((k) => !(change.remove ?? []).includes(k));
  return { desired, added: desired.filter((k) => !current.includes(k)), removed: current.filter((k) => !desired.includes(k)) };
}

/**
 * Nobody gives or takes away more than they hold: a project role needs every permission it carries in that project
 * (Administrators and Manage every project holders may give anything there); an organisation role likewise against
 * the caller's organisation permissions. Only Administrators make or remove Administrators.
 */
export async function assertMayGrant(
  ctx: RequestContext,
  roles: Pick<Role, "key" | "name" | "permissions">[],
  scopeId?: string,
  explain?: (role: Pick<Role, "key" | "name">, missingLabels: string[]) => string,
): Promise<void> {
  if (isAdmin(ctx) || !roles.length) return;
  if (roles.some((r) => r.key === ADMIN_ROLE)) throw new ForbiddenError("only Administrators make or remove Administrators");
  const held = scopeId
    ? can(ctx, "manage_all_projects")
      ? new Set<string>(PROJECT_KEYS)
      : await permissionsIn(ctx.db, scopeId, ctx.actor.id)
    : new Set(ctx.actor.kind === "human" ? (ctx.actor.permissions ?? []) : []);
  for (const r of roles) {
    const missing = r.permissions.filter((p) => !held.has(p)).map(permissionLabel);
    if (missing.length) throw new ForbiddenError(explain?.(r, missing) ?? `you can't give or take away ${r.name}: it includes permissions you don't have (${missing.join(", ")})`);
  }
}

/** The project roles that include a permission, by name: "Reviewer, Moderator and Project admin". */
export async function roleListText(db: Queryable, permission: ProjectPermission): Promise<string> {
  return joinAnd((await listRoles(db, "project")).filter((r) => r.permissions.includes(permission)).map((r) => r.name));
}

// ---- The catalogue -------------------------------------------------------------------------------------------------

/** How many people, teams, projects and open invitations hold each role (personal spaces don't count). */
async function roleUsage(db: Queryable, settings: Settings): Promise<Map<string, RoleHolderCounts>> {
  const { rows } = await db.query<{ key: string; kind: RoleKind; people: number; teams: number; projects: number; invitations: number; org_people: number }>(
    `SELECT r.key, r.kind,
            (SELECT count(DISTINCT m.user_id) FROM scope_members m JOIN scopes s ON s.id = m.scope_id WHERE m.role = r.key AND s.kind <> 'personal')::int AS people,
            (SELECT count(DISTINCT t.team_id) FROM scope_team_roles t WHERE t.role = r.key)::int AS teams,
            (SELECT count(*) FROM (SELECT m.scope_id FROM scope_members m JOIN scopes s ON s.id = m.scope_id WHERE m.role = r.key AND s.kind <> 'personal'
                                   UNION SELECT t.scope_id FROM scope_team_roles t WHERE t.role = r.key) x)::int AS projects,
            (SELECT count(*) FROM invitations i
              WHERE r.key = ANY (i.scope_roles) AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())::int AS invitations,
            (SELECT count(*) FROM user_roles u WHERE u.role = r.key)::int AS org_people
       FROM roles r`,
  );
  const admins = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE kind = 'human' AND disabled_at IS NULL AND approved_at IS NOT NULL
          AND (is_admin OR lower(coalesce(email, '')) = ANY ($1::text[]))`,
      [settings.adminEmails],
    )
  ).rows[0]!.n;
  return new Map(
    rows.map((r) => [
      r.key,
      r.kind === "project"
        ? { people: r.people, teams: r.teams, projects: r.projects, invitations: r.invitations }
        : { people: r.key === ADMIN_ROLE ? admins : r.org_people, teams: 0, projects: 0, invitations: 0 },
    ]),
  );
}

const isHeld = (r: Pick<Role, "kind">, c: RoleHolderCounts) => (r.kind === "project" ? c.people + c.teams + c.invitations > 0 : c.people > 0);

/** One catalogue row: what the role allows, who holds it (if the caller may see), and what the caller may change. */
function catalogRow(ctx: RequestContext, r: Role, counts: RoleHolderCounts, seeHolders: boolean): CatalogRole {
  const texts: Record<string, string> = r.kind === "org" ? ORG_PERMISSIONS : PROJECT_PERMISSIONS;
  const allows = r.permissions.map((p) => `${permissionLabel(p)}: ${texts[p] ?? ""}`);
  if (r.key === ADMIN_ROLE) allows.push("System settings and making other Administrators");
  const manage = can(ctx, "manage_roles");
  const mine: string[] = isAdmin(ctx) ? [...ORG_KEYS] : ORG_KEYS.filter((p) => ctx.actor.permissions?.includes(p));
  let editable: string[] = [];
  let canDelete = false;
  let note: string | null = null;
  if (!manage) note = "Changing roles needs Manage roles.";
  else if (r.key === ADMIN_ROLE) note = "Administrator always has every permission and can't be changed.";
  else if (r.builtin && r.kind === "org") note = "Built-in roles keep their permissions; create a custom role instead.";
  else if (r.kind === "project" && isHeld(r, counts) && !exempt(ctx)) note = `People hold ${r.name}, so changing what it allows needs Manage every project.`;
  else if (r.builtin) {
    editable = ["publish"];
    note = "Built-in roles keep their permissions; only Publish directly can be switched.";
  } else if (r.kind === "project") {
    editable = PROJECT_KEYS.filter((p) => p !== "read");
    canDelete = true;
  } else {
    const missing = r.permissions.filter((p) => !mine.includes(p));
    if (!missing.length) {
      editable = mine;
      canDelete = true;
    } else note = `${r.name} includes permissions you don't have (${missing.map(permissionLabel).join(", ")}), so you can't change or delete it.`;
  }
  return {
    ...r,
    kind_name: r.kind === "org" ? "Organisation role" : "Project role",
    ...(r.key === ADMIN_ROLE ? { admin: true as const } : {}),
    allows,
    holders: seeHolders ? counts : null,
    editable_permissions: editable,
    can_edit: manage && r.key !== ADMIN_ROLE,
    can_delete: canDelete,
    permissions_note: note,
  };
}

/** Every role with what it allows, the permission texts and the access model; holders only for those who may see access. */
export async function rolesCatalog(ctx: RequestContext): Promise<Catalog> {
  const roles = await listRoles(ctx.db);
  const usage = await roleUsage(ctx.db, ctx.settings);
  const seeHolders = canSeeAccess(ctx);
  const none: RoleHolderCounts = { people: 0, teams: 0, projects: 0, invitations: 0 };
  return {
    roles: roles.map((r) => catalogRow(ctx, r, usage.get(r.key) ?? none, seeHolders)),
    project_permissions: PROJECT_PERMISSIONS,
    org_permissions: ORG_PERMISSIONS,
    permission_labels: PERMISSION_LABELS,
    model: ACCESS_MODEL,
    team_roles: TEAM_ROLES,
    can_manage_roles: can(ctx, "manage_roles"),
    can_see_holders: seeHolders,
  };
}

async function catalogRoleFor(ctx: RequestContext, key: string): Promise<CatalogRole> {
  const row = (await rolesCatalog(ctx)).roles.find((r) => r.key === key);
  if (!row) throw new NotFoundError(`role '${key}'`);
  return row;
}

// ---- Defining roles ------------------------------------------------------------------------------------------------

/** Permission inputs: keys, or their labels ("Publish directly"), in catalogue order. Project roles always get Read. */
function resolvePermissions(kind: RoleKind, inputs: string[]): string[] {
  const keys: readonly string[] = kind === "org" ? ORG_KEYS : PROJECT_KEYS;
  const out = new Set<string>();
  const bad: string[] = [];
  for (const raw of inputs) {
    const n = norm(raw);
    if (!n) continue;
    const key = keys.find((k) => k === n) ?? keys.find((k) => norm(permissionLabel(k)) === n);
    if (key) out.add(key);
    else bad.push(raw);
  }
  if (bad.length) {
    const other = kind === "org" ? PROJECT_KEYS : ORG_KEYS;
    const wrongKind = bad.filter((b) => (other as readonly string[]).some((k) => k === norm(b) || norm(permissionLabel(k)) === norm(b)));
    throw new ValidationError(
      `unknown ${KIND_TEXT[kind].replace(" role", "")} permission ${bad.join(", ")}` +
        (wrongKind.length ? ` (${wrongKind.join(", ")} ${wrongKind.length === 1 ? "is" : "are"} ${kind === "org" ? "a project" : "an organisation"} permission)` : "") +
        `; choose from ${keys.join(", ")}`,
    );
  }
  // Every project role reads the project, so Read is added rather than asked for.
  if (kind === "project") out.add("read");
  return keys.filter((k) => out.has(k));
}

/**
 * A new key or name must not be taken by another role: its key, its name, or an alias that means it, singular or
 * plural. The role being changed (and aliases that mean it) don't count, so Viewer can be renamed "Read-only".
 */
async function assertNoClash(db: Queryable, candidate: { key?: string; name?: string }, self?: string) {
  const others = (await listRoles(db)).filter((r) => r.key !== self);
  // The same matching resolveRoles uses, singular and plural: a custom "Viewers" would otherwise take over "viewers".
  const clashWith = (v: string) => matchRoles(others, v)[0] ?? matchStep(others, `${v}s`)[0];
  if (candidate.key) {
    if (others.some((o) => o.key === candidate.key)) throw new ValidationError(`a role '${candidate.key}' already exists`);
    const other = clashWith(candidate.key);
    if (other) throw new ValidationError(`the key '${candidate.key}' is already used by ${other.name} (${other.key}); choose another key`);
  }
  if (candidate.name !== undefined) {
    const other = clashWith(norm(candidate.name));
    if (other) throw new ValidationError(`'${candidate.name}' is already used by ${other.name} (${other.key}); choose another name`);
  }
}

/** Whether anyone holds a project role: people or teams in a project, or open invitations. */
async function projectRoleHeld(db: Queryable, key: string): Promise<boolean> {
  const { rows } = await db.query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM scope_members m JOIN scopes s ON s.id = m.scope_id WHERE m.role = $1 AND s.kind <> 'personal')
         OR EXISTS (SELECT 1 FROM scope_team_roles WHERE role = $1)
         OR EXISTS (SELECT 1 FROM invitations WHERE $1 = ANY (scope_roles) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS held`,
    [key],
  );
  return rows[0]!.held;
}

/** Scopes where a role is given (people or teams); the projects below them are checked too. */
async function grantScopeIds(db: Queryable, key: string): Promise<string[]> {
  const { rows } = await db.query<{ scope_id: string }>("SELECT scope_id FROM scope_members WHERE role = $1 UNION SELECT scope_id FROM scope_team_roles WHERE role = $1", [
    key,
  ]);
  return rows.map((r) => r.scope_id);
}

/**
 * Creates a custom role. Needs Manage roles. The key is optional (made from the name). Project roles always include
 * read (added if left out); organisation roles can only include organisation permissions the caller holds.
 */
export async function createRole(
  ctx: RequestContext,
  input: { key?: string; kind: RoleKind; name: string; description?: string; permissions: string[] },
): Promise<CatalogRole> {
  assertCan(ctx, "manage_roles");
  const name = (input.name ?? "").trim();
  if (!name) throw new ValidationError("name is required");
  if (input.kind !== "org" && input.kind !== "project") throw new ValidationError("kind is 'project' or 'org' (organisation)");
  const key = norm(input.key ?? name);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) throw new ValidationError("the key must be lowercase letters, digits and underscores, starting with a letter (e.g. qa_lead)");
  const permissions = resolvePermissions(input.kind, input.permissions ?? []);
  await assertNoClash(ctx.db, { key, name });
  if (input.kind === "org") {
    await assertMayGrant(ctx, [{ key, name, permissions }], undefined, (_r, labels) => `you can't create ${name}: it includes permissions you don't have (${labels.join(", ")})`);
  }
  await ctx.db.query("INSERT INTO roles (key, kind, name, description, permissions, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [
    key,
    input.kind,
    name,
    input.description?.trim() ?? "",
    permissions,
    ctx.actor.id,
  ]);
  await audit(ctx.db, ctx.actor.id, "create_role", null, { targetKind: "role", targetLabel: name, details: { key, kind: input.kind, permissions } });
  return catalogRoleFor(ctx, key);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Changes a role's name, description or permissions. Administrator can't be changed. Built-in roles keep their
 * permissions, except that Publish directly can be switched on project roles. Organisation roles can only gain or lose
 * permissions the caller holds; a project role someone holds needs Manage every project to change what it allows.
 */
export async function updateRole(
  ctx: RequestContext,
  keyOrName: string,
  patch: { name?: string; description?: string; permissions?: string[] },
): Promise<CatalogRole & { before: { name: string; description: string; permissions: string[] } } & ProjectsWithoutAdmin> {
  assertCan(ctx, "manage_roles");
  const role = await findRole(ctx.db, keyOrName);
  if (role.key === ADMIN_ROLE) throw new ValidationError("Administrator can't be changed: it always has every permission");
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new ValidationError("name is required");
  if (name !== undefined && name !== role.name) await assertNoClash(ctx.db, { name }, role.key);
  let permissions: string[] | null = null;
  if (patch.permissions !== undefined) {
    const next = resolvePermissions(role.kind, patch.permissions);
    if (!sameSet(next, role.permissions)) {
      const changed = [...next.filter((p) => !role.permissions.includes(p)), ...role.permissions.filter((p) => !next.includes(p))];
      if (role.builtin && (role.kind !== "project" || changed.some((p) => p !== "publish"))) {
        throw new ValidationError("built-in roles keep their permissions (only Publish directly can be switched on project roles); create a custom role instead");
      }
      if (role.kind === "org") {
        await assertMayGrant(
          ctx,
          [{ ...role, permissions: [...new Set([...role.permissions, ...next])] }],
          undefined,
          (r, labels) => `you can't change what ${r.name} allows: it involves permissions you don't have (${labels.join(", ")})`,
        );
      } else if (!exempt(ctx) && (await projectRoleHeld(ctx.db, role.key))) {
        throw new ForbiddenError(
          `changing what ${role.name} allows changes it for everyone who holds it, in every project; that needs Manage every project (Administrators have it)`,
        );
      }
      permissions = next;
    }
  }
  const losesManage = role.kind === "project" && !!permissions && role.permissions.includes("manage_members") && !permissions.includes("manage_members");
  const scopes = losesManage ? await grantScopeIds(ctx.db, role.key) : [];
  const out = await withTx(ctx.db, (tx) =>
    keepingProjectAdmins(
      tx,
      scopes,
      () =>
        tx.query("UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description), permissions = coalesce($4, permissions) WHERE key = $1", [
          role.key,
          name ?? null,
          patch.description?.trim() ?? null,
          permissions,
        ]),
      { refuse: false, readable: null },
    ),
  );
  await audit(ctx.db, ctx.actor.id, "update_role", null, {
    targetKind: "role",
    targetLabel: name ?? role.name,
    details: {
      key: role.key,
      ...(name !== undefined && name !== role.name ? { name_before: role.name, name_after: name } : {}),
      ...(permissions ? { added: permissions.filter((p) => !role.permissions.includes(p)), removed: role.permissions.filter((p) => !permissions!.includes(p)) } : {}),
      ...(patch.description !== undefined ? { description_changed: true } : {}),
    },
  });
  return {
    ...(await catalogRoleFor(ctx, role.key)),
    before: { name: role.name, description: role.description, permissions: role.permissions },
    projects_without_admin: out.projects_without_admin,
    other_projects_without_admin: out.other_projects_without_admin,
  };
}

/**
 * Deletes a custom role, taking it from everyone who held it (and from open invitations, so a later role with the
 * same key can't come back through them). Organisation roles need their permissions; a project role someone holds
 * needs Manage every project.
 */
export async function deleteRole(ctx: RequestContext, keyOrName: string) {
  assertCan(ctx, "manage_roles");
  const role = await findRole(ctx.db, keyOrName);
  if (role.builtin) throw new ValidationError("built-in roles can't be deleted");
  if (role.kind === "org") {
    await assertMayGrant(ctx, [role], undefined, (r, labels) => `you can't delete ${r.name}: it includes permissions you don't have (${labels.join(", ")})`);
  } else if (!exempt(ctx) && (await projectRoleHeld(ctx.db, role.key))) {
    throw new ForbiddenError(`people hold ${role.name}; deleting it takes it away from them in every project, which needs Manage every project (Administrators have it)`);
  }
  const scopes = role.kind === "project" ? await grantScopeIds(ctx.db, role.key) : [];
  const out = await withTx(ctx.db, (tx) =>
    keepingProjectAdmins(
      tx,
      scopes,
      async () => {
        const held = await tx.query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM scope_members WHERE role = $1) + (SELECT count(*) FROM scope_team_roles WHERE role = $1)
                   + (SELECT count(*) FROM user_roles WHERE role = $1))::int AS n`,
          [role.key],
        );
        // scope_role (kept for older readers) follows: the first role left, or none.
        const invitations = await tx.query(
          `UPDATE invitations SET scope_roles = array_remove(scope_roles, $1), scope_role = (array_remove(scope_roles, $1))[1]
            WHERE ($1 = ANY (scope_roles) OR scope_role = $1) AND accepted_at IS NULL`,
          [role.key],
        );
        await tx.query("DELETE FROM roles WHERE key = $1", [role.key]);
        return { grants_removed: held.rows[0]!.n, invitations_changed: invitations.rowCount ?? 0 };
      },
      { refuse: false, readable: null },
    ),
  );
  await audit(ctx.db, ctx.actor.id, "delete_role", null, {
    targetKind: "role",
    targetLabel: role.name,
    details: { key: role.key, kind: role.kind, grants_removed: out.result.grants_removed },
  });
  return {
    key: role.key,
    name: role.name,
    deleted: true as const,
    grants_removed: out.result.grants_removed,
    invitations_changed: out.result.invitations_changed,
    projects_without_admin: out.projects_without_admin,
    other_projects_without_admin: out.other_projects_without_admin,
  };
}

// ---- Organisation roles on people ----------------------------------------------------------------------------------

/** A person's organisation roles stored in user_roles (Administrator isn't one of them). */
export async function userRoles(db: Queryable, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    "SELECT ur.role FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org' WHERE ur.user_id = $1 ORDER BY r.position, r.name",
    [userId],
  );
  return rows.map((r) => r.role);
}

/** A person's organisation roles, most powerful first, with 'admin' first for Administrators (flag or ADMIN_EMAILS). */
export async function orgRolesOf(db: Queryable, settings: Settings, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ admin: boolean; roles: string[] }>(
    `SELECT u.kind = 'human' AND (u.is_admin OR lower(coalesce(u.email, '')) = ANY ($2::text[])) AS admin,
            ARRAY(SELECT ur.role FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org' WHERE ur.user_id = u.id ORDER BY r.position, r.name) AS roles
       FROM users u WHERE u.id = $1`,
    [userId, settings.adminEmails],
  );
  if (!rows[0]) return [];
  return rows[0].admin ? [ADMIN_ROLE, ...rows[0].roles] : rows[0].roles;
}

export interface UserRolesPlan {
  userId: string;
  email: string | null;
  account: AccountStatus;
  byConfig: boolean;
  adminBefore: boolean;
  adminAfter: boolean;
  /** Stored organisation roles (without Administrator), before and after. */
  current: string[];
  desired: string[];
  /** Keys in catalogue order, 'admin' first when it applies. */
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

/**
 * Checks a change to someone's organisation roles without writing it. Needs Manage people; only Administrators change
 * an Administrator's account or make and remove Administrators; replacing someone's roles never removes Administrator
 * (only remove: ['Administrator'] does); nobody removes their own, and ADMIN_EMAILS Administrators can't be removed.
 * Only roles whose permissions the caller holds can be given or taken away.
 */
export async function planUserRoles(ctx: RequestContext, userId: string, change: RoleChange): Promise<UserRolesPlan> {
  assertCan(ctx, "manage_users");
  const target = (
    await ctx.db.query<{ id: string; kind: string; email: string | null; subject: string; is_admin: boolean; approved_at: unknown; disabled_at: unknown }>(
      "SELECT id, kind, email, subject, is_admin, approved_at, disabled_at FROM users WHERE id = $1",
      [userId],
    )
  ).rows[0];
  if (!target) throw new NotFoundError(`user ${userId}`);
  const human = target.kind === "human";
  const byConfig = human && !!target.email && ctx.settings.adminEmails.includes(target.email.toLowerCase());
  const adminBefore = human && (target.is_admin || byConfig);
  if (adminBefore && !isAdmin(ctx)) throw new ForbiddenError("only Administrators change an Administrator's account");

  const set = change.set ? await resolveRoles(ctx.db, "org", change.set) : undefined;
  const add = await resolveRoles(ctx.db, "org", change.add ?? []);
  const remove = await resolveRoles(ctx.db, "org", change.remove ?? []);
  const isA = (r: Role) => r.key === ADMIN_ROLE;
  const adminAdded = !!set?.some(isA) || add.some(isA);
  const adminRemoved = remove.some(isA);
  if (adminAdded && adminRemoved) throw new ValidationError("Administrator can't be added and removed at once");
  const adminAfter = adminAdded ? true : adminRemoved ? false : adminBefore;

  const all = await listRoles(ctx.db, "org");
  const current = await userRoles(ctx.db, userId);
  const keys = (rs: Role[]) => rs.filter((r) => !isA(r)).map((r) => r.key);
  const { desired } = applyRoleChange(current, { set: set ? keys(set) : undefined, add: keys(add), remove: keys(remove) });

  if (!human) {
    if (desired.length) throw new ValidationError("organisation roles are for people, not service accounts");
    if (adminAfter) throw new ValidationError("only people can be Administrators");
  }
  if (adminAfter !== adminBefore) {
    if (!isAdmin(ctx)) throw new ForbiddenError("only Administrators make or remove Administrators");
    if (!adminAfter && target.id === ctx.actor.id) throw new ForbiddenError("you can't remove your own admin rights or disable yourself");
    if (!adminAfter && byConfig) throw new ValidationError(`${target.email} is an Administrator through ADMIN_EMAILS, a server setting; change it there`);
  }
  const before = inRoleOrder(all, [...(adminBefore ? [ADMIN_ROLE] : []), ...current]);
  const after = inRoleOrder(all, [...(adminAfter ? [ADMIN_ROLE] : []), ...desired]);
  const added = after.filter((k) => !before.includes(k));
  const removed = before.filter((k) => !after.includes(k));
  await assertMayGrant(
    ctx,
    all.filter((r) => added.includes(r.key) || removed.includes(r.key)),
  );
  return { userId, email: target.email, account: accountStatus(target), byConfig, adminBefore, adminAfter, current, desired, before, after, added, removed };
}

/** Writes a checked plan: user_roles rows, and the account flag when Administrator changes. */
export async function applyUserRoles(tx: Queryable, ctx: RequestContext, plan: UserRolesPlan): Promise<void> {
  const gone = plan.current.filter((k) => !plan.desired.includes(k));
  const fresh = plan.desired.filter((k) => !plan.current.includes(k));
  if (gone.length) await tx.query("DELETE FROM user_roles WHERE user_id = $1 AND role = ANY ($2::text[])", [plan.userId, gone]);
  for (const k of fresh) {
    await tx.query("INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [plan.userId, k, ctx.actor.id]);
  }
  if (plan.adminAfter !== plan.adminBefore && !plan.byConfig) await tx.query("UPDATE users SET is_admin = $2 WHERE id = $1", [plan.userId, plan.adminAfter]);
}

/** Gives or takes away someone's organisation roles: a list replaces them (never removing Administrator), or add / remove. */
export async function setUserRoles(ctx: RequestContext, userId: string, change: string[] | RoleChange): Promise<OrgRoleChange> {
  const plan = await planUserRoles(ctx, userId, Array.isArray(change) ? { set: change } : change);
  await withTx(ctx.db, (tx) => applyUserRoles(tx, ctx, plan));
  await audit(ctx.db, ctx.actor.id, "set_user_roles", userId, {
    targetKind: "person",
    targetLabel: plan.email,
    details: { before: plan.before, after: plan.after, added: plan.added, removed: plan.removed },
  });
  const all = await listRoles(ctx.db, "org");
  return {
    user_id: userId,
    email: plan.email,
    roles: plan.after,
    role_names: namesOf(all, plan.after),
    before: plan.before,
    added: plan.added,
    removed: plan.removed,
    before_names: namesOf(all, plan.before),
    added_names: namesOf(all, plan.added),
    removed_names: namesOf(all, plan.removed),
    account: plan.account,
  };
}
