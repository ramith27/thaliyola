import { useState, type FormEvent } from "react";
import { api, authApi, type Me } from "../api";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { NotificationPrefs } from "../components/notifications";
import { useApi } from "../hooks";

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi("/login", { email, password });
      onSignedIn();
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
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">Forgot your password? Ask an admin to reset it.</p>
      </form>
    </div>
  );
}

function PasswordForm({ onDone, temporary }: { onDone: () => void; temporary?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError(new Error("the new passwords don't match"));
    try {
      await api("/account/password", { method: "POST", body: { current, next } });
      setSaved(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone();
    } catch (err) {
      setError(err as Error);
    }
  }

  return (
    <form onSubmit={submit} className="stack-form">
      <label>
        {temporary ? "Temporary password" : "Current password"}
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label>
        New password (at least 10 characters)
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
      </label>
      <label>
        Repeat new password
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">Password changed. Other sessions were signed out.</Notice>}
      <div className="actions">
        <button className="btn btn-primary" type="submit">
          Change password
        </button>
      </div>
    </form>
  );
}

export function ForcedPasswordChange({ me, onDone }: { me: Me; onDone: () => void }) {
  return (
    <div className="gate">
      <div>
        <h1>Choose a password</h1>
        <p className="muted">{me.email} is signed in with a temporary password. Pick your own to continue.</p>
        <PasswordForm onDone={onDone} temporary />
      </div>
    </div>
  );
}

interface Token {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function ApiTokens() {
  const { data, reload } = useApi<{ tokens: Token[] }>("/account/tokens");
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ token: string; name: string }>("/account/tokens", {
        method: "POST",
        body: { name, expires_in_days: days ? Number(days) : undefined },
      });
      setCreated(res);
      setName("");
      reload();
    } catch (err) {
      setError(err as Error);
    }
  }

  async function revoke(id: string) {
    await api(`/account/tokens/${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <section>
      <h2>API tokens</h2>
      <p className="muted">Tokens let Claude Code and other MCP clients act as you. They can read everything you can and propose changes in your name.</p>
      {created && (
        <Notice kind="ok">
          <p>
            <strong>{created.name}</strong>: copy the token now. It won't be shown again.
          </p>
          <pre className="code-block">{created.token}</pre>
          <p className="small">Connect Claude Code:</p>
          <pre className="code-block">{`claude mcp add --transport http cairn ${mcpUrl} \\\n  --header "Authorization: Bearer ${created.token}"`}</pre>
        </Notice>
      )}
      <form className="inline-form" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Claude Code on laptop" required aria-label="Token name" />
        <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expiry">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="">No expiry</option>
        </select>
        <button className="btn btn-primary" type="submit">
          Create token
        </button>
      </form>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => (
                <tr key={t.id} className={t.revoked_at ? "muted" : ""}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td>{formatDate(t.last_used_at)}</td>
                  <td>{t.revoked_at ? "revoked" : t.expires_at ? formatDate(t.expires_at) : "never"}</td>
                  <td>
                    {!t.revoked_at && (
                      <button className="link-btn danger small" onClick={() => revoke(t.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.tokens.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    No tokens yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ConnectedApps() {
  const { data, reload } = useApi<{ connections: { client_id: string; name: string; connected_at: string; last_refreshed_at: string }[] }>("/account/connections");
  if (!data?.connections.length) return null;
  return (
    <section>
      <h2>Connected apps</h2>
      <p className="muted">Apps you allowed to use Cairn through OAuth, such as a claude.ai connector.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>App</th>
              <th>Connected</th>
              <th>Last refreshed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.connections.map((c) => (
              <tr key={c.client_id}>
                <td>{c.name}</td>
                <td>{formatDate(c.connected_at)}</td>
                <td>{formatDate(c.last_refreshed_at)}</td>
                <td>
                  <button
                    className="link-btn danger small"
                    onClick={async () => {
                      await api(`/account/connections/${encodeURIComponent(c.client_id)}`, { method: "DELETE" });
                      reload();
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AccountPage({ me }: { me: Me }) {
  return (
    <div className="page">
      <h1>Account</h1>
      <p className="lead">
        {me.email ?? "service account"}
        {me.admin ? " · admin" : ""}
      </p>
      <ApiTokens />
      <ConnectedApps />
      <NotificationPrefs />
      {me.local_account && (
        <section>
          <h2>Password</h2>
          <PasswordForm onDone={() => undefined} />
        </section>
      )}
    </div>
  );
}

interface LocalUser {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  must_change_password: boolean;
  disabled_at: string | null;
  last_seen_at: string | null;
}

export function UsersPage({ me }: { me: Me }) {
  const { data, error, reload } = useApi<{ users: LocalUser[] }>("/users");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err as Error);
    }
  }

  return (
    <div className="page">
      <h1>Users</h1>
      <p className="lead">Accounts that sign in with a password. New users get a temporary password to change at first sign-in.</p>
      {secret && (
        <Notice kind="ok">
          <p>
            Temporary password for <strong>{secret.email}</strong>. Share it privately; it is shown once.
          </p>
          <pre className="code-block">{secret.password}</pre>
        </Notice>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const res = await api<{ user: LocalUser; temporary_password: string }>("/users", { method: "POST", body: { email, name: name || undefined, is_admin: admin } });
            setSecret({ email: res.user.email, password: res.temporary_password });
            setEmail("");
            setName("");
            setAdmin(false);
          });
        }}
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" required aria-label="Email" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (optional)" aria-label="Name" />
        <label className="inline">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> admin
        </label>
        <button className="btn btn-primary" type="submit">
          Add user
        </button>
      </form>
      <ErrorBox error={error ?? actionError} />
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.disabled_at ? "muted" : ""}>
                  <td>
                    {u.email}
                    {u.display_name && <div className="small muted">{u.display_name}</div>}
                  </td>
                  <td>{u.is_admin ? "admin" : "member"}</td>
                  <td>{u.disabled_at ? "disabled" : u.must_change_password ? "temporary password" : "active"}</td>
                  <td>{formatDate(u.last_seen_at)}</td>
                  <td>
                    {u.id !== me.id && (
                      <div className="row-actions">
                        <button
                          className="link-btn small"
                          onClick={() =>
                            act(async () => {
                              const res = await api<{ temporary_password: string }>(`/users/${u.id}/reset-password`, { method: "POST" });
                              setSecret({ email: u.email, password: res.temporary_password });
                            })
                          }
                        >
                          Reset password
                        </button>
                        <button className="link-btn small" onClick={() => act(() => api(`/users/${u.id}`, { method: "PATCH", body: { is_admin: !u.is_admin } }))}>
                          {u.is_admin ? "Remove admin" : "Make admin"}
                        </button>
                        <button
                          className="link-btn small danger"
                          onClick={() => act(() => api(`/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled_at } }))}
                        >
                          {u.disabled_at ? "Enable" : "Disable"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
