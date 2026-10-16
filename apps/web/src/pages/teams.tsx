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
      <p className="lead">A team is a group of people. Add a team to any number of projects and everyone in it gets that role there, so access follows people as they join or leave.</p>
      <ErrorBox error={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <div className="cards">
          {data.teams.map((t) => (
            <a key={t.slug} className="card card-link" href={href(`/teams/${t.slug}`)}>
              <div className="card-link-head">
                <h3>{t.name}</h3>
                {t.mine && <span className="badge badge-published">you're in it</span>}
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
  members: { id: string; email: string; name: string | null; added_at: string }[];
  projects: { slug: string; name: string; kind: string; role: Role }[];
  can_manage: boolean;
}

export function TeamPage({ slug, scopes }: { slug: string; scopes: ScopeInfo[] }) {
  const { data, error, reload } = useApi<TeamDetail>(`/teams/${encodeURIComponent(slug)}`);
  const [email, setEmail] = useState("");
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
                <td className="small muted">added {formatDate(m.added_at)}</td>
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
              await api(`/teams/${slug}/members`, { method: "PUT", body: { email, member: true } });
              setEmail("");
            });
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Email" />
          <button className="btn" type="submit">
            Add member
          </button>
          <span className="muted small">People who haven't signed in yet get access when they first do.</span>
        </form>
      )}

      <h2>Projects</h2>
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
      {data.can_manage && (
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
