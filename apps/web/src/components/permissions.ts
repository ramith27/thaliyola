/**
 * Permission predicates (SPEC §5.16, ADDENDUM-roles §3.1). Every gate in the UI reads these, so the same
 * people see the same controls everywhere. Built on `may()` (organisation permissions) and `canIn()`
 * (what the caller can actually do in a scope) from api.ts. The only `me.admin` checks are the
 * Administrator-only cases (★), which have no permission key.
 *
 * Pure module: no React, no DOM.
 */
import { canIn, may, type Me, type ScopeInfo } from "../api";

/** Just the fields the predicates read, so tests and callers can pass partial objects. */
export type MeLike = Pick<Me, "admin"> & Partial<Pick<Me, "permissions" | "can_see_access">>;
export type ScopeLike = Pick<ScopeInfo, "kind" | "can_manage"> &
  Partial<Pick<ScopeInfo, "slug" | "status" | "effective_permissions" | "my_permissions" | "can_manage_members" | "can_manage_settings">>;

const org = (me: MeLike, p: string) => may(me as Me, p);
const inScope = (scope: ScopeLike | undefined, p: string, me?: MeLike) => canIn(scope as ScopeInfo | undefined, p, me as Me | undefined);
/** A project whose own skills this person may create: Manage settings there, and it isn't archived. */
const ownsSkills = (s: ScopeLike, me: MeLike) => s.kind === "project" && (s.status === undefined || s.status === "active") && inScope(s, "manage_settings", me);

export const can = {
  /** An organisation permission (Administrators hold them all). */
  org,
  /** A project permission the caller can use in this scope. */
  inScope,

  createProject: (me: MeLike) => org(me, "create_projects"),
  /** Manage settings in at least one project: they can add a sub-project under it. */
  createSubProject: (me: MeLike, scopes: ScopeLike[]) => scopes.some((s) => s.kind === "project" && inScope(s, "manage_settings", me)),
  /** Sidebar "+", Create "New project"/"New sub-project", Home: either of the two above. */
  newProjectEntry: (me: MeLike, scopes: ScopeLike[]) => can.createProject(me) || can.createSubProject(me, scopes),
  /** Admin › Projects: the same audience as today. */
  manageProjectsList: (me: MeLike, scopes: ScopeLike[]) =>
    ["create_projects", "manage_all_projects", "read_all_projects"].some((p) => org(me, p)) || scopes.some((s) => inScope(s, "manage_settings", me)),
  manageUsers: (me: MeLike) => org(me, "manage_users"),
  /** The Admin tab only; editing on the Roles page follows the catalogue's own flags. */
  manageRoles: (me: MeLike) => org(me, "manage_roles"),
  manageTeams: (me: MeLike) => org(me, "manage_teams"),
  purge: (me: MeLike) => org(me, "purge"),
  viewMetrics: (me: MeLike) => org(me, "view_metrics"),
  /** Admin › Audit log: Read every project and See usage (Administrators and Auditors), as the server checks. */
  seeAuditLog: (me: MeLike) => org(me, "read_all_projects") && org(me, "view_metrics"),
  securityAdmin: (me: MeLike) => org(me, "security_admin"),
  /** What's new: write releases and features, publish them (Administrators and Manage releases). */
  manageReleases: (me: MeLike) => org(me, "manage_releases"),
  /** Skills for Claude: create, import, edit and assign organisation-wide skills; manage skill sources. */
  manageSkills: (me: MeLike) => org(me, "manage_skills"),
  /**
   * New skill (Skills page, Create menu): organisation-wide skills need Manage skills; a project's own skills need
   * Manage settings in an active (not archived) project. The server's /skills can.create says the same.
   */
  createSkills: (me: MeLike, scopes: ScopeLike[]) => org(me, "manage_skills") || scopes.some((s) => ownsSkills(s, me)),
  /** A project that can own a new skill made by this person: active, and they have Manage settings there. */
  skillOwner: (s: ScopeLike, me: MeLike) => ownsSkills(s, me),
  /** Approve or reject other people's skill versions, roll back, confirm audience changes. */
  reviewSkills: (me: MeLike) => org(me, "review_skills"),
  /** The skills catalogue (All skills): managers, reviewers and Auditors (Read every project and See usage). */
  seeAllSkills: (me: MeLike) => org(me, "manage_skills") || org(me, "review_skills") || (org(me, "read_all_projects") && org(me, "view_metrics")),
  /** Who loaded which skill: managers and Auditors (usage names people, like the audit log). */
  seeSkillUsage: (me: MeLike) => org(me, "manage_skills") || (org(me, "read_all_projects") && org(me, "view_metrics")),
  /** May open someone else's access page (#/admin/users/:id). */
  seeAccess: (me: MeLike) => !!me.can_see_access || org(me, "manage_users"),
  /** Admin › Notifications: team-wide Slack and Trello routes (the Team space's settings: Manage all projects). */
  teamNotifications: (me: MeLike) => org(me, "manage_all_projects"),
  /** ★ Administrator only. */
  systemSettings: (me: MeLike) => !!me.admin,
  /** ★ Administrator only: give or take the Administrator role. */
  makeAdministrator: (me: MeLike) => !!me.admin,
  /** ★ Administrator only: Team space and Library settings and sources. */
  manageSpaceSettings: (me: MeLike) => !!me.admin,

  manageSettings: (scope: ScopeLike) => scope.can_manage_settings ?? scope.can_manage,
  manageMembers: (scope: ScopeLike) => scope.can_manage_members ?? scope.can_manage,
  /** "Settings" vs read-only "Members and access". */
  manageScope: (scope: ScopeLike) => can.manageSettings(scope) || can.manageMembers(scope),
  moveFrom: (scope: ScopeLike | undefined, me: MeLike) => inScope(scope, "review", me),
  /** Create or link Jira and Linear tickets on an entry: Propose in its project (not in a personal space). */
  addTickets: (scope: ScopeLike | undefined, me: MeLike) => !!scope && scope.kind !== "personal" && inScope(scope, "propose", me),
  moveTo: (scope: ScopeLike | undefined, me: MeLike) => inScope(scope, "review", me),
  /** Predicts the button label only ("Publish" vs "Submit for review"); the server's `published` result decides. */
  publishIn: (scope: ScopeLike | undefined, me: MeLike) =>
    !!scope && (scope.kind === "personal" || inScope(scope, "publish", me) || inScope(scope, "review", me)),
  /** Any Admin tab is visible (see ADMIN_TABS in nav.ts). */
  seeAdmin: (me: MeLike, scopes: ScopeLike[]) =>
    can.manageUsers(me) || can.manageRoles(me) || can.manageProjectsList(me, scopes) || can.teamNotifications(me) || can.systemSettings(me) || can.seeAuditLog(me),
};
