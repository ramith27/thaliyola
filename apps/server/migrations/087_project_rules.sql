-- Rules for agents, enforced by the Claude Code plugin's edit hook: before an edit to a matching path,
-- read_first stops the first edit and says what to read; never_edit asks the person every time; heads_up tells
-- Claude something (who to talk to, what to keep in mind) without stopping it. What happened is recorded.
CREATE TABLE project_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component   text,
  kind        text NOT NULL CHECK (kind IN ('read_first', 'never_edit', 'heads_up')),
  paths       text[] NOT NULL CHECK (cardinality(paths) BETWEEN 1 AND 20),
  article_id  uuid REFERENCES articles (id) ON DELETE SET NULL,
  message     text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_rules_scope ON project_rules (scope_id) WHERE enabled;

CREATE TABLE rule_events (
  id         bigserial PRIMARY KEY,
  rule_id    uuid NOT NULL REFERENCES project_rules (id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
  user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  path       text NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('stopped', 'read', 'asked', 'told')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rule_events_rule ON rule_events (rule_id, created_at DESC);
CREATE INDEX rule_events_session ON rule_events (session_id, rule_id);
