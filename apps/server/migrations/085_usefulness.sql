-- Usefulness: how often each article and finding is actually read (in the app, over MCP, or quoted by
-- answer_sources), and what people and their agents said about it. Search ranks used, helpful items a little higher
-- and items reported outdated lower; Review › Suggestions lists what nobody reads any more.
CREATE TABLE item_usage (
  item_kind text NOT NULL CHECK (item_kind IN ('article', 'finding')),
  item_id   uuid NOT NULL,
  day       date NOT NULL DEFAULT current_date,
  reads     integer NOT NULL DEFAULT 0,
  quoted    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, day)
);
CREATE INDEX item_usage_day ON item_usage (day);

CREATE TABLE item_feedback (
  item_kind  text NOT NULL CHECK (item_kind IN ('article', 'finding')),
  item_id    uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verdict    text NOT NULL CHECK (verdict IN ('helpful', 'outdated', 'wrong')),
  note       text CHECK (length(note) <= 1000),
  via_agent  boolean NOT NULL DEFAULT false,
  item_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX item_feedback_item ON item_feedback (item_id, verdict);
