-- Health: every background job (and the backup scripts) records how its last run went, so Admin › System › Health
-- can show it and admins hear about failures. job_runs (021) only had the last run time.
ALTER TABLE job_runs
  ADD COLUMN status text CHECK (status IN ('ok', 'failed', 'running')),
  ADD COLUMN last_success timestamptz,
  ADD COLUMN last_error text,
  ADD COLUMN duration_ms integer,
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN alerted_at timestamptz;

-- Health alerts (backups stopped, a restore check failed, a job keeps failing) get a notification kind of their own.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'notifications'::regclass AND conname = 'notifications_kind_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint notifications_kind_check not found; it must exist before 082 extends it';
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || ARRAY['system']) AS v WHERE v <> '' ORDER BY v);
  ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
  EXECUTE format('ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;
