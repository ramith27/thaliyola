import { useState, type FormEvent } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { ErrorBox, Loading, Notice } from "../components/ui";
import { ExportButton } from "./setup";
import { useApi } from "../hooks";
import { href, navigate } from "../router";

const ROLE_HELP: Record<string, string> = {
  reader: "can read (matters for members-only projects)",
  writer: "can propose changes",
  owner: "can approve changes",
};

/** Admin page for one scope: visibility, members and (for projects) components. */
export function ScopeSettingsPage({ slug, scopes, me }: { slug: string; scopes: ScopeInfo[]; me: Me }) {
  const scope = scopes.find((s) => s.slug === slug);
  const members = useApi<{ members: { email: string; role: string }[] }>(`/scopes/${encodeURIComponent(slug)}/members`);
  const [visibility, setVisibility] = useState(scope?.visibility ?? "team");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("writer");
  const [component, setComponent] = useState({ slug: "", kind: "backend", repo_url: "" });
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (!scope) return <p>Scope not found.</p>;
  if (!me.admin) return <Notice kind="warn">Only admins can change scope settings.</Notice>;

  async function act(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      members.reload();
    } catch (e) {
      setError(e as Error);
    }
  }

  return (
    <div className="page">
      <p className="muted small">
        <a href={href(scope.kind === "project" ? `/project/${slug}` : `/scope/${slug}`)}>{scope.name}</a> / settings
      </p>
      <h1>{scope.name} settings</h1>
      <div className="actions">
        <ExportButton scope={slug} label={`Export ${scope.name} as Markdown`} />
        <a className="btn" href={href("/import")}>
          Import documents
        </a>
      </div>
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{saved}</Notice>}

      {scope.kind === "project" && (
        <section>
          <h2>Who can read it</h2>
          <fieldset className="choices">
            <label className="choice">
              <input type="radio" name="vis" checked={visibility === "team"} onChange={() => setVisibility("team")} />
              <span>
                <strong>Whole team</strong>
                <span className="muted small">Everyone signed in can read it. The default.</span>
              </span>
            </label>
            <label className="choice">
              <input type="radio" name="vis" checked={visibility === "members"} onChange={() => setVisibility("members")} />
              <span>
                <strong>Members only</strong>
                <span className="muted small">Only the people below (and admins) can see it. Others won't know it exists.</span>
              </span>
            </label>
          </fieldset>
          <button
            className="btn btn-primary"
            disabled={visibility === scope.visibility}
            onClick={() =>
              act("Visibility saved. Reloading…", async () => {
                await api(`/scopes/${slug}`, { method: "PATCH", body: { visibility } });
                setTimeout(() => window.location.reload(), 600);
              })
            }
          >
            Save visibility
          </button>
        </section>
      )}

      <section>
        <h2>Members</h2>
        <p className="muted small">
          {Object.entries(ROLE_HELP)
            .map(([r, t]) => `${r}: ${t}`)
            .join(" · ")}
          . With no writers listed, everyone can propose in a team-visible scope.
        </p>
        {!members.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {members.data.members.map((m) => (
                  <tr key={m.email}>
                    <td>{m.email}</td>
                    <td>{m.role}</td>
                    <td>
                      <button className="link-btn danger small" onClick={() => act(`Removed ${m.email}`, () => api(`/scopes/${slug}/members`, { method: "PUT", body: { email: m.email, role: null } }))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {!members.data.members.length && (
                  <tr>
                    <td className="muted">No members yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="inline-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(`Added ${email}`, async () => {
              await api(`/scopes/${slug}/members`, { method: "PUT", body: { email, role } });
              setEmail("");
            });
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" aria-label="Member email" />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="reader">reader</option>
            <option value="writer">writer</option>
            <option value="owner">owner</option>
          </select>
          <button className="btn" type="submit">
            Add member
          </button>
        </form>
      </section>

      {scope.kind === "project" && (
        <section>
          <h2>Components</h2>
          <p className="muted small">Codebases in this project. Contracts link the component that provides them to the ones that consume them.</p>
          <ul className="list">
            {scope.components.map((c) => (
              <li key={c.slug}>
                <strong>{c.slug}</strong> <span className="muted small">{c.kind}</span> {c.repo_url && <span className="small">{c.repo_url}</span>}
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act(`Added component ${component.slug}. Reloading…`, async () => {
                await api(`/projects/${slug}/components`, { method: "POST", body: { slug: component.slug, kind: component.kind, repo_url: component.repo_url || undefined } });
                setTimeout(() => window.location.reload(), 600);
              });
            }}
          >
            <input required value={component.slug} onChange={(e) => setComponent({ ...component, slug: e.target.value })} placeholder="slug, e.g. backend" aria-label="Component slug" />
            <select value={component.kind} onChange={(e) => setComponent({ ...component, kind: e.target.value })} aria-label="Component kind">
              {["backend", "frontend", "mobile", "data", "infra", "other"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input value={component.repo_url} onChange={(e) => setComponent({ ...component, repo_url: e.target.value })} placeholder="repo URL (optional)" aria-label="Repo URL" />
            <button className="btn" type="submit">
              Add component
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
