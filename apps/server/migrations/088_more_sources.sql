-- More team sources: Confluence spaces, Linear teams' completed issues and Google Drive folders (Docs).
ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('rss', 'web', 'hackernews', 'slack', 'notion', 'tavily', 'github_prs', 'sentry_issues', 'confluence', 'linear', 'gdrive'));
