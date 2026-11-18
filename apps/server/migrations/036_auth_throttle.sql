-- Failed sign-in and invitation attempts, counted in the database so every replica shares one count and a
-- deploy (which restarts every replica) doesn't reset it. The key is an unsalted SHA-256 of what is counted (an email
-- and client address, or an address) rather than the values: hashed, not anonymous.
CREATE TABLE auth_throttle (
  key       text PRIMARY KEY,
  failures  integer NOT NULL,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX auth_throttle_reset ON auth_throttle (reset_at);
