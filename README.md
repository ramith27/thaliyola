# Cairn

A shared team knowledge base exposed as a remote [MCP](https://modelcontextprotocol.io) server. Every Claude client on a team reads and writes the same knowledge: systems, metrics, runbooks, project design docs, API contracts and UI/UX specs, plus the findings from past investigations.

The server holds no LLM. Clients (Claude Code, claude.ai, scheduled agents) do the reasoning; Cairn stores, searches, validates and versions. Agent-written content goes through human review before it is published.

## Concepts

**Scopes**

| Scope | Holds |
|---|---|
| `team` | Org-wide systems, metric definitions, runbooks, team decisions |
| one per project | Project overview, design docs, decisions, API contracts, screen specs, project findings |
| `library` | Reusable items shared across projects: UI component specs, design tokens, UX and tech patterns, shared contracts |

A project can declare that it **uses** an item from the library or from another project; that item then appears in the project's context and search results.

**Components.** A project can have several codebases (`backend`, `frontend`, `mobile`, ...). API contracts link the component that provides them to the components that consume them. When a contract or a shared design changes, consumers get an **impact notice** that shows up the next time an agent loads the project context.

**Articles and findings.** Articles are curated, long-lived documents written to a template per type. Findings are episodic: incidents, RCAs, known issues, data gotchas, query recipes.

## MCP tools

| Tool | Purpose |
|---|---|
| `search_knowledge` | Keyword search over article sections and findings. Defaults to the current project + team + library |
| `get_article` | One article, or one section of it, with relations, source links and entities |
| `get_finding` | One finding with relations, source links and review history |
| `browse_kb` | Folder tree of articles in a scope |
| `list_projects` | Projects with components and owners |
| `get_project_context` | Cold-start context for an agent in a project or component: overview, contracts, impact notices, recent decisions, shared items it uses, known issues |
| `list_impact_notices` / `ack_notice` | Upstream contract or shared-design changes a project or component hasn't handled yet |
| `list_review_queue` | Pending and decided proposals (`mine: true` for your own) |
| `get_article_template` | Expected sections for an article type |

**Write tools.** Every write is a proposal that a person reviews before it is published:

| Tool | Purpose |
|---|---|
| `propose_finding` | Capture a confirmed root cause, incident, known issue, data gotcha or query recipe. Returns near-duplicates instead of storing when it finds them |
| `update_finding` | Propose changes to a finding |
| `create_article` | Propose a new article of any type |
| `propose_article_edit` | Propose new text for one section of an article. On approval, components consuming a contract and projects using a shared item get an impact notice |
| `promote_finding` | Propose folding a recurring finding into an article section |
| `verify_entry` | Mark an entry still valid (applied immediately), or propose that it is superseded |
| `link_entries` | Add a typed link: `uses`, `provided_by`, `consumed_by`, `depends_on`, `related`, `same_root_cause`, `supersedes` |

On every write the server:
- redacts secrets and personal data (keys, tokens, passwords, connection-string credentials, JWTs, emails, phone numbers) with fixed rules, and refuses a write when a required field held nothing else;
- checks the version you read. Writes based on a stale version are refused with the current content.

### Review

Approval is deliberately not an MCP tool: agents propose, people approve. Reviewers use the REST API (a web UI is next on the roadmap):

```sh
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions                       # pending queue
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions/$ID                   # current vs proposed
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions/$ID/approve
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"reason":"not confirmed"}' localhost:8080/api/revisions/$ID/reject
```

### Permissions

- **Reading** is open to every authenticated user.
- **Proposing** is open to everyone until a scope lists writers or owners; after that, only they can propose in it.
- **Approving** is limited to scope owners and admins (`ADMIN_EMAILS`). Service identities never approve.

Admins manage projects and members through the API:

```sh
curl -X POST .../api/projects -d '{"slug":"order-service","name":"Order service"}'
curl -X POST .../api/projects/order-service/components -d '{"slug":"backend","kind":"backend"}'
curl -X PUT  .../api/scopes/order-service/members -d '{"email":"owner@example.com","role":"owner"}'
```

People granted a role before they ever sign in receive it on their first login.

### Choosing the project

Tools take an optional `project` (and `component`) argument. A client can set defaults with headers so agents in a repo don't have to pass them:

```
X-Cairn-Project: order-service
X-Cairn-Component: frontend
```

## Running locally

Requirements: Node 22, pnpm 9, and either Docker or Postgres 16 with [pgvector](https://github.com/pgvector/pgvector).

**With Docker**

```sh
cp .env.example .env          # set DEV_TOKENS and POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec server node dist/scripts/seed.js   # optional demo data
```

**Without Docker**

```sh
pnpm install
export DATABASE_URL=postgres://cairn:cairn@localhost:5432/cairn
export AUTH_MODE=dev DEV_TOKENS=dev-token=you@example.com
pnpm --filter @cairn/server seed   # migrates and loads demo data
pnpm dev
```

**Connect Claude Code**

```sh
claude mcp add --transport http cairn http://localhost:8080/mcp \
  --header "Authorization: Bearer dev-token" \
  --header "X-Cairn-Project: order-service"
```

### Tests

Tests run against a real Postgres database (`TEST_DATABASE_URL`, default `postgres://cairn:cairn@localhost:5432/cairn_test`). The schema is dropped and recreated on each run.

```sh
pnpm test
```

## Deployment with Cloudflare Zero Trust

Cairn is meant to sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) and be reached by clients through a [Cloudflare MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

1. Create a Cloudflare Tunnel and put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Route a hostname (e.g. `cairn.example.com`) to `http://server:8080`.
2. Create a self-hosted Access application for that hostname, with a policy for your team. Copy its AUD tag.
3. Set `AUTH_MODE=cloudflare`, `CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` and `CF_ACCESS_AUD=<aud tag>`.
4. Start everything with `docker compose --profile tunnel up -d`. The server port is bound to localhost only.
5. Add `https://cairn.example.com/mcp` to your MCP server portal. Users connect Claude to the portal URL.

The server verifies the `Cf-Access-Jwt-Assertion` header on every request against your team's signing keys, so requests that bypass Access are rejected. Users are identified by their Access email; Access service tokens map to service identities for scheduled jobs.

## Project layout

```
apps/server/
  migrations/      SQL migrations (full data model)
  src/core/        domain services: scopes, search, items, project context,
                   writes (proposals), review, redaction, permissions, notices
  src/auth/        Cloudflare Access JWT and dev-token authentication
  src/mcp/         MCP tool definitions
  src/http/        Express app, stateless streamable HTTP transport, REST API
  test/            integration tests (real Postgres) and unit tests
```

## Roadmap

- ~~**M1** Write tools, review queue, optimistic concurrency, redaction, impact notices on approval~~ (done)
- **M2** Web UI: browse by scope, markdown editor, review queue with diffs
- **M3** Library sharing (`share_to_library`), design items with asset storage (screenshots, token files), Figma links
- **M3b** Semantic search (pgvector + local embedding model), duplicate detection
- **M4** Per-scope roles, nightly freshness jobs, production hardening
- **M5** Integrations with existing agent skills, Slack and Sentry
