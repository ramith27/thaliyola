-- People who arrive on their own (Cloudflare Access, dev tokens) wait for an admin to approve them.
-- Accounts that already exist, and accounts admins create, are approved.
ALTER TABLE users
  ADD COLUMN approved_at timestamptz DEFAULT now(),
  ADD COLUMN approved_by uuid REFERENCES users (id);
