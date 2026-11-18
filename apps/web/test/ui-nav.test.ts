import { describe, expect, it } from "vitest";
import {
  ADMIN_TABS,
  CREATE_ACTIONS,
  GO_TO,
  NAV,
  USER_MENU,
  adminEntry,
  firstAdminTab,
  navIdForRoute,
  visible,
  type NavContext,
} from "../src/components/nav";
import { can, type MeLike, type ScopeLike } from "../src/components/permissions";

/** SPEC §7.3 ui-nav and ADDENDUM-roles §1.3: every route is reachable, and the permission predicates hold. */

type TestMe = NavContext["me"];
const member = (permissions: string[] = [], extra: Partial<TestMe> = {}): TestMe => ({ admin: false, permissions, auth_mode: "local", ...extra });
const ADMIN: TestMe = { admin: true, permissions: [], auth_mode: "local" };

const project = (slug: string, perms: string[] | undefined, extra: Partial<ScopeLike> = {}): ScopeLike & { slug: string } => ({
  slug,
  kind: "project",
  can_manage: false,
  effective_permissions: perms,
  ...extra,
});
const TEAM_SPACE: ScopeLike & { slug: string } = { slug: "team", kind: "team", can_manage: false, effective_permissions: ["read", "propose"] };

const ctx = (me: TestMe, scopes: ScopeLike[] = [TEAM_SPACE], current: NavContext["current"] = null): NavContext => ({ me, scopes, current });

/** The first path segment(s) of every hash an entry point links to. */
function linkedSections(c: NavContext): Set<string> {
  const hrefs = [
    ...visible(NAV, c).map((n) => n.href),
    ...visible(CREATE_ACTIONS, c).map((a) => a.href(c)),
    ...visible(ADMIN_TABS, c).map((t) => t.href),
    ...visible(USER_MENU, c).flatMap((u) => (u.href ? [u.href] : [])),
    ...visible(GO_TO, c).map((g) => g.href),
  ];
  const out = new Set<string>();
  for (const h of hrefs) {
    const path = h.replace(/^#\/?/, "").split("?")[0]!;
    const parts = path.split("/").filter(Boolean);
    out.add(parts[0] ?? "");
    if (parts.length > 1) out.add(`${parts[0]}/${parts[1]}`);
  }
  return out;
}

/** Route sections from SPEC §2.1 plus ADDENDUM-roles §1.1, and how each is reached. */
const ROUTES: { section: string; reachedBy: "nav" | "admin" | "exception"; why?: string }[] = [
  { section: "", reachedBy: "nav" },
  { section: "review", reachedBy: "nav" },
  { section: "inbox", reachedBy: "nav" },
  { section: "sessions", reachedBy: "nav" },
  { section: "sources", reachedBy: "nav" },
  { section: "security", reachedBy: "nav" },
  { section: "graph", reachedBy: "nav" },
  { section: "metrics", reachedBy: "nav" },
  { section: "teams", reachedBy: "nav" },
  { section: "skills", reachedBy: "nav" },
  { section: "connect", reachedBy: "nav" },
  { section: "trash", reachedBy: "nav" },
  { section: "whats-new", reachedBy: "nav" },
  { section: "account", reachedBy: "nav" },
  { section: "roles", reachedBy: "nav" },
  { section: "new/article", reachedBy: "nav" },
  { section: "new/finding", reachedBy: "nav" },
  { section: "new/paste", reachedBy: "nav" },
  { section: "import", reachedBy: "nav" },
  { section: "new/project", reachedBy: "admin" },
  { section: "admin", reachedBy: "admin" },
  { section: "admin/users", reachedBy: "admin" },
  { section: "admin/roles", reachedBy: "admin" },
  { section: "admin/projects", reachedBy: "admin" },
  { section: "admin/notifications", reachedBy: "admin" },
  { section: "admin/system", reachedBy: "admin" },
  { section: "admin/audit", reachedBy: "admin" },
  { section: "search", reachedBy: "exception", why: "opened from the search overlay's 'Search everything' row and the Home field" },
  { section: "scope", reachedBy: "exception", why: "detail page: Spaces and Projects in the sidebar" },
  { section: "project", reachedBy: "exception", why: "detail page: the Projects tree" },
  { section: "article", reachedBy: "exception", why: "detail page" },
  { section: "finding", reachedBy: "exception", why: "detail page" },
  { section: "history", reachedBy: "exception", why: "detail page: an item's Version history" },
  { section: "entity", reachedBy: "exception", why: "detail page: topics from items and the graph" },
  { section: "admin/users/:id", reachedBy: "exception", why: "detail page: People 'Access', PersonLink, Roles 'Who has it', 'Look someone up', the approval notice" },
  { section: "invite", reachedBy: "exception", why: "gate: invitation links" },
  { section: "dev/kit", reachedBy: "exception", why: "DEV builds only" },
  { section: "skills/import", reachedBy: "exception", why: "Skills › Import skills (Skills managers)" },
];

describe("nav.ts reachability", () => {
  it("reaches every route section for an Administrator, or lists it as an exception", () => {
    const sections = linkedSections(ctx(ADMIN));
    const missing = ROUTES.filter((r) => r.reachedBy !== "exception" && !sections.has(r.section)).map((r) => r.section);
    expect(missing).toEqual([]);
    for (const r of ROUTES.filter((x) => x.reachedBy === "exception")) expect(r.why, r.section).toBeTruthy();
  });

  it("reaches every everyday section for a member with no permissions", () => {
    const sections = linkedSections(ctx(member()));
    const missing = ROUTES.filter((r) => r.reachedBy === "nav" && !sections.has(r.section)).map((r) => r.section);
    expect(missing).toEqual([]);
  });

  it("offers Roles and access to everyone in the user menu, and in Admin only for Manage roles", () => {
    const plain = ctx(member());
    expect(visible(USER_MENU, plain).some((u) => u.href === "#/roles" && u.label === "Roles and access")).toBe(true);
    expect(visible(ADMIN_TABS, plain).some((t) => t.id === "roles")).toBe(false);
    const roleManager = ctx(member(["manage_roles"]));
    const tab = visible(ADMIN_TABS, roleManager).find((t) => t.id === "roles");
    expect(tab?.href).toBe("#/admin/roles");
    expect(tab?.label).toBe("Roles and access");
  });

  it("shows the Audit log tab to Administrators and Auditors only (Read every project and See usage)", () => {
    const tabFor = (c: ReturnType<typeof ctx>) => visible(ADMIN_TABS, c).find((t) => t.id === "audit");
    expect(tabFor(ctx(ADMIN))?.href).toBe("#/admin/audit");
    expect(tabFor(ctx(member(["read_all_projects", "view_metrics"])))?.label).toBe("Audit log");
    expect(tabFor(ctx(member(["read_all_projects"])))).toBeUndefined();
    expect(tabFor(ctx(member(["view_metrics"])))).toBeUndefined();
    expect(tabFor(ctx(member(["manage_users"])))).toBeUndefined();
    expect(can.seeAdmin(member(["read_all_projects", "view_metrics"]), [])).toBe(true);
    expect(navIdForRoute("admin/audit")).toBe("admin");
  });

  it("shows Admin › Notifications (team-wide Slack and Trello routes) to people who manage every project", () => {
    expect(visible(ADMIN_TABS, ctx(member())).some((t) => t.id === "notifications")).toBe(false);
    expect(visible(ADMIN_TABS, ctx(member(["manage_all_projects"]))).find((t) => t.id === "notifications")?.href).toBe("#/admin/notifications");
    expect(visible(ADMIN_TABS, ctx(ADMIN)).map((t) => t.id)).toContain("notifications");
  });

  it("sends #/admin to the first visible tab, or nowhere", () => {
    expect(firstAdminTab(ctx(ADMIN))?.href).toBe("#/admin/users");
    expect(firstAdminTab(ctx(member(["manage_roles"])))?.href).toBe("#/admin/roles");
    expect(firstAdminTab(ctx(member()))).toBeNull();
  });

  it("names the footer entry Manage projects when only Projects is visible", () => {
    const manager = ctx(member(), [TEAM_SPACE, project("orders", ["read", "manage_settings"])]);
    expect(adminEntry(manager)).toEqual({ label: "Manage projects", href: "#/admin/projects", icon: "folder" });
    expect(adminEntry(ctx(ADMIN))?.label).toBe("Admin");
    expect(adminEntry(ctx(member()))).toBeNull();
  });

  it("highlights the owning nav item for a route", () => {
    expect(navIdForRoute("")).toBe("home");
    expect(navIdForRoute("review/abc")).toBe("review");
    expect(navIdForRoute("sources")).toBe("inbox");
    expect(navIdForRoute("new/paste", new URLSearchParams("inbox=x"))).toBe("inbox");
    expect(navIdForRoute("new/paste")).toBeNull();
    expect(navIdForRoute("admin/roles")).toBe("admin");
    expect(navIdForRoute("roles")).toBeNull();
    expect(navIdForRoute("admin/users/u1", undefined, ctx(member(), [TEAM_SPACE]))).toBeNull();
    expect(navIdForRoute("admin/users/u1", undefined, ctx(ADMIN))).toBe("admin");
  });
});

describe("permission predicates (ADDENDUM-roles §1.3, §3.1)", () => {
  const creator: MeLike = { admin: false, permissions: ["create_projects"] };
  const nobody: MeLike = { admin: false, permissions: [] };
  const settingsScopes = [TEAM_SPACE, project("orders", ["read", "manage_settings"])];

  it("lets a non-admin Project creator create projects", () => {
    expect(can.createProject(creator)).toBe(true);
    expect(visible(CREATE_ACTIONS, ctx(member(["create_projects"]))).some((a) => a.id === "project")).toBe(true);
  });

  it("lets Manage settings in any project add a sub-project", () => {
    expect(can.createSubProject(nobody, settingsScopes)).toBe(true);
    expect(can.newProjectEntry(nobody, settingsScopes)).toBe(true);
    const actions = visible(CREATE_ACTIONS, ctx(member(), settingsScopes)).map((a) => a.id);
    expect(actions).toContain("sub-project");
    expect(actions).not.toContain("project");
  });

  it("hides New project from people with neither", () => {
    expect(can.createProject(nobody)).toBe(false);
    expect(can.createSubProject(nobody, [TEAM_SPACE, project("orders", ["read", "review"])])).toBe(false);
    const ids = visible(CREATE_ACTIONS, ctx(member(), [TEAM_SPACE, project("orders", ["read"])])).map((a) => a.id);
    expect(ids.filter((id) => id.startsWith("project") || id.startsWith("sub-project"))).toEqual([]);
  });

  it("offers New sub-project of the current project only with Manage settings there", () => {
    const orders = { ...project("orders", ["read", "manage_settings"]), name: "Order service v2" };
    const here = visible(CREATE_ACTIONS, ctx(member(), [orders], orders)).find((a) => a.id === "sub-project-here");
    expect(here?.label(ctx(member(), [orders], orders))).toBe("New sub-project of Order service v2");
    expect(here?.href(ctx(member(), [orders], orders))).toBe("#/new/project?parent=orders");
    const reviewerOnly = { ...project("orders", ["read", "review"], { can_manage: true }), name: "Order service v2" };
    expect(visible(CREATE_ACTIONS, ctx(member(), [reviewerOnly], reviewerOnly)).some((a) => a.id === "sub-project-here")).toBe(false);
  });

  it("shows Roles and access without Manage roles", () => {
    expect(visible(USER_MENU, ctx(member())).map((u) => u.id)).toContain("roles");
  });

  it("gives New team to Team managers", () => {
    expect(can.manageTeams({ admin: false, permissions: ["manage_teams"] })).toBe(true);
    expect(can.manageTeams(nobody)).toBe(false);
  });

  it("gives Delete permanently and Security everywhere to non-admins who hold them", () => {
    expect(can.purge({ admin: false, permissions: ["purge"] })).toBe(true);
    expect(can.purge(nobody)).toBe(false);
    expect(can.securityAdmin({ admin: false, permissions: ["security_admin"] })).toBe(true);
    expect(can.securityAdmin(nobody)).toBe(false);
  });

  it("keeps Administrator-only cases for Administrators", () => {
    expect(can.systemSettings({ admin: true })).toBe(true);
    expect(can.systemSettings({ admin: false, permissions: ["manage_users", "manage_roles"] })).toBe(false);
    expect(visible(USER_MENU, ctx(member(["manage_users"]))).map((u) => u.id)).not.toContain("system");
  });

  it("lets people who may see access open someone's access page", () => {
    expect(can.seeAccess({ admin: false, can_see_access: true })).toBe(true);
    expect(can.seeAccess({ admin: false, permissions: ["manage_users"] })).toBe(true);
    expect(can.seeAccess(nobody)).toBe(false);
  });

  it("reads effective_permissions when the server sends them", () => {
    const s = project("orders", ["read"], { my_permissions: ["read", "review"] });
    expect(can.inScope(s, "review", nobody)).toBe(false);
    expect(can.moveFrom(s, nobody)).toBe(false);
    expect(can.inScope(project("orders", ["read", "review"]), "review", nobody)).toBe(true);
  });

  it("falls back to admin or my_permissions on older servers", () => {
    const old = project("orders", undefined, { my_permissions: ["read", "review"] });
    expect(can.inScope(old, "review", nobody)).toBe(true);
    expect(can.inScope(old, "manage_settings", nobody)).toBe(false);
    expect(can.inScope(old, "manage_settings", { admin: true })).toBe(true);
  });

  it("splits settings and members management, falling back to can_manage", () => {
    expect(can.manageSettings(project("a", ["read"], { can_manage: true }))).toBe(true);
    expect(can.manageSettings(project("a", ["read"], { can_manage: true, can_manage_settings: false }))).toBe(false);
    expect(can.manageScope(project("a", ["read"], { can_manage: false, can_manage_members: true }))).toBe(true);
  });

  it("shows Admin to anyone with a visible tab", () => {
    expect(can.seeAdmin(nobody, [TEAM_SPACE])).toBe(false);
    expect(can.seeAdmin({ admin: false, permissions: ["manage_users"] }, [TEAM_SPACE])).toBe(true);
    expect(can.seeAdmin(nobody, settingsScopes)).toBe(true);
  });
});

describe("shell: locate-me defaults (SPEC §2.1, §2.7)", async () => {
  const { routeScope } = await import("../src/components/Layout");
  const q = (s: string) => new URLSearchParams(s);
  it("takes the project or space from the route until the page reports its own", () => {
    expect(routeScope({ path: ["project", "order-service"], query: q("tab=pages") })).toBe("order-service");
    expect(routeScope({ path: ["scope", "team", "settings"], query: q("") })).toBe("team");
    expect(routeScope({ path: ["new", "article"], query: q("scope=payments") })).toBe("payments");
    expect(routeScope({ path: ["new", "finding"], query: q("") })).toBeNull();
    expect(routeScope({ path: ["import"], query: q("scope=library") })).toBe("library");
    expect(routeScope({ path: ["new", "project"], query: q("parent=order-service") })).toBe("order-service");
    expect(routeScope({ path: ["article", "x"], query: q("") })).toBeNull();
  });
  it("highlights nothing on #/roles, and Admin only for people who see Admin on someone's access page", () => {
    expect(navIdForRoute("roles", q(""), ctx(member()))).toBeNull();
    expect(navIdForRoute("admin/users/abc", q(""), ctx(member()))).toBeNull();
    expect(navIdForRoute("admin/users/abc", q(""), ctx(ADMIN))).toBe("admin");
    expect(navIdForRoute("sources", q(""), ctx(member()))).toBe("inbox");
    expect(navIdForRoute("new/paste", q("inbox=i1"), ctx(member()))).toBe("inbox");
    expect(navIdForRoute("new/paste", q(""), ctx(member()))).toBeNull();
  });
  it("sends #/admin to the first tab the person may see, or nowhere", () => {
    expect(firstAdminTab(ctx(ADMIN))?.href).toBe("#/admin/users");
    expect(firstAdminTab(ctx(member(["manage_roles"])))?.href).toBe("#/admin/roles");
    expect(firstAdminTab(ctx(member()))).toBeNull();
  });
});

describe("shell: notifications (SPEC §6.1.4)", async () => {
  const { groupByDay, notificationTitle } = await import("../src/components/notifications");
  it("strips the leading Review: prefix", () => {
    expect(notificationTitle("Review: Orders API v1")).toBe("Orders API v1");
    expect(notificationTitle("Your proposal was approved")).toBe("Your proposal was approved");
  });
  it("groups into Today and Earlier, dropping empty groups", () => {
    const now = new Date(2026, 10, 6, 15, 0);
    const items = [
      { id: "a", created_at: new Date(2026, 10, 6, 9, 0).toISOString() },
      { id: "b", created_at: new Date(2026, 10, 5, 23, 0).toISOString() },
    ];
    expect(groupByDay(items, now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["a"]],
      ["Earlier", ["b"]],
    ]);
    expect(groupByDay([items[1]!], now).map((g) => g.label)).toEqual(["Earlier"]);
  });
});
