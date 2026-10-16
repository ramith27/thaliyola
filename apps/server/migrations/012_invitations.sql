-- Email invitations to join (local sign-in): the invitee sets their own password from the link.
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  name        text,
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users (id),
  scope_id    uuid REFERENCES scopes (id),
  scope_role  text CHECK (scope_role IN ('reader', 'writer', 'owner')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX invitations_email ON invitations (lower(email));
