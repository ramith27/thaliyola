-- Deleting puts things in the trash: hidden everywhere, restorable, and permanently removable by admins.
ALTER TABLE articles DROP CONSTRAINT articles_status_check;
ALTER TABLE articles ADD CONSTRAINT articles_status_check CHECK (status IN ('draft', 'published', 'possibly_stale', 'superseded', 'rejected', 'deleted'));
ALTER TABLE findings DROP CONSTRAINT findings_status_check;
ALTER TABLE findings ADD CONSTRAINT findings_status_check CHECK (status IN ('draft', 'published', 'possibly_stale', 'superseded', 'rejected', 'deleted'));
ALTER TABLE scopes DROP CONSTRAINT scopes_status_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_status_check CHECK (status IN ('active', 'archived', 'deleted'));

ALTER TABLE articles ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id), ADD COLUMN status_before_delete text;
ALTER TABLE findings ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id), ADD COLUMN status_before_delete text;
ALTER TABLE scopes ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users (id);
