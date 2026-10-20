import { useState } from "react";
import { CopyBlock } from "../pages/connect";

/** Setup for MCP hosts other than Claude Code, and CI jobs that keep repository docs current. */

interface Setup {
  url: string; // MCP endpoint
  token: string;
  project?: string;
  component?: string;
}

interface HostGuide {
  id: string;
  name: string;
  steps: { label: string; text: string }[];
  note?: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

function extraHeaders(s: Setup): Record<string, string> {
  return {
    ...(s.project ? { "X-Thaliyola-Project": s.project } : {}),
    ...(s.project && s.component ? { "X-Thaliyola-Component": s.component } : {}),
  };
}

export const AGENTS_MD = `## Team knowledge (Thaliyola)
- Before investigating a bug or alert, search Thaliyola (search_knowledge) with the symptom as it first appeared.
- Before changing code, call get_project_context and handle open impact notices.
- After confirming a root cause or making a design decision, propose it to Thaliyola. Never include secrets.
- To write or refresh this repository's docs, follow Thaliyola's docs_begin flow (every fact needs file and line evidence).`;

export function hostGuides(s: Setup): HostGuide[] {
  const auth = { Authorization: `Bearer ${s.token}`, ...extraHeaders(s) };
  const tomlHeaders = Object.entries(auth)
    .map(([k, v]) => `"${k}" = "${v}"`)
    .join(", ");
  return [
    {
      id: "codex",
      name: "Codex",
      steps: [{ label: "~/.codex/config.toml", text: `[mcp_servers.thaliyola]\nurl = "${s.url}"\nhttp_headers = { ${tomlHeaders} }` }],
      note: "Codex reads AGENTS.md in the repository; add the snippet below so it uses Thaliyola without being asked.",
    },
    {
      id: "cursor",
      name: "Cursor",
      steps: [{ label: "~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one repository)", text: json({ mcpServers: { thaliyola: { url: s.url, headers: auth } } }) }],
      note: "For a committed .cursor/mcp.json, write the token as ${env:THALIYOLA_TOKEN} and set it in each person's environment.",
    },
    {
      id: "vscode",
      name: "VS Code (Copilot)",
      steps: [
        {
          label: ".vscode/mcp.json (commit it; VS Code asks each person for their token once)",
          text: json({
            inputs: [{ type: "promptString", id: "thaliyola-token", description: "Thaliyola token", password: true }],
            servers: { thaliyola: { type: "http", url: s.url, headers: { ...auth, Authorization: "Bearer ${input:thaliyola-token}" } } },
          }),
        },
      ],
      note: "Use it from Copilot Chat in Agent mode. Copilot also reads AGENTS.md and .github/copilot-instructions.md.",
    },
    {
      id: "copilot-cli",
      name: "Copilot CLI",
      steps: [{ label: "~/.copilot/mcp-config.json", text: json({ mcpServers: { thaliyola: { type: "http", url: s.url, headers: auth, tools: ["*"] } } }) }],
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      steps: [
        { label: "Run", text: `gemini mcp add --transport http thaliyola ${s.url} \\\n  ${Object.entries(auth).map(([k, v]) => `--header "${k}: ${v}"`).join(" \\\n  ")}` },
        { label: "or in ~/.gemini/settings.json", text: json({ mcpServers: { thaliyola: { httpUrl: s.url, headers: auth } } }) },
      ],
      note: "Gemini CLI reads GEMINI.md; add the snippet below there. MCP prompts appear as slash commands (/document-repo, /update-docs).",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      steps: [{ label: "~/.codeium/windsurf/mcp_config.json", text: json({ mcpServers: { thaliyola: { serverUrl: s.url, headers: auth } } }) }],
    },
    {
      id: "opencode",
      name: "OpenCode",
      steps: [
        {
          label: "opencode.json (repository) or ~/.config/opencode/opencode.json",
          text: json({ $schema: "https://opencode.ai/config.json", mcp: { thaliyola: { type: "remote", url: s.url, headers: auth, enabled: true } } }),
        },
      ],
      note: "In a committed opencode.json, write the token as {env:THALIYOLA_TOKEN}.",
    },
    {
      id: "kiro",
      name: "Kiro",
      steps: [{ label: "~/.kiro/settings/mcp.json or .kiro/settings/mcp.json", text: json({ mcpServers: { thaliyola: { url: s.url, headers: auth } } }) }],
      note: "Put the snippet below in .kiro/steering/thaliyola.md so every session follows it.",
    },
    {
      id: "other",
      name: "Other",
      steps: [{ label: "Any client with remote MCP over HTTP (streamable HTTP) and custom headers", text: json({ mcpServers: { thaliyola: { type: "http", url: s.url, headers: auth } } }) }],
      note: "Clients that only support OAuth (claude.ai, ChatGPT connectors) use the server URL alone and sign in.",
    },
  ];
}

export function OtherAgents({ setup, origin }: { setup: Setup; origin: string }) {
  const guides = hostGuides(setup);
  const [host, setHost] = useState(guides[0]!.id);
  const g = guides.find((x) => x.id === host) ?? guides[0]!;
  return (
    <>
      <h3>One command for every agent on your machine</h3>
      <p className="muted small">
        Finds Claude Code, Codex, Gemini CLI, Copilot CLI, VS Code, Cursor, Windsurf, OpenCode and Kiro and asks before adding Thaliyola to each. Config files are backed
        up first. Read it before running: <a href={`${origin}/connect.sh`}>connect.sh</a>.
      </p>
      <CopyBlock text={`curl -fsSL ${origin}/connect.sh | THALIYOLA_TOKEN=${setup.token} sh`} />

      <h3>Or set up one by hand</h3>
      <div className="chips host-tabs" role="tablist" aria-label="Agent">
        {guides.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === host} className={`chip ${x.id === host ? "active" : ""}`} onClick={() => setHost(x.id)}>
            {x.name}
          </button>
        ))}
      </div>
      {g.steps.map((st) => (
        <CopyBlock key={st.label} label={st.label} text={st.text} />
      ))}
      {g.note && <p className="muted small">{g.note}</p>}
      <CopyBlock label="Add to the repository's AGENTS.md (or the host's instructions file)" text={AGENTS_MD} />
    </>
  );
}

// ---- CI: keep repository docs current ------------------------------------------------------------

const ALLOWED = "mcp__thaliyola,Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git rev-parse:*),Bash(git remote get-url:*),Bash(git ls-files:*)";

export function ciTemplates(mcpUrl: string) {
  const setup = `claude mcp add --transport http thaliyola ${mcpUrl} --header "Authorization: Bearer $THALIYOLA_TOKEN"`;
  const runDocs = `claude -p "/mcp__thaliyola__update-docs" --allowedTools "${ALLOWED}"`;
  return [
    {
      id: "github",
      name: "GitHub Actions",
      file: ".github/workflows/thaliyola-docs.yml",
      text: `name: Update docs (Thaliyola)
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: thaliyola-docs
  cancel-in-progress: false
jobs:
  docs:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g @anthropic-ai/claude-code
      - name: Update documentation
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          THALIYOLA_TOKEN: \${{ secrets.THALIYOLA_TOKEN }}
        run: |
          ${setup}
          ${runDocs}
`,
      secrets: "Repository secrets ANTHROPIC_API_KEY and THALIYOLA_TOKEN.",
    },
    {
      id: "gitlab",
      name: "GitLab CI",
      file: ".gitlab-ci.yml",
      text: `thaliyola-docs:
  image: node:22
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  variables:
    GIT_DEPTH: 0
  resource_group: thaliyola-docs
  script:
    - npm install -g @anthropic-ai/claude-code
    - '${setup}'
    - '${runDocs}'
`,
      secrets: "Masked CI/CD variables ANTHROPIC_API_KEY and THALIYOLA_TOKEN.",
    },
    {
      id: "bitbucket",
      name: "Bitbucket Pipelines",
      file: "bitbucket-pipelines.yml",
      text: `pipelines:
  branches:
    main:
      - step:
          name: Update docs (Thaliyola)
          image: node:22
          clone:
            depth: full
          script:
            - npm install -g @anthropic-ai/claude-code
            - '${setup}'
            - '${runDocs}'
`,
      secrets: "Secured repository variables ANTHROPIC_API_KEY and THALIYOLA_TOKEN.",
    },
  ];
}

export function CiDocs({ mcpUrl }: { mcpUrl: string }) {
  const templates = ciTemplates(mcpUrl);
  const [ci, setCi] = useState(templates[0]!.id);
  const t = templates.find((x) => x.id === ci) ?? templates[0]!;
  return (
    <>
      <p className="muted small">
        After the first <code>/mcp__thaliyola__document-repo</code>, a CI job can keep the docs current on every merge: Claude Code runs headless, sends the changed files,
        and rewrites only the pages whose facts changed (and does nothing when nothing relevant changed). Create a bot token that owns the project, so pages publish directly, with{" "}
        <code>thaliyola-admin create-token --service docs-bot --name "CI docs" --owner-of &lt;project&gt;</code> on the server; with a writer token they go to review.
      </p>
      <div className="chips host-tabs" role="tablist" aria-label="CI system">
        {templates.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === ci} className={`chip ${x.id === ci ? "active" : ""}`} onClick={() => setCi(x.id)}>
            {x.name}
          </button>
        ))}
      </div>
      <CopyBlock label={t.file} text={t.text} />
      <p className="muted small">Needs: {t.secrets} The full git history is fetched so the job can diff against the last documented commit.</p>
    </>
  );
}
