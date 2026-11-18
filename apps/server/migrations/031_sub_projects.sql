-- Sub-projects: a project can sit under another (any depth; the app keeps it acyclic and at most 6 levels).
-- Roles flow down: whoever holds a role in a project (directly or through a team) holds it in every project below it.
ALTER TABLE scopes ADD COLUMN parent_id uuid REFERENCES scopes (id) ON DELETE SET NULL;
ALTER TABLE scopes ADD CONSTRAINT scopes_only_projects_nest CHECK (parent_id IS NULL OR (kind = 'project' AND parent_id <> id));
CREATE INDEX scopes_parent ON scopes (parent_id) WHERE parent_id IS NOT NULL;

-- Everyone's roles per scope: direct, through a team, and inherited from any project above it
-- (inherited_from names the ancestor the role was granted on; NULL when granted here).
CREATE OR REPLACE VIEW scope_roles AS
  WITH RECURSIVE above (scope_id, ancestor_id, depth) AS (
    SELECT id, id, 0 FROM scopes
    UNION ALL
    SELECT a.scope_id, s.parent_id, a.depth + 1 FROM above a JOIN scopes s ON s.id = a.ancestor_id
     WHERE s.parent_id IS NOT NULL AND a.depth < 6
  ),
  granted (scope_id, user_id, role, team_id) AS (
    SELECT scope_id, user_id, role, NULL::uuid FROM scope_members
    UNION ALL
    SELECT r.scope_id, m.user_id, r.role, r.team_id FROM scope_team_roles r JOIN team_members m ON m.team_id = r.team_id
  )
  SELECT a.scope_id, g.user_id, g.role, g.team_id, CASE WHEN a.depth > 0 THEN a.ancestor_id END AS inherited_from
    FROM above a JOIN granted g ON g.scope_id = a.ancestor_id;
