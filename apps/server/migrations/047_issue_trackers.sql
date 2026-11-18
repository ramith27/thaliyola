-- Issue trackers: Jira (Cloud) and Linear connections. A finding or article can open an issue in one, or link an
-- existing one; the issue's link is stored as a source link (system jira or linear) and its status is cached here,
-- refreshed by the connections job and when the item is viewed.

-- The lists are read from the current constraint and extended (see 040_connections.sql).
CREATE OR REPLACE FUNCTION pg_temp.extend_check_047(tbl regclass, con text, col text, extra text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = con;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % on % not found; it must exist before 047 extends it', con, tbl;
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || extra) AS v WHERE v <> '' ORDER BY v);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', tbl, con);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', tbl, con, col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;

SELECT pg_temp.extend_check_047('connections', 'connections_kind_check', 'kind', ARRAY['jira', 'linear']);
SELECT pg_temp.extend_check_047('source_links', 'source_links_system_check', 'system', ARRAY['jira', 'linear']);
-- ticket: an issue created through a tracker connection (audited like queries and calls).
SELECT pg_temp.extend_check_047('connection_calls', 'connection_calls_kind_check', 'kind', ARRAY['ticket']);

-- A linked issue: which tracker and connection it's read through (none: no connection reaches that site, so its
-- status isn't known), its key, and what the tracker last said about it.
CREATE TABLE tickets (
  source_link_id uuid PRIMARY KEY REFERENCES source_links (id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES connections (id) ON DELETE SET NULL,
  tracker        text NOT NULL CHECK (tracker IN ('jira', 'linear')),
  key            text NOT NULL,
  title          text,
  status         text,
  category       text NOT NULL DEFAULT 'unknown' CHECK (category IN ('todo', 'in_progress', 'done', 'canceled', 'unknown')),
  checked_at     timestamptz,
  -- Why the last check failed (redacted, no secrets); cleared by the next good one.
  error          text,
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- The job's queue: tickets it can check, oldest check first.
CREATE INDEX tickets_due ON tickets (checked_at NULLS FIRST) WHERE connection_id IS NOT NULL;
CREATE INDEX tickets_connection ON tickets (connection_id);
