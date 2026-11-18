-- Digests that didn't go out: the slot is tried again on the next ticks, a few times (digest_failures counts the
-- tries for the current slot; it's back to 0 once one is posted, found empty, or given up on).
ALTER TABLE notification_routes ADD COLUMN digest_failures int NOT NULL DEFAULT 0;

-- Access requests used to be "review" notifications and now have their own kind ("access"). People who had turned
-- off review emails keep not getting them: their access email preference starts the same.
UPDATE users
   SET prefs = jsonb_set(prefs, '{email,access}', 'false'::jsonb)
 WHERE jsonb_typeof(prefs->'email') = 'object'
   AND prefs->'email'->'review' = 'false'::jsonb
   AND NOT (prefs->'email' ? 'access');
