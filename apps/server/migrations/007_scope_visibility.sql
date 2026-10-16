-- members: only scope members (and admins) can read a project's knowledge.
ALTER TABLE scopes ADD COLUMN visibility text NOT NULL DEFAULT 'team'
  CHECK (visibility IN ('team', 'members'));
ALTER TABLE scopes ADD CONSTRAINT scopes_shared_are_team_visible CHECK (kind = 'project' OR visibility = 'team');
