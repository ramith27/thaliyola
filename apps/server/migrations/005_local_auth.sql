-- Built-in accounts (AUTH_MODE=local), browser sessions and personal API tokens.
ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_at timestamptz;

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,             -- first characters, to recognise a token in lists
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);
