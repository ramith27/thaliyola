-- Streamlined access: Administrator becomes the top organisation role (still stored as users.is_admin, plus ADMIN_EMAILS),
-- every project role includes read, role kinds are enforced, and invitations can carry several project roles.

-- 1. A custom role already using the key 'admin' moves to a free key; whoever held it keeps it.
DO $$
DECLARE free text := 'admin_custom'; n int := 2;
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE key = 'admin') THEN
    WHILE EXISTS (SELECT 1 FROM roles WHERE key = free) LOOP free := 'admin_custom_' || n; n := n + 1; END LOOP;
    INSERT INTO roles (key, kind, name, description, permissions, builtin, position, created_by, created_at)
      SELECT free, kind, name, description, permissions, false, position, created_by, created_at FROM roles WHERE key = 'admin';
    UPDATE scope_members SET role = free WHERE role = 'admin';
    UPDATE scope_team_roles SET role = free WHERE role = 'admin';
    UPDATE user_roles SET role = free WHERE role = 'admin';
    UPDATE invitations SET scope_role = free WHERE scope_role = 'admin';
    DELETE FROM roles WHERE key = 'admin';
  END IF;
END $$;
-- Custom organisation roles called "Administrator" or "Admin" get a distinct name, so that name means one role.
UPDATE roles SET name = name || ' (custom)'
 WHERE kind = 'org' AND trim(both '_' from lower(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '_', 'g'))) IN ('administrator', 'admin');

-- 2. Administrator: held through users.is_admin (and ADMIN_EMAILS), never through user_roles.
INSERT INTO roles (key, kind, name, description, permissions, builtin, position) VALUES
  ('admin', 'org', 'Administrator',
   'Can do everything: every organisation permission (so they read and manage every project), system settings, and making other Administrators.',
   '{manage_users,create_projects,manage_teams,manage_roles,manage_all_projects,read_all_projects,security_admin,purge,view_metrics}', true, 0);
ALTER TABLE user_roles ADD CONSTRAINT user_roles_admin_is_the_account_flag CHECK (role <> 'admin');

-- 3. Every project role reads (holding any role already let people read the project).
UPDATE roles SET permissions = array_prepend('read', permissions) WHERE kind = 'project' AND NOT ('read' = ANY (permissions));

-- 4. Project permissions come only from project roles (same columns, so CREATE OR REPLACE works).
CREATE OR REPLACE VIEW scope_permissions AS
  SELECT DISTINCT r.scope_id, r.user_id, p.permission
    FROM scope_roles r JOIN roles ro ON ro.key = r.role AND ro.kind = 'project'
    CROSS JOIN LATERAL unnest(ro.permissions) AS p (permission);

-- 5. Grants must use a role of the right kind (the app checks first; this catches any path that doesn't).
CREATE FUNCTION role_has_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role AND kind = TG_ARGV[0]) THEN
    RAISE EXCEPTION 'role % can''t be given here: only % roles can', NEW.role, TG_ARGV[0] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scope_members_role_kind BEFORE INSERT OR UPDATE OF role ON scope_members FOR EACH ROW EXECUTE FUNCTION role_has_kind('project');
CREATE TRIGGER scope_team_roles_role_kind BEFORE INSERT OR UPDATE OF role ON scope_team_roles FOR EACH ROW EXECUTE FUNCTION role_has_kind('project');
CREATE TRIGGER user_roles_role_kind BEFORE INSERT OR UPDATE OF role ON user_roles FOR EACH ROW EXECUTE FUNCTION role_has_kind('org');

-- 6. Invitations into a project can carry several roles (scope_role stays: the first of them, for older readers).
ALTER TABLE invitations ADD COLUMN scope_roles text[] NOT NULL DEFAULT '{}';
UPDATE invitations SET scope_roles = ARRAY[scope_role] WHERE scope_role IS NOT NULL;

-- 7. Wording.
UPDATE roles SET description = 'Approves and adds people, disables accounts and gives organisation roles.'
 WHERE key = 'user_manager' AND description = 'Approves new people, adds, disables and assigns org roles.';
UPDATE roles SET description = 'Creates teams and chooses their members and leads (for a team with project roles, only if they hold those roles too).'
 WHERE key = 'team_manager' AND description = 'Creates teams and manages any team''s members.';
