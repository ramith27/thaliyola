# Integrations

Cairn pays off when the tools people already use read from it first and write back at the end. The server exposes the same MCP tools and prompts to every client.

**Prompts:** clients that support MCP prompts show them as commands.

| Prompt | Use |
|---|---|
| `investigate` | Search what the team knows before investigating; capture the confirmed root cause afterwards |
| `start-coding` | Load project/component context (contracts, decisions, shared designs, upstream changes) before changing code |
| `capture` | Turn a confirmed outcome into a reviewed finding or article |
| `review-stale` | Re-verify entries nobody has checked recently |

## Claude Code

### Per repository (recommended for project teams)

Commit a `.mcp.json` to each repo so every session knows which project and component it is in. The token comes from each person's environment:

```json
{
  "mcpServers": {
    "cairn": {
      "type": "http",
      "url": "https://cairn.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CAIRN_TOKEN}",
        "X-Cairn-Project": "order-service",
        "X-Cairn-Component": "frontend"
      }
    }
  }
}
```

Each person creates a token on their Cairn **Account** page and sets `CAIRN_TOKEN` in their shell profile.

Add this to the repo's `CLAUDE.md`:

```markdown
## Team knowledge (Cairn)
- Before investigating a bug or alert, search Cairn (`search_knowledge`) with the symptom as it first appeared.
- Before changing code, call `get_project_context` and handle open impact notices.
- After confirming a root cause or making a design decision, propose it to Cairn. Never include secrets.
```

### As a plugin (skill + server config)

[`claude-code/`](claude-code) is a Claude Code plugin with the `cairn` skill and an MCP config driven by environment variables:

```sh
export CAIRN_URL=https://cairn.example.com CAIRN_TOKEN=cairn_pat_…   # optional: CAIRN_PROJECT, CAIRN_COMPONENT
claude --plugin-dir /path/to/cairn/integrations/claude-code
```

To use the skill on its own, copy `claude-code/skills/cairn` into `.claude/skills/` in a repo, or into `~/.claude/skills/`.

## claude.ai

- **Local sign-in:** set `PUBLIC_URL`, then add a custom connector for `https://cairn.example.com/mcp`. Each person signs in with their Cairn account and approves the connection.
- **Cloudflare:** add Cairn to your MCP server portal and connect claude.ai to the portal.

## Scheduled agents

The server has no LLM. Work that needs judgment while nobody is at a keyboard runs as scheduled Claude jobs (for example Claude Code routines) that call the same tools. Give each job its own service token:

```sh
sudo cairn-admin create-token --service nightly-jobs --name "scheduled agents"
```

Example jobs:

| Job | Prompt sketch |
|---|---|
| Weekly freshness pass | "Run the Cairn `review-stale` prompt for scope team; verify what still holds, propose corrections, retire what's gone." |
| Slack → findings | "Read yesterday's resolved threads in #incidents (Slack MCP). For each confirmed root cause not already in Cairn (`search_knowledge`), `propose_finding` with the thread as a source link." |
| Sentry → known issues | "List unresolved Sentry issues older than 7 days (Sentry MCP). Link each to existing Cairn findings (`add_source_link`) or propose a known_issue." |
| Recurring root causes | "Call `list_suggestions`. For each promotion suggestion, draft the article section with `promote_finding`; for each likely duplicate pair, `link_entries` same_root_cause or propose a merge." |

Everything these jobs write lands in the review queue like any other proposal.
