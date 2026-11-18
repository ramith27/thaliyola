-- Skills: Claude skills (SKILL.md + files) published in Thaliyola, reviewed by a second person and versioned, assigned
-- to people by role, team, project or everyone, and delivered through MCP, a zip download and the Claude Code sync.
-- core/skills/* in the server; README "Skills for Claude".

-- Where skills come from: a git repository (GitLab/GitHub API) or uploads. Secrets are sealed with CONNECTIONS_KEY
-- (core/secrets.ts, AAD "skill_source:<id>") or borrowed from a git connection.
CREATE TABLE skill_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind             text NOT NULL CHECK (kind IN ('git', 'upload')),
  provider         text CHECK (provider IN ('gitlab', 'github')),
  connection_id    uuid REFERENCES connections (id) ON DELETE SET NULL,
  api_url          text,                                   -- own-token sources: allowlisted hosts only
  repository       text,                                   -- group/sub/project or owner/repo
  ref              text,                                   -- branch, tag or SHA; null = default branch
  path             text NOT NULL DEFAULT '',               -- optional include filter: only skills under this path
  exclude          text[] NOT NULL DEFAULT '{}',           -- globs of skill dirs never imported (plugins/im-knowledge-base/**)
  no_deliver       text[] NOT NULL DEFAULT '{}',           -- globs inside a skill imported for review but never delivered (evals/**)
  owner_scope_id   uuid REFERENCES scopes (id) ON DELETE CASCADE,  -- skills from it are owned by this project
  secret           text,                                   -- sealed {"token": "..."}; never selected into responses
  secret_hint      text,                                   -- last 4 characters, like connections.secret_hints
  publish_directly boolean NOT NULL DEFAULT false,         -- set by an Administrator only
  publish_directly_by uuid REFERENCES users (id),
  interval_minutes integer CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 60 AND 10080),
  enabled          boolean NOT NULL DEFAULT true,
  owner_id         uuid REFERENCES users (id),             -- whose permissions scheduled runs use
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_ok_at       timestamptz,
  last_commit      text,
  last_filters     text,                                   -- the filters of the last run (a change re-runs at the same commit)
  last_error       text,                                   -- short, provider-message only
  failures         integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'upload' OR (provider IS NOT NULL AND repository IS NOT NULL)),
  CHECK (connection_id IS NULL OR secret IS NULL),
  CHECK (NOT publish_directly OR publish_directly_by IS NOT NULL)
);
CREATE UNIQUE INDEX skill_sources_name ON skill_sources (lower(name));
CREATE INDEX skill_sources_due ON skill_sources (next_run_at) WHERE enabled AND interval_minutes IS NOT NULL;

-- A plugin of a marketplace (or a hand-made group): display name, description and the connectors it needs.
CREATE TABLE skill_collections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  source_id        uuid REFERENCES skill_sources (id) ON DELETE SET NULL,
  owner_scope_id   uuid REFERENCES scopes (id) ON DELETE CASCADE,
  connectors       jsonb NOT NULL DEFAULT '[]',            -- [{name, type: "http"|"sse", url}] from .mcp.json
  upstream_version text,                                   -- plugin.json "version", shown only
  removed_at       timestamptz,                            -- marketplace renames[old] = null
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  collection_id         uuid REFERENCES skill_collections (id) ON DELETE SET NULL,
  owner_scope_id        uuid REFERENCES scopes (id) ON DELETE CASCADE,   -- null = organisation-wide skill
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'retired', 'archived')),
  current_version_id    uuid,                               -- FK below; null until a version is published
  source_id             uuid REFERENCES skill_sources (id) ON DELETE SET NULL,
  source_path           text,                               -- plugins/im-analytics/skills/nhausa
  source_detached       boolean NOT NULL DEFAULT false,     -- local override: imports report it, never touch it
  held_at_version       integer,                            -- set by a rollback: imports don't propose until released
  held_by               uuid REFERENCES users (id),
  pending_collection_id uuid REFERENCES skill_collections (id) ON DELETE SET NULL,  -- a widening move awaiting review
  pending_collection_import_id uuid,                        -- FK below
  pending_collection_by uuid REFERENCES users (id),         -- who started the move (can't confirm it)
  declined_collection_id uuid REFERENCES skill_collections (id) ON DELETE SET NULL, -- move declined; not re-asked
  as_prompt             boolean NOT NULL DEFAULT true,      -- also offered as an MCP prompt
  status_reason         text,                               -- "removed from <source> at <sha>", "paused by …"
  created_by            uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skills_collection ON skills (collection_id);
CREATE INDEX skills_source ON skills (source_id);

-- File contents, content-addressed so unchanged files cost nothing across versions and re-imports.
CREATE TABLE skill_blobs (
  sha256     text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size       integer NOT NULL,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()            -- refreshed on reuse; the janitor waits 24 h
);

CREATE TABLE skill_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid REFERENCES skill_sources (id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('git', 'upload', 'articles')),
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  dry_run        boolean NOT NULL DEFAULT false,
  scheduled      boolean NOT NULL DEFAULT false,
  forced         boolean NOT NULL DEFAULT false,
  ref            text,
  commit         text,                                      -- source commit SHA (git); null for uploads
  filename       text,                                      -- uploads
  layout         text CHECK (layout IN ('marketplace', 'plugin', 'plain', 'folder', 'single', 'articles')),
  owner_scope_id uuid REFERENCES scopes (id) ON DELETE CASCADE,
  report         jsonb NOT NULL DEFAULT '{}',
  error          text,
  started_by     uuid REFERENCES users (id),                -- counts as the author of what the run proposes
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE UNIQUE INDEX skill_imports_one_running ON skill_imports (source_id) WHERE status = 'running' AND source_id IS NOT NULL;
CREATE INDEX skill_imports_source ON skill_imports (source_id, started_at DESC);
ALTER TABLE skills ADD CONSTRAINT skills_pending_collection_import_fkey
  FOREIGN KEY (pending_collection_import_id) REFERENCES skill_imports (id) ON DELETE SET NULL;

CREATE TABLE skill_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id         uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  version          integer NOT NULL,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'rejected', 'superseded')),
  base_version_id  uuid REFERENCES skill_versions (id),     -- the current version when proposed (null for v1)
  description      text NOT NULL,
  frontmatter      jsonb NOT NULL,
  upstream_version text,                                     -- frontmatter metadata.version, e.g. "3.11.0"
  content_hash     text NOT NULL,                            -- sha256 over sorted "path\0sha256\n" lines (post-stamp)
  guidance_hash    text,                                     -- set when the only change vs base is shared guidance
  file_count       integer NOT NULL,
  total_bytes      integer NOT NULL,
  has_scripts      boolean NOT NULL DEFAULT false,
  allowed_tools    text,                                     -- frontmatter allowed-tools, flagged in review
  flags            jsonb NOT NULL DEFAULT '[]',              -- [{kind, path, line, message, high_risk}] for reviewers
  summary          text NOT NULL DEFAULT '',
  source_commit    text,
  source_ref       text,
  import_id        uuid REFERENCES skill_imports (id) ON DELETE SET NULL,
  restored_from    integer,                                  -- rollback: the version copied
  author_id        uuid REFERENCES users (id),               -- manual author, or the import's started_by / source owner
  reviewer_id      uuid REFERENCES users (id),
  self_approved    boolean NOT NULL DEFAULT false,
  direct           boolean NOT NULL DEFAULT false,           -- published by a publish-directly source, no reviewer
  reason           text,                                     -- rejection reason / review note / superseded-by
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  UNIQUE (skill_id, version)
);
CREATE UNIQUE INDEX skill_versions_one_pending ON skill_versions (skill_id) WHERE state = 'pending';
CREATE INDEX skill_versions_pending ON skill_versions (created_at) WHERE state = 'pending';
CREATE INDEX skill_versions_rejected ON skill_versions (skill_id, content_hash) WHERE state = 'rejected';
ALTER TABLE skills ADD CONSTRAINT skills_current_version_fkey FOREIGN KEY (current_version_id) REFERENCES skill_versions (id);

-- SKILL.md is a row here too.
CREATE TABLE skill_files (
  version_id uuid NOT NULL REFERENCES skill_versions (id) ON DELETE CASCADE,
  path       text NOT NULL CHECK (length(path) BETWEEN 1 AND 300 AND path !~ '(^/|\\|(^|/)\.\.?(/|$)|//)'),
  sha256     text NOT NULL REFERENCES skill_blobs (sha256),
  size       integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('text', 'binary')),
  is_script  boolean NOT NULL DEFAULT false,
  managed    boolean NOT NULL DEFAULT false,               -- a core/ copy stamped by the importer
  deliver    boolean NOT NULL DEFAULT true,                -- false: matched the source's no_deliver globs
  PRIMARY KEY (version_id, path)
);
CREATE INDEX skill_files_sha ON skill_files (sha256);

-- A project and every project below it (roles flow down; so do skill assignments). Depth limit as scope_roles (6).
CREATE VIEW scope_subtree AS
  WITH RECURSIVE below (root_id, scope_id, depth) AS (
    SELECT id, id, 0 FROM scopes
    UNION ALL
    SELECT b.root_id, s.id, b.depth + 1 FROM below b JOIN scopes s ON s.parent_id = b.scope_id WHERE b.depth < 6
  ) SELECT root_id, scope_id, depth FROM below;

-- Who gets a skill (or every skill of a collection, including ones added later).
CREATE TABLE skill_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id      uuid REFERENCES skills (id) ON DELETE CASCADE,
  collection_id uuid REFERENCES skill_collections (id) ON DELETE CASCADE,
  audience      text NOT NULL CHECK (audience IN ('everyone', 'org_role', 'team', 'project', 'project_role')),
  role          text REFERENCES roles (key) ON DELETE CASCADE,
  team_id       uuid REFERENCES teams (id) ON DELETE CASCADE,
  scope_id      uuid REFERENCES scopes (id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((skill_id IS NULL) <> (collection_id IS NULL)),
  CHECK (audience <> 'everyone'     OR (role IS NULL AND team_id IS NULL AND scope_id IS NULL)),
  CHECK (audience <> 'org_role'     OR (role IS NOT NULL AND team_id IS NULL AND scope_id IS NULL)),
  CHECK (audience <> 'team'         OR (team_id IS NOT NULL AND role IS NULL AND scope_id IS NULL)),
  CHECK (audience <> 'project'      OR (scope_id IS NOT NULL AND role IS NULL AND team_id IS NULL)),
  CHECK (audience <> 'project_role' OR (role IS NOT NULL AND team_id IS NULL))  -- scope_id null = that role in any project
);
CREATE UNIQUE INDEX skill_assignments_unique ON skill_assignments (
  coalesce(skill_id, collection_id), audience, coalesce(role, ''), coalesce(team_id::text, ''), coalesce(scope_id::text, ''));
CREATE INDEX skill_assignments_skill ON skill_assignments (skill_id);
CREATE INDEX skill_assignments_collection ON skill_assignments (collection_id);

-- org_role names an organisation role, project_role a project role, and scope_id a project. A skill or collection
-- owned by a project allows only project / project_role inside that project's subtree (a null scope means the owner).
-- The app checks the same first, with friendly errors.
CREATE FUNCTION skill_assignment_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
  role_kind text;
  scope_kind text;
BEGIN
  IF NEW.audience IN ('org_role', 'project_role') THEN
    SELECT kind INTO role_kind FROM roles WHERE key = NEW.role;
    IF role_kind IS DISTINCT FROM (CASE WHEN NEW.audience = 'org_role' THEN 'org' ELSE 'project' END) THEN
      RAISE EXCEPTION 'skill assignment: % is not a% role', NEW.role, CASE WHEN NEW.audience = 'org_role' THEN 'n organisation' ELSE ' project' END;
    END IF;
  END IF;
  IF NEW.skill_id IS NOT NULL THEN
    SELECT owner_scope_id INTO owner FROM skills WHERE id = NEW.skill_id;
  ELSE
    SELECT owner_scope_id INTO owner FROM skill_collections WHERE id = NEW.collection_id;
  END IF;
  IF owner IS NOT NULL THEN
    IF NEW.audience NOT IN ('project', 'project_role') THEN
      RAISE EXCEPTION 'skill assignment: a project''s own skills go only to that project and the projects under it';
    END IF;
    IF NEW.scope_id IS NULL THEN
      NEW.scope_id := owner;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM scope_subtree WHERE root_id = owner AND scope_id = NEW.scope_id) THEN
      RAISE EXCEPTION 'skill assignment: a project''s own skills go only to that project and the projects under it';
    END IF;
  END IF;
  IF NEW.scope_id IS NOT NULL THEN
    SELECT kind INTO scope_kind FROM scopes WHERE id = NEW.scope_id;
    IF scope_kind IS DISTINCT FROM 'project' THEN
      RAISE EXCEPTION 'skill assignment: % is not a project', NEW.scope_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_assignments_check BEFORE INSERT OR UPDATE ON skill_assignments FOR EACH ROW EXECUTE FUNCTION skill_assignment_check();

-- Who loaded which skill, which version, how and when (get_skill, files, prompts, downloads, the Claude Code sync).
CREATE TABLE skill_usage (
  id       bigserial PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  version  integer NOT NULL,
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel  text NOT NULL CHECK (channel IN ('mcp', 'file', 'prompt', 'download', 'sync')),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_usage_skill ON skill_usage (skill_id, at DESC);
CREATE INDEX skill_usage_user ON skill_usage (user_id, skill_id, channel, at DESC);
CREATE INDEX skill_usage_at ON skill_usage (at);

-- Last time each person's sync script checked in (the Connect page shows it; list_skills hints at the local copy).
-- Written at most once per 10 minutes per person.
CREATE TABLE skill_sync_seen (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  script     text                                          -- script version string
);

-- "This skill was wrong": lands in Review › Skills.
CREATE TABLE skill_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  version     integer,
  author_id   uuid NOT NULL REFERENCES users (id),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),   -- redacted on write
  redactions  jsonb NOT NULL DEFAULT '[]',
  via         text NOT NULL CHECK (via IN ('web', 'mcp')),
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  resolution  text,
  resolved_by uuid REFERENCES users (id),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_feedback_open ON skill_feedback (created_at) WHERE state = 'open';
CREATE INDEX skill_feedback_skill ON skill_feedback (skill_id, created_at DESC);

-- Roles: two organisation permissions and a built-in Skills manager role; Administrator lists every org permission.
INSERT INTO roles (key, kind, name, description, permissions, builtin, position) VALUES
  ('skills_manager', 'org', 'Skills manager',
   'Publishes Claude skills: imports, writes and assigns them, reviews other people''s new versions and sees who uses them.',
   '{manage_skills,review_skills}', true, 45)
ON CONFLICT (key) DO NOTHING;
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || '{manage_skills,review_skills}'::text[]) ORDER BY 1)
 WHERE key = 'admin';

-- Notifications: kind 'skill' (versions to review, problems reported, imports that failed). Extended, not restated,
-- exactly like 035.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'notifications'::regclass AND conname = 'notifications_kind_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint notifications_kind_check not found; it must exist before 051 extends it';
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || ARRAY['skill']) AS v WHERE v <> '' ORDER BY v);
  ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
  EXECUTE format('ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;
