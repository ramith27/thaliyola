import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { AGENTS_MD, CiDocs, ConnectScript, HostSetup, hostGuides, INSTRUCTIONS_FILE } from "../components/hosts";
import { humanize, plural } from "../components/labels";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  CopyButton,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  Page,
  PageHeader,
  PersonChip,
  SecretReveal,
  Select,
  SkeletonCard,
  SkeletonText,
  Stepper,
  Tabs,
  TextInput,
  type CodeBlockProps,
} from "../components/kit";
import { useApi, useMediaQuery } from "../hooks";
import { useBoot } from "../components/boot";
import type { SkillsConnect } from "../components/skill-utils";
import { SkillsConnectCard } from "./skills";
import { href } from "../router";

export interface ConnectInfo {
  mcp_url: string;
  origin: string;
  auth_mode: "local" | "cloudflare" | "dev";
  oauth_enabled: boolean;
  account: { email: string | null; name?: string | null; admin: boolean; kind: string };
  /** Project roles per project (role is the older single-role field). */
  memberships: { slug: string; name: string; kind: string; role: string; roles?: string[]; role_names?: string[] }[];
  projects: { slug: string; name: string; visibility: string; components: string[] }[];
  has_connected: boolean;
  /** Skills for Claude: the delivery state and the Claude Code sync setup. */
  skills?: SkillsConnect;
  catalog: {
    instructions: string;
    tools: { name: string; title?: string; description: string; readOnly: boolean }[];
    prompts: { name: string; title?: string; description: string; arguments: string[] }[];
  };
}

/** Names for the built-in project role keys, for when the server sends no role_names (glossary: never show a key). */
const ROLE_KEY_LABEL: Record<string, string> = { owner: "Project admin", writer: "Contributor", reader: "Viewer", reviewer: "Reviewer" };
const roleLabels = (m: ConnectInfo["memberships"][number]) =>
  m.role_names?.length ? m.role_names : (m.roles?.length ? m.roles : [m.role]).map((k) => ROLE_KEY_LABEL[k] ?? humanize(k));

/** Stands in for the token in every command until one is created on this page. */
const TOKEN_PLACEHOLDER = "<your token>";

function guessLanguage(text: string, label?: string): NonNullable<CodeBlockProps["language"]> {
  const l = (label ?? "").toLowerCase();
  const t = text.trimStart();
  if (/\.json\b/.test(l) || t.startsWith("{")) return "json";
  if (/\.ya?ml\b/.test(l)) return "yaml";
  if (/\.md\b/.test(l) || t.startsWith("## ")) return "markdown";
  if (/^(claude|curl|export|gemini|git|thaliyola-admin|npm|npx) /.test(t)) return "shell";
  return "text";
}

/**
 * Code with its label and Copy above it (the kit CodeBlock). Commands that still hold "<your token>" highlight it
 * with "Create a token first". Same props as before; `language` is optional (guessed from the label and text).
 */
export function CopyBlock({ text, label, language, wrap }: { text: string; label?: string; language?: CodeBlockProps["language"]; wrap?: boolean }) {
  return (
    <CodeBlock
      code={text}
      wrap={wrap}
      label={label}
      language={language ?? guessLanguage(text, label)}
      placeholder={text.includes(TOKEN_PLACEHOLDER) ? { token: TOKEN_PLACEHOLDER, hint: "Create a token first" } : undefined}
    />
  );
}

export function ConnectPage() {
  const { me } = useBoot();
  const info = useApi<ConnectInfo>("/connect-info");
  const narrow = useMediaQuery("(max-width: 1100px)");
  const data = info.data;
  const status = data ? (
    data.has_connected ? (
      <Badge tone="success" icon="check-circle">
        Connected
      </Badge>
    ) : (
      <Badge tone="neutral" variant="outline">
        Not connected yet
      </Badge>
    )
  ) : undefined;
  const rail =
    narrow || (info.error && !data) ? undefined : (
      <Card title="Your access" titleLevel={2} padding="sm">
        {data ? <YourAccess data={data} /> : <SkeletonText lines={8} />}
      </Card>
    );

  return (
    <Page width="content" rail={rail} railLabel="Your access">
      <PageHeader
        title="Connect Claude"
        description="Connect Claude and other agents so they search your team's knowledge before they investigate and load project context before they code."
        status={status}
      />
      <AsyncBlock
        result={info}
        label="Loading your connection details"
        errorTitle="Couldn't load your connection details"
        skeleton={
          <div className="tl-stack">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        }
      >
        {(d) => (
          <div className="tl-connect">
            {narrow && (
              <Disclosure summary="Your access" className="tl-access-disclosure">
                <YourAccess data={d} />
              </Disclosure>
            )}
            <ConnectSteps data={d} onCheck={info.reload} checking={info.loading} />
            {d.skills && <SkillsConnectCard skills={d.skills} me={me} />}
            <MoreAboutIt data={d} />
          </div>
        )}
      </AsyncBlock>
    </Page>
  );
}

/** Who you are, the server, what you can read and your project roles. */
function YourAccess({ data }: { data: ConnectInfo }) {
  const a = data.account;
  const n = data.projects.length;
  const rows: { term: string; value: ReactNode }[] = [
    {
      term: "Signed in as",
      value: (
        <span className="tl-signed-in">
          {a.email || a.name ? (
            <PersonChip name={a.name} email={a.email} kind={a.kind === "service" ? "service" : "human"} showEmail />
          ) : (
            <span>Service account</span>
          )}
          {a.admin && <Badge tone="accent">Administrator</Badge>}
        </span>
      ),
    },
    { term: "Server", value: <CodeBlock code={data.mcp_url} label="MCP URL" language="text" /> },
    {
      term: "You can read",
      value: (
        <>
          Team space, Library and {plural(n, "project")}
          {n > 0 && <span className="tl-names muted small">{data.projects.map((p) => p.name).join(", ")}</span>}
        </>
      ),
    },
    {
      term: "Project roles",
      value: (
        <>
          {a.admin && <p className="tl-role-line">Administrator: can do everything, in every project.</p>}
          {data.memberships.length > 0 ? (
            <ul className="tl-list tl-role-list">
              {data.memberships.map((m) => (
                <li key={m.slug}>
                  {m.name}: {roleLabels(m).join(", ")}
                </li>
              ))}
            </ul>
          ) : a.admin ? null : (
            <p className="tl-role-line">No project roles yet. You can read and propose in projects everyone can see; their Project admins and Reviewers approve.</p>
          )}
          <a href={href("/account")}>See all your access</a>
        </>
      ),
    },
  ];
  // Stacked terms and values: the rail is too narrow for the two-column Facts.
  return (
    <dl className="tl-access">
      {rows.map((r) => (
        <div key={r.term} className="tl-access-row">
          <dt>{r.term}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface ApiToken {
  id: string;
  revoked_at: string | null;
  expires_at: string | null;
}

type ToolId = string;
/** Step 3's tabs. "other" holds the host picker; `tool` (below) is the host id that step 4 and the panel use. */
type ToolTab = "claude-code" | "claude-ai" | "all" | "other";

/** The five steps: token, project, tool, instructions, check. */
function ConnectSteps({ data, onCheck, checking }: { data: ConnectInfo; onCheck: () => void; checking: boolean }) {
  const tokens = useApi<{ tokens: ApiToken[] }>("/account/tokens");
  const [token, setToken] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [tokenName, setTokenName] = useState("Claude Code");
  const [createdName, setCreatedName] = useState("");
  const [tokenError, setTokenError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [project, setProject] = useState("");
  const [component, setComponent] = useState("");
  const [tab, setTab] = useState<ToolTab>("claude-code");
  const [host, setHost] = useState<ToolId>("codex");
  const [checked, setChecked] = useState(false);
  const projectRef = useRef<HTMLSelectElement>(null);

  const now = Date.now();
  const active = (tokens.data?.tokens ?? []).filter((t) => !t.revoked_at && (!t.expires_at || new Date(t.expires_at).getTime() > now)).length;
  const tok = token ?? TOKEN_PLACEHOLDER;
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
  const guides = hostGuides({ url: data.mcp_url, token: tok, project: project || undefined, component: component || undefined });
  const toolTabs: { id: ToolTab; label: string; hidden?: boolean }[] = [
    { id: "claude-code", label: "Claude Code" },
    { id: "claude-ai", label: "claude.ai", hidden: !data.oauth_enabled },
    { id: "all", label: "All agents" },
    { id: "other", label: "Other agents" },
  ];
  const currentTab: ToolTab = toolTabs.some((t) => t.id === tab && !t.hidden) ? tab : "claude-code";
  const currentHost = guides.some((g) => g.id === host) ? host : (guides[0]?.id ?? "other");
  /** The tool the instructions in step 4 are for: the tab, or the host chosen under "Other agents". */
  const tool: ToolId = currentTab === "other" ? currentHost : currentTab;

  async function createToken(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setTokenError(null);
    setCreating(true);
    const name = tokenName.trim() || "Claude Code";
    try {
      const res = await api<{ token: string }>("/account/tokens", { method: "POST", body: { name, expires_in_days: 90 } });
      setToken(res.token);
      setCreatedName(name);
      setRevealing(true);
      tokens.reload();
    } catch (err) {
      setTokenError(err);
    } finally {
      setCreating(false);
    }
  }

  function copiedToken() {
    setRevealing(false);
    // The token step is done: go on to step 2.
    requestAnimationFrame(() => projectRef.current?.focus());
  }

  const setupLine = project ? (
    <p className="muted small">
      Set up for {chosen?.name ?? project}
      {component ? ` (${component})` : ""}.
    </p>
  ) : (
    <p className="muted small">Choose a project in step 2 to add its headers.</p>
  );

  function toolPanel(id: ToolTab): ReactNode {
    if (id === "claude-code") {
      return (
        <div className="tl-stack">
          <h3 className="tl-subhead">For all your work</h3>
          <CopyBlock wrap label="Run once" text={`claude mcp add --transport http thaliyola ${data.mcp_url} --scope user \\\n  ${headers[0]}`} />
          <p className="muted small">
            In a repository that's listed in a project's settings › Repositories, Claude passes its git remote and Thaliyola picks the project and repository by itself.
          </p>
          <h3 className="tl-subhead">For one project's repository (recommended)</h3>
          <p className="muted small">With the project and repository set, Claude knows which contracts, designs and change notices apply, without being told each time.</p>
          {project ? (
            <>
              <CopyBlock wrap label="In the repository, run" text={`claude mcp add --transport http thaliyola ${data.mcp_url} \\\n  ${headers.join(" \\\n  ")}`} />
              <p className="muted small">
                Or commit a shared <code>.mcp.json</code> so everyone on the repository gets it, with each person's token kept in their own environment:
              </p>
              <CopyBlock label=".mcp.json" text={repoJson} />
              <CopyBlock label="In your shell profile" language="shell" text={`export THALIYOLA_TOKEN=${tok}`} />
            </>
          ) : (
            <p className="muted small">Choose a project to get the commands for its repository.</p>
          )}
        </div>
      );
    }
    if (id === "claude-ai") {
      return (
        <div className="tl-stack">
          <ol className="tl-list tl-ordered">
            <li>
              In claude.ai, open <strong>Settings › Connectors › Add custom connector</strong>.
            </li>
            <li>Enter this URL:</li>
          </ol>
          <CopyBlock label="Connector URL" language="text" text={data.mcp_url} />
          <ol className="tl-list tl-ordered" start={3}>
            <li>Sign in with your Thaliyola account and approve. You can revoke access on your Account page.</li>
          </ol>
          <p className="muted small">claude.ai doesn't need a token: it signs in instead.</p>
        </div>
      );
    }
    if (id === "all") {
      return (
        <div className="tl-stack">
          {setupLine}
          <ConnectScript origin={data.origin} token={tok} />
        </div>
      );
    }
    const g = guides.find((x) => x.id === currentHost);
    return (
      <div className="tl-stack">
        <Field label="Your tool" className="tl-host-field">
          <Select value={currentHost} onChange={(e) => setHost(e.target.value)} options={guides.map((x) => ({ value: x.id, label: x.name }))} />
        </Field>
        {setupLine}
        {g && <HostSetup guide={g} />}
      </div>
    );
  }

  const done = [token !== null, !!project, false, false, data.has_connected];
  const current = done.findIndex((d) => !d);
  const statusOf = (i: number) => (done[i] ? "done" : i === current ? "current" : "todo") as "done" | "current" | "todo";

  const check = () => {
    setChecked(true);
    onCheck();
  };

  return (
    <Stepper
      steps={[
        {
          id: "token",
          title: "Create a token",
          status: statusOf(0),
          content: (
            <div className="tl-stack">
              <p className="muted">A personal token lets Claude act as you: it reads what you can read and proposes changes in your name.</p>
              {token && revealing ? (
                <SecretReveal
                  title="Your new token"
                  value={token}
                  warning="Copy it now: it won't be shown again. It's already filled into the commands below."
                  onDone={copiedToken}
                  doneLabel="I've copied it"
                />
              ) : token ? (
                <p className="tl-done-line">
                  Token “{createdName}” created and filled into the commands below. <a href={href("/account", { section: "tokens" })}>Manage tokens</a>
                </p>
              ) : (
                <form className="tl-token-form" onSubmit={createToken} noValidate>
                  <Field label="Token name" hint="Expires in 90 days. Revoke it any time in Account." className="tl-token-field">
                    <TextInput value={tokenName} maxLength={100} onChange={(e) => setTokenName(e.target.value)} autoComplete="off" />
                  </Field>
                  <div className="tl-row">
                    <Button type="submit" variant="primary" icon="key" loading={creating} loadingText="Creating…">
                      Create token
                    </Button>
                    <Button variant="ghost" href={href("/account", { section: "tokens" })}>
                      Manage tokens
                    </Button>
                  </div>
                  {active > 0 && (
                    <p className="muted small">
                      You have {plural(active, "active token")}. Their values aren't shown again, so create a new one to fill in the commands.
                    </p>
                  )}
                  {!!tokenError && <ErrorState compact error={tokenError} title="Couldn't create the token" />}
                </form>
              )}
            </div>
          ),
        },
        {
          id: "project",
          title: "Pin to a project (optional)",
          status: statusOf(1),
          content: (
            <div className="tl-stack">
              <div className="tl-pin">
                <Field label="Project" optional>
                  <Select
                    ref={projectRef}
                    value={project}
                    onChange={(e) => {
                      setProject(e.target.value);
                      setComponent("");
                    }}
                    options={[{ value: "", label: "Choose a project…" }, ...data.projects.map((p) => ({ value: p.slug, label: p.name }))]}
                  />
                </Field>
                {chosen && chosen.components.length > 0 && (
                  <Field label="Repository" optional>
                    <Select
                      value={component}
                      onChange={(e) => setComponent(e.target.value)}
                      options={[{ value: "", label: "Any repository" }, ...chosen.components.map((c) => ({ value: c, label: c }))]}
                    />
                  </Field>
                )}
              </div>
              {!project && <p className="muted small">Choose a project to get the commands for its repository.</p>}
            </div>
          ),
        },
        {
          id: "tool",
          title: "Choose your tool",
          status: statusOf(2),
          content: (
            <div className="tl-stack">
              <div className="tl-wrap-tabs">
                <Tabs label="Tool" idPrefix="tl-tool" value={currentTab} onChange={(id) => setTab(id as ToolTab)} items={toolTabs} />
              </div>
              <div role="tabpanel" id={`tl-tool-panel-${currentTab}`} aria-labelledby={`tl-tool-tab-${currentTab}`} className="tl-tabpanel">
                {toolPanel(currentTab)}
              </div>
            </div>
          ),
        },
        {
          id: "instructions",
          title: "Tell your agent to use it",
          status: statusOf(3),
          content: (
            <div className="tl-stack">
              <p className="muted">With these lines in its instructions, your agent uses Thaliyola without being asked.</p>
              <CopyBlock label={`Add to ${INSTRUCTIONS_FILE[tool] ?? INSTRUCTIONS_FILE.other}`} language="markdown" text={AGENTS_MD} />
            </div>
          ),
        },
        {
          id: "check",
          title: "Check it works",
          status: statusOf(4),
          content: (
            <div className="tl-stack">
              <p>
                In Claude Code, run <code>claude mcp list</code>: it should show <code>thaliyola … Connected</code>. Then ask it something, and check here.
              </p>
              <div className="tl-row">
                <Button icon="refresh" loading={checking} loadingText="Checking" onClick={check}>
                  Check connection
                </Button>
                <span role="status" className="small">
                  {checked && !checking
                    ? data.has_connected
                      ? "Connected: Thaliyola has had requests from your tools."
                      : "Not connected yet. Ask your agent something that needs Thaliyola, then check again."
                    : ""}
                </span>
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}

/** CI, what you can ask, how changes are published and the full tool list, each behind a disclosure. */
function MoreAboutIt({ data }: { data: ConnectInfo }) {
  const tools = data.catalog.tools;
  return (
    <div className="tl-more">
      <Disclosure summary="Keep docs and security checks current in CI" storageKey="tl-connect-ci">
        <CiDocs mcpUrl={data.mcp_url} />
      </Disclosure>
      <Disclosure summary="What you can ask" storageKey="tl-connect-ask">
        <div className="tl-stack">
          <p>
            You don't need to name tools. Ask normally: “the checkout alert is firing again, what do we know?”, “I'm about to change the refunds screen”, “capture what we just
            found”.
          </p>
          <p className="muted small">
            These workflows are also commands. In Claude Code, type them as <code>/mcp__thaliyola__…</code>:
          </p>
          {data.catalog.prompts.length ? (
            <div className="tl-prompts">
              {data.catalog.prompts.map((p) => {
                const command = `/mcp__thaliyola__${p.name}`;
                return (
                  <Card key={p.name} padding="sm" title={<code className="tl-break">{command}</code>} actions={<CopyButton text={command} />}>
                    <p className="small">{p.description}</p>
                    {p.arguments.length > 0 && <p className="muted small">Arguments: {p.arguments.join(", ")}</p>}
                  </Card>
                );
              })}
            </div>
          ) : (
            <EmptyState variant="compact" title="No workflow commands on this server" />
          )}
        </div>
      </Disclosure>
      <Disclosure summary="How changes are published" storageKey="tl-connect-publish">
        <ul className="tl-list">
          <li>
            Everything Claude writes is a proposal. People who can review there (Reviewers, Moderators, Project admins) approve it on the Review page before others see it in
            search.
          </li>
          <li>Secrets and personal data are removed from text automatically. Screenshots aren't scanned, so don't upload ones that show secrets.</li>
          <li>When a shared contract or design changes, the projects that use it get a change notice the next time Claude loads their context.</li>
        </ul>
      </Disclosure>
      <Disclosure summary={`All ${plural(tools.length, "tool")}`} storageKey="tl-connect-tools">
        <DataTable
          caption="All tools"
          density="compact"
          rows={tools}
          getRowId={(t) => t.name}
          columns={[
            { key: "name", header: "Tool", primary: true, cell: (t) => <code className="tl-break">{t.name}</code> },
            {
              key: "kind",
              header: "Read or proposal",
              mobileLabel: "Kind",
              cell: (t) => (t.readOnly ? <Badge>Read</Badge> : <Badge tone="accent">Proposal</Badge>),
            },
            { key: "description", header: "Description", cell: (t) => <span className="small">{t.description}</span> },
          ]}
          empty={<EmptyState variant="compact" title="No tools listed" />}
        />
      </Disclosure>
    </div>
  );
}

/** Home-page banner until the person has connected a tool. */
export function GetStartedBanner() {
  const { data } = useApi<ConnectInfo>("/connect-info");
  if (!data || data.has_connected) return null;
  return (
    <Callout
      tone="info"
      icon="plug"
      title="Get started: connect Claude to Thaliyola"
      actions={
        <Button variant="primary" size="sm" href={href("/connect")}>
          Connect Claude
        </Button>
      }
    >
      Create a token and copy one command. Claude will search team knowledge before it investigates and load project context before it codes.
    </Callout>
  );
}
