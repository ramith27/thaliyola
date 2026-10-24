import { useState, type FormEvent } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { I } from "../components/icons";
import { ErrorBox, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href, type Route } from "../router";
import { ExportButton } from "./setup";

type Role = "reader" | "writer" | "owner";
const ROLES: { role: Role; text: string }[] = [
  { role: "reader", text: "Reader: can read (needed for members-only projects)" },
  { role: "writer", text: "Writer: can propose and edit; changes go to review" },
  { role: "owner", text: "Owner: approves changes and manages the project" },
];
const KINDS = ["backend", "frontend", "mobile", "data", "infra", "other"];

interface Access {
  scope: string;
  kind: string;
  visibility: "team" | "members";
  people: { email: string; name: string | null; role: Role; pending: boolean }[];
  teams: { slug: string; name: string; role: Role; members: string[] }[];
  total_people: number;
  my_role: Role | null;
  can_manage: boolean;
}

/**
 * Settings for one scope. Projects have their own access control (people and
 * teams with roles, visibility), their repositories, and their name; their
 * owners manage them. Team and Library settings are for admins.
 */
export function ScopeSettingsPage({ slug, scopes, me, route }: { slug: string; scopes: ScopeInfo[]; me: Me; route: Route }) {
  const scope = scopes.find((s) => s.slug === slug);
  const tab = route.query.get("tab") ?? "general";
  if (!scope) return <p>Scope not found.</p>;
  const project = scope.kind === "project";
  if (!scope.can_manage)
    return (
      <div className="page">
        <h1>{scope.name}: who has access</h1>
        <Notice kind="warn">{project ? "Only this project's owners and admins can change its settings." : "Only admins can change these settings."}</Notice>
        <AccessView slug={slug} isProject={project} readOnly />
      </div>
    );
  const tabs = project
    ? [
        ["general", "General"],
        ["access", "Members and access"],
        ["repos", `Repositories (${scope.components.length})`],
        ["docs", "Documentation"],
      ]
    : [
        ["general", "General"],
        ["access", "Members"],
      ];

  return (
    <div className="page">
      <p className="breadcrumbs muted small">
        <a href={href(project ? `/project/${slug}` : `/scope/${slug}`)}>{scope.name}</a> / settings
      </p>
      <h1>{scope.name} settings</h1>
      <nav className="tabs settings-tabs" aria-label="Settings sections">
        {tabs.map(([key, label]) => (
          <a key={key} className={tab === key ? "active" : ""} href={href(`/scope/${slug}/settings`, { tab: key })}>
            {label}
          </a>
        ))}
      </nav>
      {tab === "general" && <General scope={scope} />}
      {tab === "access" && <AccessView slug={slug} isProject={project} me={me} />}
      {tab === "repos" && project && <Repositories scope={scope} />}
      {tab === "docs" && project && <DocsSettings scope={scope} />}
    </div>
  );
}

function useAction(onDone?: () => void) {
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  async function act(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      onDone?.();
    } catch (e) {
      setError(e as Error);
    }
  }
  return { act, error, saved };
}

// ---- General ---------------------------------------------------------------------

/** What the project runs on, so new critical vulnerabilities (e.g. in PHP or nginx) reach the right teams. */
function Technologies({ slug }: { slug: string }) {
  const { data, reload } = useApi<{
    own: string[];
    effective: string[];
    labels: Record<string, string>;
    known: Record<string, string>;
    repositories: { slug: string; repo_url: string | null; technologies: string[]; detected_at: string | null; detect_error: string | null }[];
  }>(`/projects/${slug}/technologies`);
  const [text, setText] = useState<string | null>(null);
  const { act, error, saved } = useAction();
  if (!data) return null;
  const value = text ?? data.own.map((t) => data.labels[t] ?? data.known[t] ?? t).join(", ");
  const detected = data.effective.filter((t) => !data.own.includes(t));
  return (
    <div className="tech-settings">
      <h2>Technologies</h2>
      <p className="muted small">
        Runtimes, servers, databases and platforms this project runs on. Thaliyola reads each repository's languages from GitHub or GitLab daily (private repositories
        need GITHUB_TOKEN or GITLAB_TOKEN on the server); add anything else here, like nginx, MySQL or Redis. New critical vulnerabilities in these go to the project's writers
        and owners.
      </p>
      <input value={value} onChange={(e) => setText(e.target.value)} placeholder="e.g. PHP, nginx, PostgreSQL, Redis, Docker, Kubernetes" aria-label="Technologies" list="known-tech" />
      <datalist id="known-tech">
        {Object.values(data.known).map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {detected.length > 0 && (
        <p className="muted small">
          Also detected from repositories, dependencies and security reviews: {detected.map((t) => data.labels[t] ?? t).join(", ")}
        </p>
      )}
      {data.repositories.some((r) => r.repo_url) && (
        <ul className="plain small detect-list">
          {data.repositories
            .filter((r) => r.repo_url)
            .map((r) => (
              <li key={r.slug}>
                <strong>{r.slug}</strong>{" "}
                {r.detect_error ? (
                  <span className="warn">couldn't read it: {r.detect_error}</span>
                ) : r.detected_at ? (
                  <span className="muted">
                    {r.technologies.length ? r.technologies.map((t) => data.labels[t] ?? data.known[t] ?? t).join(", ") : "nothing detected"} · read {new Date(r.detected_at).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="muted">not read yet (daily, or Detect now)</span>
                )}
              </li>
            ))}
        </ul>
      )}
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}
      <div className="actions">
        <button
          className="btn"
          disabled={text === null}
          onClick={() =>
            act("Saved.", async () => {
              await api(`/projects/${slug}/technologies`, { method: "PUT", body: { technologies: value.split(",").map((t) => t.trim()).filter(Boolean) } });
              setText(null);
              reload();
            })
          }
        >
          Save technologies
        </button>
        <button
          className="btn"
          onClick={() =>
            act("Read the repositories.", async () => {
              await api(`/projects/${slug}/technologies/detect`, { method: "POST" });
              reload();
            })
          }
        >
          Detect now
        </button>
      </div>
    </div>
  );
}

function General({ scope }: { scope: ScopeInfo }) {
  const [name, setName] = useState(scope.name);
  const [description, setDescription] = useState(scope.description);
  const [visibility, setVisibility] = useState(scope.visibility);
  const { act, error, saved } = useAction();
  const project = scope.kind === "project";
  const dirty = name !== scope.name || description !== scope.description || visibility !== scope.visibility;

  return (
    <section className="editor settings-section">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="What it covers, in one line" />
      </label>
      {project && (
        <>
          <div className="field-label">Who can read it</div>
          <fieldset className="choices">
            <label className="choice">
              <input type="radio" name="vis" checked={visibility === "team"} onChange={() => setVisibility("team")} />
              <span>
                <strong>Everyone in Thaliyola</strong>
                <span className="muted small">Anyone signed in can read it; members and teams decide who writes and approves.</span>
              </span>
            </label>
            <label className="choice">
              <input type="radio" name="vis" checked={visibility === "members"} onChange={() => setVisibility("members")} />
              <span>
                <strong>Members only</strong>
                <span className="muted small">Only its members, the members of its teams, and admins can see it. Others won't know it exists.</span>
              </span>
            </label>
          </fieldset>
        </>
      )}
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={!dirty || !name.trim()}
          onClick={() =>
            act("Saved. Reloading…", async () => {
              await api(`/scopes/${scope.slug}`, { method: "PATCH", body: { name, description, ...(project ? { visibility } : {}) } });
              setTimeout(() => window.location.reload(), 500);
            })
          }
        >
          Save
        </button>
      </div>
      {project && <p className="muted small">The short name ({scope.slug}) is used in links and by Claude, so it stays fixed.</p>}
      {project && <Technologies slug={scope.slug} />}
      <h2>Data</h2>
      <div className="actions">
        <ExportButton scope={scope.slug} label={`Export ${scope.name} as Markdown`} />
        <ExportButton scope={scope.slug} site label="Download as a static site" />
        <a className="btn" href={href("/import")}>
          Import documents
        </a>
      </div>
      {project && <DeleteProject scope={scope} />}
    </section>
  );
}

// ---- Members and access -------------------------------------------------------------

function RoleSelect({ value, onChange, label }: { value: Role; onChange: (r: Role) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Role)} aria-label={label}>
      {ROLES.map((r) => (
        <option key={r.role} value={r.role} title={r.text}>
          {r.role}
        </option>
      ))}
    </select>
  );
}

function AccessView({ slug, isProject, me, readOnly = false }: { slug: string; isProject: boolean; me?: Me; readOnly?: boolean }) {
  const access = useApi<Access>(`/scopes/${encodeURIComponent(slug)}/access`);
  const teams = useApi<{ teams: { slug: string; name: string; members: number }[] }>(isProject && !readOnly ? "/teams" : null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("writer");
  const [team, setTeam] = useState("");
  const [teamRole, setTeamRole] = useState<Role>("writer");
  const { act, error, saved } = useAction(() => access.reload());
  const d = access.data;
  if (!d) return access.error ? <ErrorBox error={access.error} /> : <Loading />;
  const manage = d.can_manage && !readOnly;
  const setPerson = (e: string, r: Role | null) => api(`/scopes/${slug}/members`, { method: "PUT", body: { email: e, role: r } });
  const setTeamAccess = (t: string, r: Role | null) => api(`/scopes/${slug}/teams`, { method: "PUT", body: { team: t, role: r } });
  const available = (teams.data?.teams ?? []).filter((t) => !d.teams.some((x) => x.slug === t.slug));

  return (
    <section className="settings-section">
      <p className="muted">
        {d.total_people} {d.total_people === 1 ? "person has" : "people have"} a role here{isProject ? ", directly or through a team" : ""}.{" "}
        {d.visibility === "members" ? "Only they (and admins) can see it." : "Everyone signed in can read it."}
        {" With no writers listed, anyone can propose changes; owners and admins approve them."}
      </p>
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}

      <h2>People</h2>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {d.people.map((p) => (
              <tr key={p.email}>
                <td>
                  {p.name ?? p.email}
                  {p.name && <div className="small muted">{p.email}</div>}
                  {p.pending && <div className="small muted">hasn't signed in yet</div>}
                </td>
                <td>{manage ? <RoleSelect value={p.role} label={`Role of ${p.email}`} onChange={(r) => act(`${p.email} is now ${r}`, () => setPerson(p.email, r))} /> : p.role}</td>
                <td className="row-end">
                  {manage && (
                    <button className="link-btn danger small" onClick={() => act(`Removed ${p.email}`, () => setPerson(p.email, null))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!d.people.length && (
              <tr>
                <td className="muted">No one added directly.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {manage && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(`Added ${email}`, async () => {
              await setPerson(email, role);
              setEmail("");
            });
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Email" />
          <RoleSelect value={role} onChange={setRole} label="Role" />
          <button className="btn" type="submit">
            Add person
          </button>
          {me?.admin && me.auth_mode === "local" && (
            <a className="small" href={href("/admin/users")}>
              Not on Thaliyola yet? Invite them
            </a>
          )}
        </form>
      )}

      {isProject && (
        <>
          <h2>Teams</h2>
          <p className="muted small">Everyone in a team gets its role here. A team can work on many projects.</p>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {d.teams.map((t) => (
                  <tr key={t.slug}>
                    <td>
                      <a href={href(`/teams/${t.slug}`)}>{t.name}</a>
                      <div className="small muted">{t.members.length ? t.members.join(", ") : "no members yet"}</div>
                    </td>
                    <td>{manage ? <RoleSelect value={t.role} label={`Role of ${t.name}`} onChange={(r) => act(`${t.name} is now ${r}`, () => setTeamAccess(t.slug, r))} /> : t.role}</td>
                    <td className="row-end">
                      {manage && (
                        <button className="link-btn danger small" onClick={() => act(`Removed ${t.name}`, () => setTeamAccess(t.slug, null))}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!d.teams.length && (
                  <tr>
                    <td className="muted">No teams yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {manage && (
            <form
              className="inline-form"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (team) void act("Added the team", () => setTeamAccess(team, teamRole).then(() => setTeam("")));
              }}
            >
              <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
                <option value="">{available.length ? "Choose a team…" : "No other teams"}</option>
                {available.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name} ({t.members})
                  </option>
                ))}
              </select>
              <RoleSelect value={teamRole} onChange={setTeamRole} label="Team role" />
              <button className="btn" type="submit" disabled={!team}>
                Add team
              </button>
              <a className="small" href={href("/teams")}>
                {me?.admin ? "Create or edit teams" : "See teams"}
              </a>
            </form>
          )}
        </>
      )}
      <details className="small role-help">
        <summary>What the roles allow</summary>
        <ul>
          {ROLES.map((r) => (
            <li key={r.role}>{r.text}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// ---- Repositories ------------------------------------------------------------------------

type RepoForm = { slug: string; kind: string; repo_url: string; description: string };

function Repositories({ scope }: { scope: ScopeInfo }) {
  const blank: RepoForm = { slug: "", kind: "backend", repo_url: "", description: "" };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState(blank);
  const { act, error, saved } = useAction(() => setTimeout(() => window.location.reload(), 400));
  const suggested = form.repo_url ? (form.repo_url.replace(/(\.git)?\/*$/, "").split(/[/:]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-") : "";

  return (
    <section className="settings-section">
      <p className="muted">
        The codebases that make up {scope.name}, as many as it has (an API, a worker, a web app, a mobile app…). A Claude session in one of these repositories finds this
        project on its own, and contracts link the repository that provides them to the ones that consume them.
      </p>
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}
      <ul className="plain repo-list">
        {scope.components.map((c) =>
          editing === c.slug ? (
            <li key={c.slug} className="repo editing">
              <form
                className="repo-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(`Saved ${edit.slug}. Reloading…`, () =>
                    api(`/projects/${scope.slug}/components/${c.slug}`, {
                      method: "PATCH",
                      body: { slug: edit.slug !== c.slug ? edit.slug : undefined, kind: edit.kind, repo_url: edit.repo_url || null, description: edit.description },
                    }),
                  );
                }}
              >
                <RepoFields value={edit} onChange={setEdit} />
                <div className="actions">
                  <button className="btn btn-primary btn-small" type="submit">
                    Save
                  </button>
                  <button className="btn btn-small" type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            </li>
          ) : (
            <li key={c.slug} className="repo">
              <I name="folder" size={18} />
              <div className="repo-main">
                <div>
                  <strong>{c.slug}</strong> <span className="badge badge-type">{c.kind}</span>
                </div>
                {c.repo_url ? <code className="small">{c.repo_url}</code> : <span className="small warn">No repository URL, so sessions can't find this project on their own.</span>}
                {c.description && <div className="small muted">{c.description}</div>}
              </div>
              <div className="row-actions">
                <button
                  className="link-btn small"
                  onClick={() => {
                    setEditing(c.slug);
                    setEdit({ slug: c.slug, kind: c.kind, repo_url: c.repo_url ?? "", description: c.description ?? "" });
                  }}
                >
                  Edit
                </button>
                <button
                  className="link-btn small danger"
                  onClick={() => {
                    if (confirm(`Remove ${c.slug}? Items and contracts stay; only their links to this repository go.`))
                      void act(`Removed ${c.slug}. Reloading…`, () => api(`/projects/${scope.slug}/components/${c.slug}`, { method: "DELETE" }));
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
        {!scope.components.length && <li className="muted">No repositories yet.</li>}
      </ul>
      <h2>Add a repository</h2>
      <form
        className="repo-form"
        onSubmit={(e) => {
          e.preventDefault();
          const slug = form.slug || suggested;
          void act(`Added ${slug}. Reloading…`, () => api(`/projects/${scope.slug}/components`, { method: "POST", body: { ...form, slug } }));
        }}
      >
        <RepoFields value={form} onChange={setForm} slugPlaceholder={suggested || "e.g. api"} />
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={!form.slug && !suggested}>
            Add repository
          </button>
        </div>
      </form>
    </section>
  );
}

function RepoFields({ value, onChange, slugPlaceholder = "e.g. api" }: { value: RepoForm; onChange: (v: RepoForm) => void; slugPlaceholder?: string }) {
  return (
    <div className="repo-fields editor">
      <label>
        Repository URL
        <input value={value.repo_url} onChange={(e) => onChange({ ...value, repo_url: e.target.value })} placeholder="https://github.com/acme/orders-api" />
      </label>
      <div className="row">
        <label>
          Name in Thaliyola
          <input value={value.slug} onChange={(e) => onChange({ ...value, slug: e.target.value })} placeholder={slugPlaceholder} pattern="[a-z0-9][a-z0-9-]*" />
        </label>
        <label>
          Kind
          <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        What it is (optional)
        <input value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} placeholder="e.g. Public REST API and webhooks" maxLength={500} />
      </label>
    </div>
  );
}

/** Moves the project and everything in it to the trash (restorable). */
function DeleteProject({ scope }: { scope: ScopeInfo }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (!open)
    return (
      <div className="purge-zone">
        <button className="link-btn small danger" onClick={() => setOpen(true)}>
          Delete this project…
        </button>
      </div>
    );
  return (
    <section className="purge-zone open">
      <h3>Delete {scope.name}</h3>
      <p className="small">
        The project and all its articles and findings go to the trash. Nobody can see them there, and search and agents ignore them. Its owners and admins can
        restore everything from the trash; only an admin can delete it for good.
      </p>
      <label className="small">
        Type <strong>{scope.name}</strong> to confirm
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="btn btn-danger"
          disabled={busy || (confirm.trim() !== scope.name.trim() && confirm.trim() !== scope.slug)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/projects/${scope.slug}/delete`, { method: "POST", body: { confirm } });
              window.location.hash = "#/trash";
              window.location.reload();
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Move project to the trash"}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---- Documentation ------------------------------------------------------------------------

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
  const { data, reload } = useApi<DocsStatus>(`/projects/${scope.slug}/docs`);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [ignore, setIgnore] = useState<string | null>(null);
  const [block, setBlock] = useState<{ repo: string; text: string } | null>(null);
  const { act, error, saved } = useAction(reload);
  if (!data) return <Loading />;
  const ins = instructions ?? data.instructions;
  const ign = ignore ?? data.ignore;
  return (
    <section className="settings-section">
      <p className="muted">
        A coding agent with the repository checked out writes these docs: every fact on a page points at the source lines it came from, and when the code changes,
        only the affected pages and facts are redone. In Claude Code, open the repository and run <code>/mcp__thaliyola__document-repo</code> the first time, then{" "}
        <code>/mcp__thaliyola__update-docs</code> (by hand or in CI).
      </p>
      <h2>Repositories</h2>
      {!data.repositories.length && <p className="muted">Add the project's repositories first (Repositories tab).</p>}
      <ul className="plain repo-list">
        {data.repositories.map((r) => (
          <li key={r.slug} className="repo">
            <div className="repo-main">
              <div>
                <strong>{r.slug}</strong> <span className="badge badge-type">{r.kind}</span>
                {r.stale_claims > 0 && <span className="badge badge-possibly_stale">{r.stale_claims} stale facts</span>}
              </div>
              <span className="small muted">
                {r.docs_sha
                  ? `Documented at ${r.docs_sha.slice(0, 10)} · ${formatDateShort(r.docs_updated_at)} · ${r.pages} ${r.pages === 1 ? "page" : "pages"} · ${r.claims} grounded ${r.claims === 1 ? "fact" : "facts"}`
                  : "Not documented yet"}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="link-btn small"
                onClick={async () => setBlock({ repo: r.slug, text: (await api<{ block: string }>(`/projects/${scope.slug}/agents-md?component=${r.slug}`)).block })}
              >
                AGENTS.md block
              </button>
            </div>
          </li>
        ))}
      </ul>
      {block && (
        <div className="card agents-block">
          <div className="card-head">
            <div>
              <h3>AGENTS.md block for {block.repo}</h3>
              <p>Agents keep this up to date at the end of each run. To add it by hand, paste it into AGENTS.md (and CLAUDE.md if the repository has one).</p>
            </div>
            <button className="btn btn-small" onClick={() => navigator.clipboard.writeText(block.text).catch(() => undefined)}>
              Copy
            </button>
          </div>
          <pre className="code-block">{block.text}</pre>
        </div>
      )}

      <h2>Instructions for agents</h2>
      <p className="muted small">What to document and how: the audience, pages that must exist, conventions, things to leave out. Agents receive this at the start of every run.</p>
      <textarea className="body-input" rows={6} value={ins} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Write for new backend engineers. Always include a runbook for each worker. Don't document internal admin tools." />
      <h2>Ignore rules</h2>
      <p className="muted small">gitignore-style paths agents must not read or cite (secrets, vendored code, generated files). Use ! to make exceptions.</p>
      <textarea className="body-input" rows={5} value={ign} onChange={(e) => setIgnore(e.target.value)} placeholder={"secrets/\n*.pem\nvendor/**\n!vendor/README.md"} />
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={ins === data.instructions && ign === data.ignore}
          onClick={() => act("Saved", () => api(`/projects/${scope.slug}/docs-settings`, { method: "PUT", body: { instructions: ins, ignore: ign } }))}
        >
          Save
        </button>
      </div>

      <h2>Recent runs</h2>
      {!data.runs.length && <p className="muted">No documentation runs yet.</p>}
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.repository ?? "project"} · {r.mode}
                  <div className="small muted">{r.summary ?? `${r.written}/${r.pages} pages`}</div>
                </td>
                <td>
                  <span className={`badge badge-${r.status === "done" ? "published" : r.status === "noop" ? "type" : "pending"}`}>{r.status === "noop" ? "up to date" : r.status}</span>
                </td>
                <td className="small muted">
                  {r.head_sha.slice(0, 8)} · {formatDateShort(r.started_at)} · {r.by}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const formatDateShort = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
