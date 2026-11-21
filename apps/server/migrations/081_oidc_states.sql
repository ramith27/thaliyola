-- Sign-in with an OpenID Connect provider (Google, Okta, Microsoft Entra…): the state, nonce and PKCE verifier of a
-- sign-in in progress, kept for ten minutes (in the database, so any replica can finish it). Used once.
CREATE TABLE oidc_states (
  state       text PRIMARY KEY,
  provider    text NOT NULL,
  nonce       text NOT NULL,
  verifier    text NOT NULL,
  return_to   text NOT NULL DEFAULT '/',
  expires_at  timestamptz NOT NULL
);
