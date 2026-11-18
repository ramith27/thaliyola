import type { AuditTargetKind } from "./audit.js";
import { withTx } from "../db/pool.js";
import { ForbiddenError, ValidationError, type RequestContext } from "./context.js";
import { can } from "./roles.js";

/**
 * The audit log, for Administrators and Auditors: who did what to what, and when. Seeing it needs both Read every
 * project and See usage (the Auditor role has both; Administrators hold every permission), because it names what
 * people opened and changed across every project. Personal spaces stay private here too: an item in someone else's
 * personal space is shown as "a private note", never by title.
 *
 * Rows are recorded by audit() (core/audit.ts). Older rows only have (actor, tool, target id, time); their target's
 * kind and name are looked up when they're read. The web or MCP call that wraps a change is hidden when the change
 * itself was recorded in the same request, so every change is listed once.
 */

export type AuditGroup =
  | "people"
  | "roles"
  | "service_accounts"
  | "tokens"
  | "settings"
  | "releases"
  | "projects"
  | "content"
  | "review"
  | "security"
  | "sources"
  | "connections"
  | "exports"
  | "skills"
  | "sign_in";

export const AUDIT_GROUPS: Record<AuditGroup, string> = {
  people: "People and accounts",
  roles: "Roles and access",
  service_accounts: "Service accounts",
  tokens: "Tokens and apps",
  settings: "System settings",
  releases: "Releases",
  projects: "Projects and teams",
  content: "Content",
  review: "Review",
  security: "Security",
  sources: "Sources and inbox",
  connections: "Connections and data",
  exports: "Exports",
  skills: "Skills",
  sign_in: "Signing in",
};

interface ActionDef {
  label: string;
  group: AuditGroup;
}

const A = (group: AuditGroup, label: string): ActionDef => ({ group, label });

/** Readable labels for the events worth auditing. Keys are tools without the "api:" prefix or a ":detail" suffix. */
export const AUDIT_ACTIONS: Record<string, ActionDef> = {
  // People and accounts
  add_person: A("people", "Added a person"),
  create_user: A("people", "Created an account"),
  update_user: A("people", "Changed an account"),
  approve_access: A("people", "Approved someone's access"),
  decline_access: A("people", "Declined someone's access"),
  decide_access_request: A("people", "Decided an access request"),
  set_account_status: A("people", "Enabled or disabled an account"),
  set_my_name: A("people", "Changed their own name"),
  update_account: A("people", "Changed their own name"),
  reset_password: A("people", "Reset someone's password"),
  invite_user: A("people", "Invited someone"),
  accept_invitation: A("sign_in", "Accepted an invitation"),
  change_password: A("sign_in", "Changed their password"),
  login: A("sign_in", "Signed in"),
  // Roles and access
  set_user_roles: A("roles", "Changed organisation roles"),
  create_role: A("roles", "Created a role"),
  update_role: A("roles", "Changed a role"),
  save_role: A("roles", "Saved a role"),
  delete_role: A("roles", "Deleted a role"),
  set_member_roles: A("roles", "Changed project access"),
  admin_set_member: A("roles", "Changed project access"),
  set_project_access: A("roles", "Changed project access"),
  set_team_role: A("roles", "Changed a team's project access"),
  set_projects_visibility: A("roles", "Changed who can read projects"),
  set_project_visibility: A("roles", "Changed who can read a project"),
  // Service accounts
  create_service_account: A("service_accounts", "Created a service account"),
  disable_service_account: A("service_accounts", "Disabled a service account"),
  enable_service_account: A("service_accounts", "Enabled a service account"),
  update_service_account: A("service_accounts", "Changed a service account"),
  create_service_token: A("service_accounts", "Created a service account token"),
  revoke_service_token: A("service_accounts", "Revoked a service account token"),
  rotate_service_token: A("service_accounts", "Rotated a service account token"),
  // Tokens and apps
  create_api_token: A("tokens", "Created a personal API token"),
  revoke_api_token: A("tokens", "Revoked a personal API token"),
  rotate_api_token: A("tokens", "Rotated a personal API token"),
  notify_token_expiry: A("tokens", "Warned that a token expires soon"),
  oauth_authorize: A("tokens", "Connected an app"),
  revoke_oauth_connection: A("tokens", "Disconnected an app"),
  // System settings
  update_system_settings: A("settings", "Changed system settings"),
  system_settings: A("settings", "Changed system settings"),
  apply_system_preset: A("settings", "Applied a system preset"),
  // Releases
  create_release: A("releases", "Created a release"),
  update_release: A("releases", "Changed a release"),
  publish_release: A("releases", "Published a release"),
  unpublish_release: A("releases", "Unpublished a release"),
  delete_release: A("releases", "Deleted a release"),
  draft_release: A("releases", "Drafted a release from the changelog"),
  create_feature: A("releases", "Added a feature to a release"),
  update_feature: A("releases", "Changed a feature"),
  delete_feature: A("releases", "Removed a feature"),
  reorder_features: A("releases", "Reordered a release's features"),
  // Projects and teams
  create_project: A("projects", "Created a project"),
  admin_create_project: A("projects", "Created a project"),
  request_project: A("projects", "Requested a project"),
  approve_project_request: A("projects", "Approved a project request"),
  decline_project_request: A("projects", "Declined a project request"),
  decide_project_request: A("projects", "Decided a project request"),
  admin_update_scope: A("projects", "Changed a project"),
  admin_add_component: A("projects", "Added a repository"),
  update_component: A("projects", "Changed a repository"),
  remove_component: A("projects", "Removed a repository"),
  set_project_parent: A("projects", "Moved a project"),
  delete_project: A("projects", "Moved a project to the trash"),
  restore_project: A("projects", "Restored a project"),
  empty_project: A("projects", "Deleted a project for good"),
  purge_project: A("projects", "Deleted a project for good"),
  create_team: A("projects", "Created a team"),
  save_team: A("projects", "Saved a team"),
  update_team: A("projects", "Changed a team"),
  delete_team: A("projects", "Deleted a team"),
  set_team_member: A("projects", "Changed a team's members"),
  set_team_membership: A("projects", "Changed a team's members"),
  create_team_project: A("projects", "Created a team project"),
  update_doc_settings: A("projects", "Changed documentation settings"),
  // Content
  create_article: A("content", "Wrote an article"),
  edit_article: A("content", "Edited an article"),
  create_finding: A("content", "Wrote a finding"),
  edit_finding: A("content", "Edited a finding"),
  propose_finding: A("content", "Proposed a finding"),
  update_finding: A("content", "Proposed a change to a finding"),
  propose_article_edit: A("content", "Proposed an article edit"),
  promote_finding: A("content", "Promoted a finding"),
  share_to_library: A("content", "Shared to the Library"),
  verify_entry: A("content", "Verified an entry"),
  link_entries: A("content", "Linked entries"),
  unlink_entries: A("content", "Removed a link"),
  add_source_link: A("content", "Added evidence"),
  upload_asset: A("content", "Attached a file"),
  delete_asset: A("content", "Removed a file"),
  move_item: A("content", "Moved an entry"),
  move_items: A("content", "Moved entries"),
  move_entry: A("content", "Proposed moving an entry"),
  delete_item: A("content", "Moved an entry to the trash"),
  restore_item: A("content", "Restored an entry"),
  empty_item: A("content", "Deleted an entry for good"),
  purge: A("content", "Deleted an entry for good"),
  restore_version: A("content", "Restored an older version"),
  import_docs: A("content", "Imported documents"),
  save_personal_note: A("content", "Saved a personal note"),
  docs_begin: A("content", "Started documenting a repository"),
  docs_finish: A("content", "Finished documenting a repository"),
  resolve_claims: A("content", "Resolved documentation claims"),
  ack_notice: A("content", "Acknowledged an impact notice"),
  docs_submit_plan: A("content", "Planned a repository's documentation"),
  docs_submit_page: A("content", "Wrote a documentation page"),
  docs_skip_page: A("content", "Skipped a documentation page"),
  complete_task: A("content", "Completed a curation task"),
  dismiss_gap: A("content", "Dismissed a knowledge gap"),
  // Review
  approve: A("review", "Approved a proposal"),
  approve_revision: A("review", "Approved a proposal"),
  reject: A("review", "Rejected a proposal"),
  reject_revision: A("review", "Rejected a proposal"),
  // Claude's calls (MCP): the core change they record (approve_revision, reject_revision) is listed instead.
  review_proposal: A("review", "Decided a proposal through Claude"),
  bulk_approve: A("review", "Approved several proposals"),
  bulk_reject: A("review", "Rejected several proposals"),
  comment_revision: A("review", "Commented on a proposal"),
  add_comment: A("review", "Commented on a proposal"),
  assign_revision: A("review", "Assigned a proposal"),
  email_approve: A("review", "Approved a proposal from email"),
  // Security
  report_vulnerability: A("security", "Reported a vulnerability"),
  update_vulnerability: A("security", "Updated a vulnerability"),
  record_security_review: A("security", "Recorded a security review"),
  scan_dependencies: A("security", "Scanned dependencies"),
  upload_dependencies: A("security", "Uploaded dependencies"),
  publish_advisory: A("security", "Published a security alert"),
  hide_advisory: A("security", "Hid a security alert"),
  advisory_response: A("security", "Responded to a security alert"),
  set_advisory_response: A("security", "Responded to a security alert"),
  set_project_technologies: A("security", "Changed a project's technologies"),
  // Sources and inbox
  create_source: A("sources", "Added a source"),
  add_source: A("sources", "Added a source"),
  update_source: A("sources", "Changed a source"),
  delete_source: A("sources", "Removed a source"),
  run_source: A("sources", "Checked a source now"),
  resolve_inbox_item: A("sources", "Resolved an inbox item"),
  reopen_inbox_item: A("sources", "Reopened an inbox item"),
  inbox_filed: A("sources", "Filed an inbox item"),
  inbox_dismissed: A("sources", "Dismissed an inbox item"),
  inbox_duplicate: A("sources", "Marked an inbox item as a duplicate"),
  // Connections and data
  create_connection: A("connections", "Added a connection"),
  update_connection: A("connections", "Changed a connection"),
  delete_connection: A("connections", "Removed a connection"),
  test_connection: A("connections", "Tested a connection"),
  test_connection_draft: A("connections", "Tested a connection's settings"),
  sync_connection: A("connections", "Synced a connection now"),
  create_notification_route: A("connections", "Added a notification route"),
  update_notification_route: A("connections", "Changed a notification route"),
  delete_notification_route: A("connections", "Removed a notification route"),
  send_digest: A("connections", "Sent a project digest now"),
  query_database: A("connections", "Queried a database"),
  call_api: A("connections", "Called an API"),
  call_api_refused: A("connections", "Was refused an API call"),
  read_repo_file: A("connections", "Read a repository file"),
  read_repo_file_refused: A("connections", "Was refused a repository file"),
  describe_columns: A("connections", "Described table columns"),
  create_ticket: A("connections", "Opened a ticket"),
  link_ticket: A("connections", "Linked a ticket"),
  // Skills
  create_skill: A("skills", "Created a skill"),
  propose_skill_version: A("skills", "Proposed a new skill version"),
  // Claude's calls (MCP): the core change they record (create_skill, propose_skill_version) is listed instead.
  propose_skill: A("skills", "Proposed a skill through Claude"),
  propose_skill_edit: A("skills", "Proposed a skill version through Claude"),
  publish_skill_version: A("skills", "Published a skill version"),
  publish_skill_versions_guidance: A("skills", "Published a shared-guidance update"),
  publish_skill_versions_import: A("skills", "Published the reviewed versions of an import"),
  withdraw_skill_version: A("skills", "Withdrew a skill version the source went back on"),
  narrow_skill_delivery: A("skills", "Kept more of a skill's files from Claude"),
  propose_skill_collection_change: A("skills", "Proposed a change to a skill collection's connectors or name"),
  approve_skill_collection_change: A("skills", "Approved a change to a skill collection's connectors or name"),
  decline_skill_collection_change: A("skills", "Declined a change to a skill collection's connectors or name"),
  rename_skill_collection: A("skills", "Renamed a skill collection from its source"),
  remove_skill_collection: A("skills", "Removed a skill collection from its source"),
  reject_skill_version: A("skills", "Rejected a skill version"),
  rollback_skill: A("skills", "Rolled a skill back"),
  release_skill_hold: A("skills", "Released a skill's hold"),
  decide_skill_audience_change: A("skills", "Decided a skill's move to another collection"),
  update_skill: A("skills", "Changed a skill"),
  retire_skills: A("skills", "Retired skills"),
  detach_skill: A("skills", "Detached a skill from its source"),
  reattach_skill: A("skills", "Reattached a skill to its source"),
  adopt_skill: A("skills", "Adopted a skill into a source"),
  assign_skill: A("skills", "Gave a skill to people"),
  unassign_skill: A("skills", "Took a skill away"),
  map_skill_collection: A("skills", "Gave a collection of skills to people"),
  update_skill_collection: A("skills", "Changed a skill collection"),
  create_skill_source: A("skills", "Added a skill source"),
  update_skill_source: A("skills", "Changed a skill source"),
  delete_skill_source: A("skills", "Removed a skill source"),
  sync_skill_source: A("skills", "Imported skills from a repository"),
  review_skill_version: A("skills", "Decided a skill version through Claude"),
  approve_skill_import: A("skills", "Approved an import's skill versions through Claude"),
  set_skill_source_webhook: A("skills", "Set a skill source's webhook secret"),
  remove_skill_source_webhook: A("skills", "Removed a skill source's webhook"),
  skill_source_webhook: A("skills", "A push webhook started a skill sync"),
  refuse_skill_source_webhook: A("skills", "Refused a skill source webhook call"),
  import_skills: A("skills", "Imported skills from an upload"),
  convert_articles_to_skills: A("skills", "Converted articles to skills"),
  report_skill_problem: A("skills", "Reported a problem with a skill"),
  resolve_skill_feedback: A("skills", "Resolved a skill problem report"),
  set_skill_preference: A("people", "Changed whether their skills go to Claude"),
  download_skill: A("exports", "Downloaded a skill"),
  // Exports
  export: A("exports", "Exported Markdown"),
  export_site: A("exports", "Exported a static site"),
  export_audit: A("exports", "Downloaded the audit log"),
  get_asset: A("exports", "Opened an attachment"),
};

/**
 * Read-only calls (page views, searches, lists): hidden unless asked for. The database decides this when a row is
 * written (audit_action_is_read(), last replaced in migration 050; the is_read column): change both together.
 */
const READ_PREFIX = /^(get|list|search|browse|find|latest|preview|detect)_/;
export const READ_ACTIONS = new Set([
  "me",
  "my_access",
  "person_access",
  "connect_info",
  "insights",
  "graph",
  "ask",
  "search",
  "browse",
  "success_metrics",
  "knowledge_gaps",
  "security_overview",
  "project_technologies",
  "task_summary",
  "docs_status",
  "agents_md",
  "claims",
  "onboarding",
  "project_pages",
  "project_context",
  "needs_attention",
  "role_holders",
  "resolve_repo",
  "docs_next_page",
  "docs_inspect_claims",
  "add_favourite",
  "remove_favourite",
  "audit",
  // Connections: what's connected, a connection's changes and calls, a project's data (migration 050).
  "connection_kinds",
  "connection_changes",
  "connection_calls",
  "project_data",
]);

/** "api:create_role" → "create_role"; "system_settings:a,b" → "system_settings". */
export function actionKey(tool: string): string {
  return tool.replace(/^api:/, "").replace(/:.*$/, "");
}

export function isReadAction(key: string): boolean {
  return !(key in AUDIT_ACTIONS) && (READ_ACTIONS.has(key) || READ_PREFIX.test(key));
}

const humanize = (key: string) => {
  const s = key.replace(/_/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
};

export function describeAction(tool: string): { key: string; label: string; group: AuditGroup | "reads" | "other" } {
  const key = actionKey(tool);
  const def = AUDIT_ACTIONS[key];
  if (def) return { key, label: def.label, group: def.group };
  return { key, label: humanize(key), group: isReadAction(key) ? "reads" : "other" };
}

/** Administrators and Auditors: Read every project and See usage. */
export function canSeeAuditLog(ctx: RequestContext): boolean {
  return ctx.actor.kind === "human" && can(ctx, "read_all_projects") && can(ctx, "view_metrics");
}

function assertMaySee(ctx: RequestContext) {
  if (!canSeeAuditLog(ctx)) throw new ForbiddenError("the audit log needs Read every project and See usage (Administrators and Auditors have both)");
}

export interface AuditFilters {
  /** An account id or email. */
  person?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  /** Include page views, searches and lists. */
  reads?: boolean;
  /** The id of the last row of the previous page. */
  cursor?: string;
  limit?: number;
}

export interface AuditTarget {
  /** Null when the target is private (another person's personal space). */
  id: string | null;
  kind: AuditTargetKind | null;
  label: string | null;
  /** What to link to: an item id, a project slug, an account id (a token's owner), a proposal id. */
  ref: string | null;
  /** Items and projects: the kind of space they're in (project, team, library, personal). */
  scope_kind?: string | null;
  /** Tokens: whose they are (human or service). */
  owner_kind?: string | null;
  private?: boolean;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  label: string;
  group: string;
  actor: { id: string; name: string; email: string | null; kind: "human" | "service" } | null;
  target: AuditTarget | null;
  via: "api" | "mcp" | null;
  details: Record<string, unknown> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A date or date-time; a bare date `to` means the end of that day (UTC). */
function parseTime(value: string | undefined, end: boolean): string | null {
  if (!value) return null;
  const v = value.trim();
  if (DATE_ONLY.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new ValidationError(`not a date: ${v}`);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`not a date: ${v}`);
  return d.toISOString();
}

/** The query behind the list and the CSV: newest first, after `cursor`. */
async function query(ctx: RequestContext, f: AuditFilters, limit: number): Promise<AuditEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [ctx.actor.id];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.person) {
    if (!UUID.test(f.person)) throw new ValidationError("person must be an account id or email");
    where.push(`a.actor_id = ${p(f.person)}`);
  }
  if (f.target) {
    if (!UUID.test(f.target)) throw new ValidationError("target must be an id");
    // A change recorded without a target takes the one of the web or MCP call that wrapped it (see `w` below).
    const t = p(f.target);
    where.push(
      `(a.target_id = ${t} OR (a.target_id IS NULL AND a.target_kind IS NULL AND a.via IS NULL AND a.request_id = ANY (ARRAY(
         SELECT x.request_id FROM audit_log x WHERE x.target_id = ${t} AND x.via IS NOT NULL AND x.request_id IS NOT NULL))))`,
    );
  }
  if (f.action) {
    const key = actionKey(f.action.trim());
    if (!/^[a-z0-9_]{1,80}$/.test(key)) throw new ValidationError("unknown action");
    // Actions that share a label in a group match each other (approve and approve_revision).
    where.push(`a.action = ANY (${p(aliasesOf(key))}::text[])`);
  }
  const from = parseTime(f.from, false);
  const to = parseTime(f.to, true);
  if (from) where.push(`a.at >= ${p(from)}`);
  if (to) where.push(`a.at < ${p(to)}`);
  if (f.cursor) {
    if (!/^\d{1,18}$/.test(f.cursor)) throw new ValidationError("invalid cursor");
    where.push(`a.id < ${p(f.cursor)}`);
  }
  // Page views, searches and lists: is_read is computed from the tool when the row is written (migration 035).
  if (!f.reads && !f.action) where.push("NOT a.is_read");
  // The call that wrapped a recorded change (same request) isn't listed again.
  where.push(`NOT (a.via IS NOT NULL AND a.request_id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log b WHERE b.request_id = a.request_id AND b.id <> a.id))`);

  // JIT compiling the plan costs more than this indexed, LIMITed query (it switched on for large logs).
  const { rows } = await withTx(ctx.db, async (tx) => {
    await tx.query("SET LOCAL jit = off");
    return tx.query<{
    id: string;
    at: Date;
    tool: string;
    target_id: string | null;
    details: Record<string, unknown> | null;
    stored_kind: string | null;
    stored_label: string | null;
    via: "api" | "mcp" | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    actor_kind: "human" | "service" | null;
    t_kind: string | null;
    t_label: string | null;
    t_ref: string | null;
    t_scope_kind: string | null;
    t_private: boolean | null;
  }>(
    `SELECT a.id::text, a.at, a.tool, coalesce(a.target_id, w.target_id) AS target_id, a.details, a.target_kind AS stored_kind, a.target_label AS stored_label,
            coalesce(a.via, w.via) AS via,
            a.actor_id, coalesce(nullif(u.display_name, ''), u.email, u.subject) AS actor_name, u.email AS actor_email, u.kind AS actor_kind,
            t.kind AS t_kind, t.label AS t_label, t.ref AS t_ref, t.scope_kind AS t_scope_kind, t.private AS t_private
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       -- The web or MCP call this change was made in: how it came in, and its target when the change has none.
       LEFT JOIN LATERAL (
         SELECT w.via, CASE WHEN a.target_kind IS NULL THEN w.target_id END AS target_id
           FROM audit_log w WHERE a.via IS NULL AND a.request_id IS NOT NULL AND w.request_id = a.request_id AND w.via IS NOT NULL LIMIT 1
       ) w ON true
       LEFT JOIN LATERAL (
         SELECT * FROM (
           SELECT 'article' AS kind, ar.title AS label, ar.id::text AS ref, s.kind AS scope_kind, (s.kind = 'personal' AND s.owner_id IS DISTINCT FROM $1) AS private
             FROM articles ar JOIN scopes s ON s.id = ar.scope_id WHERE ar.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'finding', f.title, f.id::text, s.kind, (s.kind = 'personal' AND s.owner_id IS DISTINCT FROM $1)
             FROM findings f JOIN scopes s ON s.id = f.scope_id WHERE f.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'project', s.name, s.slug, s.kind, (s.kind = 'personal' AND s.owner_id IS DISTINCT FROM $1) FROM scopes s WHERE s.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT CASE WHEN tu.kind = 'service' THEN 'service_account' ELSE 'person' END,
                  coalesce(nullif(tu.display_name, ''), tu.email, tu.subject), tu.id::text, NULL, false
             FROM users tu WHERE tu.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'token', tk.name, tk.user_id::text, ou.kind, false FROM api_tokens tk JOIN users ou ON ou.id = tk.user_id WHERE tk.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'proposal', coalesce(r.payload->>'title', ra.title, rf.title, 'a proposal'), r.id::text, s.kind,
                  (s.kind = 'personal' AND s.owner_id IS DISTINCT FROM $1)
             FROM revisions r JOIN scopes s ON s.id = r.scope_id
             LEFT JOIN articles ra ON ra.id = r.target_id LEFT JOIN findings rf ON rf.id = r.target_id
            WHERE r.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'vulnerability', v.title, v.id::text, NULL, false FROM vulnerabilities v WHERE v.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'team', tm.name, tm.slug, NULL, false FROM teams tm WHERE tm.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'project_request', pr.name, pr.id::text, NULL, false FROM project_requests pr WHERE pr.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'connection', c.name, cs.slug, cs.kind, false FROM connections c JOIN scopes cs ON cs.id = c.scope_id WHERE c.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'notification_route', rc.name, coalesce(rs.slug, 'team'), coalesce(rs.kind, 'team'), false
             FROM notification_routes nr JOIN connections rc ON rc.id = nr.connection_id LEFT JOIN scopes rs ON rs.id = nr.scope_id
            WHERE nr.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'repository', cs.slug || '/' || co.slug, cs.slug, cs.kind, false FROM components co JOIN scopes cs ON cs.id = co.scope_id WHERE co.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'release', 'Thaliyola ' || rl.version, rl.version, NULL, false FROM releases rl WHERE rl.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'feature', ft.title, ft.id::text, NULL, false FROM features ft WHERE ft.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'skill', sk.name || coalesce(' (in ' || os.name || ')', ''), sk.id::text, os.kind, false
             FROM skills sk LEFT JOIN scopes os ON os.id = sk.owner_scope_id WHERE sk.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'skill_source', ss.name, ss.id::text, NULL, false FROM skill_sources ss WHERE ss.id = coalesce(a.target_id, w.target_id)
           UNION ALL
           SELECT 'skill_collection', sc.name, sc.slug, NULL, false FROM skill_collections sc WHERE sc.id = coalesce(a.target_id, w.target_id)
         ) found LIMIT 1
       ) t ON coalesce(a.target_id, w.target_id) IS NOT NULL
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.id DESC
      LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
      params,
    );
  });

  return rows.map((r) => {
    const d = describeAction(r.tool);
    const kind = (r.t_kind ?? r.stored_kind) as AuditTarget["kind"];
    const hidden = !!r.t_private;
    const target: AuditEntry["target"] =
      r.target_id || r.stored_label || r.stored_kind
        ? {
            id: hidden ? null : r.target_id,
            kind,
            label: hidden ? (r.t_kind === "project" ? "Someone's personal space" : "A private note") : (r.t_label ?? r.stored_label),
            ref: hidden ? null : r.t_ref,
            ...(kind === "token" ? { owner_kind: r.t_scope_kind } : { scope_kind: r.t_scope_kind }),
            private: hidden || undefined,
          }
        : null;
    return {
      id: r.id,
      at: r.at.toISOString(),
      action: d.key,
      label: d.label,
      group: d.group,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? "Unknown", email: r.actor_email, kind: r.actor_kind ?? "human" } : null,
      target,
      via: r.via,
      details: r.details ?? suffixDetails(d.key, r.tool),
    };
  });
}

/**
 * Some older rows kept what they were about in the tool's ":detail" suffix instead of details: the app connected
 * (oauth_authorize:<app>) or the settings changed (system_settings:<keys>). Shown as details when there are none.
 */
export function suffixDetails(key: string, tool: string): Record<string, unknown> | null {
  const suffix = tool.replace(/^api:/, "").match(/^[^:]+:(.+)$/s)?.[1]?.trim();
  if (!suffix) return null;
  if (key === "oauth_authorize") return { app: suffix };
  if (key === "system_settings") return { settings: suffix.split(",").map((s) => s.trim()).filter(Boolean) };
  return { detail: suffix };
}

/** The actions to filter by, grouped as on the page. */
export function auditActionCatalog() {
  const seen = new Set<string>();
  const actions: { key: string; label: string; group: AuditGroup }[] = [];
  for (const [key, def] of Object.entries(AUDIT_ACTIONS)) {
    // One entry per label within a group (e.g. approve and approve_revision): the first key stands for both in the
    // dropdown, and the others stay reachable by URL.
    const id = `${def.group}|${def.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    actions.push({ key, label: def.label, group: def.group });
  }
  return { groups: Object.entries(AUDIT_GROUPS).map(([key, label]) => ({ key, label })), actions };
}

/** Same-label aliases: filtering by one action also finds the others with that label in its group. */
function aliasesOf(key: string): string[] {
  const def = AUDIT_ACTIONS[key];
  if (!def) return [key];
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, d]) => d.group === def.group && d.label === def.label)
    .map(([k]) => k);
}

const NOBODY = "00000000-0000-0000-0000-000000000000";

/** An email becomes the account's id (a person before a service, oldest first); an unknown email matches nothing. */
async function withPersonId(ctx: RequestContext, f: AuditFilters): Promise<AuditFilters> {
  const person = f.person?.trim();
  if (!person || UUID.test(person)) return { ...f, person: person || undefined };
  if (!/^[^\s@]+@[^\s@]+$/.test(person)) throw new ValidationError("person must be an account id or email");
  const { rows } = await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1) ORDER BY kind = 'human' DESC, created_at LIMIT 1", [person]);
  return { ...f, person: rows[0]?.id ?? NOBODY };
}

/** One page of the audit log, newest first. `next_cursor` is null on the last page. */
export async function listAudit(ctx: RequestContext, filters: AuditFilters) {
  assertMaySee(ctx);
  const f = await withPersonId(ctx, filters);
  const limit = Math.max(1, Math.min(f.limit ?? 50, 200));
  const rows = await query(ctx, f, limit + 1);
  const more = rows.length > limit;
  const entries = rows.slice(0, limit);
  const out: {
    entries: AuditEntry[];
    next_cursor: string | null;
    person?: { id: string; name: string; email: string | null; kind: string } | null;
    target?: { id: string; label: string | null; kind: string | null } | null;
  } & Partial<ReturnType<typeof auditActionCatalog>> = { entries, next_cursor: more ? entries[entries.length - 1]!.id : null };
  if (!f.cursor) {
    Object.assign(out, auditActionCatalog());
    if (f.person) {
      const { rows: p } = await ctx.db.query<{ id: string; name: string; email: string | null; kind: string }>(
        "SELECT id, coalesce(nullif(display_name, ''), email, subject) AS name, email, kind FROM users WHERE id = $1",
        [f.person],
      );
      out.person = p[0] ?? null;
    }
    if (f.target) {
      // The newest row about the target names it (with the same privacy rule as the rows).
      const named = entries.find((e) => e.target?.id === f.target)?.target ?? (await query(ctx, { target: f.target, reads: true }, 1))[0]?.target;
      out.target = named ? { id: f.target, label: named.label, kind: named.kind } : { id: f.target, label: null, kind: null };
    }
  }
  return out;
}

const CSV_MAX_ROWS = 50_000;

/** A cell that spreadsheets won't run as a formula. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole filtered log (up to 50,000 rows) as CSV lines, newest first. */
export async function* auditCsv(ctx: RequestContext, filters: AuditFilters): AsyncGenerator<string> {
  assertMaySee(ctx);
  const f = await withPersonId(ctx, filters);
  yield ["Time (UTC)", "Person", "Email", "Action", "Action key", "Target type", "Target", "Target id", "Via", "Details"].map(csvCell).join(",") + "\r\n";
  let cursor = f.cursor;
  let sent = 0;
  while (sent < CSV_MAX_ROWS) {
    const rows = await query(ctx, { ...f, cursor }, 1000);
    if (!rows.length) return;
    let chunk = "";
    for (const e of rows) {
      chunk +=
        [
          e.at,
          e.actor?.name ?? "Thaliyola",
          e.actor?.email ?? "",
          e.label,
          e.action,
          e.target?.kind ?? "",
          e.target?.label ?? "",
          e.target?.id ?? "",
          e.via === "mcp" ? "MCP" : e.via === "api" ? "Web or API" : "",
          e.details ?? "",
        ]
          .map(csvCell)
          .join(",") + "\r\n";
    }
    yield chunk;
    sent += rows.length;
    if (rows.length < 1000) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

export function assertMaySeeAudit(ctx: RequestContext) {
  assertMaySee(ctx);
}
