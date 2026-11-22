/** Thin client for the Thaliyola REST API. */

const TOKEN_KEY = "thaliyola.devToken";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Behind Cloudflare Access the browser is authenticated by Access itself; the token is for dev mode.
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const issues = body?.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(res.status, issues ? `${body.error}: ${issues}` : (body?.error ?? res.statusText), body);
  }
  return body as T;
}

// ---- Shapes returned by the API (only the fields the UI uses) ----------------

export interface Me {
  /** The public demo: when everything is wiped and re-seeded next. */
  demo?: { resets_at: string; reset_hours: number };
  id: string;
  email: string | null;
  /** Display name (Account page, set_my_name, Manage people, or the company sign-in); null when not set. */
  name?: string | null;
  kind: string;
  admin: boolean;
  /** Organisation permissions (Administrators: all) and the organisation roles granting them ("admin" first for Administrators). */
  permissions?: string[];
  roles?: string[];
  role_names?: string[];
  /** Why they're an Administrator: their account, or ADMIN_EMAILS on the server (which can't be changed here). */
  administrator_source?: "account" | "ADMIN_EMAILS" | null;
  /** May see anyone's access (Manage people, Manage roles, Read every project or Manage every project). */
  can_see_access?: boolean;
  local_account: boolean;
  must_change_password: boolean;
  auth_mode: "local" | "cloudflare" | "dev";
  /** Who can read a new project unless its creator chooses (DEFAULT_PROJECT_VISIBILITY). */
  default_project_visibility: "members" | "team";
  /** Thaliyola's version, the commit it was built from and when (older servers: absent). */
  build?: BuildInfo;
  /** The newest published release against the last one this person saw (the What's new dot). */
  whats_new?: WhatsNewStatus;
  /** Skills for Claude: the organisation's mode (Admin › System), the person's own preference, and what it means for them. */
  skills?: { delivery: "on" | "off" | "admins"; send_to_claude: boolean; state: SkillDeliveryState };
}

export interface BuildInfo {
  version: string;
  commit: string | null;
  built_at: string | null;
}

export interface WhatsNewStatus {
  latest: { version: string; title: string; features: number } | null;
  last_seen: string | null;
  unseen: boolean;
}

/** What skill delivery means for one person: on, switched off, Administrators-only pilot, or they opted out. */
export type SkillDeliveryState = "on" | "off" | "admins_only" | "opted_out";

/** Auth endpoints live outside /api. */
export async function authApi<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data as T;
}

export interface RepoFacts {
  provider: "github" | "gitlab";
  default_branch: string | null;
  last_commit: { sha: string; message: string; author: string | null; at: string | null } | null;
  open_prs: number | null;
  archived?: boolean;
  visibility?: string | null;
  error?: string | null;
  synced_at: string | null;
}

export interface ScopeInfo {
  id: string;
  kind: "team" | "project" | "library" | "personal";
  slug: string;
  name: string;
  description: string;
  visibility: "team" | "members";
  /** "active", or "archived" for an archived project (the list leaves out deleted ones). */
  status?: string;
  /** The project this one sits under, if any. */
  parent?: string | null;
  components: {
    slug: string;
    kind: string;
    repo_url: string | null;
    description?: string;
    /** What the project's git connection last read about the repository. */
    git?: RepoFacts | null;
  }[];
  /** @deprecated use effective_permissions */
  my_role: string | null;
  /** The caller's roles here (position order), their names, and the permissions those roles give. */
  my_roles?: string[];
  my_role_names?: string[];
  my_permissions?: string[];
  /** What the caller can actually do here, computed by the server with the rules it enforces. */
  effective_permissions?: string[];
  can_manage: boolean;
  can_manage_members?: boolean;
  can_manage_settings?: boolean;
}

/** An organisation permission the caller holds (Administrators hold them all). */
export const may = (me: Me, permission: string) => me.admin || !!me.permissions?.includes(permission);

/** A project permission the caller can use in this scope (falls back to role permissions on older servers). */
export const canIn = (scope: ScopeInfo | undefined, permission: string, me?: Me) =>
  !!scope && (scope.effective_permissions ? scope.effective_permissions.includes(permission) : !!me?.admin || !!scope.my_permissions?.includes(permission));

// ---- Access (roles, people, teams) --------------------------------------------------

export type AccountStatus = "active" | "not_signed_in" | "waiting_for_approval" | "disabled";

export const ACCOUNT_STATUS_TEXT: Record<AccountStatus, string> = {
  active: "active",
  not_signed_in: "hasn't signed in yet",
  waiting_for_approval: "waiting for approval",
  disabled: "disabled",
};

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
    roles: { key: string; name: string; via: "direct" | "team" | "inherited"; team: { slug: string; name: string } | null; from: { slug: string; name: string } | null }[];
    permissions: string[];
  }[];
  other_projects: number;
}

export interface MemberChange {
  scope: string;
  project_name: string;
  email: string;
  /** Their display name, if they have one. */
  name?: string | null;
  roles: string[];
  role_names: string[];
  before: string[];
  added: string[];
  removed: string[];
  /** The same roles by display name. */
  before_names?: string[];
  added_names?: string[];
  removed_names?: string[];
  account: AccountStatus;
  needs_approval: boolean;
  still_has_access_via: { team: { slug: string; name: string } | null; from: { slug: string; name: string } | null; roles: string[]; role_names: string[] }[];
  note: string | null;
}

export interface TeamChange {
  scope: string;
  project_name: string;
  team: string;
  team_name: string;
  roles: string[];
  role_names: string[];
  before: string[];
  added: string[];
  removed: string[];
  before_names?: string[];
  added_names?: string[];
  removed_names?: string[];
}

export interface TeamMemberChange {
  team: string;
  email: string;
  member: boolean;
  role: "member" | "lead" | null;
  before_role: "member" | "lead" | null;
  account: AccountStatus;
  note: string | null;
}

export interface ProjectsWithoutAdmin {
  projects_without_admin?: { slug: string; name: string }[];
  other_projects_without_admin?: number;
}

export interface Related {
  relation: string;
  direction: "in" | "out";
  kind: string;
  id: string;
  label: string;
  type: string | null;
  status: string | null;
  scope: string | null;
}

export interface SourceLink {
  system: string;
  url: string;
  label: string;
  /** A Jira or Linear issue's cached title and status (see Ticket). */
  ticket?: { key: string; title: string | null; status: string | null; category: TicketCategory; checked_at: string | null };
}

/** Where a linked issue stands, in one vocabulary for Jira and Linear. */
export type TicketCategory = "todo" | "in_progress" | "done" | "canceled" | "unknown";

/** A Jira or Linear issue linked to a finding or article (GET /items/:id/tickets). */
export interface Ticket {
  /** The source link's id. */
  id: string;
  tracker: "jira" | "linear";
  label: string;
  key: string;
  url: string;
  title: string | null;
  status: string | null;
  category: TicketCategory;
  checked_at: string | null;
  error: string | null;
  /** Whether a tracker connection reads this issue's status. */
  connected: boolean;
  /** That connection, when the viewer can read the project it belongs to. */
  connection: { id: string; name: string | null } | null;
}

/** A tracker connection someone may open tickets with, from the item's project, a project above it, or the Team space. */
export interface TrackerOption {
  id: string;
  name: string;
  kind: "jira" | "linear";
  label: string;
  /** Null for a project above that the viewer can't read (scope_name then says "a project above"). */
  scope: string | null;
  scope_name: string;
  health: "untested" | "ok" | "failing";
  /** Where new issues go: the Jira project key or the Linear team key. */
  destination: string | null;
  site: string | null;
}

export interface ItemTickets {
  item_id: string;
  tickets: Ticket[];
  can_link: boolean;
  can_create: boolean;
  trackers: TrackerOption[];
  create_blocked: string | null;
}

export interface AssetInfo {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  alt_text: string;
}

/** Fetches a raw asset with the same credentials as API calls (dev tokens can't ride on <img> requests). */
export async function fetchAssetBlob(id: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api/assets/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `could not load file (${res.status})`, null);
  return res.blob();
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface Article {
  /** When it should be looked at again (decisions get one when created). */
  review_due?: string | null;
  id: string;
  title: string;
  type: string;
  status: string;
  scope: { slug: string; kind: string };
  path: string;
  owner: string | null;
  /** The owner's display name, if they have one. */
  owner_name?: string | null;
  tags: string[];
  components: string[];
  version: number;
  last_verified_at: string | null;
  updated_at: string;
  sections: string[];
  body_md: string;
  related: Related[];
  source_links: SourceLink[];
  entities: { kind: string; name: string }[];
  assets: AssetInfo[];
  /** Table articles written by a database sync: the table in the project's Data view. */
  synced_table?: { id: string; key: string; connection: string; project: string } | null;
}

export interface Finding {
  id: string;
  title: string;
  type: string;
  status: string;
  scope: { slug: string; kind: string };
  symptoms: string;
  root_cause: string;
  fix: string;
  tags: string[];
  components: string[];
  author: string | null;
  author_name?: string | null;
  version: number;
  last_verified_at: string | null;
  updated_at: string;
  related: Related[];
  source_links: SourceLink[];
  entities: { kind: string; name: string }[];
  assets: AssetInfo[];
  history: { op: string; state: string; reason: string | null; created_at: string; author: string; author_name?: string | null }[];
}

export interface SearchHit {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  status: string;
  section: string | null;
  snippet: string;
  scope: { slug: string; kind: string };
  via_uses_link: boolean;
  match?: "keyword" | "semantic" | "keyword+semantic";
  score: number;
  warning?: string;
}

export interface Folder {
  folders: Record<string, Folder>;
  articles: { id: string; title: string; type: string; status: string }[];
}

export interface RevisionSummary {
  id: string;
  op: string;
  state: string;
  summary: string;
  redactions: { kind: string; count: number }[];
  created_at: string;
  target_kind: "article" | "finding";
  target_id: string;
  target_title: string;
  target_type: string;
  scope: string;
  /** Email (or identifier) of the author; author_name is their display name, if they have one. */
  author: string;
  author_name?: string | null;
  reviewer: string | null;
  reviewer_name?: string | null;
  /** Decided through Claude ("mcp") or with an API token ("token"); null in the web app. */
  decided_via?: string | null;
  created_via?: string | null;
  reason: string | null;
  assignee_id: string | null;
  /** The assignee's name, else their email. */
  assignee: string | null;
  assignee_email?: string | null;
  assignee_name?: string | null;
  comments: number;
  scope_name?: string;
  scope_kind?: string;
  author_kind?: "human" | "service";
  /** The caller may approve or reject it. */
  can_review?: boolean;
  /** The entry changed after this was proposed; approving it would conflict. */
  outdated?: boolean;
}

export interface Notice {
  id: string;
  summary: string;
  source_id: string;
  source_title: string;
  source_scope: string;
  source_version: number;
  component: string | null;
  created_at: string;
}

/** Result of a create/edit from the UI: published directly, or queued for review. */
export interface WriteResult {
  status: string;
  published?: boolean;
  revision_id?: string;
  article_id?: string;
  finding_id?: string;
  duplicates?: { id: string; title: string; status: string; scope: string; overlap: number }[];
  missing_template_sections?: string[];
  redactions?: { kind: string; count: number }[];
}
