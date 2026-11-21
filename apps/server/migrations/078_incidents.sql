-- Incidents: something is broken in a project right now. A person or agent declares one (or a Sentry alert, or Slack),
-- everyone in the project hears about it, and a timeline fills itself while it's open: notes, status changes, Sentry
-- events for its issues, pull requests merged in the project, sessions' questions and answers. Resolving it drafts a
-- root-cause finding for review from that timeline.

CREATE TABLE incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id       uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  severity       text NOT NULL DEFAULT 'sev3' CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'resolved')),
  commander_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  declared_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  declared_via   text NOT NULL DEFAULT 'web' CHECK (declared_via IN ('web', 'mcp', 'sentry', 'slack')),
  summary        text NOT NULL DEFAULT '',
  -- Sentry issue ids and alert rule keys that belong to this incident (a later alert for one joins it).
  sentry_keys    text[] NOT NULL DEFAULT '{}',
  started_at     timestamptz NOT NULL DEFAULT now(),
  mitigated_at   timestamptz,
  resolved_at    timestamptz,
  rca_finding_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_open ON incidents (scope_id) WHERE status <> 'resolved';
CREATE INDEX incidents_recent ON incidents (started_at DESC);

CREATE TABLE incident_events (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('declared', 'note', 'status', 'severity', 'commander', 'sentry', 'pr', 'question', 'answer', 'link')),
  actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  text        text NOT NULL DEFAULT '',
  url         text,
  -- What the event came from (a Sentry event, a PR, a question), so each is added once.
  ref         text,
  UNIQUE (incident_id, kind, ref)
);
CREATE INDEX incident_events_incident ON incident_events (incident_id, at);

-- Incidents get a notification kind of their own. Extended, not restated, exactly like 071.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'notifications'::regclass AND conname = 'notifications_kind_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint notifications_kind_check not found; it must exist before 078 extends it';
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || ARRAY['incident']) AS v WHERE v <> '' ORDER BY v);
  ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
  EXECUTE format('ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;
