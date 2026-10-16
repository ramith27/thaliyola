-- Items and scopes a person pinned to their sidebar.
CREATE TABLE favourites (
  user_id     uuid NOT NULL REFERENCES users (id),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding', 'scope')),
  target_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id)
);
CREATE INDEX entities_name_lower ON entities (lower(name) text_pattern_ops);
