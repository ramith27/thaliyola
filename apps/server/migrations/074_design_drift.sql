-- Design drift: what the code actually uses compared with the recorded design system. A CI step (or an agent's
-- check-design run) sends the tokens it found in the code and any hard-coded colours; the server compares them
-- with the effective system and keeps the report, so the Design page and get_project_context can say
-- "the code drifted: 3 changed colours, 12 hard-coded colours".

CREATE TABLE design_drift_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  report      jsonb NOT NULL,
  differences int NOT NULL,
  source      text NOT NULL DEFAULT '',
  head_sha    text,
  checked_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX design_drift_reports_scope ON design_drift_reports (scope_id, checked_at DESC);
