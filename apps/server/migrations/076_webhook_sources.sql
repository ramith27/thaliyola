-- Push sources: GitHub (merged pull requests) and Sentry (resolved issues) send webhooks to a secret URL
-- instead of being fetched on a schedule. What they send lands in the inbox like any source, for people or
-- triage-inbox to turn into findings (a merged fix's root cause, a resolved error's cause).
ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('rss', 'web', 'hackernews', 'slack', 'notion', 'tavily', 'github_prs', 'sentry_issues'));
