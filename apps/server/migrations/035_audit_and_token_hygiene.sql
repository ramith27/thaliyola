-- Audit log and token hygiene.

-- 1. The audit log says more: details of what changed (never secrets), what kind of thing the target is and its name
--    when the event was recorded (older rows get theirs when they're read), and which request wrote the row, so the
--    web or MCP call that wraps a change isn't listed next to the change itself. `via` is set on those wrapper rows.
ALTER TABLE audit_log
  ADD COLUMN details      jsonb,
  ADD COLUMN target_kind  text,
  ADD COLUMN target_label text,
  ADD COLUMN request_id   uuid,
  ADD COLUMN via          text CHECK (via IN ('api', 'mcp'));
CREATE INDEX audit_log_actor ON audit_log (actor_id, id DESC);
CREATE INDEX audit_log_target ON audit_log (target_id, id DESC) WHERE target_id IS NOT NULL;
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_request ON audit_log (request_id) WHERE request_id IS NOT NULL;

--    What the Audit log page filters by, stored so the filters use an index: `action` is the tool without "api:" or a
--    ":detail" suffix, and `is_read` marks page views, searches and lists (left out unless asked for). Both are
--    computed from `tool`, for new rows and old ones alike. audit_action_is_read() mirrors isReadAction() in
--    src/core/audit-log.ts (a test checks they agree); after changing it, `UPDATE audit_log SET tool = tool` recomputes.
CREATE FUNCTION audit_action_is_read(action text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT action <> ALL (ARRAY['get_asset'])
     AND (action = ANY (ARRAY['me', 'my_access', 'person_access', 'connect_info', 'insights', 'graph', 'ask', 'search', 'browse',
                              'success_metrics', 'knowledge_gaps', 'security_overview', 'project_technologies', 'task_summary',
                              'docs_status', 'agents_md', 'claims', 'onboarding', 'project_pages', 'project_context',
                              'needs_attention', 'role_holders', 'resolve_repo', 'docs_next_page', 'docs_inspect_claims',
                              'add_favourite', 'remove_favourite', 'audit'])
          OR action ~ '^(get|list|search|browse|find|latest|preview|detect)_')
$$;
ALTER TABLE audit_log
  ADD COLUMN action  text GENERATED ALWAYS AS (regexp_replace(regexp_replace(tool, '^api:', ''), ':.*$', '')) STORED,
  ADD COLUMN is_read boolean GENERATED ALWAYS AS (audit_action_is_read(regexp_replace(regexp_replace(tool, '^api:', ''), ':.*$', ''))) STORED;
CREATE INDEX audit_log_action ON audit_log (action, id DESC);
CREATE INDEX audit_log_changes ON audit_log (id DESC) WHERE NOT is_read;

-- 2. API tokens: rotation (the old token points at its replacement and stops at the end of its grace period), and
--    the one expiry notice each token gets a week before it expires.
ALTER TABLE api_tokens
  ADD COLUMN rotated_at         timestamptz,
  ADD COLUMN replaced_by        uuid REFERENCES api_tokens (id),
  ADD COLUMN expiry_notified_at timestamptz;
CREATE INDEX api_tokens_expiring ON api_tokens (expires_at) WHERE revoked_at IS NULL AND rotated_at IS NULL AND expiry_notified_at IS NULL;

-- 3. A notification kind for tokens about to expire. The list is read from the current constraint and extended, not
--    restated: Connections (040) adds kinds of its own, and a database that applied it first must keep them.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'notifications'::regclass AND conname = 'notifications_kind_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'constraint notifications_kind_check not found; it must exist before 035 extends it';
  END IF;
  SELECT array_agg(btrim(x)) INTO vals
    FROM regexp_matches(def, '''([^'']+)''', 'g') AS m, unnest(string_to_array(btrim(m[1], '{}'), ',')) AS x;
  vals := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(vals, '{}') || ARRAY['token']) AS v WHERE v <> '' ORDER BY v);
  ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
  EXECUTE format('ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
END $$;
