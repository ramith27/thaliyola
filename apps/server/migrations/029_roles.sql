-- Roles: named sets of permissions. Project roles are granted per project (to people directly or through teams);
-- org roles grant parts of what admins do. People and teams can hold several roles; their permissions add up.
-- reader / writer / owner keep their keys (as Viewer, Contributor and Project admin) so existing grants keep working.
CREATE TABLE roles (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind        text NOT NULL CHECK (kind IN ('org', 'project')),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  permissions text[] NOT NULL DEFAULT '{}',
  builtin     boolean NOT NULL DEFAULT false,
  position    int NOT NULL DEFAULT 100,   -- display order, most powerful first
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (key, kind, name, description, permissions, builtin, position) VALUES
  ('owner', 'project', 'Project admin', 'Everything in the project: members, settings, repositories, reviews and content.',
   '{read,comment,propose,verify,review,moderate,security,manage_members,manage_settings}', true, 10),
  ('moderator', 'project', 'Moderator', 'Reviews proposals and keeps content tidy: approves, moves, deletes and restores entries.',
   '{read,comment,propose,verify,review,moderate}', true, 20),
  ('reviewer', 'project', 'Reviewer', 'Approves or rejects proposed changes.',
   '{read,comment,propose,verify,review}', true, 30),
  ('writer', 'project', 'Contributor', 'Proposes articles, findings and edits, and sees the project''s vulnerabilities.',
   '{read,comment,propose,verify,security}', true, 40),
  ('qa', 'project', 'QA', 'Reports findings and known issues, and confirms whether entries still hold.',
   '{read,comment,propose,verify}', true, 50),
  ('stakeholder', 'project', 'Stakeholder', 'Reads everything and comments on proposals.',
   '{read,comment}', true, 60),
  ('reader', 'project', 'Viewer', 'Reads the project (needed for members-only projects).',
   '{read}', true, 70),
  ('user_manager', 'org', 'User manager', 'Approves new people, adds, disables and assigns org roles.',
   '{manage_users}', true, 10),
  ('project_creator', 'org', 'Project creator', 'Creates projects straight away and decides project requests.',
   '{create_projects}', true, 20),
  ('team_manager', 'org', 'Team manager', 'Creates teams and manages any team''s members.',
   '{manage_teams}', true, 30),
  ('security_lead', 'org', 'Security lead', 'Sees every project''s vulnerabilities and publishes security alerts.',
   '{security_admin}', true, 40),
  ('auditor', 'org', 'Auditor', 'Reads every project and sees usage metrics, without changing anything.',
   '{read_all_projects,view_metrics}', true, 50);

-- Several roles per person (and team) in a project.
ALTER TABLE scope_members DROP CONSTRAINT scope_members_pkey;
ALTER TABLE scope_members ADD PRIMARY KEY (scope_id, user_id, role);
ALTER TABLE scope_members DROP CONSTRAINT scope_members_role_check;
ALTER TABLE scope_members ADD CONSTRAINT scope_members_role_fkey FOREIGN KEY (role) REFERENCES roles (key) ON DELETE CASCADE;
ALTER TABLE scope_team_roles DROP CONSTRAINT scope_team_roles_pkey;
ALTER TABLE scope_team_roles ADD PRIMARY KEY (scope_id, team_id, role);
ALTER TABLE scope_team_roles DROP CONSTRAINT scope_team_roles_role_check;
ALTER TABLE scope_team_roles ADD CONSTRAINT scope_team_roles_role_fkey FOREIGN KEY (role) REFERENCES roles (key) ON DELETE CASCADE;
ALTER TABLE invitations DROP CONSTRAINT invitations_scope_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_scope_role_fkey FOREIGN KEY (scope_role) REFERENCES roles (key) ON DELETE SET NULL;

-- Org roles held by people.
CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES roles (key) ON DELETE CASCADE,
  granted_by uuid REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Everyone's permissions per scope, from all their roles (direct and through teams).
CREATE VIEW scope_permissions AS
  SELECT DISTINCT r.scope_id, r.user_id, p.permission
    FROM scope_roles r JOIN roles ro ON ro.key = r.role CROSS JOIN LATERAL unnest(ro.permissions) AS p (permission);
