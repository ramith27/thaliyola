-- OAuth 2.1 authorization server for local mode (MCP clients such as claude.ai connectors).
CREATE TABLE oauth_clients (
  client_id  text PRIMARY KEY,
  info       jsonb NOT NULL,              -- RFC 7591 client metadata as registered
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Authorization requests waiting for the person to sign in and consent.
CREATE TABLE oauth_requests (
  id_hash    text PRIMARY KEY,
  client_id  text NOT NULL REFERENCES oauth_clients (client_id),
  params     jsonb NOT NULL,              -- redirect_uri, code_challenge, state, scopes, resource
  expires_at timestamptz NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients (client_id),
  user_id        uuid NOT NULL REFERENCES users (id),
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  resource       text,
  family         uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id  text NOT NULL REFERENCES oauth_clients (client_id),
  user_id    uuid NOT NULL REFERENCES users (id),
  scopes     text[] NOT NULL DEFAULT '{}',
  resource   text,
  family     uuid NOT NULL,               -- all tokens descending from one authorization code
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_tokens_family ON oauth_tokens (family);
CREATE INDEX oauth_tokens_user ON oauth_tokens (user_id);
