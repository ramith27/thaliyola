-- Security reviews run by agents (Claude Code and others): what was checked, with which tools, and what was found.
-- Dependency uploads are recorded here too, so each repository shows when it was last scanned and reviewed.
CREATE TABLE security_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id   uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component  text NOT NULL DEFAULT '',
  kind       text NOT NULL CHECK (kind IN ('dependencies', 'code')),
  head_sha   text,
  summary    text NOT NULL DEFAULT '',
  areas      text[] NOT NULL DEFAULT '{}',
  tools      text[] NOT NULL DEFAULT '{}',
  counts     jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_reviews_scope ON security_reviews (scope_id, component, created_at DESC);

ALTER TABLE vulnerabilities ADD COLUMN review_id uuid REFERENCES security_reviews (id) ON DELETE SET NULL;
