-- Settings admins change in the app (System settings page). Each overrides its environment variable until reset.
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
