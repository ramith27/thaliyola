import { useState } from "react";
import { CopyBlock } from "./connect";
import { ErrorBox, Loading } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

/**
 * The guide: every feature, whether it's switched on here and how to turn it on, how to use it,
 * and every command for it (Claude Code slash commands, MCP prompts and tools, the admin CLI, pages).
 * The tool and prompt lists at the end come live from the server, so they're never out of date.
 */

type Status = Record<string, boolean | string>;

interface Guide {
  status: Status;
  admin: boolean;
  progress?: { features: Record<string, { done: boolean; tip?: string }>; done: number; total: number };
  catalog: {
    tools: { name: string; title?: string; description: string; readOnly: boolean }[];
    prompts: { name: string; title?: string; description: string; arguments: string[] }[];
  };
}

type Kind = "claude" | "prompt" | "tool" | "cli" | "page" | "setting";
interface Command {
  kind: Kind;
  cmd: string;
  what: string;
}
interface Feature {
  id: string;
  area: string;
  title: string;
  what: string;
  /** Status keys that must all be on for "On here". */
  needs?: string[];
  enable: string;
  use: string[];
  commands: Command[];
  docs?: string;
  page?: string;
}

const KIND_TEXT: Record<Kind, string> = { claude: "Claude Code", prompt: "Prompt", tool: "MCP tool", cli: "Server CLI", page: "Page", setting: "Setting" };

const FEATURES: Feature[] = [
  {
    id: "connect",
    area: "Getting started",
    title: "Connect Claude and other agents",
    what: "Gives Claude Code, claude.ai, Codex, Cursor, VS Code and other agents access to the team's knowledge over MCP.",
    enable: "Always on. claude.ai connectors also need PUBLIC_URL set to the public https address (OAuth).",
    use: [
      "Open Connect, create a personal token, and copy the command for your agent.",
      "Or run the one-line installer, which finds every agent on your machine and asks before adding Thaliyola to each.",
      "Install the Claude Code plugin to get the skill, session hooks and /thaliyola commands.",
    ],
    commands: [
      { kind: "page", cmd: "Connect", what: "Token, commands per agent, CI templates" },
      { kind: "setting", cmd: "curl -fsSL <server>/connect.sh | THALIYOLA_TOKEN=… sh", what: "Add Thaliyola to every agent on this machine" },
      { kind: "setting", cmd: "claude mcp add --transport http thaliyola <server>/mcp --header \"Authorization: Bearer …\"", what: "Claude Code by hand" },
      { kind: "setting", cmd: "claude --plugin-dir integrations/claude-code", what: "The plugin: skill, hooks and /thaliyola commands" },
    ],
    page: "/connect",
  },
  {
    id: "knowledge",
    area: "Knowledge",
    title: "Search before investigating, capture what you learn",
    what: "Articles (systems, runbooks, decisions, contracts, designs) and findings (incidents, root causes, known issues) that Claude searches first and writes back to.",
    needs: [],
    enable: "Always on. Search by meaning needs EMBEDDINGS=local (the default; downloads a 35 MB model once).",
    use: [
      "Describe the symptom to Claude as it first appeared: it searches Thaliyola before digging in.",
      "Before changing code, Claude loads the project's context: contracts, decisions, known issues, design, security.",
      "After a root cause is confirmed, ask Claude to capture it; it becomes a proposal someone reviews.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__investigate", what: "Search what's known, then capture the confirmed cause" },
      { kind: "prompt", cmd: "/mcp__thaliyola__start-coding", what: "Load project and repository context before coding" },
      { kind: "prompt", cmd: "/mcp__thaliyola__capture", what: "Turn an outcome into a finding or article" },
      { kind: "prompt", cmd: "/mcp__thaliyola__draft-from-paste", what: "Draft from a pasted Slack thread, email or notes" },
      { kind: "tool", cmd: "search_knowledge · get_project_context · propose_finding · create_article", what: "The core tools" },
      { kind: "page", cmd: "New article · Paste to draft · Import", what: "Write, paste or import documents" },
    ],
    page: "/",
  },
  {
    id: "review",
    area: "Knowledge",
    title: "Review and curation",
    what: "Everything an agent writes is a proposal until an owner approves it. Agents also tidy the knowledge base: misfiled entries, duplicates, stale facts.",
    enable: "Always on.",
    use: ["Owners approve or reject on Review (one click from the email too).", "Ask Claude to curate: it works through tasks Thaliyola hands out and reports each one."],
    commands: [
      { kind: "page", cmd: "Review", what: "Proposals, suggestions, new project requests" },
      { kind: "prompt", cmd: "/mcp__thaliyola__curate", what: "Work through curation tasks" },
      { kind: "prompt", cmd: "/mcp__thaliyola__review-stale", what: "Re-verify entries nobody checked recently" },
      { kind: "tool", cmd: "get_tasks · complete_task · move_entry · verify_entry", what: "Curation tools" },
    ],
    page: "/review",
  },
  {
    id: "docs",
    area: "Projects",
    title: "Repository documentation",
    what: "Claude writes and keeps a repository's documentation in its project, every fact linked to the lines of code it came from; updates redo only what the code changes affected.",
    enable: "Always on. Set instructions and files to ignore in project settings → Documentation.",
    use: [
      "Open the repository in Claude Code and run document-repo the first time.",
      "Run update-docs after changes, by hand or in CI on every merge (templates on Connect).",
      "Pages show Mermaid diagrams and a Sources panel with links to the exact lines.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__document-repo", what: "Write the docs (first run)" },
      { kind: "prompt", cmd: "/mcp__thaliyola__update-docs", what: "Refresh only what changed" },
      { kind: "setting", cmd: "claude -p \"/mcp__thaliyola__update-docs\"", what: "Headless, in CI" },
      { kind: "tool", cmd: "docs_begin → docs_submit_plan → docs_next_page → docs_submit_page → docs_finish", what: "The documentation run" },
    ],
    docs: "README.md#repository-documentation",
  },
  {
    id: "briefings",
    area: "Projects",
    title: "Pull request briefings",
    what: "A comment on each pull request with what's known about the changed files: docs citing them, contracts and consumers, known issues, vulnerabilities, design drift, other sessions working there.",
    enable: "Off by default. A Project admin turns it on (project → Pull requests) and adds the webhook to the git host; the git connection's token must be able to write pull-request comments.",
    use: [
      "Project → Pull requests: choose when to comment, then Set up the webhook on the GitHub or GitLab connection and paste the URL and secret into the repository's webhooks.",
      "Every opened or updated pull request gets one comment, edited in place on new pushes.",
      "Before opening a pull request, ask Claude for brief_changes on your diff, or run review-pr.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__review-pr [number]", what: "Review a pull request (or this branch) with what the team knows" },
      { kind: "tool", cmd: "brief_changes · get_pr_briefing", what: "The briefing for local changes, or a pull request's" },
      { kind: "page", cmd: "Project → Pull requests", what: "Settings, webhook, every briefing" },
    ],
    docs: "README.md#pull-request-briefings",
  },
  {
    id: "design",
    area: "Projects",
    title: "Design systems shared between projects",
    what: "A project's colours (with dark values), fonts, type scale, spacing, corners, shadows, components and design rules, as tokens every session uses. A project can be based on the Library's system and override only what differs.",
    enable: "Always on. Project contributors and up edit a project's design; Library and Team designs need their reviewers or an admin.",
    use: [
      "In Claude Code, open the app's repository and run capture-design: it records the real values from the code.",
      "To share: project → Design → Edit → Based on → Library. Entries merge by name, so the project's 'primary' replaces the Library's.",
      "Coding agents get the design in the project context and can export it as CSS variables, Tailwind or design tokens.",
      "Record design decisions on the Design page or with record_design_decision.",
      "Keep the code honest: the CI templates run a design check on every merge (or run check-design); the Design page shows what drifted and which hard-coded colours should be tokens.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__capture-design [based_on]", what: "Record the design from the code" },
      { kind: "tool", cmd: "get_design_system (format: css | tailwind | w3c | json)", what: "Read or export the effective design" },
      { kind: "tool", cmd: "update_design_system · record_design_decision", what: "Change tokens, base, rules; record decisions" },
      { kind: "prompt", cmd: "/mcp__thaliyola__check-design [yes]", what: "Check the code against the design; yes also replaces hard-coded colours" },
      { kind: "prompt", cmd: "/mcp__thaliyola__sync-figma-design <figma url> [from-figma|to-figma]", what: "Sync with Figma (needs the Figma connector)" },
      { kind: "setting", cmd: "curl -fsS <server>/design-drift.mjs -o /tmp/d.mjs && THALIYOLA_URL=<server> node /tmp/d.mjs", what: "Design check in CI (in the CI templates)" },
      { kind: "tool", cmd: "check_design_drift", what: "Compare code tokens and hard-coded colours with the system" },
      { kind: "page", cmd: "Project → Design", what: "Swatches, contrast checks, type, components, decisions, history" },
    ],
    docs: "docs/design-systems.md",
  },
  {
    id: "sessions",
    area: "Claude",
    title: "Sessions asking each other",
    what: "One Claude session asks another (yours or a teammate's, on any machine) and gets its answer back.",
    enable: "Always on. Install the Claude Code plugin for automatic joining, answering when a task finishes, and the /thaliyola commands.",
    use: [
      "Each session joins when it starts and is told its handle, e.g. ramith/leadtransit-api.",
      "Ask with /thaliyola:ask followed by a handle, an email or a project/repository, then the question.",
      "Make a session with useful context answer others with /thaliyola:listen (no token cost while waiting); /thaliyola:busy stops it.",
      "Files a session edits are claimed for it; another session about to edit them asks its person first. Hand unfinished work on with /thaliyola:handoff.",
      "Answer or ask from the browser on Sessions.",
    ],
    commands: [
      { kind: "claude", cmd: "/thaliyola:ask <who> <question>", what: "Ask another session; waits up to 45 s" },
      { kind: "claude", cmd: "/thaliyola:listen", what: "Answer questions whenever this session would go idle" },
      { kind: "claude", cmd: "/thaliyola:busy", what: "Stop listening" },
      { kind: "claude", cmd: "/thaliyola:ask expert <topic> <question>", what: "Ask the people who know a topic best (who-knows-what)" },
      { kind: "tool", cmd: "find_experts", what: "Who knows about a topic, project or repository" },
      { kind: "claude", cmd: "/thaliyola:handoff <who> [notes]", what: "Pass unfinished work on; your file claims move to whoever accepts" },
      { kind: "claude", cmd: "/thaliyola:ask everyone <project> <question>", what: "Ask every online session in a project" },
      { kind: "tool", cmd: "claim_work · release_work · list_claims · handoff_session", what: "Coordinating work between sessions" },
      { kind: "prompt", cmd: "/mcp__thaliyola__listen", what: "Listener for agents without the plugin" },
      { kind: "tool", cmd: "register_session · list_sessions · ask_session · get_answer · wait_for_questions · answer_question · decline_question", what: "Session tools" },
      { kind: "page", cmd: "Sessions", what: "Who's online, questions, answer as a person" },
    ],
    docs: "docs/sessions.md",
    page: "/sessions",
  },
  {
    id: "incidents",
    area: "Claude",
    title: "Incidents",
    what: "Declare an incident when something is broken: the project is told, and a timeline fills itself with notes, Sentry alerts, merged pull requests and sessions' questions; resolving drafts a root-cause finding.",
    enable: "Always on. Sentry alerts open incidents when the project's Sentry source has 'Open incidents from alerts' on.",
    use: [
      "Incidents → Declare incident, or /thaliyola:incident in Claude Code.",
      "Add what you learn as notes; sessions in the project are told about it on their next prompt.",
      "Mark mitigated, then resolve; then run write-rca to complete the drafted root cause.",
    ],
    commands: [
      { kind: "claude", cmd: "/thaliyola:incident <what's broken> [sev1-4]", what: "Declare one, or add to the open one" },
      { kind: "prompt", cmd: "/mcp__thaliyola__write-rca <incident id>", what: "Work out and write the root cause" },
      { kind: "tool", cmd: "declare_incident · get_incident · list_incidents · add_incident_note · update_incident", what: "Incident tools" },
      { kind: "page", cmd: "Incidents", what: "Open incidents, timelines, declare" },
    ],
    docs: "README.md#incidents",
    page: "/incidents",
  },
  {
    id: "security",
    area: "Security",
    title: "Vulnerabilities in your dependencies and code",
    what: "Lockfiles are matched against OSV.dev and re-checked daily; agents report what they find in code; critical and actively exploited ones are announced.",
    needs: ["dependency_scan"],
    enable: "VULN_SCAN=on (the default). Needs outbound access to api.osv.dev and cisa.gov.",
    use: [
      "In Claude Code, run security-check (add 'full' to also review the code).",
      "Or add the lockfile step from the CI templates on Connect.",
      "Track and resolve on the Security page; the project page shows a summary.",
      "Let Claude fix them: fix-vulnerabilities opens one tested pull request per upgrade (weekly in CI with the security-fixes template).",
      "Export a CycloneDX SBOM and check licences from Security with a project chosen.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__security-check [full] [yes]", what: "Scan dependencies, optionally review the code and fix" },
      { kind: "prompt", cmd: "/mcp__thaliyola__fix-vulnerabilities [critical|high] [pr|local] [yes]", what: "Upgrade vulnerable packages, one tested pull request each" },
      { kind: "setting", cmd: "integrations/ci/github-security-fixes.yml", what: "Weekly unattended fix PRs (GitHub Actions)" },
      { kind: "tool", cmd: "get_sbom · check_licenses", what: "CycloneDX SBOM; licence check (deps.dev)" },
      { kind: "page", cmd: "Security → a project → Dependencies", what: "Download SBOM, check licences" },
      { kind: "tool", cmd: "scan_dependencies · list_vulnerabilities · report_vulnerability · update_vulnerability · record_security_review", what: "Security tools" },
      { kind: "page", cmd: "Security", what: "Dashboard and every vulnerability" },
    ],
    page: "/security",
  },
  {
    id: "advisories",
    area: "Security",
    title: "Latest critical vulnerabilities worldwide",
    what: "New critical CVEs from NVD, GitHub and CISA every 6 hours, matched to projects by the technologies and packages they use.",
    needs: ["advisory_feed"],
    enable: "ADVISORY_FEED=on (the default). NVD_API_KEY and GITHUB_TOKEN raise rate limits; GITHUB_TOKEN / GITLAB_TOKEN also let Thaliyola read private repositories' languages.",
    use: [
      "Security → Major shows critical issues in core technologies and anything actively exploited.",
      "List what each project runs on in settings → General → Technologies, or let stack detection read it from GitHub/GitLab.",
      "Record each project's response: investigating, affected, not affected, patched.",
      "Admins publish named alerts (e.g. PHP2Shell) for breaking news.",
    ],
    commands: [
      { kind: "tool", cmd: "latest_advisories · set_advisory_response · publish_advisory", what: "Advisory tools" },
      { kind: "page", cmd: "Security → Latest critical vulnerabilities", what: "The feed" },
    ],
    page: "/security",
  },
  {
    id: "inbox",
    area: "Inbox",
    title: "Team sources and the inbox",
    what: "RSS feeds, watched web pages, Hacker News searches, Slack threads, Notion pages and web searches fetched on a schedule into an inbox that agents triage.",
    needs: ["sources"],
    enable: "SOURCES=on (the default). Slack, Notion and web search need SLACK_BOT_TOKEN, NOTION_TOKEN and TAVILY_API_KEY in the server's environment.",
    use: [
      "Add sources on Inbox → Sources (project owners for their projects, admins for Team).",
      "Capture automatically: add a GitHub merged pull requests or Sentry resolved issues source and paste its webhook URL into GitHub or Sentry.",
      "Run triage-inbox, or file and dismiss items on the Inbox page; save useful session answers from the Sessions page.",
    ],
    commands: [
      { kind: "prompt", cmd: "/mcp__thaliyola__triage-inbox [scope]", what: "File what matters, dismiss the rest" },
      { kind: "tool", cmd: "list_inbox · get_inbox_item · resolve_inbox_item · add_source", what: "Inbox tools" },
      { kind: "page", cmd: "Inbox · Sources", what: "Items and sources" },
    ],
    page: "/inbox",
  },
  {
    id: "projects",
    area: "Projects",
    title: "Projects, repositories, teams and access",
    what: "Each project has its own members, roles, repositories and settings; teams get roles on many projects at once.",
    enable: "Always on.",
    use: [
      "Create a project with + New project (or ask Claude: create_project).",
      "Add repositories (git remote URLs) in settings → Repositories, so sessions find their project.",
      "Manage members and teams in settings → Members and access.",
    ],
    commands: [
      { kind: "tool", cmd: "create_project · list_projects · get_project_context", what: "Project tools" },
      { kind: "page", cmd: "+ New project · Project → Settings · Teams", what: "Create and manage" },
    ],
  },
  {
    id: "export",
    area: "Projects",
    title: "Export and static site",
    what: "Everything as Markdown (Open Knowledge Format), or a project as a static website.",
    enable: "Always on.",
    use: ["Project settings → General → Export as Markdown, or Download as a static site."],
    commands: [
      { kind: "cli", cmd: "sudo thaliyola-admin export --out kb.zip [--scope team]", what: "Everything as Markdown, from the server" },
      { kind: "page", cmd: "Project → Settings → General → Data", what: "Export buttons" },
    ],
  },
  {
    id: "notify",
    area: "Platform",
    title: "Notifications",
    what: "In-app notifications always; email and a team Slack channel when set up; a weekly digest.",
    needs: ["email"],
    enable: "Email: MAIL_TRANSPORT=smtp with SMTP_URL and MAIL_FROM. Slack channel: SLACK_WEBHOOK_URL. Each person picks email kinds on Account.",
    use: ["Watch items to hear about changes.", "Choose which notifications email you on your Account page."],
    commands: [{ kind: "page", cmd: "Account → Notifications", what: "Your email preferences" }],
  },
  {
    id: "admin",
    area: "Platform",
    title: "Server administration",
    what: "Accounts, bot tokens and backups from the server's shell.",
    enable: "Installed by the native installer (thaliyola-admin, thaliyola-backup, thaliyola-restore).",
    use: ["Run these as root on the server.", "Backups run daily at 03:15 and keep the newest 14."],
    commands: [
      { kind: "cli", cmd: "sudo thaliyola-admin create-user --email a@b.com [--admin]", what: "Add an account; prints a temporary password" },
      { kind: "cli", cmd: "sudo thaliyola-admin reset-password --email a@b.com", what: "New temporary password" },
      { kind: "cli", cmd: "sudo thaliyola-admin list-users", what: "List accounts" },
      { kind: "cli", cmd: "sudo thaliyola-admin create-token --service docs-bot --name \"CI docs\" --in <project or space> [--role contributor]", what: "Bot token with its roles (CI docs, imports, dependency uploads)" },
      { kind: "cli", cmd: "sudo thaliyola-admin grant --service docs-bot --in <slug> [--role reviewer]", what: "Give a bot or person more roles" },
      { kind: "cli", cmd: "sudo thaliyola-backup", what: "Back up the database and uploads now" },
      { kind: "cli", cmd: "sudo thaliyola-restore <dump> [--yes]", what: "Restore (TARGET_DB=… to test a backup)" },
    ],
  },
];

const STATUS_LABELS: [string, string][] = [
  ["public_url", "Public address (PUBLIC_URL)"],
  ["oauth", "claude.ai sign-in (OAuth)"],
  ["semantic_search", "Search by meaning"],
  ["email", "Email notifications"],
  ["slack_channel", "Slack channel"],
  ["sources", "Team sources"],
  ["slack_source", "Slack source"],
  ["notion_source", "Notion source"],
  ["web_search_source", "Web search source"],
  ["dependency_scan", "Dependency scanning"],
  ["advisory_feed", "Worldwide advisory feed"],
  ["nvd_key", "NVD API key"],
  ["github_token", "GitHub token"],
  ["gitlab_token", "GitLab token"],
];

export function GuidePage() {
  const { data, error } = useApi<Guide>("/guide");
  const [q, setQ] = useState("");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const s = data.status;
  const needle = q.trim().toLowerCase();
  const match = (f: Feature) =>
    !needle || [f.title, f.what, f.area, f.enable, ...f.use, ...f.commands.flatMap((c) => [c.cmd, c.what])].join(" ").toLowerCase().includes(needle);
  const features = FEATURES.filter(match);
  const tools = data.catalog.tools.filter((t) => !needle || `${t.name} ${t.description}`.toLowerCase().includes(needle));
  const prompts = data.catalog.prompts.filter((p) => !needle || `${p.name} ${p.description}`.toLowerCase().includes(needle));

  return (
    <div className="page guide-page">
      <h1>Guide</h1>
      <p className="lead">
        Every feature, whether it's switched on here and how to turn it on, how to use it, and every command for it. Commands starting with <code>/</code> are typed in
        Claude Code; tools are called by Claude for you when you ask in plain words.
      </p>

      {data.progress && (
        <section className="card guide-progress" aria-label="Your progress">
          <div className="guide-progress-head">
            <strong>
              You've used {data.progress.done} of {data.progress.total} features
            </strong>
            <progress max={data.progress.total} value={data.progress.done} aria-label="Features used" />
          </div>
          {(() => {
            const next = FEATURES.find((f) => data.progress!.features[f.id] && !data.progress!.features[f.id]!.done) ?? FEATURES.find((f) => data.progress!.features[f.id]?.tip);
            const p = next && data.progress!.features[next.id];
            return p?.tip ? (
              <p className="small">
                <strong>Next:</strong> {p.tip}{" "}
                <a href={`#guide-${next!.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`guide-${next!.id}`)?.scrollIntoView({ behavior: "smooth" }))}>
                  {next!.title}
                </a>
              </p>
            ) : (
              <p className="small muted">You've tried everything here. Search below for any command.</p>
            );
          })()}
        </section>
      )}

      <input className="guide-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search features and commands, e.g. listen, design, CVE" aria-label="Search the guide" />

      <nav className="guide-toc" aria-label="Features">
        {features.map((f) => (
          <a key={f.id} href={`#guide-${f.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`guide-${f.id}`)?.scrollIntoView({ behavior: "smooth" }))}>
            {f.title}
          </a>
        ))}
      </nav>

      <section className="card guide-status">
        <h2>Switched on here</h2>
        <ul className="plain status-grid">
          {STATUS_LABELS.map(([k, label]) => (
            <li key={k}>
              <span className={`presence ${s[k] ? "listening" : "offline"}`} aria-hidden="true" /> {label}: <strong>{s[k] ? "on" : "off"}</strong>
            </li>
          ))}
          <li>
            <span className="presence listening" aria-hidden="true" /> Sign-in: <strong>{String(s.auth_mode)}</strong>
          </li>
          <li>
            <span className="presence listening" aria-hidden="true" /> Files stored: <strong>{s.file_store === "s3" ? "S3" : "on disk"}</strong>
          </li>
        </ul>
        <p className="muted small">Settings live in the server's environment file; an admin changes them and restarts the service.</p>
      </section>

      {features.map((f) => {
        const on = !f.needs?.length || f.needs.every((k) => s[k]);
        const mine = data.progress?.features[f.id];
        return (
          <section key={f.id} id={`guide-${f.id}`} className="card guide-feature">
            <div className="guide-head">
              <div>
                <div className="small muted">{f.area}</div>
                <h2>{f.title}</h2>
              </div>
              <span className="guide-badges">
                {mine?.done && <span className="badge badge-accent">You've used this</span>}
                <span className={`badge ${on ? "badge-published" : "badge-pending"}`}>{on ? "On here" : "Off here"}</span>
              </span>
            </div>
            {mine?.tip && <p className="guide-tip small">{mine.tip}</p>}
            <p>{f.what}</p>
            <p className="small">
              <strong>Turn on:</strong> {f.enable}
            </p>
            <h3>How to use it</h3>
            <ol className="list">
              {f.use.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ol>
            <h3>Commands</h3>
            <div className="table-wrap">
              <table className="table guide-commands">
                <tbody>
                  {f.commands.map((c) => (
                    <tr key={c.cmd}>
                      <td className="guide-kind">
                        <span className="badge badge-type">{KIND_TEXT[c.kind]}</span>
                      </td>
                      <td>
                        <code>{c.cmd}</code>
                      </td>
                      <td className="small">{c.what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small guide-links">
              {f.page && <a href={href(f.page)}>Open it</a>}
              {f.docs && (
                <a href={`https://github.com/ramith27/thaliyola/blob/main/${f.docs}`} target="_blank" rel="noopener noreferrer">
                  Full guide
                </a>
              )}
            </p>
          </section>
        );
      })}

      <section className="card">
        <h2>Every prompt ({prompts.length})</h2>
        <p className="muted small">
          In Claude Code these are slash commands: <code>/mcp__thaliyola__&lt;name&gt;</code>. Other agents show them in their prompt menu.
        </p>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {prompts.map((p) => (
                <tr key={p.name}>
                  <td>
                    <code>/mcp__thaliyola__{p.name}</code>
                    {p.arguments.length > 0 && <div className="small muted">{p.arguments.join(", ")}</div>}
                  </td>
                  <td className="small">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Every MCP tool ({tools.length})</h2>
        <p className="muted small">Claude calls these when you ask in plain words; you don't type them.</p>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                    <div className="small muted">{t.readOnly ? "reads" : "writes (proposal or change)"}</div>
                  </td>
                  <td className="small">{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Start here</h2>
        <CopyBlock label="Onboard a repository (paste into Claude Code at its root)" text="Onboard this repository into Thaliyola: find or create its project, document it (document-repo), run a security check, capture its design (capture-design), and tell me what you did." />
      </section>
    </div>
  );
}
