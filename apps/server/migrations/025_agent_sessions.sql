-- Agent sessions ask each other: a Claude session (or any MCP client) registers under a handle,
-- other sessions — the same person's or teammates', on any machine — send it questions, and the
-- answer comes back to the asker. Sessions pull (listener mode, a Stop hook, or a person on the web);
-- the server only stores and wakes waiters.

CREATE TABLE agent_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  handle            text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'),
  client            text NOT NULL DEFAULT 'mcp',
  client_session_id text,
  scope_id          uuid REFERENCES scopes (id) ON DELETE SET NULL,
  component         text,
  repo_url          text,
  description       text NOT NULL DEFAULT '',
  visibility        text NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'private')),
  listening         boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);
CREATE INDEX agent_sessions_user ON agent_sessions (user_id, last_seen_at DESC);
CREATE INDEX agent_sessions_scope ON agent_sessions (scope_id, last_seen_at DESC);
CREATE UNIQUE INDEX agent_sessions_client ON agent_sessions (user_id, client, client_session_id) WHERE client_session_id IS NOT NULL;

CREATE TABLE session_questions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_session_id        uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
  from_user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_session_id          uuid REFERENCES agent_sessions (id) ON DELETE CASCADE,
  to_user_id             uuid REFERENCES users (id) ON DELETE CASCADE,
  to_scope_id            uuid REFERENCES scopes (id) ON DELETE CASCADE,
  to_component           text,
  question               text NOT NULL,
  context                text NOT NULL DEFAULT '',
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'answered', 'declined', 'expired', 'cancelled')),
  claimed_by_session_id  uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
  claimed_until          timestamptz,
  answer                 text,
  answered_by_session_id uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
  answered_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  answered_at            timestamptz,
  delivered_at           timestamptz,
  expires_at             timestamptz NOT NULL,
  saved_item_id          uuid,
  notified_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (to_session_id IS NOT NULL OR to_user_id IS NOT NULL OR to_scope_id IS NOT NULL)
);
CREATE INDEX session_questions_to_session ON session_questions (to_session_id, created_at) WHERE status IN ('pending', 'claimed');
CREATE INDEX session_questions_to_user ON session_questions (to_user_id, created_at) WHERE status IN ('pending', 'claimed');
CREATE INDEX session_questions_to_scope ON session_questions (to_scope_id, created_at) WHERE status IN ('pending', 'claimed');
CREATE INDEX session_questions_from ON session_questions (from_session_id, created_at DESC);
CREATE INDEX session_questions_from_user ON session_questions (from_user_id, created_at DESC);

-- Questions waiting for someone get a notification kind of their own.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('review', 'decided', 'change', 'watch', 'stale', 'comment', 'assigned', 'invite', 'security', 'question'));
