-- Team leads manage their team's members and can create projects for the team.
ALTER TABLE team_members ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'lead'));
