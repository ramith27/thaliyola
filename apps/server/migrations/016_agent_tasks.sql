-- Agents can propose moving an item into a project, folder or repository.
ALTER TABLE revisions DROP CONSTRAINT revisions_op_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_op_check CHECK (op IN ('create', 'update', 'promote', 'share', 'verify', 'move'));

-- Curation tasks handed to connected agents (the server finds the work, the client's model does it).
-- Tasks themselves are computed on the fly; this records who is on one and how it ended.
CREATE TABLE agent_tasks (
  key           text PRIMARY KEY,             -- e.g. "file_into_project:<item id>"
  kind          text NOT NULL,
  claimed_by    uuid REFERENCES users (id),
  claimed_until timestamptz,
  completed_at  timestamptz,
  completed_by  uuid REFERENCES users (id),
  outcome       text CHECK (outcome IN ('done', 'skipped', 'not_applicable')),
  note          text,
  revision_id   uuid
);
CREATE INDEX agent_tasks_completed ON agent_tasks (completed_at);
