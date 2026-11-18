-- Skills for Claude, review fixes.
--
-- 1. A collection's name, description and connectors (from a plugin's plugin.json and .mcp.json) are reviewed like
--    skill content: an import that changes them leaves the published values in place and records the proposal here
--    until someone with Review skills approves or declines it (Review › Skills). A declined proposal isn't offered
--    again until the source changes it once more.
ALTER TABLE skill_collections
  ADD COLUMN pending_meta           jsonb,                         -- {name, description, connectors}
  ADD COLUMN pending_meta_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN pending_meta_import_id uuid REFERENCES skill_imports (id) ON DELETE SET NULL,
  ADD COLUMN pending_meta_at        timestamptz,
  ADD COLUMN declined_meta_hash     text;

CREATE INDEX skill_collections_pending_meta ON skill_collections (pending_meta_at) WHERE pending_meta IS NOT NULL;

-- 2. A version's content hash now covers which files are kept from Claude (no_deliver): "path\0sha256\n" per file,
--    with "\0nodeliver" before the newline for a file that isn't delivered, sorted by path. Versions whose files are
--    all delivered keep their hash; the others are recomputed here exactly as contentHash() in core/skills/types.ts.
UPDATE skill_versions v SET content_hash = h.hash
  FROM (
    SELECT f.version_id,
           encode(sha256(string_agg(
             convert_to(f.path, 'UTF8') || '\x00'::bytea || convert_to(f.sha256, 'UTF8')
               || CASE WHEN f.deliver THEN ''::bytea ELSE '\x006e6f64656c69766572'::bytea END || '\x0a'::bytea,
             ''::bytea ORDER BY f.path COLLATE "C")), 'hex') AS hash
      FROM skill_files f
     GROUP BY f.version_id
    HAVING bool_or(NOT f.deliver)
  ) h
 WHERE h.version_id = v.id;
