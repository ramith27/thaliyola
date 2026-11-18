/**
 * Navigation contracts (SPEC §2.1–§2.6, ADDENDUM-roles §1.2). The sidebar, phone tab bar and drawer, Create
 * menu and sheet, SearchOverlay "Go to" and "Create" groups, the user menu and AdminTabs all read these lists,
 * so reachability and gating are identical everywhere (tested in test/ui-nav.test.ts).
 *
 * Pure module: type-only imports plus the permission predicates. No React, no DOM.
 */
import type { IconName } from "./icons";
import { can, type MeLike, type ScopeLike } from "./permissions";

export type NavId = "home" | "review" | "inbox" | "sessions" | "security" | "graph" | "metrics" | "teams" | "skills" | "connect" | "whats-new" | "guide" | "trash" | "admin" | "account" | "search";

/** What a predicate may look at. `current` is the project or space the page belongs to (page meta), if any. */
export interface NavContext {
  me: MeLike & { auth_mode?: string; email?: string | null; role_names?: string[] };
  scopes: ScopeLike[];
  current?: (ScopeLike & { slug: string; name?: string }) | null;
}

export interface NavItem {
  id: NavId;
  label: string;
  icon: IconName;
  /** A hash href ("#/review"). */
  href: string;
  /** Extra words the search overlay matches ("rca", "token", "notion"). */
  keywords: string;
  show?: (ctx: NavContext) => boolean;
  count?: "review" | "inbox" | "sessions" | "security";
  /** Route prefixes (path without "#/", optionally with a query key) that highlight this item. */
  activeOn: string[];
}

export const PRIMARY_NAV: NavItem[] = [
  { id: "home", label: "Home", icon: "home", href: "#/", keywords: "home dashboard start", activeOn: [""] },
  { id: "review", label: "Review", icon: "review", href: "#/review", keywords: "review queue proposals approve reject", count: "review", activeOn: ["review"] },
  { id: "inbox", label: "Inbox", icon: "inbox", href: "#/inbox", keywords: "inbox feeds sources slack notion triage", count: "inbox", activeOn: ["inbox", "sources", "new/paste?inbox"] },
  { id: "sessions", label: "Sessions", icon: "chat", href: "#/sessions", keywords: "sessions ask claude agents questions answers listen teammates", count: "sessions", activeOn: ["sessions"] },
  { id: "security", label: "Security", icon: "shield", href: "#/security", keywords: "security vulnerabilities advisories cve dependencies", count: "security", activeOn: ["security"] },
];

export const EXPLORE_NAV: NavItem[] = [
  { id: "graph", label: "Knowledge graph", icon: "graph", href: "#/graph", keywords: "knowledge graph map relations topics", activeOn: ["graph"] },
  { id: "metrics", label: "Metrics", icon: "chart", href: "#/metrics", keywords: "metrics success reuse usage searches with no answer gaps", activeOn: ["metrics"] },
  { id: "teams", label: "Teams", icon: "team", href: "#/teams", keywords: "teams groups people members access", activeOn: ["teams"] },
  { id: "skills", label: "Skills", icon: "sparkle", href: "#/skills", keywords: "skills claude skill.md plugins add to my claude sync", activeOn: ["skills"] },
];

/** The sidebar footer. The Admin entry reads "Manage projects" when only the Projects tab is visible (§2.6). */
export const FOOTER_NAV: NavItem[] = [
  { id: "connect", label: "Connect Claude", icon: "plug", href: "#/connect", keywords: "connect claude connector mcp token setup tools", activeOn: ["connect"] },
  {
    id: "whats-new",
    label: "What's new",
    icon: "sparkle",
    href: "#/whats-new",
    keywords: "what's new whats new release notes releases changelog features catalog version how to",
    activeOn: ["whats-new"],
  },
  { id: "guide", label: "Guide", icon: "book", href: "#/guide", keywords: "guide help how to use features commands slash commands prompts tools cli enable settings", activeOn: ["guide"] },
  { id: "trash", label: "Trash", icon: "trash", href: "#/trash", keywords: "trash deleted restore", activeOn: ["trash"] },
  {
    id: "admin",
    label: "Admin",
    icon: "settings",
    href: "#/admin",
    keywords: "admin administration people roles projects notifications slack trello system settings",
    show: (ctx) => can.seeAdmin(ctx.me, ctx.scopes),
    activeOn: ["admin"],
  },
];

/** All sidebar items in order (top, Explore, footer). */
export const NAV: NavItem[] = [...PRIMARY_NAV, ...EXPLORE_NAV, ...FOOTER_NAV];

export const visible = <T extends { show?: (ctx: NavContext) => boolean }>(items: T[], ctx: NavContext): T[] => items.filter((i) => !i.show || i.show(ctx));

// ---- Admin -----------------------------------------------------------------------------------

export type AdminTabId = "people" | "service-accounts" | "roles" | "projects" | "notifications" | "audit" | "system";

export interface AdminTab {
  id: AdminTabId;
  label: string;
  icon: IconName;
  href: string;
  show: (ctx: NavContext) => boolean;
}

export const ADMIN_TABS: AdminTab[] = [
  { id: "people", label: "People", icon: "user-plus", href: "#/admin/users", show: (ctx) => can.manageUsers(ctx.me) },
  { id: "service-accounts", label: "Service accounts", icon: "key", href: "#/admin/service-accounts", show: (ctx) => can.manageUsers(ctx.me) },
  { id: "roles", label: "Roles and access", icon: "shield", href: "#/admin/roles", show: (ctx) => can.manageRoles(ctx.me) },
  { id: "projects", label: "Projects", icon: "folder", href: "#/admin/projects", show: (ctx) => can.manageProjectsList(ctx.me, ctx.scopes) },
  { id: "notifications", label: "Notifications", icon: "bell", href: "#/admin/notifications", show: (ctx) => can.teamNotifications(ctx.me) },
  { id: "audit", label: "Audit log", icon: "history", href: "#/admin/audit", show: (ctx) => can.seeAuditLog(ctx.me) },
  { id: "system", label: "System", icon: "settings", href: "#/admin/system", show: (ctx) => can.systemSettings(ctx.me) },
];

/** Where `#/admin` sends this person: the first tab they may see, or null (NotFound). */
export function firstAdminTab(ctx: NavContext): AdminTab | null {
  return ADMIN_TABS.find((t) => t.show(ctx)) ?? null;
}

/** The sidebar footer Admin entry: "Admin" (→ #/admin), "Manage projects" (→ #/admin/projects) when only Projects is visible, or null. */
export function adminEntry(ctx: NavContext): { label: string; href: string; icon: IconName } | null {
  const tabs = ADMIN_TABS.filter((t) => t.show(ctx));
  if (!tabs.length) return null;
  if (tabs.length === 1 && tabs[0]!.id === "projects") return { label: "Manage projects", href: "#/admin/projects", icon: "folder" };
  return { label: "Admin", href: "#/admin", icon: "settings" };
}

// ---- Create ----------------------------------------------------------------------------------

export interface CreateAction {
  id: "article" | "finding" | "paste" | "import" | "skill" | "project" | "sub-project" | "sub-project-here";
  label: (ctx: NavContext) => string;
  hint: (ctx: NavContext) => string;
  icon: IconName;
  href: (ctx: NavContext) => string;
  keywords: string;
  show?: (ctx: NavContext) => boolean;
}

const withScope = (path: string, ctx: NavContext) => (ctx.current?.slug ? `${path}?scope=${encodeURIComponent(ctx.current.slug)}` : path);
const currentName = (ctx: NavContext) => ctx.current?.name || ctx.current?.slug || "this project";
const canSubHere = (ctx: NavContext) => !!ctx.current && ctx.current.kind === "project" && can.inScope(ctx.current, "manage_settings", ctx.me);

/** One list for the sidebar New menu, the phone + sheet, the overlay Create group, Home/space/project SplitButtons and `c`. */
export const CREATE_ACTIONS: CreateAction[] = [
  {
    id: "article",
    label: () => "New article",
    hint: () => "A system, runbook, decision, design or contract",
    icon: "doc",
    href: (ctx) => withScope("#/new/article", ctx),
    keywords: "new article create write doc runbook decision design contract",
  },
  {
    id: "finding",
    label: () => "New finding",
    hint: () => "Something that happened: incident, root cause, known issue",
    icon: "bolt",
    href: (ctx) => withScope("#/new/finding", ctx),
    keywords: "new finding incident rca root cause known issue gotcha",
  },
  {
    id: "paste",
    label: () => "Draft from pasted text",
    hint: () => "Turn a Slack thread, email or notes into a draft",
    icon: "clipboard",
    href: () => "#/new/paste",
    keywords: "paste slack thread email notes draft",
  },
  {
    id: "import",
    label: () => "Import documents",
    hint: () => "Markdown, HTML, Notion or Confluence exports",
    icon: "upload",
    href: (ctx) => withScope("#/import", ctx),
    keywords: "import markdown html notion confluence google docs zip upload",
  },
  {
    // Skills managers and Administrators; Project admins for their projects' own skills. Opens the New skill dialog.
    id: "skill",
    label: () => "New skill",
    hint: () => "A Claude skill for your team, reviewed before anyone gets it",
    icon: "sparkle",
    href: () => "#/skills?new=1",
    keywords: "new skill claude skill.md write create instructions",
    show: (ctx) => can.createSkills(ctx.me, ctx.scopes),
  },
  {
    id: "project",
    label: () => "New project",
    hint: () => "With its repositories and a starter pack",
    icon: "folder-plus",
    href: () => "#/new/project",
    keywords: "new project create repository repo",
    show: (ctx) => can.createProject(ctx.me),
  },
  {
    // People without Create projects who have Manage settings somewhere: NewProjectPage offers only their projects as parents.
    id: "sub-project",
    label: () => "New sub-project",
    hint: () => "Part of a project you manage, with its own members",
    icon: "folder-plus",
    href: () => "#/new/project",
    keywords: "new sub-project create project service app",
    show: (ctx) => !can.createProject(ctx.me) && can.createSubProject(ctx.me, ctx.scopes) && !canSubHere(ctx),
  },
  {
    id: "sub-project-here",
    label: (ctx) => `New sub-project of ${currentName(ctx)}`,
    hint: (ctx) => `Part of ${currentName(ctx)}, with its own members`,
    icon: "folder-plus",
    href: (ctx) => `#/new/project?parent=${encodeURIComponent(ctx.current?.slug ?? "")}`,
    keywords: "new sub-project create project service app",
    show: canSubHere,
  },
];

/** The muted line in the Create menu when the page belongs to a project or space: "Adds to Order service v2". */
export const createContextLine = (ctx: NavContext) => (ctx.current ? `Adds to ${currentName(ctx)}` : null);

// ---- User menu -------------------------------------------------------------------------------

export type UserMenuSection = "you" | "workspace" | "preferences" | "session";

export interface UserMenuItem {
  id: string;
  section: UserMenuSection;
  label: string;
  icon: IconName;
  href?: string;
  /** Handled by the shell: the theme control, the shortcut sheet, sign out. */
  action?: "theme" | "shortcuts" | "signout";
  show?: (ctx: NavContext) => boolean;
}

export const USER_MENU: UserMenuItem[] = [
  { id: "account", section: "you", label: "Account and tokens", icon: "user", href: "#/account" },
  { id: "connect", section: "you", label: "Connect Claude", icon: "plug", href: "#/connect" },
  { id: "teams", section: "you", label: "Teams", icon: "team", href: "#/teams" },
  { id: "trash", section: "workspace", label: "Trash", icon: "trash", href: "#/trash" },
  // Everyone: what each role allows and who has it (ADDENDUM-roles §1.2). Replaces the manage_roles-gated "Roles".
  { id: "roles", section: "workspace", label: "Roles and access", icon: "shield", href: "#/roles" },
  { id: "people", section: "workspace", label: "People", icon: "user-plus", href: "#/admin/users", show: (ctx) => can.manageUsers(ctx.me) },
  { id: "projects", section: "workspace", label: "Projects", icon: "folder", href: "#/admin/projects", show: (ctx) => can.manageProjectsList(ctx.me, ctx.scopes) },
  { id: "system", section: "workspace", label: "System settings", icon: "settings", href: "#/admin/system", show: (ctx) => can.systemSettings(ctx.me) },
  { id: "theme", section: "preferences", label: "Theme", icon: "monitor", action: "theme" },
  { id: "shortcuts", section: "preferences", label: "Keyboard shortcuts", icon: "keyboard", action: "shortcuts" },
  { id: "signout", section: "session", label: "Sign out", icon: "logout", action: "signout", show: (ctx) => ctx.me.auth_mode === "local" },
];

// ---- Search overlay "Go to" ------------------------------------------------------------------

export interface GoToItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  keywords: string;
  show?: (ctx: NavContext) => boolean;
}

/** Every destination the overlay offers before typing, each behind the same check as its other entry points. */
export const GO_TO: GoToItem[] = [
  ...NAV.filter((n) => n.id !== "admin" && n.id !== "connect" && n.id !== "trash" && n.id !== "whats-new" && n.id !== "guide").map(({ id, label, icon, href, keywords, show }) => ({ id, label, icon, href, keywords, show })),
  { id: "sources", label: "Sources", icon: "rss", href: "#/sources", keywords: "sources feeds rss watched pages slack notion web search" },
  { id: "trash", label: "Trash", icon: "trash", href: "#/trash", keywords: "trash deleted restore" },
  { id: "connect", label: "Connect Claude", icon: "plug", href: "#/connect", keywords: "connect claude connector mcp token setup tools" },
  {
    id: "whats-new",
    label: "What's new and features",
    icon: "sparkle",
    href: "#/whats-new",
    keywords: "what's new whats new release notes releases changelog features catalog version how to",
  },
  { id: "guide", label: "Guide: features and commands", icon: "book", href: "#/guide", keywords: "guide help how to use features commands slash commands prompts tools cli enable settings listen busy ask design" },
  { id: "account", label: "Account and tokens", icon: "user", href: "#/account", keywords: "account tokens password notifications my access my roles your access" },
  {
    id: "roles",
    label: "Roles and access",
    icon: "shield",
    href: "#/roles",
    keywords: "roles permissions access who can organisation roles project admin",
  },
  ...ADMIN_TABS.map((t) => ({
    id: `admin-${t.id}`,
    label: `Admin: ${t.label}`,
    icon: t.icon,
    href: t.href,
    keywords: `admin ${t.label.toLowerCase()}${t.id === "people" ? " users approve disable" : t.id === "audit" ? " who changed history activity log csv" : ""}`,
    show: t.show,
  })),
];

// ---- Route → highlight -----------------------------------------------------------------------

/**
 * The sidebar item a route highlights by default (pages may override it through page meta).
 * `path` is the hash path without "#/" ("review/abc"), `query` its search params.
 */
export function navIdForRoute(path: string, query: URLSearchParams = new URLSearchParams(), ctx?: NavContext): NavId | null {
  const first = path.split("/")[0] ?? "";
  // Someone's access page: Admin for people who see Admin, nothing for everyone else (ADDENDUM-roles §1.1).
  if (/^admin\/users\/[^/]+/.test(path) && ctx && !can.seeAdmin(ctx.me, ctx.scopes)) return null;
  if (first === "") return "home";
  if (first === "new" && path.startsWith("new/paste")) return query.get("inbox") ? "inbox" : null;
  if (first === "account") return "account";
  if (first === "search") return "search";
  if (first === "roles") return null;
  for (const item of NAV) {
    if (item.activeOn.some((a) => a !== "" && !a.includes("?") && (first === a || path === a || path.startsWith(`${a}/`)))) return item.id;
  }
  return null;
}
