-- Connections (040-047) and the audit log (035) were built side by side. Connections' read-only web calls are page
-- views on the Audit log page too: what can be connected, a connection's recent changes and calls, a project's data.
-- audit_action_is_read() mirrors isReadAction() in src/core/audit-log.ts (a test checks they agree).
CREATE OR REPLACE FUNCTION audit_action_is_read(action text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT action <> ALL (ARRAY['get_asset'])
     AND (action = ANY (ARRAY['me', 'my_access', 'person_access', 'connect_info', 'insights', 'graph', 'ask', 'search', 'browse',
                              'success_metrics', 'knowledge_gaps', 'security_overview', 'project_technologies', 'task_summary',
                              'docs_status', 'agents_md', 'claims', 'onboarding', 'project_pages', 'project_context',
                              'needs_attention', 'role_holders', 'resolve_repo', 'docs_next_page', 'docs_inspect_claims',
                              'add_favourite', 'remove_favourite', 'audit',
                              'connection_kinds', 'connection_changes', 'connection_calls', 'project_data'])
          OR action ~ '^(get|list|search|browse|find|latest|preview|detect)_')
$$;

-- Rows already written for those calls get the new flag (the stored column is recomputed when the row is updated).
UPDATE audit_log SET tool = tool WHERE action IN ('connection_kinds', 'connection_changes', 'connection_calls', 'project_data');
