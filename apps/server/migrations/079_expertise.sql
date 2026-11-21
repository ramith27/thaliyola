-- Who knows what. Rebuilt nightly from what people did: versions they wrote or approved, proposals they reviewed or
-- commented on, questions they (or their sessions) answered, documentation runs they started, articles they own.
-- Each signal decays with a 180-day half-life and counts toward the item's project, repositories, entities and tags.
-- scope_id keeps where the evidence came from, so callers only see expertise from projects they can read.

CREATE TABLE expertise (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope_id   uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  topic_kind text NOT NULL CHECK (topic_kind IN ('project', 'component', 'entity', 'tag')),
  topic      text NOT NULL,
  label      text NOT NULL,
  score      real NOT NULL,
  evidence   jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope_id, topic_kind, topic)
);
CREATE INDEX expertise_topic ON expertise (topic_kind, topic, score DESC);
CREATE INDEX expertise_label ON expertise (lower(label));

-- Slack: a person's Slack user (found by verified email, cached), and where a question asked from Slack is answered.
ALTER TABLE users ADD COLUMN slack_user_id text UNIQUE;
ALTER TABLE session_questions ADD COLUMN reply_slack jsonb;
