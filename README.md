# Thaliyola

*Thaliyola* (തളിയോല) is Malayalam for the palm-leaf manuscripts Kerala used to write knowledge down and keep it for the next generation.

A shared team knowledge base exposed as a remote [MCP](https://modelcontextprotocol.io) server. Every Claude client on a team reads and writes the same knowledge: systems, metrics, runbooks, project design docs, API contracts and UI/UX specs, plus the findings from past investigations.

The server holds no LLM. Clients (Claude Code, claude.ai, scheduled agents) do the reasoning; Thaliyola stores, searches, validates and versions. Agent-written content goes through human review before it is published.

| Dashboard | Knowledge graph | Project view for a frontend session |
|---|---|---|
| ![Dashboard](docs/images/dashboard.png) | ![Knowledge graph](docs/images/graph.png) | ![Project view](docs/images/project-frontend.png) |

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
- **Figma:** frames are linked as source links. Figma stays the visual source of truth; Thaliyola holds the reviewed intent and rules.
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
| `list_stale_entries` | Entries not verified recently and articles past their review date |
| `list_suggestions` | Recurring root causes to fold into an article (with a suggested target), and unlinked near-duplicate findings |
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

### File storage

Uploaded files are content-addressed and stored either on local disk (`ASSET_DIR`, the default) or in any S3-compatible service: AWS S3, Cloudflare R2, MinIO or Garage. Use S3 when several Thaliyola servers share files or the disk isn't durable:

```sh
ASSET_STORE=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # or https://s3.<region>.amazonaws.com, http://minio:9000, …
S3_REGION=auto                                         # R2: auto; AWS: the bucket's region
S3_BUCKET=thaliyola-assets
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
# S3_PREFIX=thaliyola/          optional key prefix
# S3_PATH_STYLE=false       virtual-hosted URLs (bucket.endpoint); default true suits most self-hosted servers
```

Requests are signed with AWS Signature V4 using Node's built-in crypto (no AWS SDK). Signing was tested against a server that verifies signatures strictly. Files are always served through Thaliyola, which checks permissions, so the bucket stays private.

### Performance

Search finds candidates through indexes first (GIN for full-text, HNSW for vectors), then applies scope, status and permission filters to just those candidates. Measured on a 2-vCPU container with synthetic data (`apps/server/test/perf.bench.ts`):

| Knowledge base | Project search (keyword / hybrid) | Search everything | Duplicate check |
|---|---|---|---|
| 30k chunks (~4k articles, 10k findings) | 46 / 60 ms | 114 ms | 145 ms |
| 90k chunks (~12k articles, 30k findings) | 110–150 ms | 220–430 ms | 105 ms |

Query embedding with the local model adds about 10–40 ms. Searches made only of very common words cost the most, because full-text ranking scales with the number of matching chunks.

### Freshness

Knowledge goes stale:
- **Flagging:** a maintenance job in the server marks published entries not verified for `STALE_AFTER_DAYS` (default 90; `STALE_AFTER_DAYS_ARTICLES` to differ for articles) as `possibly_stale`. They rank lower and carry a warning.
- **Needs attention:** stale entries and articles past their `review_due` date appear on the home page and through `list_stale_entries` until someone verifies or fixes them.
- **Housekeeping:** the same job cleans up expired sessions and OAuth artifacts. It runs every `MAINTENANCE_INTERVAL_HOURS`, on one instance at a time.

### Search

Search is hybrid. Postgres full-text relevance and embedding similarity are each normalized against the query's best hit and combined, then boosted for published and current-project items. Unlike rank-only fusion, this keeps how much better a hit is, so a boost can't lift a weak match over a much stronger one. Embeddings come from a small model (`bge-small-en-v1.5`, int8) that runs in-process on CPU. It is not an LLM, needs no API key, and is downloaded once (~35 MB). New text is embedded in the background, so writes stay fast.

- "card processor is throttling us" finds the payment-provider rate-limit RCA, even though they share no keywords.
- Duplicate detection uses the same embeddings: a reworded copy of an existing finding is flagged. Thresholds were calibrated on real text and can be tuned (`DUPLICATE_SIMILARITY`, `SEARCH_MIN_SIMILARITY`, `SEARCH_SIMILARITY_WINDOW`).
- Small embedding models put most text in a narrow similarity band. So a meaning-only hit must be above a floor *and* close to the best meaning match for the query, and it weighs less than hits that also share the query's words.
- `EMBEDDINGS=off` falls back to keyword search only, e.g. for machines without internet access.

On every write the server:
- redacts secrets and personal data (keys, tokens, passwords, connection-string credentials, JWTs, emails, phone numbers) with fixed rules, and refuses a write when a required field held nothing else;
- checks the version you read. Writes based on a stale version are refused with the current content.

### Web UI

The server also serves a web UI at `/` for people:

- **Dashboard:** knowledge added per week, agent vs. web activity, freshness, knowledge by type, top contributors, recently approved changes and items needing attention. Every chart has a table view and hover details.
- **Knowledge graph:** an interactive map of how projects, components, contracts, designs, library items and findings link. Hover to trace links, click to open, zoom and pan; unlinked items are hidden until asked for.
- **Relationships:** every article and finding page shows a local graph of its connections within two links. "Open in graph" focuses the full graph on it, and project pages link to their own graph.

- **Browse:** team, library and project scopes, each with a folder tree.
- **Project view:** pick a component (backend, frontend, ...) to see the contracts it provides and consumes, upstream changes it still has to handle, the shared library items it uses, recent decisions and known issues.
- **Search:** results are highlighted, and a hit jumps to the matching section. The search box shows the best matches as you type (the last word also matches as a prefix), and the results page opens with an **answer card**: the single best section or finding, quoted from the knowledge base (never generated), marked "Best answer" when both keywords and meaning match and "Closest match" otherwise. The home page has an "Ask Thaliyola" box for questions.
- **Command palette:** ⌘K / Ctrl+K searches knowledge and entities, asks, and jumps to pages, scopes, favourites and recent items, or switches theme. `/` focuses the search box.
- **Favourites and recent:** star any article, finding or project to pin it to the sidebar (stored per person on the server); the last items you opened are listed under Recent (stored in your browser).
- **Entity pages:** every system, table, metric or service tagged on an item has a page listing what mentions it and what it's often mentioned with (`/#/entity/metric/Conversion rate`; aliases resolve).
- **Links:** copy a link to any article section from the icon beside its heading, or share an item with the Share button (the native share sheet on phones).
- **Files and links:** attach screenshots and files, add Figma/PR/Sentry links, and share project items to the library.
- **Connect:** after signing in, people see their access and roles. They can create a token in place and copy ready-made setup for Claude Code (global or per repository, with the project and component chosen from lists), claude.ai and other MCP clients. The page also lists the workflow prompts and all tools. A home-page banner points new users there until they connect.
- **Read and edit:** articles and findings. Edits by scope owners and admins publish immediately; everyone else's edits become proposals.
- **Editor:** markdown with a formatting toolbar, a live side-by-side preview, `/` for blocks (headings, lists, checklists, code, tables, callouts), `@` to link an article or finding, `#` to link a system, table, metric or service, list continuation on Enter, and pasted or dropped images uploaded as attachments (once the item exists). New articles start from their type's template with a writing hint in each section (`<!-- Hint: … -->`), removed on save. Unsaved changes are kept in the browser and offered back after a reload. It stays plain markdown: not a WYSIWYG editor.
- **Metrics:** whether the knowledge base pays off: searches answered (people and agents), reuse rate (entries confirmed still valid vs new proposals), review time, problems that keep coming back (findings linked as the same root cause), and articles without an owner or past their check. Admins also see **knowledge gaps**: searches with no keyword match, grouped and redacted, with "Write it" and "Dismiss". Searches are logged without text unless nothing matched, and kept `SEARCH_LOG_DAYS` (180).
- **Delete and trash:** owners and admins delete an article or finding (Delete on its page) or a whole project (project settings → General, typing its name). Deleted things go to the **Trash** (avatar menu): hidden from everyone else, from search, browsing, the graph and agents, and open proposals on them are closed. Whoever deleted them (owners and admins) can restore them; restoring a project brings back everything deleted with it. Admins can delete trashed items and projects permanently (logged in the purge log).
- **Purge:** admins can permanently delete an article or finding with its history, proposals, links and files when it must not exist (a leaked secret, personal data). It takes a reason and the exact title; only the reason is kept (purge log on the Metrics page).
- **Weekly digest:** an email each week (`DIGEST_DAY`, `DIGEST_HOUR`, server time) with what changed in your scopes, what waits for your review, what you own that needs re-checking and, for admins, the week's knowledge gaps. People with nothing to report get nothing; anyone can turn it off on their Account page.
- **Getting started:** the home page shows a checklist worked out from what has happened (create a project, invite the team, set up email, connect Claude, add knowledge, follow something) until it's done or hidden.
- **New project:** pick its parts (backend, frontend, mobile, data, infra) and optionally a starter pack: outlines for an overview, a design doc and an on-call runbook, plus the API contract between backend and client, linked so contract changes notify the client side.
- **Import:** Markdown or HTML files, or a zip of them, including Notion (Markdown & CSV), Confluence (HTML space export) and Google Docs (Web page) exports. A preview lists the pages, folders and images first; images in the zip become attachments, folders become article folders, and everything goes through redaction and review like any write (`POST /api/import?scope=…&type=…&filename=…[&dry_run=true]` with the file as the body, up to `IMPORT_MAX_BYTES`).
- **Export:** a zip of Markdown files with YAML front matter and attachments, for everything you can read (Account page) or one scope (scope settings), or `GET /api/export[?scope=…]`.
- **Paste to draft:** paste a Slack thread, email or notes and get a draft finding or article. Simple rules pull out the title and labelled parts ("Root cause:", "Fix:") and drop timestamps, reactions, email headers and signatures; you check it before saving. For a smarter draft, use the `draft-from-paste` prompt in an AI client.
- **Review queue:** line diffs of current vs proposed text, with approve and reject. Reviewers can correct a proposal before approving it (the change is marked "edited by reviewer"), discuss it in a comment thread, assign it to another reviewer, and select several proposals to approve at once. Keyboard: `j`/`k` move, `x` select, `o` open in the queue; `a` approve, `e` edit, `r` reject, `n` next on a proposal.
- **History:** every published version of an article or finding is kept. The History page diffs any version against the one before it and restores an old version as a new one (directly for owners, as a proposal for everyone else).
- **Suggestions:** recurring root causes to promote into the article people read first, and possible duplicates to link, each with a one-click action. Both actions create proposals.

Behind Cloudflare Access, the browser is already signed in. In dev mode the UI asks for a dev token.

For UI development, run the server on :8080 and `pnpm --filter @thaliyola/web dev`. Vite serves on :5173 and proxies `/api`.

### Notifications

Everyone gets in-app notifications under the bell:
- **Proposals to review:** sent to scope owners and admins. The email version carries a one-click Approve link, which opens a confirmation page first so mail scanners can't approve.
- **Decisions:** the author hears when their proposal is approved or rejected.
- **Upstream changes:** members of a project, and anyone watching it, hear when a contract or shared design it uses changes.
- **Watched items:** anyone can watch an article, finding or project to hear about its changes.
- **Stale items:** owners hear when something they own needs re-verifying.

Email is sent over SMTP (`MAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM`). Each person chooses which types are emailed on their Account page. Review and change events can also go to a team Slack channel (`SLACK_WEBHOOK_URL`). The theme (system, light or dark) is set from the avatar menu.

### Review

Approval is deliberately not an MCP tool: agents propose, people approve. Reviewers use the web UI (`/#/review`) or the REST API:

```sh
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions                       # pending queue
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions/$ID                   # current vs proposed
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/api/revisions/$ID/approve
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"edits":{"patch":{"fix":"Use integer cents."}}}' localhost:8080/api/revisions/$ID/approve  # edit, then approve
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"ids":["…","…"]}' localhost:8080/api/revisions/bulk-approve
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"reason":"not confirmed"}' localhost:8080/api/revisions/$ID/reject
```

Also: `GET/POST /api/revisions/:id/comments`, `GET /api/revisions/:id/reviewers`, `PUT /api/revisions/:id/assignee` (`{"user_id": …}` or `null`), `GET /api/revisions?assigned=true`, and for history `GET /api/items/:id/versions[/:version]` and `POST /api/items/:id/restore` (`{"version": n}`).

### Permissions

- **Projects manage themselves:** each project has its own settings page (General, Members and access, Repositories) that its owners manage, not only admins: name and description, visibility, people and teams with roles, and its repositories.
- **Teams:** groups of people (Teams page). Admins create teams; admins and each team's **leads** assign its members (member or lead) and can start a **project for the team** from its page: the team gets a role on it (reader, writer or owner) and the chosen members own it. Add a team to any number of projects, and everyone in it gets that role there. A person's role in a project is the highest of their own and their teams' roles.
- **Repositories:** a project can have any number of repositories (components), each with its URL; one repository belongs to one project. A Claude session finds its project from the git remote: the `X-Thaliyola-Repo` header, or the `repo` argument of `get_project_context` (`GET /api/repos/resolve?url=` for scripts).
- **Moving:** owners can move a folder from one scope into a project, or make the folder a new project in one step (Move or make a project… beside a folder): items keep their ids, history and links; the folder prefix can be dropped, the folder can go into a folder of the destination, and chosen sub-folders become the project's repositories while staying folders (`POST /api/move`, with `dry_run` for a preview). A single article or finding moves with **Move…** on its page: to another project or space, into a folder there, and onto one of the project's repositories (findings have no folders, so a repository is how they're grouped). The project page lists everything grouped by repository.
- **Reading:** every signed-in user can read team-visible scopes. A project can be made **members-only** (scope settings, or `PATCH /api/scopes/:slug`). Then only its members and admins can read it, and for everyone else its articles, findings, files, review items and links don't appear anywhere: search, browse, project lists, "used by" links, needs-attention and suggestions all leave them out, and direct requests return "not found". Library owners can still review what such a project proposes to publish to the library.
- **Proposing:** in a team-visible scope, anyone can propose until the scope lists writers or owners; after that, only they can. In members-only projects, only writers and owners can.
- **Approving** is limited to scope owners and admins (`ADMIN_EMAILS`). Service identities never approve.

Admins manage projects, members, components and visibility on each scope's **Settings** page, or through the API:

```sh
curl -X POST .../api/projects -d '{"slug":"order-service","name":"Order service"}'
curl -X POST .../api/projects/order-service/components -d '{"slug":"backend","kind":"backend"}'
curl -X PUT  .../api/scopes/order-service/members -d '{"email":"owner@example.com","role":"owner"}'
```

People granted a role before they ever sign in receive it on their first login.

### Choosing the project

Tools take an optional `project` (and `component`) argument. A client can set defaults with headers so agents in a repo don't have to pass them:

```
X-Thaliyola-Project: order-service
X-Thaliyola-Component: frontend
```

## Agent integrations

[`integrations/`](integrations) has everything needed to make agents use Thaliyola by default:
- **Prompts:** `investigate`, `start-coding`, `capture`, `draft-from-paste`, `curate` and `review-stale`, served by every Thaliyola server.
- **Curation by the client's model:** Thaliyola has no LLM, so it hands judgment work to connected agents. `get_tasks` returns tasks with instructions: entries filed in the team space that belong to a project, project pages missing their repository, look-alike findings, recurring problems, empty outline sections, stale entries, projects without an overview, unlinked entries, and (for admins) searches that found nothing. The agent acts through normal tools (`move_entry` proposes moving an entry to a project, folder and/or repository) and reports with `complete_task`; handed-out tasks are reserved for an hour and finished ones stay hidden. `get_project_context` mentions open tasks so agents tidy as they go. Run it with the `curate` prompt (`/mcp__thaliyola__curate` in Claude Code), on demand or on a schedule (e.g. `claude -p "/mcp__thaliyola__curate"` from cron). Review → Suggestions shows the queue and what agents did. (MCP sampling isn't used: the endpoint is stateless and most clients don't support it.)
- **Claude Code:** a plugin with the `thaliyola` skill, a per-repo `.mcp.json` template, and a CLAUDE.md snippet.
- **claude.ai:** connector setup.
- **Scheduled jobs:** recipes for agents that turn Slack threads and Sentry issues into proposals.

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
- creates a `thaliyola` service user and database;
- builds the server and UI, deploys them to `/opt/thaliyola`, and runs them as the `thaliyola` systemd service on `127.0.0.1:8080`.

```sh
sudo ADMIN_EMAIL=you@example.com deploy/native/install.sh
```

- New installs use local sign-in. With `ADMIN_EMAIL` set, the first admin account is created and its temporary password printed at the end.
- Config lives in `/etc/thaliyola/thaliyola.env`.
- Re-run the script to upgrade. It keeps the config and the database.
- Logs: `journalctl -u thaliyola -f`.
- Backups run daily at 03:15 (`thaliyola-backup.timer`). Each one is a database dump plus an archive of uploaded files, written to `/var/backups/thaliyola`, and the newest 14 are kept. Run one now with `sudo thaliyola-backup`.
- Restore with `sudo thaliyola-restore /var/backups/thaliyola/thaliyola-….dump`. To check a backup without touching the live data, add `TARGET_DB=thaliyola_check` to restore it into a scratch database. Copy backups off the machine too.

**Without Docker, for development**

```sh
pnpm install
pnpm --filter @thaliyola/web build     # optional: the UI the server serves at /
export DATABASE_URL=postgres://thaliyola:thaliyola@localhost:5432/thaliyola
export AUTH_MODE=dev DEV_TOKENS=dev-token=you@example.com
pnpm --filter @thaliyola/server seed   # migrates and loads demo data
pnpm dev
```

**Connect Claude Code**

Create an API token on your Account page, then:

```sh
claude mcp add --transport http thaliyola http://localhost:8080/mcp \
  --header "Authorization: Bearer thaliyola_pat_…" \
  --header "X-Thaliyola-Project: order-service"
```

### Acceptance

[`docs/acceptance.md`](docs/acceptance.md) describes the full acceptance run and its latest results:
- a sweep of all 26 MCP tools (`pnpm --filter @thaliyola/server acceptance`);
- real Claude Code sessions acting as designer, backend developer, frontend developer, on-call engineer, admin and outsider.

### Behind a reverse proxy

[`deploy/native/nginx-thaliyola.conf`](deploy/native/nginx-thaliyola.conf) puts Thaliyola on port 80 behind Cloudflare (Tunnel or proxied DNS) or another proxy that terminates TLS. It passes the visitor's scheme and real IP (`CF-Connecting-IP`) through. Set `PUBLIC_URL` to the public https address. Browser writes are accepted from that origin even if a proxy rewrites the `Host` header.

If an authentication gateway sits in front, let these paths through without the gateway's sign-in, because Thaliyola authenticates them itself (API tokens or OAuth) and MCP clients can't complete a browser sign-in: `/mcp`, `/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/oauth/*` and `/api/*`.

### Smoke test

After a deploy with the demo data loaded, run end-to-end checks against the live server. It plays a backend agent changing a contract, a reviewer approving it, and a frontend agent picking up the change:

```sh
THALIYOLA_URL=http://localhost:8080 AGENT_TOKEN=<user token> ADMIN_TOKEN=<admin token> pnpm --filter @thaliyola/server smoke
```

### Tests

`THALIYOLA_REAL_EMBEDDINGS=1 pnpm test` also runs the semantic tests against the real model.

Tests run against a real Postgres database (`TEST_DATABASE_URL`, default `postgres://thaliyola:thaliyola@localhost:5432/thaliyola_test`). The schema is dropped and recreated on each run.

```sh
pnpm test
```

## Sign-in

Choose with `AUTH_MODE`:

| Mode | For | How people and agents sign in |
|---|---|---|
| `local` (default) | Self-hosting without an identity provider | Built-in accounts with passwords (scrypt) and browser sessions. Admins manage users on the **Users** page or with `thaliyola-admin` |
| `cloudflare` | Teams on Cloudflare Zero Trust | Cloudflare Access (and the MCP server portal) in front; the server verifies the Access JWT |
| `dev` | Local development only | Static bearer tokens from `DEV_TOKENS` |

In every mode, people can create **personal API tokens** on their Account page for Claude Code and other MCP clients. The page shows a ready-to-paste `claude mcp add` command. Tokens are stored hashed, can expire, and can be revoked.

Local mode details:
- **Invitations:** admins invite people by email from the Users page (optionally into a project with a role). The link works once, expires after 7 days, and lets the invitee choose their own password. Without email set up, the admin gets the link to pass on.
- Accounts added directly get a temporary password that must be changed at first sign-in.
- Failed sign-ins are throttled.
- Browser writes made with the session cookie must come from the same origin (CSRF protection on top of `SameSite=Lax`).
- Disabling a user ends their sessions and revokes their tokens.
- Session length: `SESSION_TTL_HOURS`. The cookie is `Secure` whenever the request came in over https (`COOKIE_SECURE`).

```sh
sudo thaliyola-admin create-user --email you@example.com --admin      # first admin (prints a temporary password)
sudo thaliyola-admin reset-password --email someone@example.com
sudo thaliyola-admin create-token --service nightly-rca --name "RCA job"  # token for a bot account
sudo thaliyola-admin export --out /tmp/thaliyola.zip [--scope team]          # everything as Markdown (members-only projects too)
```

### OAuth for claude.ai and other OAuth clients (local mode)

Set `PUBLIC_URL` (e.g. `https://thaliyola.example.com`) and Thaliyola also acts as an OAuth 2.1 authorization server for MCP clients that only support OAuth, such as claude.ai custom connectors:
- **Discovery:** protected-resource and authorization-server metadata, so clients find the server from a single 401.
- **Registration:** dynamic client registration.
- **Authorization:** authorization code with PKCE (S256). The person signs in with their Thaliyola account and approves the app on a consent page that shows where they'll be sent.
- **Tokens:** opaque access tokens (1 hour) and rotating refresh tokens (30 days). A reused refresh token or authorization code revokes everything issued from it, and tokens are bound to this server's `/mcp` resource.
- **Revocation:** people see and revoke connected apps on their Account page.

To add Thaliyola to claude.ai, use **Settings → Connectors → Add custom connector** with `https://thaliyola.example.com/mcp`. Thaliyola must be reachable from the internet over https, for example through a Cloudflare Tunnel or a reverse proxy.

The flow is built on the MCP TypeScript SDK's OAuth server router. Thaliyola supplies storage, sign-in, consent and token issuance.

(`thaliyola-admin` is installed by the native installer. Elsewhere, run `node dist/scripts/admin.js …` with `DATABASE_URL` set.)

## Deployment with Cloudflare Zero Trust

Thaliyola is meant to sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) and be reached by clients through a [Cloudflare MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

1. Create a Cloudflare Tunnel and put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Route a hostname (e.g. `thaliyola.example.com`) to `http://server:8080`.
2. Create a self-hosted Access application for that hostname, with a policy for your team. Copy its AUD tag.
3. Set `AUTH_MODE=cloudflare`, `CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` and `CF_ACCESS_AUD=<aud tag>`.
4. Start everything with `docker compose --profile tunnel up -d`. The server port is bound to localhost only. For a native install, [install `cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) as a service instead and point the tunnel at `http://localhost:8080`. Then set the Access variables in `/etc/thaliyola/thaliyola.env` and run `systemctl restart thaliyola`.
5. Add `https://thaliyola.example.com/mcp` to your MCP server portal. Users connect Claude to the portal URL.

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
- ~~**M4** Freshness jobs, OAuth for claude.ai connectors in local mode~~ (done)
- ~~Workflow prompts, Claude Code plugin, backups, promotion and duplicate suggestions~~ (done)
- ~~Members-only projects~~ (done)
- ~~S3-compatible file storage~~ (done)
- Next: Trello cards for recurring root causes (as a scheduled agent recipe)
- **M5** Integrations with existing agent skills, Slack and Sentry
