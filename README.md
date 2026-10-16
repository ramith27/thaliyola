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

**Design knowledge.**
- **Item types:** design tokens, UI component specs, UX patterns and screen specs.
- **Attachments:** screenshots and token files, which can also be embedded in markdown with `![alt](asset:<id>)`.
- **Figma:** frames are linked as source links. Figma stays the visual source of truth; Cairn holds the reviewed intent and rules.
- **Wiring:** a screen spec `uses` library UI components and `depends_on` the API contract it calls. A change to either reaches the teams that depend on it as an impact notice.

**Articles and findings.** Articles are curated, long-lived documents written to a template per type. Findings are episodic: incidents, RCAs, known issues, data gotchas, query recipes.

## MCP tools

| Tool | Purpose |
|---|---|
| `search_knowledge` | Hybrid keyword and semantic search over article sections and findings. Defaults to the current project + team + library |
| `get_article` | One article, or one section of it, with relations, source links and entities |
| `get_finding` | One finding with relations, source links and review history |
| `browse_kb` | Folder tree of articles in a scope |
| `list_projects` | Projects with components and owners |
| `get_project_context` | Cold-start context for an agent in a project or component: overview, contracts, impact notices, recent decisions, shared items it uses, known issues |
| `list_impact_notices` / `ack_notice` | Upstream contract or shared-design changes a project or component hasn't handled yet |
| `list_review_queue` | Pending and decided proposals (`mine: true` for your own) |
| `get_article_template` | Expected sections for an article type |
| `get_asset` | A screenshot, exported frame, token file or spec attached to an item. Images come back as MCP image content the agent can look at |

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
| `add_source_link` | Attach a Figma frame, PR, Sentry issue or dashboard to an item |
| `upload_asset` | Attach a screenshot (PNG/JPEG/WebP/GIF), token JSON, markdown or PDF. Text files are redacted; images can't be |
| `share_to_library` | Propose publishing a project item to the library. On approval by a library owner, a copy (with its links and files) is created and the project is linked to it |

### Search

Search is hybrid. Postgres full-text search and embedding similarity are merged with reciprocal rank fusion, then boosted for published, recently verified and current-project items. Embeddings come from a small model (`bge-small-en-v1.5`, int8) that runs in-process on CPU. It is not an LLM, needs no API key, and is downloaded once (~35 MB). New text is embedded in the background, so writes stay fast.

- "card processor is throttling us" finds the payment-provider rate-limit RCA, even though they share no keywords.
- Duplicate detection uses the same embeddings: a reworded copy of an existing finding is flagged. Thresholds were calibrated on real text and can be tuned (`DUPLICATE_SIMILARITY`, `SEARCH_MIN_SIMILARITY`).
- `EMBEDDINGS=off` falls back to keyword search only, e.g. for machines without internet access.

On every write the server:
- redacts secrets and personal data (keys, tokens, passwords, connection-string credentials, JWTs, emails, phone numbers) with fixed rules, and refuses a write when a required field held nothing else;
- checks the version you read. Writes based on a stale version are refused with the current content.

### Web UI

The server also serves a web UI at `/` for people:

- **Browse:** team, library and project scopes, each with a folder tree.
- **Project view:** pick a component (backend, frontend, ...) to see the contracts it provides and consumes, upstream changes it still has to handle, the shared library items it uses, recent decisions and known issues.
- **Search:** results are highlighted, and a hit jumps to the matching section.
- **Files and links:** attach screenshots and files, add Figma/PR/Sentry links, and share project items to the library.
- **Read and edit:** articles (markdown with preview) and findings. Edits by scope owners and admins publish immediately; everyone else's edits become proposals.
- **Review queue:** line diffs of current vs proposed text, with approve and reject.

Behind Cloudflare Access, the browser is already signed in. In dev mode the UI asks for a dev token.

For UI development, run the server on :8080 and `pnpm --filter @cairn/web dev`. Vite serves on :5173 and proxies `/api`.

### Review

Approval is deliberately not an MCP tool: agents propose, people approve. Reviewers use the web UI (`/#/review`) or the REST API:

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
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec server node dist/scripts/admin.js create-user --email you@example.com --admin
docker compose exec server node dist/scripts/seed.js   # optional demo data
```

**Native install (systemd, no Docker)**

On Debian or Ubuntu, `deploy/native/install.sh` sets up everything:
- installs Node 22 and Postgres 16 with pgvector;
- creates a `cairn` service user and database;
- builds the server and UI, deploys them to `/opt/cairn`, and runs them as the `cairn` systemd service on `127.0.0.1:8080`.

```sh
sudo ADMIN_EMAIL=you@example.com deploy/native/install.sh
```

- New installs use local sign-in. With `ADMIN_EMAIL` set, the first admin account is created and its temporary password printed at the end.
- Config lives in `/etc/cairn/cairn.env`.
- Re-run the script to upgrade. It keeps the config and the database.
- Logs: `journalctl -u cairn -f`.

**Without Docker, for development**

```sh
pnpm install
pnpm --filter @cairn/web build     # optional: the UI the server serves at /
export DATABASE_URL=postgres://cairn:cairn@localhost:5432/cairn
export AUTH_MODE=dev DEV_TOKENS=dev-token=you@example.com
pnpm --filter @cairn/server seed   # migrates and loads demo data
pnpm dev
```

**Connect Claude Code**

Create an API token on your Account page, then:

```sh
claude mcp add --transport http cairn http://localhost:8080/mcp \
  --header "Authorization: Bearer cairn_pat_…" \
  --header "X-Cairn-Project: order-service"
```

### Smoke test

After a deploy with the demo data loaded, run end-to-end checks against the live server. It plays a backend agent changing a contract, a reviewer approving it, and a frontend agent picking up the change:

```sh
CAIRN_URL=http://localhost:8080 AGENT_TOKEN=<user token> ADMIN_TOKEN=<admin token> pnpm --filter @cairn/server smoke
```

### Tests

`CAIRN_REAL_EMBEDDINGS=1 pnpm test` also runs the semantic tests against the real model.

Tests run against a real Postgres database (`TEST_DATABASE_URL`, default `postgres://cairn:cairn@localhost:5432/cairn_test`). The schema is dropped and recreated on each run.

```sh
pnpm test
```

## Sign-in

Choose with `AUTH_MODE`:

| Mode | For | How people and agents sign in |
|---|---|---|
| `local` (default) | Self-hosting without an identity provider | Built-in accounts with passwords (scrypt) and browser sessions. Admins manage users on the **Users** page or with `cairn-admin` |
| `cloudflare` | Teams on Cloudflare Zero Trust | Cloudflare Access (and the MCP server portal) in front; the server verifies the Access JWT |
| `dev` | Local development only | Static bearer tokens from `DEV_TOKENS` |

In every mode, people can create **personal API tokens** on their Account page for Claude Code and other MCP clients. The page shows a ready-to-paste `claude mcp add` command. Tokens are stored hashed, can expire, and can be revoked.

Local mode details:
- New accounts get a temporary password that must be changed at first sign-in.
- Failed sign-ins are throttled.
- Browser writes made with the session cookie must come from the same origin (CSRF protection on top of `SameSite=Lax`).
- Disabling a user ends their sessions and revokes their tokens.
- Session length: `SESSION_TTL_HOURS`. The cookie is `Secure` whenever the request came in over https (`COOKIE_SECURE`).

```sh
sudo cairn-admin create-user --email you@example.com --admin      # first admin (prints a temporary password)
sudo cairn-admin reset-password --email someone@example.com
sudo cairn-admin create-token --service nightly-rca --name "RCA job"  # token for a bot account
```

(`cairn-admin` is installed by the native installer. Elsewhere, run `node dist/scripts/admin.js …` with `DATABASE_URL` set.)

## Deployment with Cloudflare Zero Trust

Cairn is meant to sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) and be reached by clients through a [Cloudflare MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

1. Create a Cloudflare Tunnel and put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Route a hostname (e.g. `cairn.example.com`) to `http://server:8080`.
2. Create a self-hosted Access application for that hostname, with a policy for your team. Copy its AUD tag.
3. Set `AUTH_MODE=cloudflare`, `CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` and `CF_ACCESS_AUD=<aud tag>`.
4. Start everything with `docker compose --profile tunnel up -d`. The server port is bound to localhost only. For a native install, [install `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) as a service instead and point the tunnel at `http://localhost:8080`. Then set the Access variables in `/etc/cairn/cairn.env` and run `systemctl restart cairn`.
5. Add `https://cairn.example.com/mcp` to your MCP server portal. Users connect Claude to the portal URL.

The server verifies the `Cf-Access-Jwt-Assertion` header on every request against your team's signing keys, so requests that bypass Access are rejected. Users are identified by their Access email; Access service tokens map to service identities for scheduled jobs.

## Project layout

```
apps/web/          React UI (Vite), served by the server at /
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
- ~~**M2** Web UI: browse by scope, markdown editor, review queue with diffs~~ (done)
- ~~**M3** Library sharing, design assets (screenshots, token files), Figma links~~ (done)
- ~~**M3b** Semantic search (pgvector + local embedding model), duplicate detection~~ (done)
- ~~Local sign-in with built-in accounts and personal API tokens~~ (done)
- **M4** Nightly freshness jobs, OAuth for claude.ai connectors in local mode, production hardening
- **M5** Integrations with existing agent skills, Slack and Sentry
