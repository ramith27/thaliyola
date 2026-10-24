# Changelog

## Unreleased

- Security feed opens on Major: critical issues in widely used technologies, actively exploited ones, and anything affecting your projects (`view=major`). Repositories' languages are read daily from GitHub or GitLab (`GITHUB_TOKEN` / `GITLAB_TOKEN` for private ones), and GitHub's dependency graph feeds OSV matching, so projects are matched without manual tagging (`POST /api/projects/:slug/technologies/detect`)

- Latest critical vulnerabilities worldwide on the Security page: NVD, GitHub advisories and CISA known-exploited additions every 6 hours, merged by CVE, releases grouped by product, and matched to projects by technology (dependencies, project settings → Technologies, stacks detected in reviews) or package. Affected projects are notified and record a response. Admins publish named alerts (e.g. PHP2Shell) that fold matching CVEs under them. `latest_advisories`, `set_advisory_response`, `publish_advisory`, `/api/advisories`, `/api/projects/:slug/technologies`; recent unsettled advisories in `get_project_context` and on project pages

- Scan any project from Claude Code: `/mcp__thaliyola__security-check full` scans dependencies and reviews the code with whatever audit tools are installed, then publishes findings and a review record to the project. An owner's first scan adds an unregistered repository to the project. `record_security_review` logs what each review covered. Repeat findings keep one entry. Project pages get a Security card, and the dashboard shows recent scans and reviews and the last code review per repository

- Security: per-project vulnerability register and dashboard. Lockfiles uploaded by agents (`scan_dependencies` hands out a one-time link and command) or CI (`POST /api/dependencies`) are matched against OSV.dev, deduplicated across advisory ids, and re-checked daily. Agents and people report what they find (`report_vulnerability`). CISA KEV flags actively exploited ones. Critical and actively exploited ones notify the project's writers and owners. Details are for writers and above; readers see counts. Also `list_vulnerabilities`, `get_vulnerability`, `update_vulnerability`, the `security-check` prompt, open critical/high vulnerabilities in `get_project_context`, a dependency step in the CI templates, and a Security page with trend, by-repository, packages, coverage and a filterable list

- Team sources and an inbox: RSS/Atom feeds, watched web pages, Hacker News searches, Slack channel threads, Notion pages and Tavily web searches fetched on a schedule (credentials from `SLACK_BOT_TOKEN`, `NOTION_TOKEN`, `TAVILY_API_KEY`; public addresses only unless `SOURCES_ALLOW_PRIVATE=true`); Inbox and Sources pages with preview, Check now, pause, dismiss and draft-from-item; `triage_inbox` curation tasks, a `triage-inbox` prompt and `list_inbox`, `get_inbox_item`, `resolve_inbox_item` and `add_source` MCP tools (`/api/sources`, `/api/inbox`)

- More agent hosts: `GET /connect.sh` installs Thaliyola into Claude Code, Codex, Gemini CLI, Copilot CLI, VS Code, Cursor, Windsurf, OpenCode and Kiro (asks per agent, backs up configs, `--yes`, `--only`, `--dry-run`); the Connect page has manual setup for each and an AGENTS.md snippet
- CI templates (GitHub Actions, GitLab CI, Bitbucket Pipelines) that run `update-docs` headless on every merge, shown on the Connect page and in `integrations/ci/`
- Repository URLs drop embedded credentials (CI checkout tokens) before they're stored or shown

- Repository documentation written by connected agents: documentation runs (`docs_begin` → `docs_submit_plan` → `docs_next_page` → `docs_submit_page` → `docs_finish`), `document-repo` and `update-docs` prompts, every fact stored as a claim with source-line evidence, incremental updates that mark only the facts and pages touched by changed files (and do nothing when nothing relevant changed), per-project instructions and gitignore-style ignore rules, Mermaid checks, a managed AGENTS.md block, and a `stale_claims` curation task
- Mermaid diagrams render in articles; a Sources panel shows each page's grounded facts with links to the exact lines and lets owners re-check stale ones (`/api/items/:id/claims`)
- Project settings → Documentation: instructions, ignore rules, documented commit per repository, recent runs and the AGENTS.md block (`/api/projects/:slug/docs`)
- Live refresh: pages, the project view and the graph update while agents write (`GET /api/events`, server-sent events)
- Static site export: a zip with a standalone reader for a project or the whole knowledge base (`GET /api/export/site`); the Markdown export now follows the Open Knowledge Format 0.2 (front matter with `kind` and provenance, `index.md`, `log.md`)

- `create_project` MCP tool: a session working in code with no project creates it (admins) or requests it (everyone else), with its repositories; admins approve or decline requests under Review → New projects (`/api/project-requests`)

- Mobile: bottom tab bar with a create sheet, full-screen search with Cancel, a More sheet for secondary actions on articles, findings and projects, tap-to-select and pinch-to-zoom in the graph, wrapping stat tiles, a one-row editor toolbar, 16px inputs (no iOS zoom), safe-area spacing, and an installable web app (manifest, icons, theme colour); fixed pages that scrolled sideways on phones (article, history)

- **Renamed from Cairn to Thaliyola.** Breaking: API tokens are now `thaliyola_pat_…` (and `thaliyola_oat_`/`thaliyola_ort_` for OAuth), headers are `X-Thaliyola-Project`, `X-Thaliyola-Component` and `X-Thaliyola-Repo`, the MCP server name is `thaliyola`, the session cookie is `thaliyola_session`, packages are `@thaliyola/*`, and the native install uses `thaliyola-admin`, `/etc/thaliyola`, `/opt/thaliyola`, `/var/lib/thaliyola` and the `thaliyola` service. Existing tokens and client configs must be recreated.

- Delete articles, findings and whole projects to a trash: hidden everywhere, open proposals closed, restorable by owners and admins, and permanently removable by admins (`POST /api/items/:id/delete`, `POST /api/projects/:slug/delete`, `/api/trash`)

- Curation by connected agents: `get_tasks` / `complete_task` hand judgment work to the client's model (misfiled entries, missing repositories, duplicates, recurring problems, empty outlines, stale entries, missing overviews, unlinked entries, unanswered searches), a `curate` prompt runs the loop, `get_project_context` reports open tasks, and Review → Suggestions shows the queue (`GET /api/tasks`)
- `move_entry` MCP tool: agents propose moving an entry to a project, folder and/or repository; reviewers see and approve move proposals like any other

- Knowledge graph: project articles and findings link to the repository they're about, or to the project, so a project and its pages form one cluster

- Move a single article or finding (Move… on its page) to a project, into a folder there and onto a repository; re-file items inside a project (`into_folder`, `component` on `POST /api/move`)
- Fix: sub-folders chosen as repositories during a move keep their folder (they were flattened to the top level); the project page lists everything grouped by repository (`GET /api/projects/:slug/pages`)

- Team leads: assign team members and their role (member or lead) and create projects for the team, with the team's role and the owners chosen at creation (`POST /api/teams/:slug/projects`)
- Make a folder its own project from the Move dialog (creates the project, then moves the folder)

- Projects manage their own access: a settings page with General, Members and access, and Repositories, open to the project's owners (not just admins); owners can't leave a project without an owner (`/api/scopes/:slug/access`)
- Teams: groups of people that get a role on many projects at once (`/api/teams`, `PUT /api/scopes/:slug/teams`); effective roles combine direct and team roles everywhere (reading, proposing, approving, notifications, digests)
- Any number of repositories per project, editable and removable, one project per repository; sessions find their project from the git remote (`X-Thaliyola-Repo` header, `repo` argument of `get_project_context`, `/api/repos/resolve`)
- Move a folder or items into a project, keeping history and links, optionally turning sub-folders into repositories (`POST /api/move`)

- Metrics page (`/api/success`): searches answered, reuse rate, review time, repeat problems, unowned and stale items; knowledge gaps for admins (`/api/gaps`), from a search log that keeps query text only for misses, redacted (`SEARCH_LOG_DAYS`)
- Admin purge of an article or finding with a required reason and a purge log (`POST /api/purge/:id`, `/api/purges`); stored files are removed when nothing else uses them
- Weekly digest email (`DIGEST_DAY`, `DIGEST_HOUR`)

- Email invitations for local sign-in: one-time links (7 days) where the invitee chooses a password, optional project and role, managed on the Users page (`/api/invitations`)
- First-run checklist on the home page, derived from what has happened (`/api/onboarding`)
- New project page with components and a starter pack (overview, design doc, on-call runbook, and a linked API contract when there is a backend and a client)
- Import of Markdown, HTML and zip files, including Notion, Confluence and Google Docs exports, with a dry-run preview, folders, image attachments and one review notification per batch (`POST /api/import`, `IMPORT_MAX_BYTES`)
- Markdown export as a zip with front matter and attachments (`GET /api/export`, `thaliyola-admin export`)

- Editor: formatting toolbar, live split preview, `/` block commands, `@` links to articles and findings, `#` links to entities, list continuation, image paste and drop (uploaded as attachments), local autosave with restore, and writing hints in new-article templates (`/api/templates/:type?hints=true`; `<!-- Hint: … -->` comments are removed on save)
- Paste to draft (`/#/new/paste`): rule-based drafts of findings and articles from Slack threads, emails and notes, plus a `draft-from-paste` MCP prompt for AI clients
- Web unit tests (`pnpm --filter @thaliyola/web test`)

- Finding things: an answer card above search results (the best section or finding, quoted, with a confidence label), an "Ask Thaliyola" box on the home page, results as you type in the search box (`/api/search?prefix=true` matches the last word as a prefix), and a ⌘K command palette for search, entities, navigation, favourites, recent items and theme
- Favourites (per person, `GET /api/favourites`, `PUT`/`DELETE /api/favourites/:id`) and recently viewed items in the sidebar
- Entity pages (`/api/entities?q=`, `/api/entities/:kind/:name`) linked from each item's "About" list
- Copy a link to an article section; Share button on articles and findings

- Review workflow: edit a proposal before approving it, comment threads on proposals (participants are notified), assign a proposal to a reviewer ("Assigned to me" filter), bulk approve, and keyboard shortcuts in the queue and on proposals
- Version history: every published version of an article or finding is stored; the History page diffs versions and restores an old one as a new version (a proposal for non-owners)
- Notifications: in-app bell, email (SMTP) with per-type preferences and a one-click approve link behind a confirmation page, optional Slack webhook; watch articles, findings and projects; reviewers, authors, consuming projects and owners of stale items are told what concerns them
- Theme switch (system, light, dark) in the avatar menu

- Redesigned web UI: Inter typeface, slate/blue palette with full dark mode, icon sidebar, avatar menu, ⌘K search
- Dashboard with stat tiles and charts (knowledge added, activity, freshness, knowledge by type, top contributors), built to the dataviz method: validated palette, legends, hover tooltips, table view for every chart
- Interactive knowledge graph of projects, components, articles and findings and how they link
- Relationships panel on every article and finding (two-hop local graph), graph focus mode (`/api/graph?focus=…&depth=…`), graph button on project pages

- Web UI: Connect page with the user's access and roles, inline token creation, and ready-to-copy setup for Claude Code (global and per repository), claude.ai and other MCP clients, plus the live list of prompts and tools; getting-started banner for users who haven't connected yet
- Support for running behind a reverse proxy and an authentication gateway (nginx config, public-origin aware same-origin checks)

- Search fuses normalized keyword and semantic scores instead of ranks, so the current-project boost can't lift a weak match over a much stronger one (found by the Docker CI job)
- Fix: `docker compose up` no longer requires a Cloudflare tunnel token when the tunnel profile is off

- Acceptance sweep (`pnpm --filter @thaliyola/server acceptance`) and a documented Claude Code acceptance run (`docs/acceptance.md`)
- CI builds the Docker image and smoke-tests the Compose stack
- `investigate` prompt takes a single argument (multi-word symptoms survive clients that split prompt arguments on spaces)
- `share_to_library` accepts drafts; the share is approved after the item itself
- Fix: asset uploads and deletions were audited twice
- Web UI: unfiled articles listed before folders in the sidebar tree

## 0.1.0 (2026-10-16)

First release.

- **Knowledge model.** Team, project and library scopes; project components (backend, frontend, …); curated articles in 14 templated types, including API contracts, design tokens, UI component specs, UX patterns and screen specs; episodic findings; typed links (`uses`, `provided_by`, `consumed_by`, `depends_on`, `same_root_cause`, …).
- **MCP server.** 23 tools over streamable HTTP, plus `investigate`, `start-coding`, `capture` and `review-stale` prompts. Every agent write is a reviewed proposal.
- **Review.** Optimistic concurrency, rule-based redaction of secrets and personal data, duplicate detection, impact notices to consumers of changed contracts and shared designs, and promotion and duplicate suggestions.
- **Search.** Hybrid full-text and semantic search with a local embedding model (bge-small, no LLM, no API key), reciprocal rank fusion, HNSW index, and freshness-aware ranking.
- **Sharing.** Publish project items to the library; design assets (screenshots, token files) on local disk or S3-compatible storage; Figma and other source links.
- **Access.** Local accounts with sessions and personal API tokens; OAuth 2.1 for claude.ai connectors; Cloudflare Access; members-only projects; per-scope roles; per-user rate limits.
- **Web UI.** Browse, project and component views, search, markdown editor, review queue with diffs, suggestions, account and user management, scope settings.
- **Operations.** Native systemd installer with daily backups and restore, Docker Compose with optional Cloudflare Tunnel, freshness maintenance job, access logs, health check.
- **Integrations.** Claude Code plugin and skill, per-repo setup, claude.ai connector, and scheduled-agent recipes (Slack, Sentry, Trello).
