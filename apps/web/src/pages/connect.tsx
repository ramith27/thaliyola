import { useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

export interface ConnectInfo {
  mcp_url: string;
  origin: string;
  auth_mode: "local" | "cloudflare" | "dev";
  oauth_enabled: boolean;
  account: { email: string | null; admin: boolean; kind: string };
  memberships: { slug: string; name: string; kind: string; role: string }[];
  projects: { slug: string; name: string; visibility: string; components: string[] }[];
  has_connected: boolean;
  catalog: {
    instructions: string;
    tools: { name: string; title?: string; description: string; readOnly: boolean }[];
    prompts: { name: string; title?: string; description: string; arguments: string[] }[];
  };
}

/** A code block with a copy button. */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      {label && <div className="copy-label">{label}</div>}
      <pre className="code-block">{text}</pre>
      <button
        className="btn btn-small copy-btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable (e.g. plain http); the text is selectable */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const ROLE_TEXT: Record<string, string> = { reader: "can read", writer: "can propose changes", owner: "can approve changes" };

export function ConnectPage() {
  const { data, error } = useApi<ConnectInfo>("/connect-info");
  const [token, setToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("Claude Code");
  const [tokenError, setTokenError] = useState<Error | null>(null);
  const [project, setProject] = useState("");
  const [component, setComponent] = useState("");

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const tok = token ?? "<your token>";
  const chosen = data.projects.find((p) => p.slug === project);
  const headers = [
    `--header "Authorization: Bearer ${tok}"`,
    ...(project ? [`--header "X-Thaliyola-Project: ${project}"`] : []),
    ...(project && component ? [`--header "X-Thaliyola-Component: ${component}"`] : []),
  ];
  const repoJson = JSON.stringify(
    {
      mcpServers: {
        thaliyola: {
          type: "http",
          url: data.mcp_url,
          headers: {
            Authorization: "Bearer ${THALIYOLA_TOKEN}",
            ...(project ? { "X-Thaliyola-Project": project } : {}),
            ...(project && component ? { "X-Thaliyola-Component": component } : {}),
          },
        },
      },
    },
    null,
    2,
  );
  const genericJson = JSON.stringify({ mcpServers: { thaliyola: { type: "http", url: data.mcp_url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2);

  async function createToken() {
    setTokenError(null);
    try {
      const res = await api<{ token: string }>("/account/tokens", { method: "POST", body: { name: tokenName || "Claude Code", expires_in_days: 90 } });
      setToken(res.token);
    } catch (e) {
      setTokenError(e as Error);
    }
  }

  return (
    <div className="page connect">
      <h1>Connect your tools</h1>
      <p className="lead">
        Thaliyola is your team's shared knowledge for Claude: systems, project designs, API contracts, UI specs and what past investigations found. Connect
        Claude once, and it searches here before investigating, loads project context before coding, and proposes what it learns for review.
      </p>

      <section className="step">
        <h2>Your access</h2>
        <dl className="facts">
          <dt>Signed in as</dt>
          <dd>
            {data.account.email ?? "service account"} {data.account.admin && <span className="badge">admin</span>}
          </dd>
          <dt>Server</dt>
          <dd>
            <code>{data.mcp_url}</code>
          </dd>
          <dt>You can read</dt>
          <dd>
            Team, Library and {data.projects.length} project{data.projects.length === 1 ? "" : "s"}
            {data.projects.length ? `: ${data.projects.map((p) => p.name).join(", ")}` : ""}
          </dd>
          <dt>Roles</dt>
          <dd>
            {data.account.admin
              ? "Admin: can approve anywhere and manage projects and users."
              : data.memberships.length
                ? data.memberships.map((m) => `${m.name}: ${m.role} (${ROLE_TEXT[m.role] ?? m.role})`).join(" · ")
                : "No specific roles yet. You can read and propose in team-visible scopes; scope owners approve."}
          </dd>
        </dl>
      </section>

      <section className="step">
        <h2>
          <span className="step-no">1</span> Create a token
        </h2>
        <p className="muted">A personal API token lets Claude act as you. It can read what you can read and propose changes in your name.</p>
        {token ? (
          <Notice kind="ok">
            <p>
              Token created. It's filled into the commands below. <strong>Copy it now:</strong> it won't be shown again.
            </p>
            <CopyBlock text={token} />
          </Notice>
        ) : (
          <div className="inline-form">
            <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} aria-label="Token name" placeholder="Token name" />
            <button className="btn btn-primary" onClick={createToken}>
              Create token
            </button>
            <a className="small" href={href("/account")}>
              Manage tokens
            </a>
          </div>
        )}
        <ErrorBox error={tokenError} />
      </section>

      <section className="step">
        <h2>
          <span className="step-no">2</span> Connect Claude Code
        </h2>
        <h3>For all your work</h3>
        <CopyBlock text={`claude mcp add --transport http thaliyola ${data.mcp_url} --scope user \\\n  ${headers[0]}`} />
        <p className="muted small">
          In a repository that's listed under a project's settings → Repositories, Claude passes its git remote and Thaliyola picks the project and component by itself.
        </p>

        <h3>For one project's repository (recommended)</h3>
        <p className="muted small">
          With the project and component set, Claude knows which contracts, designs and change notices apply, without being told each time.
        </p>
        <div className="inline-form">
          <select value={project} onChange={(e) => (setProject(e.target.value), setComponent(""))} aria-label="Project">
            <option value="">Choose a project…</option>
            {data.projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          {chosen && chosen.components.length > 0 && (
            <select value={component} onChange={(e) => setComponent(e.target.value)} aria-label="Component">
              <option value="">Any component</option>
              {chosen.components.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>
        {project ? (
          <>
            <CopyBlock label="In the repository, run:" text={`claude mcp add --transport http thaliyola ${data.mcp_url} \\\n  ${headers.join(" \\\n  ")}`} />
            <p className="muted small">
              Or commit a shared <code>.mcp.json</code> so everyone on the repo gets it, with each person's token kept in their own environment:
            </p>
            <CopyBlock label=".mcp.json" text={repoJson} />
            <CopyBlock label="In your shell profile" text={`export THALIYOLA_TOKEN=${tok}`} />
            <CopyBlock
              label="Add to the repo's CLAUDE.md"
              text={`## Team knowledge (Thaliyola)
- Before investigating a bug or alert, search Thaliyola (search_knowledge) with the symptom as it first appeared.
- Before changing code, call get_project_context and handle open impact notices.
- After confirming a root cause or making a design decision, propose it to Thaliyola. Never include secrets.`}
            />
          </>
        ) : (
          <p className="muted small">Choose a project to get the commands for its repository.</p>
        )}
        <p className="small">
          Check the connection with <code>claude mcp list</code>: it should show <code>thaliyola … Connected</code>.
        </p>
      </section>

      {data.oauth_enabled && (
        <section className="step">
          <h2>
            <span className="step-no">3</span> Connect claude.ai (optional)
          </h2>
          <ol className="list">
            <li>
              In claude.ai, open <strong>Settings → Connectors → Add custom connector</strong>.
            </li>
            <li>Enter this URL:</li>
          </ol>
          <CopyBlock text={data.mcp_url} />
          <ol className="list" start={3}>
            <li>Sign in with your Thaliyola account and approve. You can revoke access on your Account page.</li>
          </ol>
        </section>
      )}

      <section className="step">
        <h2>Other MCP clients</h2>
        <p className="muted small">Any client that supports remote MCP servers over HTTP (streamable HTTP) with a bearer token:</p>
        <CopyBlock text={genericJson} />
      </section>

      <section className="step">
        <h2>Using it</h2>
        <p>
          You don't need to name tools. Ask normally: "the checkout alert is firing again, what do we know?", "I'm about to change the refunds screen",
          "capture what we just found". These workflow prompts are also available as commands (in Claude Code: <code>/mcp__thaliyola__…</code>):
        </p>
        <table className="table">
          <tbody>
            {data.catalog.prompts.map((p) => (
              <tr key={p.name}>
                <td>
                  <code>/mcp__thaliyola__{p.name}</code>
                  {p.arguments.length > 0 && <div className="small muted">{p.arguments.join(", ")}</div>}
                </td>
                <td>{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>How changes are published</h3>
        <ul className="list">
          <li>Everything Claude writes is a proposal. A scope owner approves it on the Review page before others see it in search.</li>
          <li>Secrets and personal data are removed automatically from text. Screenshots aren't scanned, so don't upload ones that show secrets.</li>
          <li>When a shared contract or design changes, the projects that use it get an impact notice the next time Claude loads their context.</li>
        </ul>
        <details>
          <summary>All {data.catalog.tools.length} tools</summary>
          <table className="table">
            <tbody>
              {data.catalog.tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                    <div className="small muted">{t.readOnly ? "read" : "write (proposal)"}</div>
                  </td>
                  <td className="small">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </div>
  );
}

/** Home-page banner until the person has connected a tool. */
export function GetStartedBanner() {
  const { data } = useApi<ConnectInfo>("/connect-info");
  if (!data || data.has_connected) return null;
  return (
    <div className="get-started">
      <div>
        <strong>Get started: connect Claude to Thaliyola</strong>
        <p className="muted small">Create a token and copy one command. Claude will search team knowledge before it investigates and load project context before it codes.</p>
      </div>
      <a className="btn btn-primary" href={href("/connect")}>
        Connect your tools
      </a>
    </div>
  );
}
