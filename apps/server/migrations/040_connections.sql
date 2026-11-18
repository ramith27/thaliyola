-- Connections: a project's databases, APIs, git hosts and notification targets (Slack, Trello).
-- Secrets are sealed with AES-256-GCM (core/secrets.ts, CONNECTIONS_KEY) and never leave the server.

CREATE TABLE connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id         uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  -- Optional: the repository this connection belongs to (a git host token, or the service that provides an API).
  component_id     uuid REFERENCES components (id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('mysql', 'redshift', 'postgres', 'clickhouse', 'snowflake', 'bigquery', 'git', 'http_api', 'slack', 'trello')),
  name             text NOT NULL,
  -- Non-secret fields only (host, port, database, user, base URL, channel…).
  config           jsonb NOT NULL DEFAULT '{}',
  -- "v1$iv$tag$ciphertext": the secret fields as sealed JSON. Never selected into API responses.
  secret           text,
  -- The last characters of each long secret field ({"password": "x9Qa"}), so people can tell which one is stored.
  secret_hints     jsonb NOT NULL DEFAULT '{}',
  -- allow_query, allow_write_methods, path_prefixes, schemas_include, schemas_exclude, max_objects.
  options          jsonb NOT NULL DEFAULT '{}',
  interval_minutes integer NOT NULL DEFAULT 360 CHECK (interval_minutes BETWEEN 15 AND 10080),
  enabled          boolean NOT NULL DEFAULT true,
  state            jsonb NOT NULL DEFAULT '{}',
  -- NULL: never scheduled (Slack and Trello are delivery targets; their health comes from deliveries and tests).
  next_run_at      timestamptz DEFAULT now(),
  last_run_at      timestamptz,
  last_ok_at       timestamptz,
  last_error       text,
  failures         integer NOT NULL DEFAULT 0,
  health           text NOT NULL DEFAULT 'untested' CHECK (health IN ('untested', 'ok', 'failing')),
  created_by       uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connections_scope_name ON connections (scope_id, lower(name));
CREATE INDEX connections_due ON connections (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

-- What a sync found: tables and views (key db.schema.table) and API endpoints (key "GET /path").
CREATE TABLE connection_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('table', 'view', 'endpoint')),
  key           text NOT NULL,
  -- Columns (name, type, nullable, default, pk, fk, comment), row estimate, endpoint parameters and responses.
  definition    jsonb NOT NULL DEFAULT '{}',
  hash          text NOT NULL DEFAULT '',
  article_id    uuid REFERENCES articles (id) ON DELETE SET NULL,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  UNIQUE (connection_id, key)
);

-- Schema history: one row per difference a sync noticed.
CREATE TABLE connection_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  object_key    text NOT NULL,
  change        text NOT NULL CHECK (change IN ('added', 'removed', 'column_added', 'column_removed', 'type_changed')),
  detail        jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_changes_recent ON connection_changes (connection_id, at DESC);

-- The data dictionary: what a column means, and whether it holds personal data (masked in query results).
CREATE TABLE column_notes (
  object_id   uuid NOT NULL REFERENCES connection_objects (id) ON DELETE CASCADE,
  "column"    text NOT NULL,
  description text NOT NULL DEFAULT '',
  pii         boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_id, "column")
);

-- Audit log of read-only queries and API calls made through a connection.
CREATE TABLE connection_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  actor_id      uuid REFERENCES users (id),
  kind          text NOT NULL CHECK (kind IN ('query', 'call')),
  -- Redacted SQL, or "METHOD /path".
  text          text NOT NULL,
  rows          integer,
  status        integer,
  ms            integer,
  error         text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_calls_recent ON connection_calls (connection_id, at DESC);
CREATE INDEX connection_calls_actor ON connection_calls (actor_id, at DESC);

-- Where notifications also go: a Slack or Trello connection, for some kinds, team-wide (scope_id NULL) or for one project.
CREATE TABLE notification_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id      uuid REFERENCES scopes (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  kinds         text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_routes_scope ON notification_routes (scope_id);

-- Constraint changes. Other migrations may have added values to these lists, so each list is read from the
-- current constraint and extended rather than restated (the drop-and-add of 017_trash.sql, without losing values).
CREATE FUNCTION pg_temp.extend_check(tbl regclass, con text, col text, extra text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = tbl AND conname = con;
  -- Never rebuild a list from nothing: that would quietly drop every value it allowed.
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint % on % not found; it must exist before 040 extends it', con, tbl;
  END IF;
  -- Quoted values, whether the constraint reads ARRAY['a'::text, ...] or '{a,b}'::text[].
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || extra) AS v WHERE v <> '' ORDER BY v);
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', tbl, con);
  -- Written as IN (...) so the next migration that extends a list reads it the same way.
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', tbl, con, col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;

-- connection: a connection stopped working (or works again), a synced schema changed. access: access requests.
SELECT pg_temp.extend_check('notifications', 'notifications_kind_check', 'kind', ARRAY['connection', 'access']);
-- Lineage: a component reads or writes a table.
SELECT pg_temp.extend_check('relations', 'relations_kind_check', 'kind', ARRAY['reads', 'writes']);
