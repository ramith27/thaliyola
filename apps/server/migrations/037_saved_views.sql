-- Saved views: a person's named filter sets on a list page (Review, Inbox, Security, Admin › Projects).
-- Private to their owner; at most one default per page, opened when that page has no filters in its link.
CREATE TABLE saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area        text NOT NULL CHECK (area IN ('review', 'inbox', 'security', 'projects')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_views_name ON saved_views (user_id, area, lower(name));
CREATE UNIQUE INDEX saved_views_one_default ON saved_views (user_id, area) WHERE is_default;
