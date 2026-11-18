import { useId, useRef, useState, type FormEvent } from "react";
import { ProjectSkillsCard } from "./skills";
import { ACCOUNT_STATUS_TEXT, api, canIn, type AccountStatus, type MemberChange, type Me, type ScopeInfo, type TeamChange } from "../api";
import { useBoot, usePageMeta } from "../components/boot";
import { I } from "../components/icons";
import { humanize, plural, REPO_KIND } from "../components/labels";
import { PersonInput } from "../components/people";
import { can } from "../components/permissions";
import { changedText, namesOr, PermissionMatrix, roleDelta, RolePicker, useRoles, type CatalogRole } from "../components/roles";
import {
  displayName,
  AsyncBlock,
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ChoiceCards,
  CodeBlock,
  CopyButton,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  humanizeError,
  InfoTip,
  ListRow,
  MetaLine,
  OverflowMenu,
  Page,
  PageHeader,
  ProjectPicker,
  RelativeTime,
  RowList,
  SaveBar,
  Section,
  Select,
  SkeletonRows,
  SkeletonText,
  StatusBadge,
  Stepper,
  Tabs,
  Textarea,
  TextInput,
  useAsyncAction,
  useConfirm,
  useToast,
  Dialog,
  focusFirstInvalid,
  projectSwitcher,
  type Crumb,
} from "../components/kit";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";
import { ConnectionsSettings } from "./connections";
import { NotificationRoutes } from "./notification-routes";
import { ExportButton } from "./setup";

const KINDS = ["backend", "frontend", "mobile", "data", "infra", "other"];
const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: REPO_KIND[k] ?? humanize(k) }));
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const repoName = (url: string) => (url.replace(/(\.git)?\/*$/, "").split(/[/:]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");

/** The projects above a scope, top first (for the breadcrumbs). */
function ancestors(scope: ScopeInfo, scopes: ScopeInfo[]): ScopeInfo[] {
  const bySlug = new Map(scopes.map((s) => [s.slug, s]));
  const out: ScopeInfo[] = [];
  let p = scope.parent ? bySlug.get(scope.parent) : undefined;
  for (let guard = 0; p && guard < 10; guard++) {
    out.unshift(p);
    p = p.parent ? bySlug.get(p.parent) : undefined;
  }
  return out;
}

const scopeHref = (s: ScopeInfo) => href(s.kind === "project" ? `/project/${s.slug}` : `/scope/${s.slug}`);

interface Access {
  scope: string;
  project_name?: string;
  kind: string;
  visibility: "team" | "members";
  /** One sentence: who can see it and how many people have a role here. */
  summary?: string;
  people: {
    id?: string;
    email: string;
    name: string | null;
    role: string;
    roles: string[];
    role_names?: string[];
    pending: boolean;
    account?: AccountStatus;
    kind?: "human" | "service";
  }[];
  teams: {
    slug: string;
    name: string;
    role: string;
    roles: string[];
    role_names?: string[];
    members: string[];
    member_list?: { id?: string; email: string; name: string | null; team_role: "member" | "lead" }[];
  }[];
  /** Roles people hold here because they hold them in a project above. */
  inherited?: { id?: string; email: string; name: string | null; roles: string[]; role_names?: string[]; sources: { slug: string; name: string; team: string | null }[] }[];
  total_people: number;
  my_role: string | null;
  my_roles: string[];
  my_role_names?: string[];
  effective_permissions?: string[];
  can_manage: boolean;
  can_manage_members?: boolean;
  can_manage_settings?: boolean;
  /** Who may comment, propose or verify because nobody here holds that permission (team-visible projects). */
  open_to_everyone?: { read: boolean; comment: boolean; propose: boolean; verify: boolean };
  /** Members-only projects: people who see it through an organisation role (names only for those who manage access). */
  org_wide?: { count: number; people: { email: string; name: string | null; why: string[] }[] | null } | null;
}

/** An unknown slug (or one the person can't see): the shell's NotFound look, with a way home. */
function ScopeNotFound() {
  usePageMeta({ title: "Project or space not found" });
  return (
    <Page>
      <h1 className="sr-only">Project or space not found</h1>
      <EmptyState
        icon="search"
        title="Project or space not found"
        description="It doesn't exist, it was moved to the trash, or you can't see it."
        primary={
          <Button variant="primary" href={href("/")}>
            Back to Home
          </Button>
        }
      />
    </Page>
  );
}

/**
 * Settings for one scope. Projects have their own access control (people and teams with roles, visibility), their
 * repositories, connections and name. Manage settings (General, Repositories, Connections, Documentation) and Manage access (Members and
 * access) are separate permissions; Project admins have both. Team and Library settings are for Administrators.
 */
/**
 * The settings tabs someone may open: with Manage settings, a project's General, Access, Repositories, Connections,
 * Notifications (its Slack and Trello routes) and Documentation (the Team space and Library: General and Access);
 * without it, Access only.
 */
export function settingsTabs(settings: boolean, project: boolean): string[] {
  return settings ? (project ? ["general", "access", "repos", "connections", "notifications", "docs"] : ["general", "access"]) : ["access"];
}

export function ScopeSettingsPage({ slug, scopes, me, route }: { slug: string; scopes: ScopeInfo[]; me: Me; route: Route }) {
  const scope = scopes.find((s) => s.slug === slug);
  if (!scope) return <ScopeNotFound />;
  const project = scope.kind === "project";
  const settings = !!can.manageSettings(scope);
  const members = !!can.manageMembers(scope);
  const accessLabel = project ? "Members and access" : "Members";
  // The project crumb switches to another project's settings, on the same tab (one it can't open falls back to its first).
  const tabNow = route.query.get("tab");
  const switcher = projectSwitcher(scopes, scope.slug, (s) => href(`/scope/${s}/settings`, { tab: tabNow ?? undefined }));
  const crumbs: Crumb[] = [...ancestors(scope, scopes).map((p) => ({ label: p.name, href: scopeHref(p) })), { label: scope.name, href: scopeHref(scope), switcher }];
  const visibilityBadge = project ? <StatusBadge domain="visibility" value={scope.visibility} /> : undefined;
  const view = (
    <Button href={scopeHref(scope)} icon={project ? "folder" : "building"}>
      {project ? "View project" : "View space"}
    </Button>
  );

  if (!settings && !members)
    return (
      <Page>
        <PageHeader title={accessLabel} documentTitle={accessLabel} crumbs={crumbs} status={visibilityBadge} actions={view} scope={slug} />
        <Callout tone="neutral" icon="lock">
          {project
            ? "You can't change this project: that needs Manage access or Manage settings, which its Project admins have."
            : "Only Administrators can change these settings."}
        </Callout>
        <AccessView slug={slug} isProject={project} me={me} readOnly />
      </Page>
    );

  const allowed = settingsTabs(settings, project);
  const asked = route.query.get("tab") ?? (settings ? "general" : "access");
  const tab = allowed.includes(asked) ? asked : allowed[0]!;
  const tabHref = (id: string) => href(`/scope/${slug}/settings`, { tab: id === "general" ? undefined : id });
  const items = [
    { id: "general", label: "General", href: tabHref("general"), hidden: !settings },
    { id: "access", label: accessLabel, href: tabHref("access") },
    { id: "repos", label: "Repositories", count: scope.components.length, href: tabHref("repos"), hidden: !settings || !project },
    { id: "connections", label: "Connections", href: tabHref("connections"), hidden: !settings || !project },
    { id: "notifications", label: "Notifications", href: tabHref("notifications"), hidden: !settings || !project },
    { id: "docs", label: "Documentation", href: tabHref("docs"), hidden: !settings || !project },
  ];

  return (
    <Page>
      <PageHeader
        title="Settings"
        documentTitle={`${scope.name} settings`}
        crumbs={crumbs}
        status={visibilityBadge}
        meta={
          <span className="pj-shortname">
            <span className="muted">Short name</span>
            <code>{scope.slug}</code>
            <CopyButton text={scope.slug} label="Copy" />
            <InfoTip label="About the short name">Used in links and by Claude, so it can't change.</InfoTip>
          </span>
        }
        actions={view}
        scope={slug}
        tabs={<Tabs label="Settings sections" value={tab} items={items} />}
      />
      {!settings && (
        <Callout tone="neutral" icon="lock">
          Changing its settings needs Manage settings, which its Project admins have.
        </Callout>
      )}
      {tab === "general" && <General scope={scope} scopes={scopes} me={me} />}
      {tab === "access" && (
        <AccessView slug={slug} isProject={project} me={me} readOnly={!members} readOnlyReason="Changing access needs Manage access, which its Project admins have." />
      )}
      {tab === "repos" && <Repositories scope={scope} />}
      {tab === "connections" && <ConnectionsSettings scope={scope} />}
      {tab === "notifications" && <NotificationRoutes scope={scope} />}
      {tab === "docs" && <DocsSettings scope={scope} />}
    </Page>
  );
}

// ---- General ---------------------------------------------------------------------------------------------------

interface Technologies {
  own: string[];
  effective: string[];
  labels: Record<string, string>;
  known: Record<string, string>;
  repositories: { slug: string; repo_url: string | null; technologies: string[]; detected_at: string | null; detect_error: string | null }[];
}

/** Server detection errors without environment variable names ("(set GITHUB_TOKEN)"); Administrators see them in an InfoTip. */
const plainError = (e: string) => e.replace(/\s*\((?:set |needs? )?[A-Z][A-Z0-9_]{3,}(?: or [A-Z][A-Z0-9_]{3,})?\)/g, "").trim() || e;

/** One tab, one SaveBar: Basics, who can see it, where it sits and its technologies save together. */
function General({ scope, scopes, me }: { scope: ScopeInfo; scopes: ScopeInfo[]; me: Me }) {
  const boot = useBoot();
  const toast = useToast();
  const project = scope.kind === "project";
  const formRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(scope.name);
  const [description, setDescription] = useState(scope.description ?? "");
  const [visibility, setVisibility] = useState(scope.visibility);
  const [parent, setParent] = useState(scope.parent ?? "");
  const tech = useApi<Technologies>(project ? `/projects/${scope.slug}/technologies` : null);
  const [techText, setTechText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);

  const techLabel = (t: string) => tech.data?.labels[t] ?? tech.data?.known[t] ?? t;
  const ownTech = tech.data ? tech.data.own.map(techLabel).join(", ") : "";
  const techValue = techText ?? ownTech;
  const changed = {
    name: name !== scope.name,
    description: description !== (scope.description ?? ""),
    visibility: project && visibility !== scope.visibility,
    parent: project && parent !== (scope.parent ?? ""),
    tech: project && techText !== null && techText.trim() !== ownTech,
  };
  const dirtyCount = Object.values(changed).filter(Boolean).length;

  // Where it can go: projects with Manage settings there (Administrators: all), never itself or a project below it.
  const projects = scopes.filter((s) => s.kind === "project");
  const below = new Set<string>();
  const walk = (slug: string) => projects.filter((p) => p.parent === slug).forEach((p) => (below.add(p.slug), walk(p.slug)));
  walk(scope.slug);
  const parentOk = (p: ScopeInfo) => p.slug === scope.parent || (p.slug !== scope.slug && !below.has(p.slug) && canIn(p, "manage_settings", me));
  const subs = projects.filter((p) => p.parent === scope.slug);
  const newParent = projects.find((p) => p.slug === parent);

  const detect = useAsyncAction(() => api(`/projects/${scope.slug}/technologies/detect`, { method: "POST" }), {
    success: "Read the repositories",
    error: "Couldn't read the repositories",
    onDone: () => tech.reload(),
  });

  function discard() {
    setName(scope.name);
    setDescription(scope.description ?? "");
    setVisibility(scope.visibility);
    setParent(scope.parent ?? "");
    setTechText(null);
    setFailures([]);
    setNameError(null);
  }

  async function save() {
    if (!name.trim()) {
      setNameError("Give it a name.");
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setNameError(null);
    setSaving(true);
    const failed: string[] = [];
    const part = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failed.push(`${label}: ${humanizeError(e).title}`);
      }
    };
    if (changed.name || changed.description || changed.visibility)
      await part("Basics", () => api(`/scopes/${scope.slug}`, { method: "PATCH", body: { name: name.trim(), description, ...(project ? { visibility } : {}) } }));
    if (changed.parent) await part("Part of", () => api(`/projects/${scope.slug}/parent`, { method: "PUT", body: { parent: parent || null } }));
    if (changed.tech)
      await part("Technologies", async () => {
        await api(`/projects/${scope.slug}/technologies`, { method: "PUT", body: { technologies: techValue.split(",").map((t) => t.trim()).filter(Boolean) } });
        setTechText(null);
        tech.reload();
      });
    await boot.reloadScopes().catch(() => undefined);
    setFailures(failed);
    setSaving(false);
    if (!failed.length) toast.success("Settings saved");
    else toast.error(`${plural(failed.length, "part")} didn't save`, { description: failed.join(" ") });
  }

  return (
    <div className="pj-general" ref={formRef}>
      <Card as="section" title="Basics" titleLevel={2}>
        <div className="pj-fields">
          <Field label="Name" error={nameError} counter={{ value: name.length, max: 200 }}>
            <TextInput value={name} onChange={(e) => (setName(e.target.value), setNameError(null))} maxLength={200} />
          </Field>
          <Field label="Description" optional counter={{ value: description.length, max: 2000 }}>
            <Textarea autoGrow minRows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="What it covers, in one line" />
          </Field>
        </div>
      </Card>

      {project && (
        <Card as="section" title="Who can see it" titleLevel={2}>
          <ChoiceCards
            name="pj-visibility"
            legend="Who can see it"
            legendHidden
            value={visibility}
            onChange={(v) => setVisibility(v as "team" | "members")}
            options={[
              {
                value: "members",
                label: "Members only",
                icon: "lock",
                description: "Only its members, the members of its teams, and people who can see every project (Administrators, Auditors) can see it. Others won't know it exists.",
              },
              { value: "team", label: "Everyone in Thaliyola", icon: "globe", description: "Anyone signed in can read it; members and teams decide who writes and approves." },
            ]}
          />
        </Card>
      )}

      {project && (
        <Card
          as="section"
          title="Part of"
          titleLevel={2}
          description="Put this project under a product or system it belongs to. Everyone with a role in the projects above gets the same role here, and searching in either covers both."
        >
          <div className="pj-fields">
            <Field label="Parent project" hint={subs.length > 0 ? `Its sub-projects (${subs.map((p) => p.name).join(", ")}) move with it.` : undefined}>
              {/* "Nothing" is offered to everyone who may change the parent: the server lets anyone who manages the old parent take it out. */}
              <ProjectPicker
                searchable
                value={parent}
                onChange={setParent}
                scopes={scopes}
                includeSpaces={false}
                filter={parentOk}
                noneLabel="Nothing: a top-level project"
                currentLabel="(where it is now)"
              />
            </Field>
            {changed.parent && (
              <Callout tone="info" title={newParent ? `Moves under ${newParent.name}` : "Becomes a top-level project"}>
                {subs.length > 0 && `${subs.map((p) => p.name).join(", ")} ${subs.length === 1 ? "moves" : "move"} with it. `}
                {newParent ? `People with roles in ${newParent.name} get the same roles here.` : "It stops getting roles from the projects above it."}
              </Callout>
            )}
          </div>
        </Card>
      )}

      {project && (
        <Card
          as="section"
          title="Technologies"
          titleLevel={2}
          description={
            <>
              Runtimes, servers, databases and platforms this project runs on. Thaliyola reads each repository's languages from GitHub or GitLab daily; add anything else here, like
              nginx, MySQL or Redis. New critical vulnerabilities in these go to the project's Contributors and Project admins.{" "}
              <InfoTip label="Private repositories">
                {can.systemSettings(me)
                  ? "Private repositories need GITHUB_TOKEN or GITLAB_TOKEN on the server."
                  : "Private repositories need an access token on the server, which an Administrator sets."}
              </InfoTip>
            </>
          }
        >
          <AsyncBlock result={tech} label="Loading technologies" skeleton={<SkeletonText lines={3} />}>
            {(t) => {
              const detected = t.effective.filter((x) => !t.own.includes(x));
              const repos = t.repositories.filter((r) => r.repo_url);
              return (
                <div className="pj-fields">
                  <Field label="This project's technologies" hint="Separate them with commas." optional>
                    <TextInput value={techValue} onChange={(e) => setTechText(e.target.value)} placeholder="e.g. PHP, nginx, PostgreSQL, Redis, Docker, Kubernetes" list="pj-known-tech" />
                  </Field>
                  <datalist id="pj-known-tech">
                    {Object.values(t.known).map((l) => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                  {detected.length > 0 && (
                    <div className="pj-detected">
                      <span className="pj-label">Also detected from repositories, dependencies and security reviews</span>
                      <span className="pj-badges">
                        {detected.map((x) => (
                          <Badge key={x}>{t.labels[x] ?? x}</Badge>
                        ))}
                      </span>
                    </div>
                  )}
                  {repos.length > 0 && (
                    <ul className="pj-detect-list" aria-label="Detected per repository">
                      {repos.map((r) => (
                        <li key={r.slug}>
                          <span className="pj-detect-repo">
                            <I name="git-branch" size={14} />
                            {r.slug}
                          </span>
                          {r.detect_error ? (
                            <span className="pj-warn">
                              <I name="alert" size={14} /> Couldn't read it: {plainError(r.detect_error)}
                              {plainError(r.detect_error) !== r.detect_error && can.systemSettings(me) && (
                                <InfoTip label="Technical details">{r.detect_error}</InfoTip>
                              )}
                            </span>
                          ) : r.detected_at ? (
                            <span className="muted">
                              {r.technologies.length ? r.technologies.map((x) => t.labels[x] ?? t.known[x] ?? x).join(", ") : "Nothing detected"} · Read <RelativeTime date={r.detected_at} />
                            </span>
                          ) : (
                            <span className="muted">Not read yet (daily, or Detect now)</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div>
                    <Button size="sm" icon="refresh" loading={detect.busy} loadingText="Detecting" onClick={() => void detect.run()}>
                      Detect now
                    </Button>
                  </div>
                </div>
              );
            }}
          </AsyncBlock>
        </Card>
      )}

      <Card as="section" title="Data" titleLevel={2} description={`Download what's in ${scope.name}, or bring in documents from elsewhere.`}>
        <ul className="pj-data">
          <li>
            <div>
              <p className="pj-data-title">Markdown (.zip)</p>
              <p className="pj-data-text">Every article and finding as a Markdown file, in its folders.</p>
            </div>
            <ExportButton scope={scope.slug} label="Export as Markdown" />
          </li>
          <li>
            <div>
              <p className="pj-data-title">Static site (.zip)</p>
              <p className="pj-data-text">A website you can open offline or host anywhere.</p>
            </div>
            <ExportButton scope={scope.slug} site label="Download as a static site" />
          </li>
          <li>
            <div>
              <p className="pj-data-title">Import documents</p>
              <p className="pj-data-text">Markdown, HTML, or exports from Notion, Confluence and Google Docs.</p>
            </div>
            <Button href={href("/import", { scope: scope.slug })} icon="upload">
              Import documents
            </Button>
          </li>
        </ul>
      </Card>

      {project && <ProjectSkillsCard scope={scope} />}

      {project && <DangerZone scope={scope} />}

      <SaveBar dirtyCount={dirtyCount} onSave={() => void save()} onDiscard={discard} saving={saving} error={failures.length ? failures.join(" ") : undefined} />
    </div>
  );
}

/** Moves the project and everything in it to the trash (restorable), after typing its name. */
function DangerZone({ scope }: { scope: ScopeInfo }) {
  const confirm = useConfirm();
  const toast = useToast();
  const boot = useBoot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function trash() {
    const r = await confirm({
      title: `Move ${scope.name} to the trash?`,
      body: "The project and all its articles and findings go to the trash. Nobody can see them there, and search and agents ignore them.",
      confirmLabel: "Move to trash",
      tone: "danger",
      typeToConfirm: { values: [scope.name.trim(), scope.slug], label: `Type ${scope.name} to confirm` },
    });
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${scope.slug}/delete`, { method: "POST", body: { confirm: r.typed ?? scope.name } });
      navigate("/trash");
      toast.success("Moved to the trash");
      void boot.reloadScopes().catch(() => undefined);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Card as="section" title="Danger zone" titleLevel={2} tone="danger">
      <div className="pj-danger">
        <p>
          Move {scope.name} and everything in it to the trash. Its Project admins and Administrators can restore everything from the trash; only people who can delete permanently
          (Administrators) can delete it for good.
        </p>
        <Button variant="danger" icon="trash" loading={busy} loadingText="Deleting" onClick={() => void trash()}>
          Move project to the trash…
        </Button>
      </div>
      {error ? <ErrorState compact error={error} title="Couldn't move it to the trash" onRetry={() => void trash()} /> : null}
    </Card>
  );
}

// ---- Members and access -------------------------------------------------------------------------------------------

/**
 * Project roles as checkboxes with what each allows. The Add dialogs have the room to show every role's description
 * at once, which a first-time choice needs; table rows use the compact RolePicker.
 */
function RoleChoices({ roles, value, onChange, legend, error }: { roles: CatalogRole[] | undefined; value: string[]; onChange(v: string[]): void; legend: string; error?: string | null }) {
  if (!roles) return <SkeletonText lines={3} />;
  return (
    <div className="pj-role-choices" data-invalid={error ? true : undefined}>
      <ChoiceCards
        name={`pj-roles-${legend}`}
        legend={legend}
        type="checkbox"
        columns={2}
        value={value}
        onChange={(v) => onChange(v as string[])}
        options={roles
          .filter((r) => r.kind === "project")
          .map((r) => ({ value: r.key, label: r.name, description: r.description || (r.allows?.length ? r.allows.map((a) => a.split(":")[0]).join(", ") : r.permissions.join(", ")) }))}
      />
      {error && (
        <p className="field-error" role="alert">
          <I name="alert" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}

function AccessView({ slug, isProject, me, readOnly = false, readOnlyReason }: { slug: string; isProject: boolean; me?: Me; readOnly?: boolean; readOnlyReason?: string }) {
  const access = useApi<Access>(`/scopes/${encodeURIComponent(slug)}/access`);
  return (
    <AsyncBlock
      result={access}
      label="Loading who has access"
      errorTitle="Couldn't load who has access"
      skeleton={
        <div className="pj-stack">
          <SkeletonText lines={3} />
          <SkeletonRows count={4} />
        </div>
      }
    >
      {(d) => <AccessBody d={d} slug={slug} isProject={isProject} me={me} readOnly={readOnly} readOnlyReason={readOnlyReason} reload={access.reload} />}
    </AsyncBlock>
  );
}

function AccessBody({
  d,
  slug,
  isProject,
  me,
  readOnly,
  readOnlyReason,
  reload,
}: {
  d: Access;
  slug: string;
  isProject: boolean;
  me?: Me;
  readOnly: boolean;
  readOnlyReason?: string;
  reload(): void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const catalog = useRoles();
  const all = catalog.data?.roles;
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [addPerson, setAddPerson] = useState(false);
  const [addTeam, setAddTeam] = useState(false);
  const manage = !!(d.can_manage_members ?? d.can_manage) && !readOnly;
  const seeAccess = !!me && can.seeAccess(me);
  const projectName = d.project_name ?? slug;
  const open = d.open_to_everyone;
  const personHref = (id?: string) => (id && seeAccess ? href(`/admin/users/${id}`) : undefined);

  // A change is { roles } (sets every role; [] removes access) or { add, remove } (changes only those).
  type Change = { roles: string[] } | { add: string[]; remove: string[] };
  const setPerson = (email: string, c: Change) => api<MemberChange>(`/scopes/${slug}/members`, { method: "PUT", body: { email, ...c } });
  const setTeamAccess = (team: string, c: Change) => api<TeamChange>(`/scopes/${slug}/teams`, { method: "PUT", body: { team, ...c } });
  // What a person keeps here after losing their direct roles: their teams' roles here.
  const keepsThrough = (email: string) =>
    d.teams.filter((t) => t.member_list?.some((m) => m.email === email)).map((t) => `${namesOr(t.role_names, all, t.roles)} through team ${t.name}`);

  async function changeRoles(
    row: string,
    who: string,
    before: string[],
    next: string[],
    send: (c: Change) => Promise<MemberChange | TeamChange>,
  ) {
    const delta = roleDelta(before, next);
    if (!delta.add.length && !delta.remove.length) return;
    setBusyRow(row);
    try {
      const res = await send(delta);
      const note = "note" in res ? res.note : null;
      toast.success(`${who}: ${changedText(res, all)}`, {
        description: `Now ${namesOr(res.role_names, all, res.roles ?? next)}.${note ? ` ${note}` : ""}`,
        duration: note ? 10000 : undefined,
        // Undo sends the opposite change, never the whole list.
        undo: () => send({ add: delta.remove, remove: delta.add }).then(reload),
      });
      reload();
    } catch (e) {
      toast.error(e, { title: `Couldn't change ${who}'s roles` });
    } finally {
      setBusyRow(null);
    }
  }

  async function removePerson(p: Access["people"][number]) {
    const who = displayName(p.name, p.email);
    const kept = keepsThrough(p.email);
    const self = !!me?.email && p.email.toLowerCase() === me.email.toLowerCase();
    const ok = await confirm({
      title: `Remove ${who} from ${projectName}?`,
      body: (
        <>
          <p>
            They lose {namesOr(p.role_names, all, p.roles)} here{kept.length ? ` (they keep ${kept.join(", ")})` : ""}.
          </p>
          {self && <p>You'll lose access to this project unless you hold a role here another way.</p>}
        </>
      ),
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    setBusyRow(`p:${p.email}`);
    try {
      const res = await setPerson(p.email, { roles: [] });
      toast.success(`Removed ${who}`, res?.note ? { description: res.note, duration: 10000 } : undefined);
      reload();
    } catch (e) {
      toast.error(e, { title: `Couldn't remove ${who}` });
    } finally {
      setBusyRow(null);
    }
  }

  async function removeTeam(t: Access["teams"][number]) {
    const n = t.member_list?.length ?? t.members.length;
    const ok = await confirm({
      title: `Remove team ${t.name} from ${projectName}?`,
      body: `Its ${plural(n, "member")} ${n === 1 ? "loses" : "lose"} ${namesOr(t.role_names, all, t.roles)} here (unless they hold it another way).`,
      confirmLabel: "Remove team",
      tone: "danger",
    });
    if (!ok) return;
    setBusyRow(`t:${t.slug}`);
    try {
      await setTeamAccess(t.slug, { roles: [] });
      toast.success(`Removed team ${t.name}`);
      reload();
    } catch (e) {
      toast.error(e, { title: `Couldn't remove team ${t.name}` });
    } finally {
      setBusyRow(null);
    }
  }

  const people = d.people.map((p) => ({ ...p, status: (p.account ?? (p.pending ? "not_signed_in" : "active")) as AccountStatus }));
  const openLine =
    open?.propose && d.visibility === "team"
      ? "Everyone signed in can propose here until someone here has Propose. "
      : open && !open.propose
        ? "Only people whose roles include Propose can propose here. "
        : "";

  return (
    <div className="pj-stack">
      {readOnly && readOnlyReason && (
        <Callout tone="neutral" icon="lock">
          {readOnlyReason}
        </Callout>
      )}
      <div className="pj-summary">
        <p className="pj-summary-lead">
          {d.summary ?? (
            <>
              {d.total_people} {d.total_people === 1 ? "person has" : "people have"} a role here{isProject ? ", directly or through a team" : ""}.{" "}
              {d.visibility === "members" ? "Only they, and people who can see every project, can see it." : "Everyone signed in can read it."}
            </>
          )}{" "}
          {isProject && can.manageSettings({ kind: "project", can_manage: d.can_manage, can_manage_settings: d.can_manage_settings }) && (
            <a href={href(`/scope/${slug}/settings`)}>Change who can see it</a>
          )}
        </p>
      </div>
      <Disclosure summary="How roles work here" storageKey="pj-roles-matrix">
        <p className="pj-summary-rules">
          People can hold several roles; their permissions add up. {openLine}Reviewers, Moderators and Project admins approve. People with Publish directly publish their own writes
          without review.
        </p>
        {isProject && (
          <p className="pj-summary-rules">
            These are project roles: what someone can do in {projectName} and the projects under it. Organisation roles (User manager, Auditor, …) are given on the{" "}
            {me && can.manageUsers(me) ? <a href={href("/admin/users")}>People page</a> : "People page"}.
          </p>
        )}
        {catalog.data && (
          <div className="pj-matrix">
            <PermissionMatrix catalog={catalog.data} kind="project" />
          </div>
        )}
        <p className="pj-note">
          <a href={href("/roles")}>All roles</a>
        </p>
      </Disclosure>

      <Section
        title="People"
        count={people.length}
        actions={
          manage && (
            <Button icon="user-plus" onClick={() => setAddPerson(true)}>
              Add people
            </Button>
          )
        }
      >
        <DataTable
          caption={`People with a role in ${projectName}`}
          rows={people}
          getRowId={(p) => p.email}
          columns={[
            {
              key: "person",
              header: "Person",
              primary: true,
              cell: (p) => (
                <span className="pj-person">
                  <PersonChipLine name={p.name} email={p.email} kind={p.kind} you={!!me?.email && me.email.toLowerCase() === p.email.toLowerCase()} href={personHref(p.id)} />
                  {(p.name || p.status !== "active") && (
                    <span className="pj-person-sub">{[p.email, p.status !== "active" ? (ACCOUNT_STATUS_TEXT[p.status] ?? p.status) : null].filter(Boolean).join(" · ")}</span>
                  )}
                </span>
              ),
            },
            {
              key: "roles",
              header: "Project roles",
              cell: (p) =>
                manage ? (
                  <RolePicker
                    roles={all}
                    kind="project"
                    value={p.roles}
                    required
                    disabled={busyRow === `p:${p.email}`}
                    label={`Project roles of ${displayName(p.name, p.email)}`}
                    onChange={(r) => void changeRoles(`p:${p.email}`, displayName(p.name, p.email), p.roles, r, (c) => setPerson(p.email, c))}
                  />
                ) : (
                  namesOr(p.role_names, all, p.roles)
                ),
            },
            { key: "via", header: "Access via", hideBelow: 760, cell: () => <span className="muted">Directly</span> },
          ]}
          rowMenu={manage ? (p) => [{ id: "remove", label: "Remove…", icon: "x", tone: "danger", onSelect: () => void removePerson(p) }] : undefined}
          empty={
            <EmptyState
              variant="compact"
              icon="user"
              title="No one added directly"
              description={isProject ? "People can also get access through a team or a project above." : undefined}
              primary={
                manage && (
                  <Button icon="user-plus" onClick={() => setAddPerson(true)}>
                    Add people
                  </Button>
                )
              }
            />
          }
        />
      </Section>
      {manage && (
        <AddPersonDialog
          open={addPerson}
          onClose={() => setAddPerson(false)}
          roles={all}
          exclude={d.people.map((p) => p.email)}
          me={me}
          send={(email, roles) => setPerson(email, { roles })}
          onAdded={(email, res, roles) => {
            const notActive = res?.account && res.account !== "active" ? res.note : null;
            toast.success(`Added ${res?.name ? `${res.name} (${email})` : email}`, { description: `${namesOr(res?.role_names, all, roles)}.${notActive ? ` ${notActive}` : ""}`, duration: notActive ? 10000 : undefined });
            reload();
          }}
        />
      )}

      {isProject && (
        <Section
          title="Teams"
          count={d.teams.length}
          description={
            <>
              Everyone in a team gets the team's project roles here. A team can work on many projects.{" "}
              <a href={href("/teams")}>{me && can.manageTeams(me) ? "Create or edit teams" : "See teams"}</a>
            </>
          }
          actions={
            manage && (
              <Button icon="team" onClick={() => setAddTeam(true)}>
                Add team
              </Button>
            )
          }
        >
          <DataTable
            caption={`Teams with a role in ${projectName}`}
            rows={d.teams}
            getRowId={(t) => t.slug}
            columns={[
              {
                key: "team",
                header: "Team",
                primary: true,
                cell: (t) => (
                  <span className="pj-person">
                    <a href={href(`/teams/${t.slug}`)} className="pj-strong">
                      {t.name}
                    </a>
                    <span className="pj-person-sub">
                      {t.member_list?.length
                        ? t.member_list.map((m, i) => (
                            <span key={m.email}>
                              {i > 0 && ", "}
                              {personHref(m.id) ? <a href={personHref(m.id)}>{displayName(m.name, m.email)}</a> : (displayName(m.name, m.email))}
                              {m.team_role === "lead" ? " (lead)" : ""}
                            </span>
                          ))
                        : t.members.length
                          ? t.members.join(", ")
                          : "No members yet"}
                    </span>
                  </span>
                ),
              },
              {
                key: "roles",
                header: "Project roles",
                cell: (t) =>
                  manage ? (
                    <RolePicker
                      roles={all}
                      kind="project"
                      value={t.roles}
                      required
                      disabled={busyRow === `t:${t.slug}`}
                      label={`Project roles of ${t.name}`}
                      onChange={(r) => void changeRoles(`t:${t.slug}`, t.name, t.roles, r, (c) => setTeamAccess(t.slug, c))}
                    />
                  ) : (
                    namesOr(t.role_names, all, t.roles)
                  ),
              },
            ]}
            rowMenu={manage ? (t) => [{ id: "remove", label: "Remove…", icon: "x", tone: "danger", onSelect: () => void removeTeam(t) }] : undefined}
            empty={
              <EmptyState
                variant="compact"
                icon="team"
                title="No teams yet"
                description="Add a team to give all its members the same roles here."
                primary={
                  manage && (
                    <Button icon="team" onClick={() => setAddTeam(true)}>
                      Add team
                    </Button>
                  )
                }
              />
            }
          />
        </Section>
      )}
      {isProject && manage && (
        <AddTeamDialog
          open={addTeam}
          onClose={() => setAddTeam(false)}
          roles={all}
          existing={d.teams.map((t) => t.slug)}
          me={me}
          send={(team, roles) => setTeamAccess(team, { roles })}
          onAdded={(team, res, roles) => {
            toast.success(`Added the team ${res?.team_name ?? team}`, { description: `${namesOr(res?.role_names, all, roles)}.` });
            reload();
          }}
        />
      )}

      {!!d.inherited?.length && (
        <Section title="From the projects above" count={d.inherited.length} description="These people hold roles in a project this one is part of, so they hold them here too. Change them there.">
          <DataTable
            caption="Roles from the projects above"
            rows={d.inherited}
            getRowId={(p) => p.email}
            columns={[
              {
                key: "person",
                header: "Person",
                primary: true,
                cell: (p) => (
                  <span className="pj-person">
                    <PersonChipLine name={p.name} email={p.email} href={personHref(p.id)} />
                    <span className="pj-person-sub">{p.email}</span>
                  </span>
                ),
              },
              { key: "roles", header: "Project roles", cell: (p) => namesOr(p.role_names, all, p.roles) },
              {
                key: "via",
                header: "Access via",
                cell: (p) => (
                  <span>
                    From{" "}
                    {p.sources.map((src, i) => (
                      <span key={`${src.slug}-${src.team ?? ""}`}>
                        {i > 0 && ", "}
                        <a href={href(`/scope/${src.slug}/settings`, { tab: "access" })}>{src.name}</a>
                        {src.team ? ` (team ${src.team})` : ""}
                      </span>
                    ))}
                  </span>
                ),
              },
            ]}
            empty={null}
          />
        </Section>
      )}

      {d.org_wide &&
        (d.org_wide.people ? (
          d.org_wide.people.length > 0 && (
            <Section title="People who can see every project" count={d.org_wide.people.length} description="They can see this project through an organisation role, without a role here.">
              <ul className="pj-plain-list">
                {d.org_wide.people.map((p) => (
                  <li key={p.email}>
                    <PersonChipLine name={p.name} email={p.email} />
                    {p.why.length > 0 && <span className="muted"> ({p.why.join(", ")})</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )
        ) : (
          d.org_wide.count > 0 && (
            <p className="pj-note">
              {d.org_wide.count} more {d.org_wide.count === 1 ? "person" : "people"} can see every project (Administrators, Auditors).
            </p>
          )
        ))}
    </div>
  );
}

/** A person's avatar and display name (linked to their access when the viewer may see it); the email is secondary text. */
function PersonChipLine({ name, email, kind, you, href: link }: { name: string | null; email: string; kind?: "human" | "service"; you?: boolean; href?: string }) {
  const label = displayName(name, email);
  return (
    <span className="pj-chip-line">
      <Avatar name={name} email={email} kind={kind} size={24} />
      {link ? (
        <a href={link} className="pj-strong">
          {label}
        </a>
      ) : (
        <span className="pj-strong">{label}</span>
      )}
      {kind === "service" && (
        <Badge tone="neutral" icon="bot">
          AI agent
        </Badge>
      )}
      {you && <Badge tone="accent">You</Badge>}
    </span>
  );
}

function AddPersonDialog({
  open,
  onClose,
  roles,
  exclude,
  me,
  send,
  onAdded,
}: {
  open: boolean;
  onClose(): void;
  roles: CatalogRole[] | undefined;
  exclude: string[];
  me?: Me;
  send(email: string, roles: string[]): Promise<MemberChange>;
  onAdded(email: string, res: MemberChange, roles: string[]): void;
}) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>(["writer"]);
  const [errors, setErrors] = useState<{ email?: string; roles?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const close = () => {
    setEmail("");
    setChosen(["writer"]);
    setErrors({});
    setError(null);
    onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = { email: email.trim() ? undefined : "Choose a person, or type their email.", roles: chosen.length ? undefined : "Choose at least one role." };
    setErrors(next);
    if (next.email || next.roles) return;
    setBusy(true);
    setError(null);
    try {
      const res = await send(email.trim(), chosen);
      onAdded(email.trim(), res, chosen);
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add people"
      description="They get these project roles here and in the projects under it."
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Adding">
            Add person
          </Button>
        </>
      }
    >
      <form id={formId} className="pj-dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field" data-invalid={errors.email ? true : undefined}>
          <span className="field-label">Person</span>
          <PersonInput value={email} onChange={(v) => (setEmail(v), setErrors((x) => ({ ...x, email: undefined })))} exclude={exclude} placeholder="Find a person, or type an email" label="Person to add" />
          {errors.email && (
            <p className="field-error" role="alert">
              <I name="alert" size={14} />
              {errors.email}
            </p>
          )}
          {me && can.manageUsers(me) && me.auth_mode === "local" && (
            <p className="field-hint">
              <a href={href("/admin/users")}>Not on Thaliyola yet? Invite them</a>
            </p>
          )}
        </div>
        <RoleChoices roles={roles} value={chosen} onChange={(v) => (setChosen(v), setErrors((x) => ({ ...x, roles: undefined })))} legend="Project roles" error={errors.roles} />
        {error ? <ErrorState compact error={error} title="Couldn't add them" /> : null}
      </form>
    </Dialog>
  );
}

function AddTeamDialog({
  open,
  onClose,
  roles,
  existing,
  me,
  send,
  onAdded,
}: {
  open: boolean;
  onClose(): void;
  roles: CatalogRole[] | undefined;
  existing: string[];
  me?: Me;
  send(team: string, roles: string[]): Promise<TeamChange>;
  onAdded(team: string, res: TeamChange, roles: string[]): void;
}) {
  const formId = useId();
  const teams = useApi<{ teams: { slug: string; name: string; members: number }[] }>(open ? "/teams" : null);
  const [team, setTeam] = useState("");
  const [chosen, setChosen] = useState<string[]>(["writer"]);
  const [errors, setErrors] = useState<{ team?: string; roles?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const available = (teams.data?.teams ?? []).filter((t) => !existing.includes(t.slug));
  const close = () => {
    setTeam("");
    setChosen(["writer"]);
    setErrors({});
    setError(null);
    onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = { team: team ? undefined : "Choose a team.", roles: chosen.length ? undefined : "Choose at least one role." };
    setErrors(next);
    if (next.team || next.roles) return;
    setBusy(true);
    setError(null);
    try {
      const res = await send(team, chosen);
      onAdded(team, res, chosen);
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const none = teams.data && !available.length;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add team"
      description="Everyone in the team gets these project roles here."
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {!none && (
            <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Adding">
              Add team
            </Button>
          )}
        </>
      }
    >
      <form id={formId} className="pj-dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <AsyncBlock result={teams} label="Loading teams" skeleton={<SkeletonText lines={2} />}>
          {() =>
            none ? (
              <EmptyState
                variant="compact"
                icon="team"
                title="Every team already has access"
                description={me && can.manageTeams(me) ? undefined : "Ask an Administrator or a Team manager to create one."}
                primary={
                  me &&
                  can.manageTeams(me) && (
                    <Button href={href("/teams")} icon="plus">
                      Create a team
                    </Button>
                  )
                }
              />
            ) : (
              <>
                <Field label="Team" error={errors.team}>
                  <Select
                    value={team}
                    onChange={(e) => (setTeam(e.target.value), setErrors((x) => ({ ...x, team: undefined })))}
                    options={[{ value: "", label: "Choose a team…" }, ...available.map((t) => ({ value: t.slug, label: `${t.name} (${plural(t.members, "member")})` }))]}
                  />
                </Field>
                <RoleChoices roles={roles} value={chosen} onChange={(v) => (setChosen(v), setErrors((x) => ({ ...x, roles: undefined })))} legend="Project roles for the team" error={errors.roles} />
                <p className="pj-note">
                  <a href={href("/teams")}>{me && can.manageTeams(me) ? "Create or edit teams" : "See teams"}</a>
                </p>
              </>
            )
          }
        </AsyncBlock>
        {error ? <ErrorState compact error={error} title="Couldn't add the team" /> : null}
      </form>
    </Dialog>
  );
}

// ---- Repositories ------------------------------------------------------------------------------------------------

/** What the project's GitHub or GitLab connection last read about a repository. */
function RepoFactsLine({ git }: { git: NonNullable<ScopeInfo["components"][number]["git"]> }) {
  const prs = git.provider === "gitlab" ? ["open merge request", "open merge requests"] : ["open pull request", "open pull requests"];
  return (
    <span className="pj-repo-facts">
      <MetaLine
        items={[
          git.default_branch ? (
            <span key="b" className="pj-repo-branch">
              <I name="git-branch" size={12} /> {git.default_branch}
            </span>
          ) : null,
          git.open_prs !== null ? plural(git.open_prs, prs[0]!, prs[1]) : null,
          git.last_commit ? (
            <span key="c">
              Last commit <q className="pj-repo-commit">{git.last_commit.message}</q>
              {git.last_commit.author ? ` by ${git.last_commit.author}` : ""}
              {git.last_commit.at ? (
                <>
                  {" "}
                  <RelativeTime date={git.last_commit.at} />
                </>
              ) : null}
            </span>
          ) : null,
          git.archived ? "Archived" : null,
        ]}
      />
      {git.error && (
        <span className="pj-warn">
          <I name="alert" size={14} /> The last sync couldn't read it: {git.error}
        </span>
      )}
    </span>
  );
}

type RepoForm = { slug: string; kind: string; repo_url: string; description: string };

function Repositories({ scope }: { scope: ScopeInfo }) {
  const boot = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ScopeInfo["components"][number] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(slug: string) {
    const ok = await confirm({
      title: `Remove ${slug}?`,
      body: "Articles and contracts stay; only their links to this repository go.",
      confirmLabel: "Remove repository",
      tone: "danger",
    });
    if (!ok) return;
    setRemoving(slug);
    try {
      await api(`/projects/${scope.slug}/components/${slug}`, { method: "DELETE" });
      await boot.reloadScopes();
      toast.success(`Removed ${slug}`);
    } catch (e) {
      toast.error(e, { title: `Couldn't remove ${slug}` });
    } finally {
      setRemoving(null);
    }
  }

  const add = (
    <Button icon="plus" onClick={() => setAdding(true)}>
      Add repository
    </Button>
  );
  return (
    <Section
      title="Repositories"
      count={scope.components.length}
      description={`The codebases that make up ${scope.name} (an API, a worker, a web app, a mobile app…). A Claude session in one of them finds this project on its own, and contracts link the repository that provides them to the ones that consume them.`}
      actions={scope.components.length > 0 && add}
    >
      {scope.components.length === 0 ? (
        <EmptyState icon="git-branch" title="No repositories yet" description="Add the project's repositories so Claude can find it from the code." primary={add} />
      ) : (
        <RowList label={`Repositories of ${scope.name}`}>
          {scope.components.map((c) => (
            <ListRow
              key={c.slug}
              leading={<I name="git-branch" size={18} />}
              title={c.slug}
              badges={c.kind !== c.slug && <Badge>{REPO_KIND[c.kind] ?? humanize(c.kind)}</Badge>}
              meta={
                c.repo_url ? (
                  /^https?:\/\//.test(c.repo_url) ? (
                    <a href={c.repo_url} target="_blank" rel="noreferrer" className="pj-url">
                      {c.repo_url}
                      <I name="external" size={12} />
                    </a>
                  ) : (
                    <code className="pj-url">{c.repo_url}</code>
                  )
                ) : undefined
              }
              description={c.description || undefined}
              extra={
                !c.repo_url ? (
                  <span className="pj-warn">
                    <I name="alert" size={14} /> No URL yet: Claude can't match this repository, so sessions can't find this project on their own.
                  </span>
                ) : c.git ? (
                  <RepoFactsLine git={c.git} />
                ) : undefined
              }
              trailing={
                <span className="pj-row-tools">
                  <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(c)} aria-label={`Edit ${c.slug}`}>
                    Edit…
                  </Button>
                  <OverflowMenu
                    label={`More actions for ${c.slug}`}
                    size="sm"
                    items={[{ id: "remove", label: removing === c.slug ? "Removing…" : "Remove…", icon: "trash", tone: "danger", onSelect: () => void remove(c.slug) }]}
                  />
                </span>
              }
            />
          ))}
        </RowList>
      )}
      <RepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add repository"
        submitLabel="Add repository"
        initial={{ slug: "", kind: "backend", repo_url: "", description: "" }}
        onSubmit={async (v) => {
          await api(`/projects/${scope.slug}/components`, { method: "POST", body: { ...v, repo_url: v.repo_url || undefined } });
          await boot.reloadScopes();
          toast.success(`Added ${v.slug}`);
        }}
      />
      {editing && (
        <RepoDialog
          open
          onClose={() => setEditing(null)}
          title={`Edit ${editing.slug}`}
          submitLabel="Save repository"
          initial={{ slug: editing.slug, kind: editing.kind, repo_url: editing.repo_url ?? "", description: editing.description ?? "" }}
          onSubmit={async (v) => {
            await api(`/projects/${scope.slug}/components/${editing.slug}`, {
              method: "PATCH",
              body: { slug: v.slug !== editing.slug ? v.slug : undefined, kind: v.kind, repo_url: v.repo_url || null, description: v.description },
            });
            await boot.reloadScopes();
            toast.success(`Saved ${v.slug}`);
          }}
        />
      )}
    </Section>
  );
}

function RepoDialog({
  open,
  onClose,
  title,
  submitLabel,
  initial,
  onSubmit,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  submitLabel: string;
  initial: RepoForm;
  onSubmit(v: RepoForm): Promise<void>;
}) {
  const formId = useId();
  const [v, setV] = useState(initial);
  // The short name follows the URL until someone edits it.
  const [slugEdited, setSlugEdited] = useState(!!initial.slug);
  const [errors, setErrors] = useState<{ slug?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const close = () => {
    setV(initial);
    setSlugEdited(!!initial.slug);
    setErrors({});
    setError(null);
    onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const slug = v.slug.trim() || repoName(v.repo_url);
    const slugError = !slug ? "Give it a short name, or paste the repository URL." : !SLUG_PATTERN.test(slug) ? "Use lowercase letters, numbers and dashes, starting with a letter or number." : undefined;
    setErrors({ slug: slugError });
    if (slugError) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...v, slug, repo_url: v.repo_url.trim() });
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving">
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="pj-dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Repository URL" optional hint="Claude matches sessions to this project by it.">
          <TextInput
            value={v.repo_url}
            onChange={(e) => setV((x) => ({ ...x, repo_url: e.target.value, slug: slugEdited ? x.slug : repoName(e.target.value) }))}
            placeholder="https://github.com/acme/orders-api"
            inputMode="url"
          />
        </Field>
        <div className="pj-field-row">
          <Field label="Short name" error={errors.slug} hint="Lowercase letters, numbers and dashes; Claude uses it to find this project.">
            <TextInput
              value={v.slug}
              onChange={(e) => (setSlugEdited(true), setV((x) => ({ ...x, slug: e.target.value })), setErrors({}))}
              placeholder="e.g. api"
             
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Kind">
            <Select value={v.kind} onChange={(e) => setV((x) => ({ ...x, kind: e.target.value }))} options={KIND_OPTIONS} />
          </Field>
        </div>
        <Field label="What it is" optional counter={{ value: v.description.length, max: 500 }}>
          <TextInput value={v.description} onChange={(e) => setV((x) => ({ ...x, description: e.target.value }))} placeholder="e.g. Public REST API and webhooks" maxLength={500} />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't save the repository" /> : null}
      </form>
    </Dialog>
  );
}

// ---- Documentation ---------------------------------------------------------------------------------------------

interface DocsStatus {
  repositories: { slug: string; kind: string; repo_url: string | null; docs_sha: string | null; docs_updated_at: string | null; pages: number; claims: number; stale_claims: number }[];
  runs: { id: string; repository: string | null; mode: string; status: string; head_sha: string; started_at: string; summary: string | null; by: string; pages: number; written: number }[];
  instructions: string;
  ignore: string;
}

/**
 * Repository documentation written by connected agents: what's documented at
 * which commit, how current it is, and the instructions and ignore rules
 * agents follow.
 */
function DocsSettings({ scope }: { scope: ScopeInfo }) {
  const docs = useApi<DocsStatus>(`/projects/${scope.slug}/docs`);
  return (
    <AsyncBlock
      result={docs}
      label="Loading documentation"
      errorTitle="Couldn't load the documentation status"
      skeleton={
        <div className="pj-stack">
          <SkeletonText lines={3} />
          <SkeletonRows count={3} />
        </div>
      }
    >
      {(data) => <DocsBody scope={scope} data={data} reload={docs.reload} />}
    </AsyncBlock>
  );
}

function DocsBody({ scope, data, reload }: { scope: ScopeInfo; data: DocsStatus; reload(): void }) {
  const toast = useToast();
  const [instructions, setInstructions] = useState<string | null>(null);
  const [ignore, setIgnore] = useState<string | null>(null);
  const [block, setBlock] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ins = instructions ?? data.instructions;
  const ign = ignore ?? data.ignore;
  const dirty = (ins !== data.instructions ? 1 : 0) + (ign !== data.ignore ? 1 : 0);
  const documented = data.repositories.some((r) => r.docs_sha);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/projects/${scope.slug}/docs-settings`, { method: "PUT", body: { instructions: ins, ignore: ign } });
      setInstructions(null);
      setIgnore(null);
      reload();
      toast.success("Saved");
    } catch (e) {
      setSaveError(humanizeError(e).title);
    } finally {
      setSaving(false);
    }
  }

  const steps = (
    <Stepper
      steps={[
        { id: "open", title: "Open the repository in Claude Code", status: documented ? "done" : "current" },
        {
          id: "document",
          title: "Document it",
          status: documented ? "done" : "todo",
          content: <CodeBlock code="/mcp__thaliyola__document-repo" label="Run in Claude Code" language="shell" />,
        },
        {
          id: "fresh",
          title: "Keep it fresh",
          status: documented ? "current" : "todo",
          content: (
            <>
              <CodeBlock code="/mcp__thaliyola__update-docs" label="Run after changes, by hand or in CI" language="shell" />
              <p className="pj-note">
                To run it in CI, see <a href={href("/connect")}>Connect</a>.
              </p>
            </>
          ),
        },
      ]}
    />
  );

  return (
    <div className="pj-stack">
      <Section
        title="Get started"
        description="A coding agent with the repository checked out writes these docs: every fact on a page points at the source lines it came from, and when the code changes, only the affected pages and facts are redone."
      >
        {documented ? (
          <Disclosure summary="How to document a repository" storageKey="pj-docs-steps">
            {steps}
          </Disclosure>
        ) : (
          steps
        )}
      </Section>

      <Section title="Repositories" count={data.repositories.length}>
        <DataTable
          caption="Documentation status per repository"
          rows={data.repositories}
          getRowId={(r) => r.slug}
          columns={[
            {
              key: "repo",
              header: "Repository",
              primary: true,
              cell: (r) => (
                <span className="pj-person">
                  <span className="pj-strong">{r.slug}</span>
                  <span className="pj-person-sub">{REPO_KIND[r.kind] ?? humanize(r.kind)}</span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (r) =>
                !r.docs_sha ? (
                  <Badge tone="neutral" variant="outline">
                    Not documented yet
                  </Badge>
                ) : r.stale_claims > 0 ? (
                  <Badge tone="warning" icon="clock">
                    {plural(r.stale_claims, "fact")} may be out of date
                  </Badge>
                ) : (
                  <Badge tone="success" icon="check">
                    Up to date
                  </Badge>
                ),
            },
            {
              key: "run",
              header: "Documented at",
              cell: (r) =>
                r.docs_sha ? (
                  <span className="pj-person">
                    <code>{r.docs_sha.slice(0, 10)}</code>
                    <span className="pj-person-sub">
                      <RelativeTime date={r.docs_updated_at} />
                    </span>
                  </span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            { key: "pages", header: "Pages", numeric: true, cell: (r) => r.pages },
            {
              key: "facts",
              header: "Grounded facts",
              numeric: true,
              cell: (r) => (
                <>
                  {r.claims}{" "}
                  {r.claims > 0 && (
                    <InfoTip label="Grounded facts">Statements on the pages that point at the source lines they came from. Fact check shows them on each page.</InfoTip>
                  )}
                </>
              ),
            },
          ]}
          rowAction={(r) => (
            <Button size="sm" variant="ghost" icon="doc" onClick={() => setBlock(r.slug)}>
              AGENTS.md block
            </Button>
          )}
          empty={
            <EmptyState
              variant="compact"
              icon="git-branch"
              title="No repositories yet"
              description="Add the project's repositories first."
              primary={<Button href={href(`/scope/${scope.slug}/settings`, { tab: "repos" })}>Go to Repositories</Button>}
            />
          }
        />
      </Section>
      {block && <AgentsBlockDialog project={scope.slug} repo={block} onClose={() => setBlock(null)} />}

      <Card as="section" title="Instructions for Claude" titleLevel={2} description="What agents receive at the start of every documentation run.">
        <div className="pj-fields">
          <Field label="Instructions for agents" optional hint="What to document and how: the audience, pages that must exist, conventions, things to leave out.">
            <Textarea
              autoGrow
              minRows={5}
              value={ins}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Write for new backend engineers. Always include a runbook for each worker. Don't document internal admin tools."
            />
          </Field>
          <Field label="Ignore rules" optional hint="gitignore-style paths agents must not read or cite (secrets, vendored code, generated files). Use ! to make exceptions.">
            <Textarea autoGrow mono minRows={4} value={ign} onChange={(e) => setIgnore(e.target.value)} placeholder={"secrets/\n*.pem\nvendor/**\n!vendor/README.md"} />
          </Field>
        </div>
      </Card>

      <Section title="Recent runs" count={data.runs.length}>
        <DataTable
          caption="Recent documentation runs"
          rows={data.runs}
          getRowId={(r) => r.id}
          density="compact"
          columns={[
            {
              key: "repo",
              header: "Repository",
              primary: true,
              cell: (r) => (
                <span className="pj-person">
                  <span className="pj-strong">
                    {r.repository ?? "project"} · {humanize(r.mode)}
                  </span>
                  <span className="pj-person-sub">{r.summary ?? `${r.written}/${r.pages} pages written`}</span>
                </span>
              ),
            },
            { key: "status", header: "Status", cell: (r) => <StatusBadge domain="run" value={r.status} /> },
            { key: "sha", header: "Commit", cell: (r) => <code>{r.head_sha.slice(0, 8)}</code> },
            { key: "started", header: "Started", cell: (r) => <RelativeTime date={r.started_at} /> },
            { key: "by", header: "By", cell: (r) => r.by },
          ]}
          empty={<EmptyState variant="compact" icon="history" title="No documentation runs yet" description="Runs appear here once Claude documents a repository." />}
        />
      </Section>

      <SaveBar dirtyCount={dirty} onSave={() => void save()} onDiscard={() => (setInstructions(null), setIgnore(null), setSaveError(null))} saving={saving} error={saveError} />
    </div>
  );
}

function AgentsBlockDialog({ project, repo, onClose }: { project: string; repo: string; onClose(): void }) {
  const block = useApi<{ block: string }>(`/projects/${project}/agents-md?component=${encodeURIComponent(repo)}`);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`AGENTS.md block for ${repo}`}
      description="Agents keep this up to date at the end of each run. To add it by hand, paste it into AGENTS.md (and CLAUDE.md if the repository has one)."
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <AsyncBlock result={block} label="Loading the block" errorTitle="Couldn't load the block" skeleton={<SkeletonText lines={6} />}>
        {(b) => <CodeBlock code={b.block} label="AGENTS.md" language="markdown" maxHeight={360} />}
      </AsyncBlock>
    </Dialog>
  );
}

