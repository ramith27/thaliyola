# Integrations

Thaliyola pays off when the tools people already use read from it first and write back at the end. The server exposes the same MCP tools and prompts to every client.

**Prompts:** clients that support MCP prompts show them as commands.

| Prompt | Use |
|---|---|
| `investigate` | Search what the team knows before investigating; capture the confirmed root cause afterwards |
| `start-coding` | Load project/component context (contracts, decisions, shared designs, upstream changes) before changing code |
| `capture` | Turn a confirmed outcome into a reviewed finding or article |
| `review-stale` | Re-verify entries nobody has checked recently |
| `draft-from-paste` | Turn a pasted Slack thread, email or notes into a draft finding or article |
| `curate` | Work through the curation tasks the server hands out (misfiled entries, duplicates, stale facts) |
| `document-repo` | Write grounded documentation for the repository you're in (first run) |
| `update-docs` | Refresh only the pages and facts that changed since the last documented commit |

## Claude Code

### Per repository (recommended for project teams)

Commit a `.mcp.json` to each repo so every session knows which project and component it is in. The token comes from each person's environment:

```json
{
  "mcpServers": {
    "thaliyola": {
      "type": "http",
      "url": "https://thaliyola.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${THALIYOLA_TOKEN}",
        "X-Thaliyola-Project": "order-service",
        "X-Thaliyola-Component": "frontend"
      }
    }
  }
}
```

Each person creates a token on their Thaliyola **Account** page and sets `THALIYOLA_TOKEN` in their shell profile.

Add this to the repo's `CLAUDE.md`:

```markdown
## Team knowledge (Thaliyola)
- Before investigating a bug or alert, search Thaliyola (`search_knowledge`) with the symptom as it first appeared.
- Before changing code, call `get_project_context` and handle open impact notices.
- After confirming a root cause or making a design decision, propose it to Thaliyola. Never include secrets.
```

### As a plugin (skill + server config)

[`claude-code/`](claude-code) is a Claude Code plugin with the `thaliyola` skill and an MCP config driven by environment variables:

```sh
export THALIYOLA_URL=https://thaliyola.example.com THALIYOLA_TOKEN=thaliyola_pat_…   # optional: THALIYOLA_PROJECT, THALIYOLA_COMPONENT
claude --plugin-dir /path/to/thaliyola/integrations/claude-code
```

To use the skill on its own, copy `claude-code/skills/thaliyola` into `.claude/skills/` in a repo, or into `~/.claude/skills/`.

## Other coding agents

One command adds Thaliyola to every agent it finds on a machine (Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, VS Code, Cursor, Windsurf, OpenCode, Kiro). It asks before each one and backs up config files first:

```sh
curl -fsSL https://thaliyola.example.com/connect.sh | THALIYOLA_TOKEN=thaliyola_pat_… sh
# non-interactive, only some agents:  … | sh -s -- --yes --only codex,cursor      preview:  … | sh -s -- --dry-run
```

The script is [`apps/web/public/connect.sh`](../apps/web/public/connect.sh); the server fills in its own address. The Connect page shows the same setup by hand for each agent, with the chosen project's headers:

| Agent | Config | Server entry |
|---|---|---|
| Codex | `~/.codex/config.toml` | `[mcp_servers.thaliyola]` with `url` and `http_headers` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `mcpServers.thaliyola` with `url` and `headers` (`${env:THALIYOLA_TOKEN}` in committed files) |
| VS Code (Copilot agent mode) | `.vscode/mcp.json` | `servers.thaliyola` with `type: "http"`, token from a `promptString` input |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers.thaliyola` with `type: "http"`, `url`, `headers`, `tools: ["*"]` |
| Gemini CLI | `~/.gemini/settings.json` (or `gemini mcp add --transport http`) | `mcpServers.thaliyola` with `httpUrl` and `headers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.thaliyola` with `serverUrl` and `headers` |
| OpenCode | `opencode.json` | `mcp.thaliyola` with `type: "remote"`, `url`, `headers` (`{env:THALIYOLA_TOKEN}` in committed files) |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.thaliyola` with `url` and `headers` |

Most of these read `AGENTS.md` (Gemini CLI reads `GEMINI.md`, Kiro reads `.kiro/steering/`); put the same snippet as for `CLAUDE.md` there. `docs_finish` and `get_agents_md_block` return a managed block for it too.

## Keep repository docs current in CI

After the first `/mcp__thaliyola__document-repo`, a CI job keeps the docs in step with the code: Claude Code runs headless, sends the changed files, and rewrites only the pages whose facts changed (nothing at all when nothing relevant changed).

- [`ci/github-actions.yml`](ci/github-actions.yml), [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml), [`ci/bitbucket-pipelines.yml`](ci/bitbucket-pipelines.yml)
- Secrets: `ANTHROPIC_API_KEY` and `THALIYOLA_TOKEN`. Use a bot token that owns the project so pages publish directly (`sudo thaliyola-admin create-token --service docs-bot --name "CI docs" --owner-of <project>`); with a writer role they go to review.
- The full git history is fetched so the job can diff against the last documented commit. Tools are limited to Thaliyola, reading files and read-only git commands.
- Credentials that CI systems put in the remote URL are dropped before Thaliyola stores or shows it.

## claude.ai

- **Local sign-in:** set `PUBLIC_URL`, then add a custom connector for `https://thaliyola.example.com/mcp`. Each person signs in with their Thaliyola account and approves the connection.
- **Cloudflare:** add Thaliyola to your MCP server portal and connect claude.ai to the portal.

## Scheduled agents

The server has no LLM. Work that needs judgment while nobody is at a keyboard runs as scheduled Claude jobs (for example Claude Code routines) that call the same tools. Give each job its own service token:

```sh
sudo thaliyola-admin create-token --service nightly-jobs --name "scheduled agents"
```

Example jobs:

| Job | Prompt sketch |
|---|---|
| Weekly freshness pass | "Run the Thaliyola `review-stale` prompt for scope team; verify what still holds, propose corrections, retire what's gone." |
| Slack → findings | "Read yesterday's resolved threads in #incidents (Slack MCP). For each confirmed root cause not already in Thaliyola (`search_knowledge`), `propose_finding` with the thread as a source link." |
| Sentry → known issues | "List unresolved Sentry issues older than 7 days (Sentry MCP). Link each to existing Thaliyola findings (`add_source_link`) or propose a known_issue." |
| Trello cards for repeat problems | "Call `list_suggestions`. For each recurring root cause, create a Trello card (Trello MCP) in the Engineering board's 'Permanent fixes' list with the finding link, unless one exists; add the card URL to the finding with `add_source_link` (system trello)." |
| Recurring root causes | "Call `list_suggestions`. For each promotion suggestion, draft the article section with `promote_finding`; for each likely duplicate pair, `link_entries` same_root_cause or propose a merge." |

Everything these jobs write lands in the review queue like any other proposal.
