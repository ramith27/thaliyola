-- One-line description of a proposed change, shown in the review queue and impact notices.
ALTER TABLE revisions ADD COLUMN summary text NOT NULL DEFAULT '';
-- Redactions applied on write, for reviewers: [{"kind": "email", "count": 2}]
ALTER TABLE revisions ADD COLUMN redactions jsonb NOT NULL DEFAULT '[]';
CREATE INDEX revisions_target ON revisions (target_id);
CREATE INDEX impact_notices_open ON impact_notices (component_id, scope_id) WHERE state = 'open';
