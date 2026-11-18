-- Connections, APIs and git: a pasted OpenAPI spec, endpoint changes, repository facts from a project's git token,
-- and repository file reads in the audit log.

-- An OpenAPI (Swagger) spec pasted instead of a spec URL: JSON or YAML, at most 3 MB. Not a secret, but only the
-- project's admins see it; agents see the endpoints it describes.
ALTER TABLE connections ADD COLUMN spec text CHECK (spec IS NULL OR octet_length(spec) <= 3145728);

-- What a project's git connection last read about a repository: default branch, last commit, languages, open pull
-- (merge) requests.
ALTER TABLE components ADD COLUMN repo_info jsonb, ADD COLUMN repo_synced_at timestamptz;

-- The lists are read from the current constraint and extended (see 040_connections.sql).
CREATE OR REPLACE FUNCTION pg_temp.extend_check_043(tbl regclass, con text, col text, extra text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = con;
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % on % not found; it must exist before 043 extends it', con, tbl;
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || extra) AS v WHERE v <> '' ORDER BY v);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', tbl, con);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', tbl, con, col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;

-- changed: an API endpoint's parameters, request body or responses changed.
SELECT pg_temp.extend_check_043('connection_changes', 'connection_changes_change_check', 'change', ARRAY['changed']);
-- read: a repository file or folder read through a git connection.
SELECT pg_temp.extend_check_043('connection_calls', 'connection_calls_kind_check', 'kind', ARRAY['read']);

CREATE INDEX connection_objects_endpoints ON connection_objects (connection_id) WHERE kind = 'endpoint';
