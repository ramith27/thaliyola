# Changelog

## Unreleased

- Acceptance sweep (`pnpm --filter @cairn/server acceptance`) and a documented Claude Code acceptance run (`docs/acceptance.md`)
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
