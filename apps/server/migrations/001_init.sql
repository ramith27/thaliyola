-- Team knowledge base: full data model (see plan §4).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject      text NOT NULL UNIQUE,            -- 'cf:<email>' | 'cf-svc:<client id>' | 'dev:<email>'
  email        text,
  display_name text,
  kind         text NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'service')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Team (one), Library (one), Project (many).
CREATE TABLE scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('team', 'project', 'library')),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scopes_one_team_one_library ON scopes (kind) WHERE kind IN ('team', 'library');

CREATE TABLE scope_members (
  scope_id uuid NOT NULL REFERENCES scopes (id),
  user_id  uuid NOT NULL REFERENCES users (id),
  role     text NOT NULL CHECK (role IN ('reader', 'writer', 'owner')),
  PRIMARY KEY (scope_id, user_id)
);

-- Codebases inside a project (backend, frontend, ...).
CREATE TABLE components (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes (id),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  kind        text NOT NULL CHECK (kind IN ('backend', 'frontend', 'mobile', 'data', 'infra', 'other')),
  repo_url    text,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, slug)
);

CREATE TABLE articles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id         uuid NOT NULL REFERENCES scopes (id),
  type             text NOT NULL CHECK (type IN (
                     'system', 'table', 'metric', 'runbook', 'decision',
                     'project_overview', 'design_doc', 'tech_spec', 'api_contract', 'pattern',
                     'design_tokens', 'ui_component', 'ux_pattern', 'screen_spec')),
  title            text NOT NULL,
  path             text NOT NULL DEFAULT '',     -- browse tree folder, e.g. 'Systems/Redis'
  body_md          text NOT NULL DEFAULT '',
  tags             text[] NOT NULL DEFAULT '{}',
  component_ids    uuid[] NOT NULL DEFAULT '{}', -- components this article is about
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'published', 'possibly_stale', 'superseded', 'rejected')),
  owner_id         uuid REFERENCES users (id),
  version          integer NOT NULL DEFAULT 1,
  review_due       date,
  last_verified_at timestamptz,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX articles_scope ON articles (scope_id, type);

CREATE TABLE findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id         uuid NOT NULL REFERENCES scopes (id),
  type             text NOT NULL CHECK (type IN ('incident', 'rca', 'known_issue', 'data_gotcha', 'query_recipe')),
  title            text NOT NULL,
  symptoms         text NOT NULL DEFAULT '',
  root_cause       text NOT NULL DEFAULT '',
  fix              text NOT NULL DEFAULT '',
  tags             text[] NOT NULL DEFAULT '{}',
  component_ids    uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'published', 'possibly_stale', 'superseded', 'rejected')),
  author_id        uuid REFERENCES users (id),
  version          integer NOT NULL DEFAULT 1,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_scope ON findings (scope_id, type);

-- Search units: one per article section, one per finding.
CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  parent_kind text NOT NULL CHECK (parent_kind IN ('article', 'finding')),
  parent_id   uuid NOT NULL,
  scope_id    uuid NOT NULL REFERENCES scopes (id),
  ord         integer NOT NULL,
  heading     text NOT NULL DEFAULT '',
  text        text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
                setweight(to_tsvector('english', text), 'B')) STORED,
  embedding   vector(384)
);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_parent ON chunks (parent_kind, parent_id);

CREATE TABLE entities (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind    text NOT NULL CHECK (kind IN ('system', 'table', 'metric', 'service', 'advertiser', 'publisher', 'offer', 'other')),
  name    text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  UNIQUE (kind, name)
);

CREATE TABLE entity_links (
  entity_id   uuid NOT NULL REFERENCES entities (id),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding')),
  target_id   uuid NOT NULL,
  PRIMARY KEY (entity_id, target_kind, target_id)
);

-- Typed links. from/to may be an article, finding, scope (project) or component.
CREATE TABLE relations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind  text NOT NULL CHECK (from_kind IN ('article', 'finding', 'scope', 'component')),
  from_id    uuid NOT NULL,
  to_kind    text NOT NULL CHECK (to_kind IN ('article', 'finding', 'scope', 'component')),
  to_id      uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN (
               'same_root_cause', 'supersedes', 'related', 'promoted_into',
               'uses', 'published_as', 'provided_by', 'consumed_by', 'depends_on')),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX relations_to ON relations (to_id, kind);

CREATE TABLE source_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding')),
  target_id   uuid NOT NULL,
  system      text NOT NULL CHECK (system IN ('slack', 'sentry', 'trello', 'pr', 'figma', 'dashboard', 'repo', 'other')),
  url         text NOT NULL,
  label       text NOT NULL DEFAULT ''
);
CREATE INDEX source_links_target ON source_links (target_id);

-- Every agent write lands here first; approval applies it.
CREATE TABLE revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind  text NOT NULL CHECK (target_kind IN ('article', 'finding')),
  target_id    uuid,                          -- null for a proposed new item
  scope_id     uuid NOT NULL REFERENCES scopes (id),
  op           text NOT NULL CHECK (op IN ('create', 'update', 'promote', 'share', 'verify')),
  base_version integer,
  payload      jsonb NOT NULL,
  author_id    uuid NOT NULL REFERENCES users (id),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  reviewer_id  uuid REFERENCES users (id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX revisions_pending ON revisions (scope_id, created_at) WHERE state = 'pending';

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes (id),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding')),
  target_id   uuid NOT NULL,
  mime        text NOT NULL,
  sha256      text NOT NULL,
  size_bytes  bigint NOT NULL,
  storage_key text NOT NULL,
  alt_text    text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Upstream change (contract / shared design) a consumer has not acknowledged yet.
CREATE TABLE impact_notices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind    text NOT NULL CHECK (source_kind IN ('article', 'finding')),
  source_id      uuid NOT NULL,
  source_version integer NOT NULL,
  component_id   uuid REFERENCES components (id),
  scope_id       uuid REFERENCES scopes (id),
  summary        text NOT NULL,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acked')),
  acked_by       uuid REFERENCES users (id),
  acked_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (component_id IS NOT NULL OR scope_id IS NOT NULL)
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  actor_id  uuid REFERENCES users (id),
  tool      text NOT NULL,
  target_id uuid,
  at        timestamptz NOT NULL DEFAULT now()
);
