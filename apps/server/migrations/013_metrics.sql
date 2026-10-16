-- Searches, for the hit rate and knowledge gaps. The query text is kept (redacted)
-- only when nothing matched by keyword; it is deleted after SEARCH_LOG_DAYS.
CREATE TABLE search_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users (id),
  source       text NOT NULL CHECK (source IN ('web', 'mcp')),
  results      integer NOT NULL,
  keyword_hits integer NOT NULL,
  query        text
);
CREATE INDEX search_log_at ON search_log (at);
CREATE INDEX search_log_gaps ON search_log (lower(query)) WHERE query IS NOT NULL;

-- Hard deletions by admins (secrets or personal data that must go). No content is kept, only why.
CREATE TABLE purges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL,
  target_id   uuid NOT NULL,
  reason      text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users (id),
  removed     jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
