-- Teams: groups of people that can be given a role on many projects at once.
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
  team_id  uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users (id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);
CREATE TABLE scope_team_roles (
  scope_id uuid NOT NULL REFERENCES scopes (id),
  team_id  uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('reader', 'writer', 'owner')),
  PRIMARY KEY (scope_id, team_id)
);

-- Everyone's roles per scope: granted directly or through a team (a person may appear more than once).
CREATE VIEW scope_roles AS
  SELECT scope_id, user_id, role, NULL::uuid AS team_id FROM scope_members
  UNION ALL
  SELECT r.scope_id, m.user_id, r.role, r.team_id FROM scope_team_roles r JOIN team_members m ON m.team_id = r.team_id;

-- Repositories: a normalized key ("github.com/org/repo") so a session can find its project from the git remote.
ALTER TABLE components ADD COLUMN repo_key text;
UPDATE components SET repo_key = lower(regexp_replace(regexp_replace(regexp_replace(repo_url,
  '^([a-z+]+://)?([^@/]+@)?', ''), '^([^/:]+):(?!\d+/)', '\1/'), '(\.git)?/*$', ''))
 WHERE repo_url IS NOT NULL;
CREATE INDEX components_repo_key ON components (repo_key);
