-- Approvals from Claude and skill source webhooks (1.1.0).
--
-- 1. Where a proposal or skill version was written and where it was decided: 'mcp' (through Claude, the MCP
--    connector) or, for decisions, 'token' (a REST call with a personal API token or OAuth token, what Claude Code
--    holds). NULL is the web app (or a row from before this migration). Review history shows "via Claude", and a
--    proposal someone wrote through Claude minutes ago needs the user's say-so before the same person approves it there.
ALTER TABLE revisions
  ADD COLUMN created_via text CHECK (created_via IN ('mcp')),
  ADD COLUMN decided_via text CHECK (decided_via IN ('mcp', 'token'));

ALTER TABLE skill_versions
  ADD COLUMN created_via text CHECK (created_via IN ('mcp')),
  ADD COLUMN decided_via text CHECK (decided_via IN ('mcp', 'token'));

-- 2. A git skill source's push webhook: a per-source secret (sealed with CONNECTIONS_KEY like the source's token,
--    never selected into responses), when a webhook last started a sync (one per minute per source), and a sync it
--    queued because one was running or had just run (the skill jobs pick it up).
ALTER TABLE skill_sources
  ADD COLUMN webhook_secret      text,
  ADD COLUMN webhook_secret_hint text,
  ADD COLUMN webhook_at          timestamptz,
  ADD COLUMN webhook_due_at      timestamptz;

CREATE INDEX skill_sources_webhook_due ON skill_sources (webhook_due_at) WHERE webhook_due_at IS NOT NULL;
