-- In-app notifications, watches, per-user preferences and single-use action links (email approve).
ALTER TABLE users ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}';

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  kind       text NOT NULL CHECK (kind IN ('review', 'decided', 'change', 'watch', 'stale', 'comment', 'assigned', 'invite')),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text NOT NULL DEFAULT '',
  target_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE watches (
  user_id     uuid NOT NULL REFERENCES users (id),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding', 'scope')),
  target_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id)
);
CREATE INDEX watches_target ON watches (target_id);

CREATE TABLE action_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  action      text NOT NULL CHECK (action IN ('approve')),
  revision_id uuid NOT NULL REFERENCES revisions (id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
ALTER TABLE revisions ADD COLUMN assignee_id uuid REFERENCES users (id);
