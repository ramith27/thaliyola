import { Fragment, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type ScopeInfo } from "../api";
import { I, type IconName } from "../components/icons";
import {
  AsyncBlock,
  Button,
  Callout,
  Checkbox,
  ChoiceCards,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  focusFirstInvalid,
  humanizeError,
  ListRow,
  MetaLine,
  OverflowMenu,
  PasswordInput,
  RelativeTime,
  RowList,
  Section,
  Select,
  Sheet,
  SkeletonRows,
  Spinner,
  StatusBadge,
  Textarea,
  TextInput,
  useConfirm,
  useToast,
} from "../components/kit";
import { CONNECTION_GROUP, CONNECTION_KIND, humanize, plural } from "../components/labels";
import { useApi, useMediaQuery } from "../hooks";
import { href } from "../router";

/**
 * Project settings › Connections: the project's databases, APIs, git hosts and notification channels. People with
 * Manage settings add them, test them and see their health. Secret fields are write-only: the server says whether one
 * is stored (and the last characters of a long one); they can be replaced or removed, never read back.
 */

type Group = "database" | "api" | "git" | "notify" | "tracker";
type SyncKind = "schema" | "api" | "repos";
type When = { key: string; values: string[] } | undefined;

interface FieldInfo {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
  placeholder?: string;
  type: "text" | "number" | "url" | "select";
  options?: { value: string; label: string }[];
  default?: string;
  when?: When;
}
interface SecretInfo {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
  multiline: boolean;
  when?: When;
}
/**
 * Pausing a connection: scheduled kinds stop being checked (and synced); Slack channels and Trello lists stop getting
 * notifications and digests. Other kinds have nothing to pause (null).
 */
export function pauseLabel(c: { scheduled: boolean; group: Group; enabled: boolean }): string | null {
  if (c.scheduled) return c.enabled ? "Pause checks" : "Resume checks";
  if (c.group === "notify") return c.enabled ? "Pause notifications" : "Resume notifications";
  return null;
}

interface KindInfo {
  kind: string;
  label: string;
  group: Group;
  description: string;
  scheduled: boolean;
  /** Sync now brings something in: a database's tables ("schema"), an API's endpoints ("api"), repositories' facts ("repos"). */
  syncs?: boolean;
  sync_kind?: SyncKind | null;
  /** It can run read-only queries. */
  queries?: boolean;
  /** Fields that say where secrets go: changing one means entering the secrets again. */
  target_fields?: string[];
  fields: FieldInfo[];
  secret_fields: SecretInfo[];
  configured: boolean;
  needs: string | null;
}
interface Connection {
  id: string;
  kind: string;
  label: string;
  group: Group;
  name: string;
  scope: string;
  component: string | null;
  config: Record<string, string>;
  secrets: Record<string, { set: boolean; hint: string | null }>;
  options: Record<string, unknown>;
  interval_minutes: number;
  enabled: boolean;
  scheduled: boolean;
  syncs?: boolean;
  sync_kind?: SyncKind | null;
  queries?: boolean;
  /** HTTP APIs: a pasted OpenAPI spec (its size only). */
  spec?: { pasted: boolean; bytes: number } | null;
  synced_at: string | null;
  sync: { tables?: number; views?: number; endpoints?: number; repositories?: number; synced?: number; failed?: number; truncated?: boolean } | null;
  health: "untested" | "ok" | "failing";
  failures: number;
  last_ok_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  last_detail: string | null;
  warning: string | null;
  next_run_at: string | null;
  created_by: string | null;
  created_by_email?: string | null;
}
interface ConnectionsData {
  project: string;
  can_manage: boolean;
  enabled: boolean;
  key_set: boolean;
  connections: Connection[];
  kinds?: KindInfo[];
}
type TestResult = { ok: true; detail: string; warning: string | null } | { ok: false; error: string };

/** Headings for a list of one kind of connection only (Admin › Notifications). */
const ONLY_COPY: Partial<Record<Group, { title: string; description: string; icon: IconName; emptyTitle: string; emptyDescription: string }>> = {
  notify: {
    title: "Notification channels",
    description: "Slack channels and Trello lists that team-wide notifications can go to. Test posts a test message or card. Tokens are encrypted and never shown again.",
    icon: "bell",
    emptyTitle: "No Slack channel or Trello list yet",
    emptyDescription: "Add a Slack channel (a bot token or an incoming webhook) or a Trello list, then choose below which notifications go there.",
  },
  tracker: {
    title: "Issue trackers",
    description:
      "Jira and Linear connections every team-visible project can open tickets with, from a finding or article (a project's own trackers come first; members-only projects only use their own). Test checks the account and where new issues go; it creates nothing. Tokens are encrypted and never shown again.",
    icon: "ticket",
    emptyTitle: "No Jira or Linear connection yet",
    emptyDescription: "Add a Jira Cloud site or a Linear team, so people who can propose in a project can open tickets from its findings and articles.",
  },
};

const GROUP_ICON: Record<Group, IconName> = { database: "database", api: "globe", git: "git-branch", tracker: "ticket", notify: "bell" };
const GROUP_ORDER: Group[] = ["database", "api", "git", "tracker", "notify"];
const INTERVALS: [number, string][] = [
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Twice a day"],
  [1440, "Daily"],
  [10080, "Weekly"],
];
const intervalText = (m: number) => INTERVALS.find(([n]) => n === m)?.[1] ?? `Every ${m} min`;
const applies = (when: When, config: Record<string, string>) => !when || when.values.includes(config[when.key] ?? "");

/** One line saying what a connection points at (never a secret). */
export function target(c: Connection): string {
  const x = c.config;
  switch (c.kind) {
    case "postgres":
    case "redshift":
    case "mysql":
      return `${x.user}@${x.host}:${x.port}/${x.database}`;
    case "clickhouse":
      return `${x.url} · ${x.database ?? "default"}`;
    case "snowflake":
      return [x.account, x.user, x.database].filter(Boolean).join(" · ");
    case "bigquery":
      return x.project_id ? `Project ${x.project_id}` : "The key's project";
    case "http_api":
      return x.base_url ?? "";
    case "git":
      return x.api_url ?? (x.provider === "gitlab" ? "gitlab.com" : "github.com");
    case "slack":
      return x.channel ? `Channel ${x.channel}` : "Incoming webhook";
    case "trello":
      return `List ${x.list_id}`;
    // Where new issues go first (the line may be cut short on a phone), then the site.
    case "jira":
      return `${x.project_key} · ${x.issue_type ?? "Task"} on ${(x.site_url ?? "").replace(/^https:\/\/|\/+$/g, "")}`;
    case "linear":
      return `Team ${x.team}`;
    default:
      return "";
  }
}

/** What the last sync brought in, for the row's meta line. */
function syncedText(c: Connection): string | null {
  const s = c.sync;
  if (!c.syncs || !s) return null;
  if (c.sync_kind === "schema") return `${plural((s.tables ?? 0) + (s.views ?? 0), "table")} synced`;
  if (c.sync_kind === "api") return `${plural(s.endpoints ?? 0, "endpoint")} synced`;
  if (c.sync_kind === "repos") return s.repositories ? `${plural(s.synced ?? 0, "repository", "repositories")} synced` : null;
  return null;
}

/** Issue trackers: the other projects or teams whose linked issues a connection reads, for the row's meta line. */
export function alsoReadsText(c: Pick<Connection, "kind" | "options">): string | null {
  const keys = c.kind === "jira" ? c.options?.allowed_projects : c.kind === "linear" ? c.options?.allowed_teams : undefined;
  if (!Array.isArray(keys) || !keys.length) return null;
  return keys.includes("*") ? `Reads every ${c.kind === "jira" ? "project" : "team"}'s issues` : `Also reads ${(keys as string[]).join(", ")}`;
}

/** Which calls an API connection allows, for the row's meta line. */
function callsText(o: Record<string, unknown>): string {
  if (o.allow_calls === false) return "Calls off";
  const writes = Array.isArray(o.allow_write_methods) ? (o.allow_write_methods as string[]) : [];
  return writes.length ? `Calls: GET, ${writes.join(", ")}` : "Calls: GET only";
}

/**
 * `groups`: only these kinds of connection (Admin › Notifications shows the Team space's Slack and Trello ones).
 */
export function ConnectionsSettings({ scope, groups }: { scope: ScopeInfo; groups?: Group[] }) {
  const result = useApi<ConnectionsData>(`/projects/${scope.slug}/connections`);
  const { reload } = result;
  const only = (g: Group) => !groups || groups.includes(g);
  const data = useMemo(
    () => (result.data && groups ? { ...result.data, connections: result.data.connections.filter((c) => only(c.group)), kinds: result.data.kinds?.filter((k) => only(k.group)) } : result.data),
    [result.data, groups], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // One kind of connection only (Admin › Notifications: the Team space's channels, and its issue trackers).
  const only1 = groups && groups.length === 1 ? (ONLY_COPY[groups[0]!] ?? null) : null;
  const toast = useToast();
  const confirm = useConfirm();
  const [sheet, setSheet] = useState<{ connection: Connection | null } | null>(null);
  type Busy = "test" | "sync" | "toggle" | "remove";
  const [rows, setRows] = useState<Record<string, { busy?: Busy; error?: string }>>({});
  const patchRow = (id: string, patch: { busy?: Busy; error?: string } | null) =>
    setRows((r) => {
      const next = { ...r };
      if (patch === null) delete next[id];
      else next[id] = { ...r[id], ...patch };
      return next;
    });

  async function test(c: Connection) {
    patchRow(c.id, { busy: "test", error: undefined });
    try {
      const r = await api<TestResult>(`/connections/${c.id}/test`, { method: "POST" });
      patchRow(c.id, null);
      if (r.ok) toast.success(`${c.name} works`, { description: r.warning ? `${r.detail} ${r.warning}` : r.detail });
      else toast.error(r.error, { title: `${c.name} failed` });
      reload();
    } catch (e) {
      patchRow(c.id, { error: `Couldn't test it: ${humanizeError(e).title}` });
    }
  }

  async function sync(c: Connection) {
    patchRow(c.id, { busy: "sync", error: undefined });
    try {
      const r = await api<TestResult>(`/connections/${c.id}/sync`, { method: "POST" });
      patchRow(c.id, null);
      if (r.ok) toast.success(`Synced ${c.name}`, { description: r.warning ? `${r.detail} ${r.warning}` : r.detail });
      else toast.error(r.error, { title: `${c.name} didn't sync` });
      reload();
    } catch (e) {
      patchRow(c.id, { error: `Couldn't sync it: ${humanizeError(e).title}` });
    }
  }

  async function setEnabled(c: Connection, enabled: boolean) {
    await api(`/connections/${c.id}`, { method: "PATCH", body: { enabled } });
    reload();
  }

  async function toggle(c: Connection) {
    patchRow(c.id, { busy: "toggle", error: undefined });
    try {
      await setEnabled(c, !c.enabled);
      patchRow(c.id, null);
      toast.success(c.enabled ? `Paused ${c.name}` : `Resumed ${c.name}`, { undo: () => setEnabled(c, c.enabled) });
    } catch (e) {
      patchRow(c.id, { error: `Couldn't ${c.enabled ? "pause" : "resume"} it: ${humanizeError(e).title}` });
    }
  }

  async function remove(c: Connection) {
    const ok = await confirm({
      title: `Remove ${c.name}?`,
      body: "Its stored secret is deleted with it, and Thaliyola stops checking it. This can't be undone.",
      confirmLabel: "Remove connection",
      tone: "danger",
    });
    if (!ok) return;
    patchRow(c.id, { busy: "remove", error: undefined });
    try {
      await api(`/connections/${c.id}`, { method: "DELETE" });
      patchRow(c.id, null);
      toast.success(`Removed ${c.name}`);
      reload();
    } catch (e) {
      patchRow(c.id, { error: `Couldn't remove it: ${humanizeError(e).title}` });
    }
  }

  const canAdd = !!data?.kinds?.length;
  const add = (
    <Button icon="plus" onClick={() => setSheet({ connection: null })} disabledReason={canAdd ? undefined : "Wait for the page to load"}>
      Add connection
    </Button>
  );

  return (
    <Section
      title={only1 ? only1.title : "Connections"}
      count={data?.connections.length}
      description={
        only1
          ? only1.description
          : `The databases, APIs, git hosts, issue trackers and channels ${scope.name} uses. Thaliyola checks them on a schedule and tells this project's admins when one stops working. Passwords, tokens and keys are encrypted and never shown again.`
      }
      actions={data && data.connections.length > 0 && add}
    >
      {data && !data.enabled && (
        <Callout tone="warning" title="Connections are kept but not used right now.">
          They're turned off on this server, so nothing is checked or tested until an Administrator turns them back on.
        </Callout>
      )}
      {data && !data.key_set && (
        <Callout tone="warning" title="Passwords, tokens and keys can't be stored yet.">
          An Administrator needs to set the server's encryption key (<code>CONNECTIONS_KEY</code>) and restart it. Until then, only connections without a secret can be added.
        </Callout>
      )}
      <AsyncBlock result={{ ...result, data }} label="Loading connections" skeleton={<SkeletonRows count={3} />} errorTitle="Couldn't load connections">
        {(d) =>
          !d.connections.length ? (
            <EmptyState
              icon={only1 ? only1.icon : "plug"}
              title={only1 ? only1.emptyTitle : "No connections yet"}
              description={only1 ? only1.emptyDescription : "Connect a database, an API, a GitHub or GitLab token, Jira or Linear for tickets, or a Slack channel or Trello list for notifications."}
              primary={add}
            />
          ) : (
            <div className="cn-groups">
              {GROUP_ORDER.filter((g) => d.connections.some((c) => c.group === g)).map((g) => {
                const list = d.connections.filter((c) => c.group === g);
                const group = (
                  <RowList label={`${CONNECTION_GROUP[g] ?? g} of ${scope.name}`} refreshing={result.loading}>
                    {list.map((c) => {
                      const row = rows[c.id] ?? {};
                      return (
                        <ListRow
                          key={c.id}
                          leading={<I name={GROUP_ICON[c.group] ?? "plug"} size={20} />}
                          title={c.name}
                          badges={<StatusBadge domain="connection" value={c.enabled ? c.health : "paused"} />}
                          description={<span className="cn-target">{target(c)}</span>}
                          meta={
                            <MetaLine
                              items={[
                                c.label,
                                c.component ? `Repository ${c.component}` : null,
                                c.scheduled && c.enabled ? intervalText(c.interval_minutes) : null,
                                syncedText(c),
                                c.sync_kind === "schema" && c.options?.allow_query ? "Queries allowed" : null,
                                c.kind === "http_api" ? callsText(c.options) : null,
                                alsoReadsText(c),
                                c.last_ok_at ? <RelativeTime key="ok" prefix="Last worked " date={c.last_ok_at} /> : null,
                                c.health === "failing" && c.failures > 1 ? `${plural(c.failures, "failed check")} in a row` : null,
                              ]}
                            />
                          }
                          extra={
                            c.health === "failing" && c.last_error ? (
                              <Disclosure summary={<span className="cn-error-text">Why it failed</span>}>
                                <p className="cn-error-detail">{c.last_error}</p>
                              </Disclosure>
                            ) : c.warning ? (
                              <span className="pj-warn">
                                <I name="alert" size={14} /> {c.warning}
                              </span>
                            ) : undefined
                          }
                          error={row.error}
                          actions={
                            <>
                              {row.busy === "toggle" || row.busy === "remove" ? (
                                <span className="cn-row-busy" role="status">
                                  <Spinner />
                                  {row.busy === "remove" ? "Removing…" : c.enabled ? "Pausing…" : "Resuming…"}
                                </span>
                              ) : (
                                <Button
                                  size="sm"
                                  icon="refresh"
                                  loading={row.busy === "test" || row.busy === "sync"}
                                  loadingText={row.busy === "sync" ? "Syncing…" : "Testing…"}
                                  onClick={() => void (c.syncs && c.enabled ? sync(c) : test(c))}
                                  disabledReason={d.enabled ? undefined : "Connections are turned off on this server"}
                                >
                                  {c.syncs && c.enabled ? "Sync now" : "Test"}
                                </Button>
                              )}
                              <OverflowMenu
                                label={`More actions for ${c.name}`}
                                size="sm"
                                items={[
                                  { id: "edit", label: "Edit…", icon: "pencil", onSelect: () => setSheet({ connection: c }), disabledReason: row.busy === "remove" ? "Wait for the current action to finish" : undefined },
                                  ...(c.syncs
                                    ? [
                                        {
                                          id: "test",
                                          label: "Test only",
                                          icon: "check-circle" as IconName,
                                          onSelect: () => void test(c),
                                          disabledReason: !d.enabled ? "Connections are turned off on this server" : row.busy ? "Wait for the current action to finish" : undefined,
                                        },
                                      ]
                                    : []),
                                  ...(c.sync_kind === "schema" ? [{ id: "data", label: "Open its tables", icon: "table" as IconName, href: href(`/project/${scope.slug}`, { tab: "data" }) }] : []),
                                  ...(c.sync_kind === "api" ? [{ id: "data", label: "Open its endpoints", icon: "globe" as IconName, href: href(`/project/${scope.slug}`, { tab: "data", api: c.id }) }] : []),
                                  ...(pauseLabel(c)
                                    ? [
                                        {
                                          id: "toggle",
                                          label: pauseLabel(c)!,
                                          icon: (c.enabled ? "pause" : "play") as IconName,
                                          onSelect: () => void toggle(c),
                                          disabledReason: row.busy ? "Wait for the current action to finish" : undefined,
                                        },
                                      ]
                                    : []),
                                  { type: "separator" as const },
                                  { id: "remove", label: "Remove…", icon: "trash", tone: "danger" as const, onSelect: () => void remove(c), disabledReason: row.busy ? "Wait for the current action to finish" : undefined },
                                ]}
                              />
                            </>
                          }
                        />
                      );
                    })}
                  </RowList>
                );
                // One kind of connection only (Admin › Notifications): the page's own heading names it.
                return only1 ? (
                  <Fragment key={g}>{group}</Fragment>
                ) : (
                  <Section key={g} level={3} title={CONNECTION_GROUP[g] ?? humanize(g)} count={list.length}>
                    {group}
                  </Section>
                );
              })}
            </div>
          )
        }
      </AsyncBlock>
      {!only1 && (
        <Disclosure summary="Keeping connections safe" storageKey="cn-safety" className="cn-safety">
          <ul className="cn-notes">
            <li>Use a read-only database user (SELECT only). Thaliyola reads schemas and only ever runs read-only queries.</li>
            <li>Databases sync their tables into this project, one article each, under Data. Turn on read-only queries to let Contributors and Claude run small SELECTs (30 a minute each, logged; columns marked as personal data are masked).</li>
            <li>APIs bring their OpenAPI spec in as an API contract, and Contributors and Claude can call them through Thaliyola: GET and HEAD only unless you allow more, only under the paths you list, each call logged. Thaliyola adds the credentials itself.</li>
            <li>A GitHub or GitLab token lets Thaliyola read this project's private repositories: their default branch, last commit and open pull requests, their stack, and files Claude asks for (read-only, logged). Use a read-only token.</li>
            <li>Databases can be on your private network. APIs, git hosts, Slack and Trello must be on the internet unless an Administrator allows private networks.</li>
            <li>Slack channels and Trello lists get the notifications you choose under Notifications (Test posts a test message or card there).</li>
            <li>Jira and Linear let Contributors and Claude open a ticket from a finding or article (it links back here) and show linked tickets' status. Issues are created and read as the connection's account: use one that sees only the projects you mean. Test creates nothing.</li>
            <li>Secrets are encrypted on the server and only used to connect. Nobody, Claude included, can read them back.</li>
          </ul>
        </Disclosure>
      )}
      {sheet && data?.kinds && (
        <ConnectionSheet
          scope={scope}
          connection={sheet.connection}
          kinds={data.kinds}
          enabled={data.enabled}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

interface Form {
  kind: string;
  name: string;
  config: Record<string, string>;
  /** Secret values typed in (new, or replacing a stored one). */
  secrets: Record<string, string>;
  /** Stored secrets the person chose to replace (show an input) or remove. */
  replacing: string[];
  removing: string[];
  every: number;
  component: string;
  /** Databases: read-only queries, which schemas to sync, and how many tables at most. */
  allowQuery: boolean;
  include: string;
  exclude: string;
  maxObjects: string;
  /** APIs: calls on or off, other methods than GET and HEAD, the paths calls may reach. */
  allowCalls: boolean;
  writeMethods: string[];
  prefixes: string;
  /** Issue trackers: other Jira projects or Linear teams whose linked issues it reads (besides its own). */
  alsoReads: string;
  /** APIs: a pasted spec (typed in), and what to do with the stored one. */
  spec: string;
  specAction: "keep" | "replace" | "remove";
}

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

const listText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
const listOf = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

const defaults = (k: KindInfo) => Object.fromEntries(k.fields.filter((f) => f.default).map((f) => [f.key, f.default!]));

/** Add a connection, or edit one: a right sheet on desktop, a bottom sheet on phones. */
function ConnectionSheet({
  scope,
  connection,
  kinds,
  enabled,
  onClose,
  onSaved,
}: {
  scope: ScopeInfo;
  connection: Connection | null;
  kinds: KindInfo[];
  enabled: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!connection;
  const phone = useMediaQuery("(max-width: 640px)");
  const initial = useMemo<Form>(() => {
    if (connection) {
      const o = connection.options ?? {};
      return {
        kind: connection.kind,
        name: connection.name,
        config: { ...connection.config },
        secrets: {},
        replacing: [],
        removing: [],
        every: connection.interval_minutes,
        component: connection.component ?? "",
        allowQuery: o.allow_query === true,
        include: listText(o.schemas_include),
        exclude: listText(o.schemas_exclude),
        maxObjects: typeof o.max_objects === "number" ? String(o.max_objects) : "",
        allowCalls: o.allow_calls !== false,
        writeMethods: Array.isArray(o.allow_write_methods) ? (o.allow_write_methods as string[]) : [],
        prefixes: listText(o.path_prefixes),
        alsoReads: listText(connection.kind === "jira" ? o.allowed_projects : o.allowed_teams),
        spec: "",
        specAction: "keep",
      };
    }
    const first = kinds.find((k) => k.configured) ?? kinds[0]!;
    return {
      kind: first.kind,
      name: "",
      config: defaults(first),
      secrets: {},
      replacing: [],
      removing: [],
      every: 360,
      component: "",
      allowQuery: false,
      include: "",
      exclude: "",
      maxObjects: "",
      allowCalls: true,
      writeMethods: [],
      prefixes: "",
      alsoReads: "",
      spec: "",
      specAction: "keep",
    };
  }, [connection, kinds]);
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<{ during: "test" | "save"; error: unknown } | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const info = kinds.find((k) => k.kind === form.kind) ?? kinds[0]!;
  const stored = connection?.secrets ?? {};
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const intervals = INTERVALS.some(([m]) => m === form.every) ? INTERVALS : [...INTERVALS, [form.every, intervalText(form.every)] as [number, string]];
  const fields = info.fields.filter((f) => applies(f.when, form.config));
  const tracker = form.kind === "jira" || form.kind === "linear";
  const secretFields = info.secret_fields.filter((f) => applies(f.when, form.config));
  const needsKey = !info.configured && secretFields.some((f) => form.secrets[f.key]?.trim() || f.required);
  const blocked = needsKey ? `${info.label} needs a password, token or key, and the server can't store one until an Administrator sets ${info.needs}.` : undefined;

  const touch = () => {
    setResult(null);
    setError(null);
  };
  const setField = (key: string, value: string) => {
    setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));
    setErrors((e) => ({ ...e, [key]: "" }));
    touch();
  };
  const setSecret = (key: string, value: string) => {
    setForm((f) => ({ ...f, secrets: { ...f.secrets, [key]: value } }));
    setErrors((e) => ({ ...e, [`secret:${key}`]: "" }));
    touch();
  };
  // Pointing it somewhere else: the server won't send stored secrets there, so they have to be entered again.
  const moved = !!connection && (info.target_fields ?? []).some((k) => (form.config[k] ?? "") !== (connection.config[k] ?? ""));
  const isStored = (key: string) => !moved && !!stored[key]?.set && !form.replacing.includes(key) && !form.removing.includes(key);

  function pickKind(kind: string) {
    const next = kinds.find((k) => k.kind === kind);
    if (!next) return;
    setForm((f) => ({ ...f, kind, config: defaults(next), secrets: {}, replacing: [], removing: [] }));
    setErrors({});
    touch();
  }

  function validate() {
    const errs: Record<string, string> = {};
    for (const f of fields) if (f.required && !(form.config[f.key] ?? "").trim()) errs[f.key] = `Add the ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}.`;
    for (const f of secretFields) if (f.required && !isStored(f.key) && !(form.secrets[f.key] ?? "").trim()) errs[`secret:${f.key}`] = `Add the ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}.`;
    if (info.sync_kind === "api") {
      if (listOf(form.prefixes).some((x) => !/^\/[^\s?#]*$/.test(x) || x.includes(".."))) errs.prefixes = "Paths start with /, separated by commas (e.g. /v1/orders).";
      const n = Number(form.maxObjects);
      if (form.maxObjects.trim() && (!Number.isInteger(n) || n < 1 || n > 5000)) errs.maxObjects = "Enter a whole number from 1 to 5,000.";
      if (new Blob([form.spec]).size > 900 * 1024) errs.spec = "The spec is larger than 900 KB: give its URL instead.";
    }
    if (info.sync_kind === "schema") {
      const n = Number(form.maxObjects);
      if (form.maxObjects.trim() && (!Number.isInteger(n) || n < 1 || n > 5000)) errs.maxObjects = "Enter a whole number from 1 to 5,000.";
      for (const [key, value] of [["include", form.include], ["exclude", form.exclude]] as const) {
        if (listOf(value).some((x) => !/^[A-Za-z0-9_$.*-]{1,128}$/.test(x))) errs[key] = "Schema names, separated by commas (* matches anything).";
      }
    }
    if (tracker && listOf(form.alsoReads).some((x) => !(form.kind === "jira" ? /^(\*|[A-Za-z][A-Za-z0-9_]{0,19})$/ : /^(\*|[A-Za-z0-9][A-Za-z0-9_]{0,9})$/).test(x))) {
      errs.alsoReads = form.kind === "jira" ? "Project keys, separated by commas (e.g. HR, SEC), or * for any." : "Team keys, separated by commas (e.g. DES, OPS), or * for any.";
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => formRef.current && focusFirstInvalid(formRef.current));
      return false;
    }
    return true;
  }

  const config = () => Object.fromEntries(fields.map((f) => [f.key, (form.config[f.key] ?? "").trim()]).filter(([, v]) => v));
  /** Typed values replace; removed ones are sent as null; untouched stored ones aren't sent (the server keeps them). */
  const secret = () => {
    const out: Record<string, string | null> = {};
    for (const f of secretFields) {
      const v = (form.secrets[f.key] ?? "").trim();
      if (v) out[f.key] = v;
      else if (form.removing.includes(f.key)) out[f.key] = null;
    }
    return out;
  };

  async function run(kind: "test" | "save", fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ during: kind, error: e });
    } finally {
      setBusy(null);
    }
  }

  function doTest() {
    if (!validate()) return;
    void run("test", async () => {
      setResult(await api<TestResult>(`/projects/${scope.slug}/connections/test`, { method: "POST", body: { kind: form.kind, id: connection?.id, config: config(), secret: secret() } }));
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !validate()) return;
    void run("save", async () => {
      const options =
        info.sync_kind === "schema"
          ? {
              allow_query: form.allowQuery,
              schemas_include: listOf(form.include),
              schemas_exclude: listOf(form.exclude),
              ...(form.maxObjects.trim() ? { max_objects: Number(form.maxObjects) } : {}),
            }
          : info.sync_kind === "api"
            ? {
                allow_calls: form.allowCalls,
                allow_write_methods: form.allowCalls ? form.writeMethods : [],
                path_prefixes: listOf(form.prefixes),
                ...(form.maxObjects.trim() ? { max_objects: Number(form.maxObjects) } : {}),
              }
            : tracker
              ? { [form.kind === "jira" ? "allowed_projects" : "allowed_teams"]: listOf(form.alsoReads).map((x) => x.toUpperCase()) }
              : undefined;
      // A pasted spec: typed in replaces, "Remove" removes, otherwise the stored one stays.
      const spec = info.sync_kind !== "api" ? undefined : form.spec.trim() ? form.spec : form.specAction === "remove" ? null : undefined;
      const body = { name: form.name.trim() || undefined, config: config(), secret: secret(), options, interval_minutes: info.scheduled ? form.every : undefined, component: form.component || null, spec };
      if (connection) {
        const c = await api<Connection>(`/connections/${connection.id}`, { method: "PATCH", body });
        toast.success(`Saved ${c.name}`);
        onSaved();
        return;
      }
      const c = await api<Connection>(`/projects/${scope.slug}/connections`, { method: "POST", body: { kind: form.kind, ...body } });
      if (!enabled) {
        toast.success(`Added ${c.name}`);
        onSaved();
        return;
      }
      // Test it right away (databases: sync it), so the list shows whether it works.
      const r = await api<TestResult>(`/connections/${c.id}/${info.syncs ? "sync" : "test"}`, { method: "POST" }).catch((err: unknown) => ({ ok: false as const, error: humanizeError(err).title }));
      if (r.ok) toast.success(`Added ${c.name}`, { description: r.detail });
      else toast.warning(`Added ${c.name}, but the test failed: ${r.error}`, { duration: 10000 });
      onSaved();
    });
  }

  async function close() {
    if (busy) return;
    if (dirty) {
      const ok = await confirm({
        title: editing ? "Discard your changes?" : "Discard this connection?",
        body: "What you entered here is lost.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      });
      if (!ok) return;
    }
    onClose();
  }

  const componentOptions = [{ value: "", label: "None" }, ...scope.components.map((c) => ({ value: c.slug, label: c.slug }))];

  return (
    <Sheet
      open
      side={phone ? "bottom" : "right"}
      onClose={() => void close()}
      dismissible={!busy}
      title={editing ? `Edit ${connection!.name}` : "Add a connection"}
      description={editing ? undefined : "Thaliyola tests it now, then checks it on a schedule."}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()} disabled={!!busy}>
            Cancel
          </Button>
          <Button
            onClick={doTest}
            loading={busy === "test"}
            loadingText="Testing…"
            disabledReason={!enabled ? "Connections are turned off on this server" : (blocked ?? (busy === "save" ? "Wait for the save to finish" : undefined))}
          >
            Test
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy === "save"}
            loadingText={editing ? "Saving…" : "Adding and testing…"}
            disabledReason={blocked ?? (busy === "test" ? "Wait for the test to finish" : undefined)}
          >
            {editing ? "Save changes" : "Add connection"}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="cn-form" onSubmit={submit} noValidate autoComplete="off">
        {editing ? (
          <p className="cn-kind-fixed">
            <I name={GROUP_ICON[info.group] ?? "plug"} size={16} /> {info.label}
          </p>
        ) : (
          <>
            <ChoiceCards
              name={`${formId}-kind`}
              legend="What to connect"
              value={form.kind}
              onChange={(v) => pickKind(v as string)}
              columns={2}
              options={kinds.map((k) => ({ value: k.kind, label: k.label ?? CONNECTION_KIND[k.kind] ?? humanize(k.kind), icon: GROUP_ICON[k.group] ?? "plug" }))}
            />
            <p className="cn-kind-note">{info.description}</p>
          </>
        )}
        {blocked && <Callout tone="warning">{blocked}</Callout>}

        {fields.map((f) => (
          <Field key={`${form.kind}-${f.key}`} label={f.label} optional={!f.required && !f.default} hint={f.hint} error={errors[f.key] || null}>
            {f.type === "select" ? (
              <Select value={form.config[f.key] ?? f.default ?? ""} onChange={(e) => setField(f.key, e.target.value)} options={f.options ?? []} />
            ) : (
              <TextInput
                value={form.config[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                inputMode={f.type === "number" ? "numeric" : f.type === "url" ? "url" : undefined}
                autoCapitalize="off"
                spellCheck={false}
              />
            )}
          </Field>
        ))}

        {secretFields.map((f) =>
          isStored(f.key) ? (
            <fieldset key={`${form.kind}-secret-${f.key}`} className="cn-secret">
              <legend className="cn-secret-label">{f.label}</legend>
              <div className="cn-secret-row">
                <span className="cn-secret-value">
                  <I name="lock" size={14} /> Stored{stored[f.key]?.hint ? ` (ends in ${stored[f.key]!.hint})` : ""}
                </span>
                <span className="cn-secret-tools">
                  <Button size="sm" variant="ghost" icon="pencil" onClick={() => (setForm((x) => ({ ...x, replacing: [...x.replacing, f.key] })), touch())}>
                    Replace
                  </Button>
                  {!f.required && (
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => (setForm((x) => ({ ...x, removing: [...x.removing, f.key] })), touch())}>
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            </fieldset>
          ) : (
            <Field
              key={`${form.kind}-secret-${f.key}`}
              label={f.label}
              optional={!f.required}
              hint={
                moved && stored[f.key]?.set
                  ? "Enter it again: you changed where this connection points (or its encryption), and stored secrets only go where and how they were first used."
                  : form.removing.includes(f.key)
                    ? "Removed when you save. Type a new one to replace it instead."
                    : (f.hint ?? (stored[f.key]?.set ? "Replaces the stored one when you save." : undefined))
              }
              error={errors[`secret:${f.key}`] || null}
            >
              {f.multiline ? (
                <Textarea value={form.secrets[f.key] ?? ""} onChange={(e) => setSecret(f.key, e.target.value)} mono minRows={4} autoGrow maxRows={10} spellCheck={false} autoComplete="off" />
              ) : (
                <PasswordInput value={form.secrets[f.key] ?? ""} onChange={(e) => setSecret(f.key, e.target.value)} autoComplete="new-password" spellCheck={false} />
              )}
            </Field>
          ),
        )}

        {info.sync_kind === "api" && (
          <ApiOptions
            form={form}
            stored={connection?.spec ?? null}
            errors={errors}
            onChange={(patch) => {
              setForm((f) => ({ ...f, ...patch }));
              setErrors((x) => ({ ...x, ...Object.fromEntries(Object.keys(patch).map((k) => [k, ""])) }));
              touch();
            }}
          />
        )}
        {tracker && (
          <fieldset className="cn-options">
            <legend className="cn-secret-label">Linked issues</legend>
            <p className="cn-kind-note cn-spec-note">
              Linked issues from the {form.kind === "jira" ? "project" : "team"} above show their title and status to everyone who can read the page they're on. Issues from other {form.kind === "jira" ? "projects" : "teams"} stay plain links unless you add them here.
            </p>
            <Field label={form.kind === "jira" ? "Other projects it reads" : "Other teams it reads"} optional hint={form.kind === "jira" ? "Project keys, separated by commas; * for every project the account can see." : "Team keys, separated by commas; * for every team the key can see."} error={errors.alsoReads || null}>
              <TextInput value={form.alsoReads} onChange={(e) => (setForm((f) => ({ ...f, alsoReads: e.target.value })), setErrors((x) => ({ ...x, alsoReads: "" })), touch())} placeholder={form.kind === "jira" ? "SUP, INFRA" : "DES, OPS"} autoCapitalize="characters" spellCheck={false} />
            </Field>
          </fieldset>
        )}
        {info.sync_kind === "schema" && (
          <fieldset className="cn-options">
            <legend className="cn-secret-label">Tables and queries</legend>
            <Checkbox
              label="Allow read-only queries"
              description="Contributors and Claude can run small SELECTs through Thaliyola (30 a minute each, every one logged). Columns marked as personal data are masked."
              checked={form.allowQuery}
              onChange={(e) => (setForm((f) => ({ ...f, allowQuery: e.target.checked })), touch())}
            />
            <Field label="Schemas to sync" optional hint={form.kind === "mysql" ? "Databases on the server, separated by commas; * matches anything. Empty: just this database." : "Separated by commas; * matches anything. Empty: every schema."} error={errors.include || null}>
              <TextInput value={form.include} onChange={(e) => (setForm((f) => ({ ...f, include: e.target.value })), setErrors((x) => ({ ...x, include: "" })), touch())} placeholder="public, sales_*" autoCapitalize="off" spellCheck={false} />
            </Field>
            <Field label="Schemas to skip" optional error={errors.exclude || null}>
              <TextInput value={form.exclude} onChange={(e) => (setForm((f) => ({ ...f, exclude: e.target.value })), setErrors((x) => ({ ...x, exclude: "" })), touch())} placeholder="tmp_*, staging" autoCapitalize="off" spellCheck={false} />
            </Field>
            <Field label="Most tables to sync" optional hint="500 when empty. Each table becomes an article under Data." error={errors.maxObjects || null}>
              <TextInput value={form.maxObjects} onChange={(e) => (setForm((f) => ({ ...f, maxObjects: e.target.value })), setErrors((x) => ({ ...x, maxObjects: "" })), touch())} inputMode="numeric" placeholder="500" />
            </Field>
          </fieldset>
        )}
        {info.scheduled && (
          <Field label={info.syncs ? "How often to sync" : "How often to check"} hint={info.sync_kind === "api" ? "Thaliyola reads the spec again and records what changed." : undefined}>
            <Select value={String(form.every)} onChange={(e) => (setForm((f) => ({ ...f, every: Number(e.target.value) })), touch())} options={intervals.map(([m, label]) => ({ value: String(m), label }))} />
          </Field>
        )}
        {scope.components.length > 0 && (
          <Field label="Repository" optional hint="The repository this belongs to (its token, or the service that provides the API).">
            <Select value={form.component} onChange={(e) => setForm((f) => ({ ...f, component: e.target.value }))} options={componentOptions} />
          </Field>
        )}
        <Field label="Name" optional hint={editing ? undefined : "Leave it empty to name it after the database or address."}>
          <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Orders database (read replica)" maxLength={80} />
        </Field>

        {result && (
          <Callout tone={result.ok ? (result.warning ? "warning" : "success") : "danger"} title={result.ok ? "It works" : "It didn't work"}>
            {result.ok ? (
              <>
                {result.detail}
                {result.warning && <> {result.warning}</>}
              </>
            ) : (
              <span className="cn-error-detail">{result.error}</span>
            )}
          </Callout>
        )}
        {error && <ErrorState compact error={error.error} title={error.during === "test" ? "Couldn't test the connection" : editing ? "Couldn't save your changes" : "Couldn't add the connection"} />}
      </form>
    </Sheet>
  );
}

/** An API connection's spec (pasted, when there's no spec URL) and what calls it allows. */
function ApiOptions({
  form,
  stored,
  errors,
  onChange,
}: {
  form: Form;
  stored: { pasted: boolean; bytes: number } | null;
  errors: Record<string, string>;
  onChange(patch: Partial<Form>): void;
}) {
  const hasUrl = !!form.config.spec_url?.trim();
  const showStored = !!stored && form.specAction === "keep" && !form.spec;
  return (
    <>
      <fieldset className="cn-options">
        <legend className="cn-secret-label">OpenAPI spec</legend>
        {hasUrl ? (
          <p className="cn-kind-note cn-spec-note">Thaliyola reads the spec from its URL on every sync and keeps one API contract article with its endpoints.</p>
        ) : showStored ? (
          <div className="cn-secret-row">
            <span className="cn-secret-value">
              <I name="doc" size={14} /> Pasted spec stored ({Math.max(1, Math.round(stored!.bytes / 1024))} KB)
            </span>
            <span className="cn-secret-tools">
              <Button size="sm" variant="ghost" icon="pencil" onClick={() => onChange({ specAction: "replace" })}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => onChange({ specAction: "remove" })}>
                Remove
              </Button>
            </span>
          </div>
        ) : (
          <Field
            label="Paste the spec"
            optional
            hint={form.specAction === "remove" && !form.spec ? hasUrl ? "Removed when you save. The spec URL above is synced instead." : "Removed when you save. The next sync marks the endpoints it gave as removed and the API contract as possibly stale, until a spec is given again." : "JSON or YAML (OpenAPI 3 or Swagger 2), up to 900 KB. Or give its URL above."}
            error={errors.spec || null}
          >
            <Textarea value={form.spec} onChange={(e) => onChange({ spec: e.target.value })} mono minRows={4} autoGrow maxRows={12} spellCheck={false} placeholder={"openapi: 3.0.3\ninfo:\n  title: Orders API"} />
          </Field>
        )}
      </fieldset>
      <fieldset className="cn-options">
        <legend className="cn-secret-label">Calls</legend>
        <Checkbox
          label="Allow calls through Thaliyola"
          description="Contributors and Claude can call this API with call_api (30 a minute each, every one logged). Thaliyola adds the credentials; nobody sees them."
          checked={form.allowCalls}
          onChange={(e) => onChange({ allowCalls: e.target.checked })}
        />
        {form.allowCalls && (
          <>
            <fieldset className="cn-methods">
              <legend className="cn-methods-label">Methods besides GET and HEAD</legend>
              <div className="cn-methods-list">
                {WRITE_METHODS.map((m) => (
                  <Checkbox
                    key={m}
                    label={m}
                    checked={form.writeMethods.includes(m)}
                    onChange={(e) => onChange({ writeMethods: e.target.checked ? [...form.writeMethods, m] : form.writeMethods.filter((x) => x !== m) })}
                  />
                ))}
              </div>
              <p className="cn-kind-note cn-spec-note">Leave them off unless agents should change data through this API.</p>
            </fieldset>
            <Field label="Allowed paths" optional hint="Calls may only reach paths under these, separated by commas. Empty: any path under the base URL." error={errors.prefixes || null}>
              <TextInput value={form.prefixes} onChange={(e) => onChange({ prefixes: e.target.value })} placeholder="/orders, /refunds" autoCapitalize="off" spellCheck={false} />
            </Field>
          </>
        )}
        <Field label="Most endpoints to sync" optional hint="500 when empty." error={errors.maxObjects || null}>
          <TextInput value={form.maxObjects} onChange={(e) => onChange({ maxObjects: e.target.value })} inputMode="numeric" placeholder="500" />
        </Field>
      </fieldset>
    </>
  );
}
