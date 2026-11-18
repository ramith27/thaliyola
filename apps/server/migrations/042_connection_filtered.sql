-- Connections, databases: tables a schema filter leaves out are kept (marked, not deleted), so their data dictionary
-- notes, personal-data flags included, and their articles come back with them.
ALTER TABLE connection_objects ADD COLUMN filtered_at timestamptz;
