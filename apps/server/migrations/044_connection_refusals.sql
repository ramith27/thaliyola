-- Connections: calls and reads refused before they were made (no Propose, calls turned off, a method, path or header
-- the connection doesn't allow) are logged too, as kind 'refused'. They don't count toward the per-minute budget.

-- The list is read from the current constraint and extended (see 040_connections.sql).
CREATE OR REPLACE FUNCTION pg_temp.extend_check_044(tbl regclass, con text, col text, extra text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = con;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % on % not found; it must exist before 044 extends it', con, tbl;
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || extra) AS v WHERE v <> '' ORDER BY v);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', tbl, con);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', tbl, con, col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;

SELECT pg_temp.extend_check_044('connection_calls', 'connection_calls_kind_check', 'kind', ARRAY['refused']);
