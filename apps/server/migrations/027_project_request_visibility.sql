-- Who can read a requested project once it is approved (NULL: the server's DEFAULT_PROJECT_VISIBILITY).
ALTER TABLE project_requests ADD COLUMN visibility text CHECK (visibility IN ('team', 'members'));
