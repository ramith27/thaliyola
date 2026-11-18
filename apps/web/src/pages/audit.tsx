import { useEffect, useMemo, useState } from "react";
import { api, getToken, type Me } from "../api";
import { I } from "../components/icons";
import { formatTimestamp, PERMISSION_LABELS } from "../components/labels";
import { PersonInput } from "../components/people";
import { can } from "../components/permissions";
import { useRoles, type CatalogRole } from "../components/roles";
import { useAppRoute, useQueryState } from "../hooks";
import { href } from "../router";
import {
  AdminTabs,
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadMore,
  Page,
  PageHeader,
  PersonChip,
  Select,
  SkeletonRows,
  Switch,
  TextInput,
  useToast,
  type Column,
  type MenuItemSpec,
} from "../components/kit";

/**
 * Admin › Audit log: who did what to what, and when. For Administrators and Auditors (Read every project and See
 * usage). Filters live in the URL (person, action, target, from, to, reads) so a view can be shared; the same filters
 * download as CSV. Page views and searches are left out unless "Include page views and searches" is on.
 */

type TargetKind =
  | "article"
  | "finding"
  | "project"
  | "person"
  | "service_account"
  | "token"
  | "proposal"
  | "role"
  | "team"
  | "settings"
  | "vulnerability"
  | "source"
  | "app"
  | "project_request"
  | "connection"
  | "notification_route"
  | "repository";

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  label: string;
  group: string;
  actor: { id: string; name: string; email: string | null; kind: "human" | "service" } | null;
  target: {
    id: string | null;
    kind: TargetKind | null;
    label: string | null;
    ref: string | null;
    scope_kind?: string | null;
    owner_kind?: string | null;
    private?: boolean;
  } | null;
  via: "api" | "mcp" | null;
  details: Record<string, unknown> | null;
}

interface AuditPage {
  entries: AuditEntry[];
  next_cursor: string | null;
  groups?: { key: string; label: string }[];
  actions?: { key: string; label: string; group: string }[];
  person?: { id: string; name: string; email: string | null; kind: string } | null;
  target?: { id: string; label: string | null; kind: string | null } | null;
}

const TARGET_KIND: Record<TargetKind, string> = {
  article: "Article",
  finding: "Finding",
  project: "Project",
  person: "Person",
  service_account: "Service account",
  token: "API token",
  proposal: "Proposal",
  role: "Role",
  team: "Team",
  settings: "Settings",
  vulnerability: "Vulnerability",
  source: "Source",
  app: "App",
  project_request: "Project request",
  connection: "Connection",
  notification_route: "Notification route",
  repository: "Repository",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateText = (d: unknown) => (typeof d === "string" && !Number.isNaN(new Date(d).getTime()) ? formatTimestamp(d) : null);

/** The API query for the page's filters. Dates are whole days in the viewer's time zone. */
export function apiQuery(q: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["person", "action", "target"]) if (q[k]) p.set(k, q[k]!);
  if (q.from && DATE.test(q.from)) {
    const d = new Date(`${q.from}T00:00:00`);
    if (!Number.isNaN(d.getTime())) p.set("from", d.toISOString());
  }
  if (q.to && DATE.test(q.to)) {
    const d = new Date(`${q.to}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1);
      p.set("to", d.toISOString());
    }
  }
  if (q.reads === "true") p.set("reads", "true");
  return p;
}

/** Where a target links to on this page, or nothing (private, deleted, or no page for it). */
function targetHref(t: NonNullable<AuditEntry["target"]>, me: Me): string | undefined {
  if (t.private || !t.ref) return undefined;
  switch (t.kind) {
    case "article":
    case "finding":
      return href(`/${t.kind}/${t.ref}`);
    case "project":
      return t.scope_kind === "personal" ? undefined : href(t.scope_kind === "project" ? `/project/${t.ref}` : `/scope/${t.ref}`);
    case "person":
      return href(`/admin/users/${t.ref}`);
    case "service_account":
      return can.manageUsers(me) ? href("/admin/service-accounts") : href(`/admin/users/${t.ref}`);
    case "token":
      if (t.ref === me.id) return href("/account", { section: "tokens" });
      return t.owner_kind === "service" && can.manageUsers(me) ? href("/admin/service-accounts") : href(`/admin/users/${t.ref}`);
    case "proposal":
      return href(`/review/${t.ref}`);
    case "vulnerability":
      return href(`/security/${t.ref}`);
    case "team":
      return href(`/teams/${t.ref}`);
    case "project_request":
      return href("/review", { tab: "projects" });
    // Connections and routes live in their project's settings; the Team space's in Admin › Notifications.
    case "connection":
      return t.scope_kind === "team" ? href("/admin/notifications") : t.scope_kind === "project" ? href(`/scope/${t.ref}/settings`, { tab: "connections" }) : undefined;
    case "notification_route":
      return t.scope_kind === "team" ? href("/admin/notifications") : t.scope_kind === "project" ? href(`/scope/${t.ref}/settings`, { tab: "notifications" }) : undefined;
    case "repository":
      return t.scope_kind === "project" ? href(`/project/${t.ref}`) : undefined;
    default:
      return undefined;
  }
}

/** Readable lines for what changed: role and permission names, before → after, token grace periods. */
export function detailLines(e: AuditEntry, roles: CatalogRole[] | undefined): string[] {
  const d = e.details;
  if (!d) return [];
  const roleName = (k: string) => (k === "admin" ? "Administrator" : (roles?.find((r) => r.key === k)?.name ?? k));
  const permissionName = (k: string) => PERMISSION_LABELS[k] ?? k;
  const names = (v: unknown, name: (k: string) => string) => (Array.isArray(v) ? v.map((k) => name(String(k))).join(", ") : "");
  const isRoleChange = e.action !== "update_role" && e.action !== "create_role";
  const name = isRoleChange ? roleName : permissionName;
  const out: string[] = [];
  if (e.action === "set_team_member" || e.action === "set_team_membership") {
    const as = d.role === "lead" ? " as a lead" : d.role === "member" ? " as a member" : "";
    if (d.member === "added") out.push(`Added ${String(d.person ?? "someone")}${as}`);
    else if (d.member === "removed") out.push(`Removed ${String(d.person ?? "someone")}`);
    else if (d.member === "role changed") out.push(`Made ${String(d.person ?? "someone")} ${d.role === "lead" ? "a lead" : "a member"}`);
    return out;
  }
  if (typeof d.person === "string") out.push(`For ${d.person}`);
  if (typeof d.team === "string" && e.target?.kind !== "team") out.push(`Team ${d.team}`);
  if (Array.isArray(d.added) && d.added.length) out.push(`Added ${names(d.added, name)}`);
  if (Array.isArray(d.removed) && d.removed.length) out.push(`Removed ${names(d.removed, name)}`);
  if (Array.isArray(d.permissions)) out.push(`Allows ${names(d.permissions, permissionName) || "nothing"}`);
  // Names: a rename (roles, teams, people), a first name or a name removed (null before or after).
  if ("name_before" in d || "name_after" in d) {
    if (typeof d.name_before === "string" && typeof d.name_after === "string") out.push(`Renamed from ${d.name_before} to ${d.name_after}`);
    else if (typeof d.name_after === "string") out.push(`Name set to ${d.name_after}`);
    else if (typeof d.name_before === "string") out.push(`Name removed (was ${d.name_before})`);
  }
  if (d.account === "disabled") out.push("Disabled the account");
  if (d.account === "enabled") out.push("Enabled the account");
  if (typeof d.name === "string" && e.action === "update_user") out.push(`Name set to ${d.name}`);
  if (Array.isArray(d.roles) && d.roles.length) out.push(`Roles: ${names(d.roles, roleName)}`);
  if (typeof d.project === "string" && d.project) out.push(`Project ${d.project}${Array.isArray(d.project_roles) && d.project_roles.length ? ` as ${names(d.project_roles, roleName)}` : ""}`);
  if (Array.isArray(d.team_roles) && d.team_roles.length) out.push(`The team holds ${names(d.team_roles, roleName)} there`);
  if (typeof d.parent === "string" && d.parent) out.push(`Under ${d.parent}`);
  if (typeof d.identifier === "string") out.push(d.identifier);
  if (typeof d.token_name === "string" && e.target?.kind !== "token") out.push(`Token “${d.token_name}”`);
  const until = dateText(d.old_works_until);
  const expires = dateText(d.expires_at);
  if (typeof d.grace === "string") out.push(until ? `Old token works until ${until}` : d.grace === "none" ? "Old token stopped at once" : `Old token kept for ${d.grace === "7d" ? "7 days" : "1 day"}`);
  else if (expires) out.push(`Expires ${expires}`);
  if (Array.isArray(d.changes)) {
    for (const c of d.changes as { label?: string; setting?: string; change?: string; from?: unknown; to?: unknown; reset?: boolean }[]) {
      const what = c.label ?? c.setting ?? "Setting";
      if (c.change) out.push(`${what}: ${c.change}`);
      else out.push(`${what}: ${JSON.stringify(c.from ?? null)} → ${JSON.stringify(c.to ?? null)}${c.reset ? " (reset)" : ""}`);
    }
  }
  if (typeof d.visibility === "string") {
    const vis = d.visibility === "members" ? "Members only" : "Open to everyone";
    // Several projects changed at once list them; a new project just says how it starts.
    out.push(Array.isArray(d.projects) ? `${vis}: ${names(d.projects, String) || "no projects"}` : vis);
  }
  if (typeof d.preset === "string") out.push(`Preset ${typeof d.label === "string" ? d.label : d.preset}`);
  if (typeof d.slug === "string" && /project_request$|^request_project$/.test(e.action)) out.push(`Short name ${d.slug}`);
  if (typeof d.reason === "string") out.push(`Reason: ${d.reason}`);
  if (typeof d.app === "string") out.push(`App ${d.app}`);
  else if (typeof d.client_name === "string" && e.target?.kind !== "app") out.push(`App ${d.client_name}`);
  if (Array.isArray(d.settings) && d.settings.length) out.push(`Settings: ${d.settings.map(String).join(", ")}`);
  // Connections: what changed (field names; secrets only by name), where a route posts, what was called or read.
  if (Array.isArray(d.fields) && d.fields.length) out.push(`Changed ${d.fields.map(String).join(", ")}`);
  if (d.paused === true) out.push("Paused");
  if (d.paused === false) out.push("Resumed");
  if (Array.isArray(d.secret_changed) && d.secret_changed.length) out.push(`New ${d.secret_changed.map(String).join(", ")}`);
  if (typeof d.destination === "string" && e.target?.kind !== "notification_route") out.push(`To ${d.destination}`);
  if (Array.isArray(d.kinds)) out.push(d.kinds.length ? `Sends ${d.kinds.map(String).join(", ")}` : "Sends no notifications");
  if (typeof d.digest === "string" && d.digest !== "off") out.push(`Digest ${d.digest}`);
  if (typeof d.request === "string") out.push(d.request);
  if (typeof d.table === "string") out.push(`Table ${d.table}${Array.isArray(d.columns) && d.columns.length ? `: ${d.columns.map(String).join(", ")}` : ""}`);
  if (typeof d.ticket === "string") out.push(`Ticket ${d.ticket}`);
  if (typeof d.path === "string") out.push(`${typeof d.repository === "string" ? `${d.repository}: ` : ""}${d.path}${typeof d.ref === "string" ? ` @ ${d.ref}` : ""}`);
  if (d.filters && typeof d.filters === "object") {
    const f = Object.entries(d.filters as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "");
    out.push(f.length ? `Filters: ${f.map(([k, v]) => `${k} ${String(v)}`).join(", ")}` : "Everything");
  }
  return out;
}

function DetailsCell({ entry, roles }: { entry: AuditEntry; roles: CatalogRole[] | undefined }) {
  const lines = detailLines(entry, roles);
  if (!entry.details) return <span className="pp-audit-none">—</span>;
  return (
    <div className="pp-audit-details">
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
      <details className="pp-audit-raw">
        <summary>All details</summary>
        <pre>{JSON.stringify(entry.details, null, 2)}</pre>
      </details>
    </div>
  );
}

export function AuditLogPage({ me }: { me: Me }) {
  const route = useAppRoute();
  const [q, setQ] = useQueryState(route, {});
  const query = useMemo(() => apiQuery(q).toString(), [q]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [first, setFirst] = useState<AuditPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [tick, setTick] = useState(0);
  const [personText, setPersonText] = useState(q.person && EMAIL.test(q.person) ? q.person : "");
  const { data: catalog } = useRoles();
  const toast = useToast();

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    api<AuditPage>(`/audit${query ? `?${query}` : ""}`)
      .then((r) => {
        if (stale) return;
        setFirst(r);
        setPage(r);
      })
      .catch((e) => !stale && setError(e))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [query, tick]);

  // The person box shows the filter's email (or the account's, when the filter came from a row).
  useEffect(() => {
    if (!q.person) setPersonText("");
    else if (EMAIL.test(q.person)) setPersonText(q.person);
    else if (first?.person) setPersonText(first.person.email ?? first.person.name);
  }, [q.person, first?.person]);

  async function loadMore() {
    if (!page?.next_cursor) return;
    setMore(true);
    try {
      const p = apiQuery(q);
      p.set("cursor", page.next_cursor);
      const next = await api<AuditPage>(`/audit?${p.toString()}`);
      setPage({ ...page, entries: [...page.entries, ...next.entries], next_cursor: next.next_cursor });
    } catch (e) {
      toast.error(e, { title: "Couldn't load more" });
    } finally {
      setMore(false);
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const token = getToken();
      const res = await fetch(`/api/audit.csv${query ? `?${query}` : ""}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "thaliyola-audit.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Download started");
    } catch (e) {
      toast.error(e, { title: "Couldn't download the audit log", action: { label: "Try again", onClick: () => void download() } });
    } finally {
      setDownloading(false);
    }
  }

  const actions = first?.actions ?? [];
  const groups = (first?.groups ?? []).map((g) => ({ label: g.label, options: actions.filter((a) => a.group === g.key).map((a) => ({ value: a.key, label: a.label })) }));
  const actionLabel = (key: string) => actions.find((a) => a.key === key)?.label ?? key.replace(/_/g, " ");
  const personLabel = first?.person ? first.person.name : (q.person ?? "");
  const targetLabel = first?.target?.label ?? "this target";
  const filtered = !!(q.person || q.action || q.target || q.from || q.to);

  const active = [
    q.person ? { id: "person", label: `By ${personLabel}`, onRemove: () => setQ({ person: undefined }) } : null,
    q.action ? { id: "action", label: actionLabel(q.action), onRemove: () => setQ({ action: undefined }) } : null,
    q.target ? { id: "target", label: `About ${targetLabel}`, onRemove: () => setQ({ target: undefined }) } : null,
    q.from && DATE.test(q.from) ? { id: "from", label: `From ${shortDay(q.from)}`, onRemove: () => setQ({ from: undefined }) } : null,
    q.to && DATE.test(q.to) ? { id: "to", label: `To ${shortDay(q.to)}`, onRemove: () => setQ({ to: undefined }) } : null,
    q.reads === "true" ? { id: "reads", label: "Includes page views and searches", onRemove: () => setQ({ reads: undefined }) } : null,
  ].filter((x): x is { id: string; label: string; onRemove: () => void } => !!x);

  const columns: Column<AuditEntry>[] = [
    {
      key: "when",
      header: "When",
      width: "10rem",
      cell: (e) => (
        <time className="pp-audit-when" dateTime={e.at}>
          {formatTimestamp(e.at)}
        </time>
      ),
    },
    {
      key: "person",
      header: "Person",
      cell: (e) =>
        e.actor ? (
          <PersonChip
            name={e.actor.name !== e.actor.email ? e.actor.name : null}
            email={e.actor.email}
            kind={e.actor.kind}
            size="sm"
            href={href(`/admin/users/${e.actor.id}`)}
          />
        ) : (
          <span className="pp-audit-system">
            <I name="settings" /> Thaliyola
          </span>
        ),
    },
    {
      key: "action",
      header: "Action",
      primary: true,
      cell: (e) => (
        <span className="pp-audit-action">
          {e.label}
          {e.via === "mcp" && (
            <Badge tone="neutral" icon="bot">
              via Claude
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "target",
      header: "Target",
      cell: (e) => {
        if (!e.target) return <span className="pp-audit-none">—</span>;
        const link = targetHref(e.target, me);
        const text = e.target.label ?? "Unknown";
        return (
          <span className="pp-audit-target">
            {link ? <a href={link}>{text}</a> : <span>{text}</span>}
            {e.target.kind && <span className="pp-audit-kind">{TARGET_KIND[e.target.kind] ?? e.target.kind}</span>}
          </span>
        );
      },
    },
    { key: "details", header: "Details", cell: (e) => <DetailsCell entry={e} roles={catalog?.roles} /> },
  ];

  const rowMenu = (e: AuditEntry): MenuItemSpec[] => [
    ...(e.actor && q.person !== e.actor.id ? [{ id: "person", label: `Only what ${e.actor.name} did`, icon: "user" as const, onSelect: () => setQ({ person: e.actor!.id }) }] : []),
    ...(q.action !== e.action ? [{ id: "action", label: `Only “${e.label}”`, icon: "filter" as const, onSelect: () => setQ({ action: e.action }) }] : []),
    ...(e.target?.id && q.target !== e.target.id ? [{ id: "target", label: `Only about ${e.target.label ?? "this target"}`, icon: "filter" as const, onSelect: () => setQ({ target: e.target!.id! }) }] : []),
  ];

  return (
    <Page width="wide">
      <PageHeader
        title="Audit log"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        nav="admin"
        tabs={<AdminTabs current="audit" />}
        description="Who changed what, and when: accounts and roles, service accounts and tokens, settings, permanent deletions, content and reviews."
        info={{
          label: "About the audit log",
          content: (
            <>
              <p>Administrators and Auditors see it: it needs both Read every project and See usage.</p>
              <p>Secrets are never recorded: no tokens, passwords, invitation links or secret settings. Items in someone's personal space show as “A private note”.</p>
              <p>Page views and searches are left out unless you include them. The CSV has everything that matches the filters, up to 50,000 rows.</p>
            </>
          ),
        }}
        primary={
          <Button icon="download" loading={downloading} loadingText="Preparing" onClick={() => void download()}>
            Download CSV
          </Button>
        }
      />
      <FilterBar
        filters={
          <div className="pp-audit-filters">
            <Select
              aria-label="Action"
              value={q.action ?? ""}
              onChange={(e) => setQ({ action: e.target.value || undefined })}
              options={[{ value: "", label: "All actions" }, ...(q.action && !actions.some((a) => a.key === q.action) ? [{ value: q.action, label: actionLabel(q.action) }] : [])]}
              groups={groups}
            />
            <div className="pp-audit-person">
              <PersonInput
                label="Person"
                placeholder="Anyone (name or email)"
                value={personText}
                onChange={(v) => {
                  setPersonText(v);
                  if (EMAIL.test(v.trim())) setQ({ person: v.trim().toLowerCase() });
                  else if (!v.trim()) setQ({ person: undefined });
                }}
              />
            </div>
            <label className="pp-audit-date">
              <span>From</span>
              <TextInput type="date" value={q.from ?? ""} max={q.to || undefined} onChange={(e) => setQ({ from: e.target.value || undefined })} />
            </label>
            <label className="pp-audit-date">
              <span>To</span>
              <TextInput type="date" value={q.to ?? ""} min={q.from || undefined} onChange={(e) => setQ({ to: e.target.value || undefined })} />
            </label>
          </div>
        }
        more={{
          count: q.reads === "true" ? 1 : 0,
          content: (
            <Switch
              label="Include page views and searches"
              description="Reading pages, searching and listing, as well as changes."
              checked={q.reads === "true"}
              onChange={(on: boolean) => setQ({ reads: on ? "true" : undefined })}
            />
          ),
        }}
        active={active}
        onClearAll={active.length ? () => setQ({ person: undefined, action: undefined, target: undefined, from: undefined, to: undefined, reads: undefined }) : undefined}
      />
      {error && !page ? (
        <ErrorState error={error} title="Couldn't load the audit log" onRetry={() => setTick((t) => t + 1)} />
      ) : !page ? (
        <div aria-busy="true">
          <span className="sr-only" role="status">
            Loading the audit log…
          </span>
          <SkeletonRows count={8} />
        </div>
      ) : (
        <div aria-busy={loading || undefined}>
          {error ? <ErrorState compact error={error} title="Couldn't refresh the audit log" /> : null}
          <DataTable
            caption="Audit log"
            columns={columns}
            rows={page.entries}
            getRowId={(e) => e.id}
            rowMenu={rowMenu}
            density="compact"
            empty={
              <EmptyState
                variant="compact"
                icon="history"
                title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}
                description={filtered ? "Try a wider date range, another action or anyone." : "Changes to accounts, roles, tokens, settings and content appear here."}
                primary={
                  filtered ? (
                    <Button onClick={() => setQ({ person: undefined, action: undefined, target: undefined, from: undefined, to: undefined })}>Clear filters</Button>
                  ) : undefined
                }
              />
            }
          />
          {page.entries.length > 0 && (
            <LoadMore shown={page.entries.length} noun={["entry", "entries"]} onMore={page.next_cursor ? () => void loadMore() : undefined} busy={more} />
          )}
        </div>
      )}
    </Page>
  );
}
