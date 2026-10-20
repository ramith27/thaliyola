-- Repository documentation, written by a connected agent and kept current.
-- A run plans pages and works through them one at a time (resumable); each page
-- is an article in the project, and the facts on it are claims grounded in
-- source lines at a commit, so code changes flag exactly the facts to re-check.

ALTER TABLE scopes ADD COLUMN doc_instructions text NOT NULL DEFAULT '';   -- what to document and how (like INSTRUCTIONS.md)
ALTER TABLE scopes ADD COLUMN doc_ignore text NOT NULL DEFAULT '';         -- gitignore-style paths agents must not read or cite
ALTER TABLE components ADD COLUMN docs_sha text;                           -- commit the docs last matched
ALTER TABLE components ADD COLUMN docs_updated_at timestamptz;

CREATE TABLE doc_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id     uuid NOT NULL REFERENCES scopes (id),
  component_id uuid REFERENCES components (id) ON DELETE SET NULL,
  mode         text NOT NULL CHECK (mode IN ('init', 'update')),
  base_sha     text,
  head_sha     text NOT NULL,
  changed_files text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'writing', 'done', 'noop', 'abandoned')),
  started_by   uuid NOT NULL REFERENCES users (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  summary      text
);
CREATE INDEX doc_runs_scope ON doc_runs (scope_id, started_at DESC);

CREATE TABLE doc_run_pages (
  run_id      uuid NOT NULL REFERENCES doc_runs (id) ON DELETE CASCADE,
  position    integer NOT NULL,
  key         text NOT NULL,
  title       text NOT NULL,
  folder      text NOT NULL DEFAULT '',
  type        text NOT NULL,
  purpose     text NOT NULL DEFAULT '',
  sources     text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'submitted', 'skipped')),
  claimed_at  timestamptz,
  article_id  uuid,
  revision_id uuid,
  note        text,
  PRIMARY KEY (run_id, key)
);

-- Which article is which generated page, per project and repository.
CREATE TABLE doc_pages (
  scope_id     uuid NOT NULL REFERENCES scopes (id),
  component    text NOT NULL DEFAULT '',            -- component slug, '' for the whole project
  key          text NOT NULL,
  article_id   uuid NOT NULL,
  sources      text[] NOT NULL DEFAULT '{}',
  last_sha     text,
  generated_by uuid REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, component, key)
);
CREATE INDEX doc_pages_article ON doc_pages (article_id);

CREATE TABLE claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  uuid NOT NULL,
  section     text NOT NULL DEFAULT '',
  text        text NOT NULL,
  evidence    jsonb NOT NULL,                       -- [{path, start, end, sha}]
  status      text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'stale', 'retired')),
  stale_reason text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_article ON claims (article_id) WHERE status <> 'retired';
CREATE INDEX claims_evidence ON claims USING gin (evidence jsonb_path_ops);
