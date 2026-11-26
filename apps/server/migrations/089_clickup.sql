-- ClickUp: a tracker connection (tasks opened from findings and articles, linked tasks' status) and a source
-- (closed tasks with their comments).
CREATE OR REPLACE FUNCTION pg_temp.extend_check_089(tbl regclass, con text, col text, extra text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = con;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % on % not found; it must exist before 089 extends it', con, tbl;
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || extra) AS v WHERE v <> '' ORDER BY v);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', tbl, con);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', tbl, con, col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;

SELECT pg_temp.extend_check_089('connections', 'connections_kind_check', 'kind', ARRAY['clickup']);
SELECT pg_temp.extend_check_089('source_links', 'source_links_system_check', 'system', ARRAY['clickup']);
SELECT pg_temp.extend_check_089('sources', 'sources_kind_check', 'kind', ARRAY['clickup']);
ALTER TABLE tickets DROP CONSTRAINT tickets_tracker_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_tracker_check CHECK (tracker IN ('jira', 'linear', 'clickup'));

DROP INDEX source_links_one_issue;
CREATE UNIQUE INDEX source_links_one_issue ON source_links (target_id, url) WHERE system IN ('jira', 'linear', 'clickup');
