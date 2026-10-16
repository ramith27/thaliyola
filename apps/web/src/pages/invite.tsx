import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, authApi, type ScopeInfo } from "../api";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";

/** Accepting an invitation link (no account yet): choose a password, then you're signed in. */
export function InviteAcceptPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; name: string | null; inviter: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    authApi<{ email: string; name: string | null; inviter: string }>(`/invite/${encodeURIComponent(token)}`)
      .then((i) => {
        setInfo(i);
        setName(i.name ?? "");
      })
      .catch((e) => setInvalid(e instanceof ApiError ? e.message : "This invitation can't be opened."));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("the passwords don't match"));
    setBusy(true);
    setError(null);
    try {
      await authApi(`/invite/${encodeURIComponent(token)}`, { password, name: name || undefined });
      window.location.hash = "#/";
      onDone();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form onSubmit={submit}>
        <h1>
          <img src="/favicon.svg" alt="" width={26} height={26} /> Cairn
        </h1>
        {invalid ? (
          <>
            <Notice kind="warn">{invalid}</Notice>
            <p className="muted small">Ask whoever invited you to send a new invitation.</p>
          </>
        ) : !info ? (
          <Loading />
        ) : (
          <>
            <p>
              <strong>{info.inviter}</strong> invited <strong>{info.email}</strong> to your team's knowledge base. Choose a password to finish.
            </p>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
            <input type="email" value={info.email} autoComplete="username" readOnly hidden />
            <label>
              Password (at least 10 characters)
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus />
            </label>
            <label>
              Repeat password
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            <ErrorBox error={error} />
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Join Cairn"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

interface Invitation {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  expires_at: string;
  invited_by: string;
  scope: string | null;
  scope_role: string | null;
  state: "open" | "accepted" | "revoked" | "expired";
}

/** Admin panel: send invitations by email and see their state. */
export function Invitations({ scopes }: { scopes: ScopeInfo[] }) {
  const { data, reload } = useApi<{ invitations: Invitation[] }>("/invitations");
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState("");
  const [role, setRole] = useState("writer");
  const [sent, setSent] = useState<{ email: string; emailed: boolean; link: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const projects = scopes.filter((s) => s.kind === "project");

  return (
    <section className="card invite-card">
      <div className="card-head">
        <h3>Invite people</h3>
        <p>They get an email with a link to choose their own password. Links work once and expire after 7 days.</p>
      </div>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const res = await api<{ email: string; emailed: boolean; link: string }>("/invitations", {
              method: "POST",
              body: { email, scope: scope || undefined, role: scope ? role : undefined },
            });
            setSent(res);
            setEmail("");
            reload();
          } catch (err) {
            setError(err as Error);
          }
        }}
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required aria-label="Email to invite" />
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Add to project">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        {scope && (
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Project role">
            <option value="reader">reader</option>
            <option value="writer">writer</option>
            <option value="owner">owner</option>
          </select>
        )}
        <button className="btn btn-primary" type="submit">
          Send invitation
        </button>
      </form>
      <ErrorBox error={error} />
      {sent && (
        <Notice kind="ok">
          {sent.emailed ? `Invitation emailed to ${sent.email}.` : `Email isn't set up on this server, so send ${sent.email} this link yourself:`}
          {!sent.emailed && <pre className="code-block">{sent.link}</pre>}
        </Notice>
      )}
      {!!data?.invitations.length && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Project</th>
                <th>State</th>
                <th>Sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.invitations.map((i) => (
                <tr key={i.id} className={i.state === "open" ? "" : "muted"}>
                  <td>{i.email}</td>
                  <td>{i.scope ? `${i.scope} (${i.scope_role})` : "—"}</td>
                  <td>{i.state}</td>
                  <td>
                    {formatDate(i.created_at)} <span className="small muted">by {i.invited_by}</span>
                  </td>
                  <td>
                    {i.state === "open" && (
                      <button className="link-btn small danger" onClick={() => api(`/invitations/${i.id}`, { method: "DELETE" }).then(reload)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
