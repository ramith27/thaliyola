import { useState } from "react";
import { CopyBlock } from "../pages/connect";
import { Tabs } from "./kit";

/** Setup for MCP hosts other than Claude Code, and CI jobs that keep repository docs current. */

export interface Setup {
  url: string; // MCP endpoint
  token: string;
  project?: string;
  component?: string;
}

export interface HostGuide {
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

/** Where each tool reads its standing instructions (the AGENTS_MD snippet goes there). */
export const INSTRUCTIONS_FILE: Record<string, string> = {
  "claude-code": "the repository's CLAUDE.md",
  "claude-ai": "a claude.ai project's instructions",
  codex: "the repository's AGENTS.md",
  cursor: "the repository's AGENTS.md",
  vscode: "AGENTS.md or .github/copilot-instructions.md",
  "copilot-cli": "the repository's AGENTS.md",
  gemini: "the repository's GEMINI.md",
  windsurf: "the repository's AGENTS.md",
  opencode: "the repository's AGENTS.md",
  kiro: ".kiro/steering/thaliyola.md",
  other: "AGENTS.md (or the tool's instructions file)",
  all: "the repository's AGENTS.md (or each tool's instructions file)",
};

/** One host's config snippets, each with Copy, and its note. */
export function HostSetup({ guide }: { guide: HostGuide }) {
  return (
    <div className="tl-stack">
      {guide.steps.map((st) => (
        <CopyBlock key={st.label} label={st.label} text={st.text} />
      ))}
      {guide.note && <p className="muted small">{guide.note}</p>}
    </div>
  );
}

/** The connect.sh one-liner that sets up every agent found on the machine. */
export function ConnectScript({ origin, token }: { origin: string; token: string }) {
  return (
    <div className="tl-stack">
      <p className="muted small">
        Finds Claude Code, Codex, Gemini CLI, Copilot CLI, VS Code, Cursor, Windsurf, OpenCode and Kiro and asks before adding Thaliyola to each. Config files are backed
        up first. Read it before running:{" "}
        <a href={`${origin}/connect.sh`} target="_blank" rel="noopener noreferrer">
          connect.sh
        </a>
        .
      </p>
      <CopyBlock label="Run in a terminal" language="shell" text={`curl -fsSL ${origin}/connect.sh | THALIYOLA_TOKEN=${token} sh`} />
      <p className="muted small">The command includes your token, so it ends up in your shell history. Revoke the token in Account if that's a problem.</p>
    </div>
  );
}

/** Every agent other than Claude Code: the one-liner, a host picker (kit Tabs, arrow keys) and the instructions snippet. */
export function OtherAgents({ setup, origin }: { setup: Setup; origin: string }) {
  const guides = hostGuides(setup);
  const [host, setHost] = useState(guides[0]!.id);
  const g = guides.find((x) => x.id === host) ?? guides[0]!;
  return (
    <div className="tl-stack">
      <h3 className="tl-subhead">One command for every agent on your machine</h3>
      <ConnectScript origin={origin} token={setup.token} />
      <h3 className="tl-subhead">Or set up one by hand</h3>
      <Tabs label="Agent" idPrefix="tl-host" value={g.id} onChange={setHost} items={guides.map((x) => ({ id: x.id, label: x.name }))} />
      <div role="tabpanel" id={`tl-host-panel-${g.id}`} aria-labelledby={`tl-host-tab-${g.id}`} className="tl-tabpanel">
        <HostSetup guide={g} />
      </div>
      <CopyBlock label={`Add to ${INSTRUCTIONS_FILE[g.id] ?? INSTRUCTIONS_FILE.other}`} language="markdown" text={AGENTS_MD} />
    </div>
  );
}

// ---- CI: keep repository docs current ------------------------------------------------------------

const ALLOWED = "mcp__thaliyola,Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git rev-parse:*),Bash(git remote get-url:*),Bash(git ls-files:*)";

const LOCKFILE_GLOBS =
  "'*package-lock.json' '*npm-shrinkwrap.json' '*pnpm-lock.yaml' '*yarn.lock' '*requirements.txt' '*poetry.lock' '*uv.lock' '*Pipfile.lock' '*go.mod' '*Cargo.lock' '*Gemfile.lock' '*composer.lock' '*packages.lock.json' '*gradle.lockfile' '*requirements*.txt'";

/** Sends the repository's lockfiles to Thaliyola, which matches them against OSV and updates the security dashboard. */
export function dependencyUpload(mcpUrl: string) {
  const base = mcpUrl.replace(/\/mcp$/, "");
  return (
    `git ls-files -z -- ${LOCKFILE_GLOBS} | tar --null -T - -czf - | curl -fsS -X POST -H "Authorization: Bearer $THALIYOLA_TOKEN" -H 'Content-Type: application/gzip' ` +
    `--data-binary @- --url-query "repo=$(git remote get-url origin)" --url-query "sha=$(git rev-parse HEAD)" ${base}/api/dependencies`
  );
}

/** Compares the code's design tokens and hard-coded colours with the project's design system (never fails the build). */
export function designCheck(mcpUrl: string) {
  const base = mcpUrl.replace(/\/mcp$/, "");
  return `curl -fsS ${base}/design-drift.mjs -o /tmp/thaliyola-design-drift.mjs && THALIYOLA_URL=${base} node /tmp/thaliyola-design-drift.mjs || true`;
}

export function ciTemplates(mcpUrl: string) {
  const deps = dependencyUpload(mcpUrl);
  const design = designCheck(mcpUrl);
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
      - name: Check dependencies for vulnerabilities
        env:
          THALIYOLA_TOKEN: \${{ secrets.THALIYOLA_TOKEN }}
        run: |
          ${deps}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Check the code against the design system
        env:
          THALIYOLA_TOKEN: \${{ secrets.THALIYOLA_TOKEN }}
        run: ${design}
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
    - |
      ${deps}
    - ${design}
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
            - |
              ${deps}
            - ${design}
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
    <div className="tl-stack">
      <p className="muted small">
        After the first <code>/mcp__thaliyola__document-repo</code>, a CI job can keep the docs, the security dashboard and the design check current on every merge.
      </p>
      <ul className="tl-list small">
        <li>
          Its first step uploads the lockfiles for vulnerability matching. It needs no Anthropic key: keep just that step if you only want security checks.
        </li>
        <li>Then Claude Code runs headless, sends the changed files, and rewrites only the pages whose facts changed. When nothing relevant changed, it does nothing.</li>
      </ul>
      <Tabs label="CI system" idPrefix="tl-ci" value={t.id} onChange={setCi} items={templates.map((x) => ({ id: x.id, label: x.name }))} />
      <div role="tabpanel" id={`tl-ci-panel-${t.id}`} aria-labelledby={`tl-ci-tab-${t.id}`} className="tl-tabpanel tl-stack">
        <CopyBlock label={t.file} language="yaml" text={t.text} />
        <p className="muted small">
          Needs: {t.secrets} The full git history is fetched so the job can diff against the last documented commit.
        </p>
      </div>
      <h3 className="tl-subhead">For admins: the job's token</h3>
      <p className="muted small">
        Create a bot account with access to the project with the command below, on the server. Its pages go to review, where a Reviewer or Project admin approves them.
        Save the token it prints as THALIYOLA_TOKEN in the CI secrets.
      </p>
      <CopyBlock label="On the server" language="shell" text={'thaliyola-admin create-token --service docs-bot --name "CI docs" --owner-of <project>'} />
    </div>
  );
}
