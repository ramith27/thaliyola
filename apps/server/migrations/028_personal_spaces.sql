-- Personal spaces: one per person for their own notes and context, readable and writable by that person only
-- (admins included), searched from every project. A free-form "note" article type for them (and anywhere else).
ALTER TABLE scopes DROP CONSTRAINT scopes_kind_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_kind_check CHECK (kind IN ('team', 'project', 'library', 'personal'));
ALTER TABLE scopes ADD COLUMN owner_id uuid REFERENCES users (id);
CREATE UNIQUE INDEX scopes_one_personal_space_each ON scopes (owner_id) WHERE kind = 'personal';
ALTER TABLE scopes DROP CONSTRAINT scopes_shared_are_team_visible;
ALTER TABLE scopes ADD CONSTRAINT scopes_shared_are_team_visible CHECK (kind IN ('project', 'personal') OR visibility = 'team');
ALTER TABLE scopes ADD CONSTRAINT scopes_personal_are_private CHECK (kind <> 'personal' OR (visibility = 'members' AND owner_id IS NOT NULL));

ALTER TABLE articles DROP CONSTRAINT articles_type_check;
ALTER TABLE articles ADD CONSTRAINT articles_type_check CHECK (type IN (
  'system', 'table', 'metric', 'runbook', 'decision',
  'project_overview', 'design_doc', 'tech_spec', 'api_contract', 'pattern',
  'design_tokens', 'ui_component', 'ux_pattern', 'screen_spec', 'note'));
