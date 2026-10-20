-- Team sources: feeds, pages, Slack channels, Notion, Hacker News and web searches that Thaliyola
-- fetches on a schedule (no model involved). What they bring in waits in an inbox until a person
-- or a connected agent files it as knowledge or dismisses it.
CREATE TABLE sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('rss', 'web', 'hackernews', 'slack', 'notion', 'tavily')),
  name             text NOT NULL,
  scope_id         uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  config           jsonb NOT NULL DEFAULT '{}',
  interval_minutes integer NOT NULL DEFAULT 360 CHECK (interval_minutes >= 15),
  enabled          boolean NOT NULL DEFAULT true,
  state            jsonb NOT NULL DEFAULT '{}',
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  last_run_at      timestamptz,
  last_error       text,
  last_count       integer,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_due ON sources (next_run_at) WHERE enabled;

CREATE TABLE inbox_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  scope_id     uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  title        text NOT NULL,
  url          text,
  author       text,
  body         text NOT NULL DEFAULT '',
  content_hash text NOT NULL DEFAULT '',
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  updated      boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'filed', 'dismissed')),
  resolved_by  uuid REFERENCES users (id),
  resolved_at  timestamptz,
  note         text,
  item_kind    text CHECK (item_kind IN ('article', 'finding')),
  item_id      uuid,
  revision_id  uuid,
  UNIQUE (source_id, external_id)
);
CREATE INDEX inbox_items_new ON inbox_items (scope_id, fetched_at DESC) WHERE status = 'new';
