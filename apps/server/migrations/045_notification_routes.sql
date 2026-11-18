-- Notification routes (created in 040): a Slack or Trello connection that gets some kinds of notifications, team-wide
-- (scope_id NULL) or for one project, and optionally a daily or weekly digest of a project (Slack only).

ALTER TABLE notification_routes
  ADD COLUMN digest         text NOT NULL DEFAULT 'off' CHECK (digest IN ('off', 'daily', 'weekly')),
  -- When the last digest went out (or the route was set up): the next one waits for the next slot after it.
  ADD COLUMN digest_sent_at timestamptz,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- One route per destination and place (the team, or a project): its kinds say what goes there.
CREATE UNIQUE INDEX notification_routes_one_per_destination
  ON notification_routes (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), connection_id);
CREATE INDEX notification_routes_digests ON notification_routes (digest_sent_at) WHERE digest <> 'off';
