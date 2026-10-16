import { useState, type FormEvent } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href, navigate } from "../router";

type Role = "reader" | "writer" | "owner";

interface TeamSummary {
  slug: string;
  name: string;
  description: string;
  members: number;
  mine: boolean;
  my_role: "member" | "lead" | null;
  can_manage: boolean;
  projects: { slug: string; name: string; role: Role }[];
}

/** Teams: groups of people that work on one or more projects. */
export function TeamsPage({ me }: { me: Me }) {
  const { data, error, reload } = useApi<{ teams: TeamSummary[] }>("/teams");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<Error | null>(null);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <div className="page">
      <h1>Teams</h1>
      <p className="lead">
        A team is a group of people. Add a team to any number of projects and everyone in it gets that role there, so access follows people as they join or leave. Team
        leads manage their team's members and can start projects for it.
      </p>
      <ErrorBox error={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <div className="cards">
          {data.teams.map((t) => (
            <a key={t.slug} className="card card-link" href={href(`/teams/${t.slug}`)}>
              <div className="card-link-head">
                <h3>{t.name}</h3>
                {t.mine && <span className="badge badge-published">{t.my_role === "lead" ? "you lead it" : "you're in it"}</span>}
              </div>
              {t.description && <p>{t.description}</p>}
              <p className="muted small">
                {t.members} {t.members === 1 ? "person" : "people"} · {t.projects.length ? t.projects.map((p) => `${p.name} (${p.role})`).join(", ") : "no projects yet"}
              </p>
            </a>
          ))}
          {!data.teams.length && <p className="muted">No teams yet.</p>}
        </div>
      )}
      {me.admin && (
        <section>
          <h2>New team</h2>
          <form
            className="inline-form"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              setFormError(null);
              try {
                await api("/teams", { method: "POST", body: { slug, name, description: description || undefined } });
                navigate(`/teams/${slug}`);
                reload();
              } catch (err) {
                setFormError(err as Error);
              }
            }}
          >
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name, e.g. Payments" aria-label="Team name" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What they work on (optional)" aria-label="Description" />
            <button className="btn btn-primary" type="submit" disabled={!slug}>
              Create team
            </button>
          </form>
          <ErrorBox error={formError} />
        </section>
      )}
    </div>
  );
}

interface TeamDetail {
  slug: string;
  name: string;
  description: string;
  members: { id: string; email: string; name: string | null; role: "member" | "lead"; added_at: string; pending: boolean }[];
  projects: { slug: string; name: string; kind: string; role: Role }[];
  can_manage: boolean;
  can_edit_team: boolean;
}

export function TeamPage({ slug, scopes, me }: { slug: string; scopes: ScopeInfo[]; me: Me }) {
  const { data, error, reload } = useApi<TeamDetail>(`/teams/${encodeURIComponent(slug)}`);
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"member" | "lead">("member");
  const [creating, setCreating] = useState(false);
  const [project, setProject] = useState("");
  const [role, setRole] = useState<Role>("writer");
  const [actionError, setActionError] = useState<Error | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  async function act(label: string, fn: () => Promise<unknown>) {
    setActionError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      reload();
    } catch (e) {
      setActionError(e as Error);
    }
  }
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  // Projects this person can add the team to: the ones they manage.
  const addable = scopes.filter((s) => s.kind === "project" && s.can_manage && !data.projects.some((p) => p.slug === s.slug));

  return (
    <div className="page">
      <p className="breadcrumbs muted small">
        <a href={href("/teams")}>Teams</a> / {data.name}
      </p>
      <h1>{data.name}</h1>
      {data.description && <p className="lead">{data.description}</p>}
      <ErrorBox error={actionError} />
      {saved && <Notice kind="ok">{saved}</Notice>}

      <h2>Members</h2>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name ?? m.email}
                  {m.name && <div className="small muted">{m.email}</div>}
                </td>
                <td>
                  {data.can_manage ? (
                    <select
                      value={m.role}
                      aria-label={`Team role of ${m.email}`}
                      onChange={(e) => act(`${m.email} is now a ${e.target.value}`, () => api(`/teams/${slug}/members`, { method: "PUT", body: { email: m.email, member: true, role: e.target.value } }))}
                    >
                      <option value="member">member</option>
                      <option value="lead">lead</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td className="small muted">{m.pending ? "hasn't signed in yet" : `added ${formatDate(m.added_at)}`}</td>
                <td className="row-end">
                  {data.can_manage && (
                    <button className="link-btn danger small" onClick={() => act(`Removed ${m.email}`, () => api(`/teams/${slug}/members`, { method: "PUT", body: { email: m.email, member: false } }))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data.members.length && (
              <tr>
                <td className="muted">No members yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data.can_manage && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(`Added ${email}`, async () => {
              await api(`/teams/${slug}/members`, { method: "PUT", body: { email, member: true, role: memberRole } });
              setEmail("");
            });
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Email" />
          <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as "member" | "lead")} aria-label="Team role">
            <option value="member">member</option>
            <option value="lead">lead</option>
          </select>
          <button className="btn" type="submit">
            Add member
          </button>
          <span className="muted small">People who haven't signed in yet get access when they first do.</span>
        </form>
      )}

      <div className="section-head">
        <h2>Projects</h2>
        {data.can_manage && !creating && (
          <button className="btn btn-primary btn-small" onClick={() => setCreating(true)}>
            New project for this team
          </button>
        )}
      </div>
      {creating && (
        <TeamProjectForm
          team={data}
          me={me}
          onCancel={() => setCreating(false)}
          onCreated={(project) => {
            navigate(`/scope/${project}/settings`, { tab: "repos" });
            window.location.reload();
          }}
        />
      )}
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.slug}>
                <td>
                  <a href={href(p.kind === "project" ? `/project/${p.slug}` : `/scope/${p.slug}`)}>{p.name}</a>
                </td>
                <td>{p.role}</td>
                <td className="row-end">
                  {scopes.find((s) => s.slug === p.slug)?.can_manage && (
                    <button className="link-btn danger small" onClick={() => act(`Removed from ${p.name}`, () => api(`/scopes/${p.slug}/teams`, { method: "PUT", body: { team: slug, role: null } }))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data.projects.length && (
              <tr>
                <td className="muted">Not on any project yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {addable.length > 0 && (
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (project) void act("Added to the project", () => api(`/scopes/${project}/teams`, { method: "PUT", body: { team: slug, role } }).then(() => setProject("")));
          }}
        >
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">Add to a project…</option>
            {addable.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            <option value="reader">reader</option>
            <option value="writer">writer</option>
            <option value="owner">owner</option>
          </select>
          <button className="btn" type="submit" disabled={!project}>
            Add
          </button>
        </form>
      )}
      {data.can_edit_team && (
        <p className="purge-zone">
          <button
            className="link-btn small danger"
            onClick={() => {
              if (confirm(`Delete the team ${data.name}? Its members lose the access the team gave them.`)) void api(`/teams/${slug}`, { method: "DELETE" }).then(() => navigate("/teams"));
            }}
          >
            Delete this team
          </button>
        </p>
      )}
    </div>
  );
}

/** Starts a project that belongs to this team: the team gets a role on it and the chosen members own it. */
function TeamProjectForm({ team, me, onCancel, onCreated }: { team: TeamDetail; me: Me; onCancel: () => void; onCreated: (slug: string) => void }) {
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [description, setDescription] = useState("");
  const [teamRole, setTeamRole] = useState<Role>("writer");
  const leads = team.members.filter((m) => m.role === "lead").map((m) => m.email);
  const [owners, setOwners] = useState<string[]>(leads.length ? leads : me.email ? [me.email] : []);
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = short || auto;
  const selfForced = !me.admin && !!me.email;

  return (
    <form
      className="card team-project-form editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/teams/${team.slug}/projects`, {
            method: "POST",
            body: { slug, name, description: description || undefined, team_role: teamRole, owners, starter },
          });
          onCreated(slug);
        } catch (err) {
          setError(err as Error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>New project for {team.name}</h3>
      <div className="row">
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Referral program" maxLength={200} />
        </label>
        <label>
          Short name (used in links and by Claude)
          <input value={short} onChange={(e) => setShort(e.target.value)} placeholder={auto || "referrals"} pattern="[a-z0-9][a-z0-9-]*" />
        </label>
      </div>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, in one line" />
      </label>
      <label>
        {team.name}'s role on it
        <select value={teamRole} onChange={(e) => setTeamRole(e.target.value as Role)}>
          <option value="reader">reader: everyone in the team can read it</option>
          <option value="writer">writer: everyone in the team can write; owners approve</option>
          <option value="owner">owner: everyone in the team can approve and manage it</option>
        </select>
      </label>
      <fieldset className="checks">
        <legend>Owners (approve changes and manage the project)</legend>
        {team.members.map((m) => {
          const forced = selfForced && m.email === me.email;
          return (
            <label key={m.id} className="inline">
              <input
                type="checkbox"
                checked={forced || owners.includes(m.email)}
                disabled={forced}
                onChange={(e) => setOwners((o) => (e.target.checked ? [...o, m.email] : o.filter((x) => x !== m.email)))}
              />{" "}
              {m.name ?? m.email}
            </label>
          );
        })}
        {!team.members.length && <span className="muted small">Add members to the team first, or you'll be the owner.</span>}
      </fieldset>
      <label className="inline starter-toggle">
        <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
        <span>
          <strong>Add a starter pack</strong>
          <span className="muted small"> Outlines for an overview, a design doc and an on-call runbook. You add repositories next.</span>
        </span>
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !slug}>
          {busy ? "Creating…" : "Create project"}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
