ALTER TABLE assets ADD COLUMN filename text NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN deleted_at timestamptz;
CREATE INDEX assets_target ON assets (target_id) WHERE deleted_at IS NULL;
