-- Requests for new projects from people (and their agents) who can't create projects themselves.
CREATE TABLE project_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  repos         jsonb NOT NULL DEFAULT '[]',
  reason        text NOT NULL DEFAULT '',
  requested_by  uuid NOT NULL REFERENCES users (id),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
  decided_by    uuid REFERENCES users (id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_requests_pending ON project_requests (created_at) WHERE state = 'pending';
