-- Connections, databases: lookups the Data view, schema history and table articles need.
CREATE INDEX connection_objects_article ON connection_objects (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX connection_changes_object ON connection_changes (connection_id, object_key, at DESC);
CREATE INDEX column_notes_pii ON column_notes (object_id) WHERE pii;
