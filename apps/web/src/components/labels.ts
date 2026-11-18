/**
 * UI labels for server keys (SPEC §1.3, §1.4; ADDENDUM-roles §4). Every label shown for a type, status,
 * category, kind or role key comes from here. Unknown keys fall back to `humanize(key)`.
 *
 * Pure module: type-only imports, no React and no DOM, so tests can import it.
 */
import type { IconName } from "./icons";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** "possibly_stale" → "Possibly stale". Underscores and dashes become spaces; the first letter is capitalised. */
export function humanize(key: string | null | undefined): string {
  const s = String(key ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** plural(1, "proposal") → "1 proposal"; plural(3, "proposal") → "3 proposals"; plural(2, "person", "people"). */
export function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

// ---- Types -----------------------------------------------------------------------------------

export interface TypeLabel {
  label: string;
  description: string;
  kind: "article" | "finding";
}

export const ARTICLE_TYPES = [
  "system", "table", "metric", "runbook", "decision", "project_overview", "design_doc", "tech_spec",
  "api_contract", "pattern", "design_tokens", "ui_component", "ux_pattern", "screen_spec", "note",
] as const;
export const FINDING_TYPES = ["incident", "rca", "known_issue", "data_gotcha", "query_recipe"] as const;

export const TYPE_LABELS: Record<string, TypeLabel> = {
  system: { label: "System", description: "How a system works: parts, owners, dependencies", kind: "article" },
  table: { label: "Data table", description: "What a table holds and how to query it", kind: "article" },
  metric: { label: "Metric", description: "A metric's definition and how it's calculated", kind: "article" },
  runbook: { label: "Runbook", description: "Steps to follow when something happens", kind: "article" },
  decision: { label: "Decision", description: "What was decided, why, and what else was considered", kind: "article" },
  project_overview: { label: "Project overview", description: "What the project is, its goals and parts", kind: "article" },
  design_doc: { label: "Design doc", description: "A proposed design: context, goals, approach", kind: "article" },
  tech_spec: { label: "Technical spec", description: "How something will be built", kind: "article" },
  api_contract: { label: "API contract", description: "An API others depend on: endpoints, versions", kind: "article" },
  pattern: { label: "Pattern", description: "A reusable approach to a common problem", kind: "article" },
  design_tokens: { label: "Design tokens", description: "Colours, spacing and type for a design system", kind: "article" },
  ui_component: { label: "UI component", description: "A reusable interface component", kind: "article" },
  ux_pattern: { label: "UX pattern", description: "A reusable interaction pattern", kind: "article" },
  screen_spec: { label: "Screen spec", description: "What a screen shows and how it behaves", kind: "article" },
  note: { label: "Note", description: "Anything else worth keeping", kind: "article" },
  incident: { label: "Incident", description: "Something broke: what happened and its impact", kind: "finding" },
  rca: { label: "Root cause analysis", description: "Why something happened and how it was fixed", kind: "finding" },
  known_issue: { label: "Known issue", description: "A problem that still exists, with a workaround", kind: "finding" },
  data_gotcha: { label: "Data gotcha", description: "A surprise in the data that trips people up", kind: "finding" },
  query_recipe: { label: "Query recipe", description: "A query that answers a common question", kind: "finding" },
};

/** "rca" → "Root cause analysis"; unknown types are humanized. */
export function typeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return TYPE_LABELS[type]?.label ?? humanize(type);
}

/**
 * The server builds new proposals' summaries with the type's label ("New root cause analysis: …"); older rows carry
 * the raw key ("New rca: Webhook retries…"). Swap a leading "New <key>:" for the label, keeping acronyms ("API contract").
 */
export function summaryText(text: string): string {
  return text.replace(/^(New|Edit|Retire) ([a-z][a-z_]*):/, (whole, verb: string, key: string) => {
    const label = TYPE_LABELS[key]?.label;
    if (!label) return whole;
    return `${verb} ${/^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`}:`;
  });
}

/** Emails inside server-built sentences ("wes@example.com proposed…") read as display names ("wes proposed…"). */
export function peopleText(text: string): string {
  return text.replace(/\b([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "$1");
}

export function typeDescription(type: string | null | undefined): string | undefined {
  return type ? TYPE_LABELS[type]?.description : undefined;
}

// ---- Status ----------------------------------------------------------------------------------

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon?: IconName;
  /** Drawn as an outline badge instead of a soft fill. */
  outline?: boolean;
  /** Shows a spinner instead of an icon (running jobs). */
  spinner?: boolean;
  /** Not shown in lists (the default state, e.g. published items). */
  hiddenInLists?: boolean;
}

export type StatusDomain =
  | "item" | "proposal" | "vulnerability" | "advisory" | "inbox" | "source" | "run" | "invite" | "token" | "user" | "member" | "visibility" | "connection" | "schema_change" | "ticket";

export const STATUS: Record<StatusDomain, Record<string, StatusMeta>> = {
  item: {
    published: { label: "Published", tone: "success", icon: "check", hiddenInLists: true },
    possibly_stale: { label: "Needs a check", tone: "warning", icon: "clock" },
    draft: { label: "Draft", tone: "neutral", icon: "pencil" },
    superseded: { label: "Replaced", tone: "neutral", icon: "arrow" },
    rejected: { label: "Rejected", tone: "danger", icon: "x" },
    deleted: { label: "In trash", tone: "neutral", icon: "trash" },
  },
  proposal: {
    pending: { label: "Waiting for review", tone: "warning", icon: "clock" },
    approved: { label: "Approved", tone: "success", icon: "check" },
    rejected: { label: "Rejected", tone: "danger", icon: "x" },
    outdated: { label: "Outdated", tone: "warning", icon: "alert" },
    redacted: { label: "Secrets removed", tone: "neutral", icon: "eye-off" },
    reviewer_edited: { label: "Edited by reviewer", tone: "neutral", icon: "pencil" },
  },
  vulnerability: {
    open: { label: "Open", tone: "danger", outline: true },
    acknowledged: { label: "Being fixed", tone: "accent" },
    fixed: { label: "Fixed", tone: "success" },
    accepted: { label: "Risk accepted", tone: "neutral" },
    false_positive: { label: "Not a real issue", tone: "neutral" },
  },
  advisory: {
    investigating: { label: "Investigating", tone: "warning" },
    affected: { label: "Affected", tone: "danger" },
    not_affected: { label: "Not affected", tone: "success" },
    patched: { label: "Patched", tone: "success" },
    none: { label: "No response yet", tone: "neutral", outline: true },
  },
  inbox: {
    new: { label: "New", tone: "accent" },
    filed: { label: "Filed", tone: "success" },
    dismissed: { label: "Dismissed", tone: "neutral" },
    updated: { label: "Changed since first seen", tone: "accent" },
  },
  source: {
    ok: { label: "Working", tone: "success" },
    paused: { label: "Paused", tone: "neutral", icon: "pause" },
    failing: { label: "Failing", tone: "danger" },
    never: { label: "Not checked yet", tone: "neutral" },
  },
  run: {
    running: { label: "Running", tone: "accent", spinner: true },
    done: { label: "Done", tone: "success" },
    noop: { label: "Up to date", tone: "success", outline: true },
    failed: { label: "Failed", tone: "danger" },
  },
  invite: {
    open: { label: "Pending", tone: "accent" },
    accepted: { label: "Accepted", tone: "success" },
    revoked: { label: "Revoked", tone: "neutral" },
    expired: { label: "Expired", tone: "neutral" },
  },
  token: {
    active: { label: "Active", tone: "success" },
    expiring: { label: "Expires soon", tone: "warning" },
    expired: { label: "Expired", tone: "neutral" },
    revoked: { label: "Revoked", tone: "neutral" },
    // Rotated: replaced by a new token, still working until its grace period ends.
    replaced: { label: "Replaced", tone: "neutral", icon: "refresh" },
    unused: { label: "Unused 90+ days", tone: "warning", icon: "clock", outline: true },
  },
  user: {
    active: { label: "Active", tone: "success" },
    disabled: { label: "Disabled", tone: "neutral" },
    pending: { label: "Hasn't signed in", tone: "neutral" },
    must_change_password: { label: "Temporary password", tone: "warning" },
    // The server's AccountStatus keys (ADDENDUM-roles §4.2).
    not_signed_in: { label: "Hasn't signed in yet", tone: "neutral" },
    waiting_for_approval: { label: "Waiting for approval", tone: "warning", icon: "clock" },
  },
  member: {
    lead: { label: "Lead", tone: "accent" },
    member: { label: "Member", tone: "neutral" },
    builtin: { label: "Built-in", tone: "neutral", outline: true, icon: "lock" },
    custom: { label: "Custom", tone: "neutral" },
  },
  visibility: {
    members: { label: "Members only", tone: "neutral", icon: "lock" },
    team: { label: "Everyone", tone: "neutral", icon: "globe" },
  },
  connection: {
    ok: { label: "Working", tone: "success" },
    failing: { label: "Failing", tone: "danger" },
    untested: { label: "Not tested yet", tone: "neutral", outline: true },
    paused: { label: "Paused", tone: "neutral", icon: "pause" },
  },
  // A synced table's history (Data view).
  schema_change: {
    added: { label: "New", tone: "success" },
    removed: { label: "Removed", tone: "danger" },
    column_added: { label: "Column added", tone: "accent" },
    column_removed: { label: "Column removed", tone: "danger" },
    type_changed: { label: "Type changed", tone: "warning" },
    // An API endpoint's parameters, body or responses changed.
    changed: { label: "Changed", tone: "warning" },
  },
  // A linked Jira or Linear issue, by where it stands (the badge shows the tracker's own status name).
  ticket: {
    todo: { label: "To do", tone: "neutral" },
    in_progress: { label: "In progress", tone: "accent" },
    done: { label: "Done", tone: "success", icon: "check" },
    canceled: { label: "Canceled", tone: "neutral", icon: "x" },
    unknown: { label: "Status unknown", tone: "neutral", outline: true },
  },
};

/** The label, tone and icon for a status value. Unknown values are humanized and neutral. */
export function statusMeta(domain: StatusDomain, value: string | null | undefined): StatusMeta {
  const v = value ?? "";
  return STATUS[domain]?.[v] ?? { label: humanize(v), tone: "neutral" };
}

/** Legacy StatusBadge({ status }): item statuses first, then proposal states. */
export function guessStatusDomain(value: string): StatusDomain {
  if (value in STATUS.item) return "item";
  if (value in STATUS.proposal) return "proposal";
  return "item";
}

// ---- Review categories and operations ---------------------------------------------------------

export type Category = "new" | "edit" | "move" | "share" | "retire";

export const CATEGORY: Record<Category, { label: string; hint: string; tone: Tone; icon: IconName }> = {
  new: { label: "New", hint: "New articles and findings", tone: "success", icon: "plus" },
  edit: { label: "Edits", hint: "Changes to existing items, and findings added to articles", tone: "accent", icon: "pencil" },
  move: { label: "Moves", hint: "Items moved to another project, folder or repository", tone: "neutral", icon: "move" },
  share: { label: "Library shares", hint: "Items offered to the Library", tone: "accent", icon: "library" },
  retire: { label: "Marked outdated", hint: "Items someone says are no longer true", tone: "danger", icon: "alert" },
};

export const OP_LABELS: Record<string, string> = {
  create: "New",
  update: "Edit",
  promote: "Added to article",
  move: "Move",
  share: "Library share",
  verify: "Marked outdated",
};

export const opLabel = (op: string | null | undefined) => (op ? (OP_LABELS[op] ?? humanize(op)) : "");

// ---- Kinds ---------------------------------------------------------------------------------------

export const SCOPE_KIND: Record<string, string> = {
  team: "Team space",
  library: "Library",
  personal: "Personal space",
  project: "Project",
};

/** Icons per scope kind (SPEC §3.10: building, library, user, folder). */
export const SCOPE_ICON: Record<string, IconName> = { team: "building", library: "library", personal: "user", project: "folder" };

export const ENTITY_KIND: Record<string, string> = {
  service: "Service",
  system: "System",
  metric: "Metric",
  table: "Data table",
  team: "Team",
  advertiser: "Advertiser",
  publisher: "Publisher",
  offer: "Offer",
  other: "Other",
};

export const entityKindLabel = (kind: string | null | undefined) => (kind ? (ENTITY_KIND[kind] ?? humanize(kind)) : "");

export const LINK_SYSTEM: Record<string, string> = {
  figma: "Figma",
  pr: "Pull request",
  sentry: "Sentry",
  slack: "Slack",
  trello: "Trello",
  dashboard: "Dashboard",
  repo: "Repository",
  jira: "Jira",
  linear: "Linear",
  other: "Other",
};

/** Connection kinds (the server's /connection-kinds labels, for places that only have the key). */
export const CONNECTION_KIND: Record<string, string> = {
  postgres: "PostgreSQL",
  redshift: "Amazon Redshift",
  mysql: "MySQL",
  clickhouse: "ClickHouse",
  snowflake: "Snowflake",
  bigquery: "BigQuery",
  http_api: "HTTP API",
  git: "GitHub or GitLab",
  slack: "Slack",
  trello: "Trello",
  jira: "Jira",
  linear: "Linear",
};

/** What a notification route carries (Settings › Notifications, Admin › Notifications), short. */
export const ROUTE_KIND: Record<string, string> = {
  review: "Reviews",
  decided: "Decisions",
  comment: "Comments",
  change: "Upstream changes",
  stale: "Needs re-verifying",
  security: "Security",
  connection: "Connections",
  access: "Access requests",
};

/** A project's Slack digest. */
export const DIGEST_FREQUENCY: Record<string, string> = { off: "No digest", daily: "Daily digest", weekly: "Weekly digest" };

/** Connection groups, in the order the Connections tab shows them. */
export const CONNECTION_GROUP: Record<string, string> = { database: "Databases", api: "APIs", git: "Git hosts", notify: "Notification channels", tracker: "Issue trackers" };

export const SOURCE_KIND: Record<string, string> = {
  rss: "Feed",
  web: "Watched page",
  hackernews: "Hacker News",
  slack: "Slack",
  notion: "Notion",
  tavily: "Web search",
};

export const REPO_KIND: Record<string, string> = {
  backend: "Backend",
  frontend: "Frontend",
  mobile: "Mobile",
  data: "Data",
  infra: "Infrastructure",
  other: "Other",
};

/** Any of the maps above, with the humanize fallback. */
export function labelFrom(map: Record<string, string>, key: string | null | undefined): string {
  return key ? (map[key] ?? humanize(key)) : "";
}

// ---- Roles and access (ADDENDUM-roles §4) -------------------------------------------------------

export const ROLE_KIND: Record<"project" | "org", string> = { project: "Project role", org: "Organisation role" };

/** How someone holds a project role. `{name}` and `{project}` are filled in by `accessVia`. */
export const ACCESS_VIA = {
  direct: "Directly",
  team: "Through team {name}",
  inherited: "From {project} (above)",
} as const;

export function accessVia(how: keyof typeof ACCESS_VIA, names: { name?: string; project?: string } = {}): string {
  return ACCESS_VIA[how].replace("{name}", names.name ?? "").replace("{project}", names.project ?? "a project");
}

/** Fallback permission labels for older servers; the catalogue's `permission_labels` wins. */
export const PERMISSION_LABELS: Record<string, string> = {
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

// ---- Skills for Claude ------------------------------------------------------------------------------

/** A skill's own state (not its versions'). */
export const SKILL_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Paused", tone: "warning" },
  retired: { label: "Retired", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
  /** Not a stored state: an active skill with no published version yet (skillStatusKey). */
  unpublished: { label: "Not published yet", tone: "neutral" },
};

export const SKILL_VERSION_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for review", tone: "warning" },
  published: { label: "Published", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  superseded: { label: "Replaced", tone: "neutral" },
};

/** Who an assignment gives a skill to (the Add dialog's choices). */
export const SKILL_AUDIENCE: Record<string, { label: string; hint: string }> = {
  everyone: { label: "Everyone", hint: "Every person in Thaliyola." },
  org_role: { label: "Organisation role", hint: "Everyone holding an organisation role, such as Auditor." },
  team: { label: "Team", hint: "The members of one team." },
  project: { label: "Project", hint: "Everyone with a role in a project or the projects under it." },
  project_role: { label: "Project role", hint: "People holding a project role, in one project (and those under it) or in any project." },
};

/** How a skill was loaded (usage). */
export const SKILL_USAGE_CHANNEL: Record<string, string> = {
  mcp: "Loaded by Claude",
  file: "File loaded",
  prompt: "Slash command",
  download: "Downloaded",
  sync: "Claude Code sync",
};

/** What the scanner flags for reviewers; high-risk kinds need "I checked the flagged lines" before approval. */
export const SKILL_FLAG: Record<string, { label: string; high_risk: boolean }> = {
  admin_tools: { label: "Uses Thaliyola admin or write tools", high_risk: true },
  external_url: { label: "New external address", high_risk: true },
  hidden_text: { label: "Hidden or invisible text", high_risk: true },
  allowed_tools: { label: "Pre-approves tools", high_risk: false },
  scripts: { label: "Contains scripts", high_risk: false },
  pip_install: { label: "Installs packages", high_risk: false },
  possible_secret: { label: "Looks like a credential", high_risk: false },
  personal_data: { label: "Personal data", high_risk: false },
  tool_id: { label: "Hard-coded tool id", high_risk: false },
  html: { label: "HTML in Markdown", high_risk: false },
  binary: { label: "Binary file", high_risk: false },
  large_description: { label: "Long description", high_risk: false },
};

/** A flag's label, falling back to its kind in words. */
export const skillFlagLabel = (kind: string) => SKILL_FLAG[kind]?.label ?? humanize(kind);

/** The import report's sections, in the order the report page shows them. */
export const SKILL_REPORT_SECTION: { key: string; label: string; tone: Tone; hint: string }[] = [
  { key: "added", label: "Added", tone: "success", hint: "New skills. They wait for review before anyone gets them." },
  { key: "changed", label: "Changed", tone: "accent", hint: "New versions of skills that changed upstream; they wait for review." },
  { key: "moved", label: "Audience changes", tone: "warning", hint: "Skills that moved to another plugin. A move that gives the skill to more people waits for a second person." },
  { key: "rejected", label: "Rejected", tone: "danger", hint: "Not imported, with the reasons." },
  { key: "rejected_before", label: "Rejected earlier", tone: "neutral", hint: "The same content was rejected before, so it wasn't proposed again. Sync with Force to propose it anyway." },
  { key: "withdrawn", label: "Withdrawn", tone: "neutral", hint: "Waiting versions withdrawn because the repository went back to the published content." },
  { key: "delivery_narrowed", label: "Kept from Claude", tone: "neutral", hint: "Only which files are kept from Claude changed, and fewer are delivered now: applied to the published version without review." },
  { key: "held", label: "Held", tone: "warning", hint: "Rolled back: imports don't propose new versions until a reviewer releases the hold." },
  { key: "detached", label: "Detached", tone: "neutral", hint: "Changed here instead of in the repository; imports leave them alone." },
  { key: "adoptable", label: "Can be linked", tone: "neutral", hint: "Skills written here that also exist in the repository." },
  { key: "removed", label: "Removed", tone: "neutral", hint: "Gone from the repository, so no longer delivered. Their assignments stay." },
  { key: "reactivated", label: "Back again", tone: "success", hint: "Back in the repository after being removed." },
  { key: "not_covered", label: "No longer covered", tone: "neutral", hint: "Imported earlier from paths this source no longer reads." },
  { key: "unchanged", label: "Unchanged", tone: "neutral", hint: "Nothing changed since the last import." },
  { key: "excluded", label: "Excluded", tone: "neutral", hint: "Skipped by the exclude patterns." },
  { key: "warnings", label: "Warnings", tone: "warning", hint: "Imported, but worth a look." },
];

/** Who the delivery state message is about. */
export const SKILL_DELIVERY_MODE: Record<string, string> = { on: "On", admins: "Administrators only", off: "Off" };

/** The user-menu and Account role line: "Administrator", the organisation role names, or "Member". */
export function orgRoleLine(me: { admin: boolean; role_names?: string[] }): string {
  if (me.admin) return "Administrator";
  const names = (me.role_names ?? []).filter((n) => n && n !== "Administrator");
  return names.length ? names.join(", ") : "Member";
}

// ---- Glossary (Help › "What the words mean") ----------------------------------------------------

export interface GlossaryEntry {
  /** The internal or older word. */
  term: string;
  /** What the UI says instead. */
  say: string;
  /** Where the internal word may still appear. */
  where?: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: "scope", say: "“project” or “space” (Team space, Library, Personal space); pickers say “Project or space”; filters say “Where”", where: "code, API" },
  { term: "slug", say: "“short name”, shown read-only in monospace with a Copy button", where: "Technical details" },
  { term: "component", say: "“repository” (“Repositories” everywhere: facts, filters, move, settings)", where: "API params" },
  { term: "revision (in review)", say: "“proposal”" },
  { term: "revision (in history)", say: "“version” (“Version 4”, “Restore version 3”)" },
  { term: "op create / update / promote / move / share / verify", say: "New / Edit / Added to article / Move / Library share / Marked outdated" },
  { term: "supersede, superseded", say: "“Replaced”, “replaced by”" },
  { term: "possibly_stale", say: "badge “Needs a check”; sentence “Not verified recently”" },
  { term: "verify, “Still valid”", say: "“Confirm still accurate”; meta “Verified 3 days ago”" },
  { term: "retire", say: "“Mark as outdated”" },
  { term: "promote a finding", say: "“Add to <article title>”" },
  { term: "claims, grounded facts", say: "“Fact check” (panel); “statements” (the unit)", where: "Documentation tab tooltip" },
  { term: "source_links", say: "“External links”" },
  { term: "related, Links", say: "“Related items”" },
  { term: "entity, entities", say: "“topic”, “Topics”, with the kind as a label (Service, Metric, Table)" },
  { term: "upstream change, impact notice", say: "“Change from another team”, “Mark as handled”" },
  { term: "Uses from shared scopes", say: "“Shared items this project uses”" },
  { term: "View as", say: "“Repository”" },
  { term: "MCP, agents (MCP)", say: "“Claude (connector)”, “AI agents”", where: "Connect › Technical details" },
  { term: "agent, service author", say: "“AI agent” (bot icon)", where: "Admin › People: “Service account”" },
  { term: "org role, org roles, Workspace roles, Extra permissions", say: "“Organisation roles”; singular “organisation role”", where: "API kind: \"org\"" },
  { term: "project role, role (in a project)", say: "“Project roles”" },
  { term: "admin, is_admin, “Admin” badge, “admins”", say: "“Administrator” / “Administrators” (the top organisation role)", where: "“set on the server”, with ADMIN_EMAILS in its InfoTip" },
  { term: "owner (project role key), Owners, scope owner, project owner", say: "“Project admin” / “Project admins” (the article “Owner” fact stays “Owner”)", where: "muted “ID: owner” on the Roles page" },
  { term: "writer / reader / reviewer … (role keys)", say: "role names from the catalogue (Contributor, Viewer, Reviewer…)", where: "muted “ID: key” on the Roles page" },
  { term: "team role member / lead", say: "“In the team”: “Member” / “Lead (chooses the team's members)”. Never called a role.", where: "API role, team_role" },
  { term: "permission keys (manage_members, purge…)", say: "permission labels: Read, Comment, Propose, Verify, Review, Publish directly, Moderate, Security, Manage access, Manage settings, Manage people, Create projects, Manage teams, Manage roles, Manage every project, Read every project, Security everywhere, Delete permanently, See usage, Manage releases" },
  { term: "role key", say: "“ID”" },
  { term: "access of one person", say: "“Access” (link), “{name}: access”, “Your access” (Account)" },
  { term: "Roles page", say: "“Roles and access”", where: "routes /admin/roles, /roles" },
  { term: "holders", say: "“Held by”, “Who has it”" },
  { term: "inherited role", say: "“from {project} (above)”, “From the projects above”" },
  { term: "via team", say: "“through team {name}”" },
  { term: "account status (not_signed_in, waiting_for_approval…)", say: "“hasn't signed in yet”, “waiting for approval”, “disabled”, “active”; “temporary password” on People" },
  { term: "read_all_projects holders", say: "“people who can see every project (Administrators, Auditors)”" },
  { term: "view_metrics", say: "“See usage”" },
  { term: "manage_releases", say: "“Manage releases”: writes and publishes What's new" },
  { term: "release notes, changelog, catalog", say: "“What's new”; a release is “Thaliyola 1.0.0”; its entries are “features”", where: "#/whats-new, MCP whats_new" },
  { term: "purge (permission)", say: "“Delete permanently”" },
  { term: "security_admin", say: "“Security everywhere”; holders are “Security leads”" },
  { term: "visibility team / members", say: "“Everyone” (“Everyone in Thaliyola” in choice cards) / “Members only”" },
  { term: "KEV, CISA KEV", say: "“Actively exploited”", where: "“About these sources” InfoTip" },
  { term: "CVSS", say: "“Severity score”", where: "Technical details (vector)" },
  { term: "OSV, NVD, GHSA", say: "named only in “About these sources”", where: "IDs stay as identifiers" },
  { term: "Unrated", say: "“Not yet scored”" },
  { term: "team-published alert", say: "“advisory” (“Publish an advisory”)" },
  { term: "purge", say: "“Delete permanently”" },
  { term: "delete (to trash)", say: "“Move to trash” / “Restore”" },
  { term: "Paste to draft", say: "“Draft from pasted text”" },
  { term: "Ask Thaliyola", say: "“Search”, “Best answer” / “Closest match”" },
  { term: "knowledge gaps", say: "“Searches with no answer”" },
  { term: "hygiene, “Needs an owner or a check”", say: "“Needs attention”" },
  { term: "digest", say: "“Weekly summary email”" },
  { term: "DEV_TOKENS, dev token", say: "“Access token”", where: "developer hint on the gate" },
  { term: "Cloudflare Access", say: "“your company sign-in”", where: "admin helper text" },
  { term: "curate tasks", say: "“Work for Claude”", where: "the command in RunWithClaude" },
  { term: "Users (admin page)", say: "“People”", where: "route /admin/users" },
  { term: "Shared (sidebar group)", say: "“Spaces”" },
];

// ---- Time and errors (pure helpers behind RelativeTime and humanizeError, SPEC §5.8, §5.12) ------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

function toDate(date: string | number | Date | null | undefined): Date | null {
  if (date === null || date === undefined || date === "") return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5 Nov 2026, 14:03": the full timestamp for tooltips. */
export function formatTimestamp(date: string | number | Date | null | undefined): string {
  const d = toDate(date);
  if (!d) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Relative within 7 days, then absolute (SPEC §1.2 rule 10): "just now", "12 min ago", "3 hours ago",
 * "yesterday", "3 days ago", then "4 Nov" (this year) or "4 Nov 2025". Returns `never` for no date.
 */
export function formatRelativeTime(date: string | number | Date | null | undefined, now: Date = new Date(), never = "Never"): string {
  const d = toDate(date);
  if (!d) return never;
  const ms = now.getTime() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (ms < 60_000 && ms > -5 * 60_000) return "just now";
  if (ms >= 0) {
    if (min < 60) return `${min} min ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
    const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
    if (days <= 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
  }
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Sentence case: the first letter capitalised, a trailing full stop added. */
function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return t;
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/**
 * A calm, blame-free message for any error (SPEC §5.8). The raw text goes in `detail` ("Technical details").
 * Reads `status` like ApiError does, without importing it.
 */
export function humanizeError(e: unknown): { title: string; detail?: string } {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "";
  const status = e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number" ? (e as { status: number }).status : undefined;
  const detail = raw || undefined;
  if (status === undefined) {
    if (e instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
      return { title: "Thaliyola isn't responding. Check your connection and try again.", detail };
    }
    return { title: raw ? sentence(raw) : "Something went wrong. Try again.", detail };
  }
  if (status === 401) return { title: "Your session has ended. Sign in again.", detail };
  if (status === 403) return { title: "You don't have permission to do this.", detail };
  if (status === 404) return { title: "We couldn't find this. It may have been moved or deleted.", detail };
  if (status === 409) return { title: "Someone changed this while you were working.", detail };
  if (status === 413) return { title: "That file is too large.", detail };
  if (status === 429) return { title: "Too many requests. Wait a moment and try again.", detail };
  if (status >= 500) return { title: "Something went wrong on the server. Try again in a moment.", detail };
  if ((status === 400 || status === 422) && raw) return { title: sentence(raw), detail };
  return { title: raw ? sentence(raw) : "Something went wrong. Try again.", detail };
}
