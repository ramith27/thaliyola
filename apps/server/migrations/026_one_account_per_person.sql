-- One account per person. Someone with a built-in account who signs in through Cloudflare Access (or a dev token)
-- now uses that account; merge the second accounts created that way into the original, keeping the original's
-- name, rights, memberships and history. Also: when each account was last used, whatever the sign-in.
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

DO $$
DECLARE
  pair record;
  fk record;
  r record;
BEGIN
  FOR pair IN
    SELECT dup.id AS dup_id, keep.id AS keep_id, dup.is_admin AS dup_admin, dup.approved_at AS dup_approved
      FROM users dup JOIN users keep ON keep.subject = 'local:' || lower(dup.email)
     WHERE dup.email IS NOT NULL AND dup.subject NOT LIKE 'local:%' AND dup.subject NOT LIKE 'pending:%'
  LOOP
    FOR fk IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1
    LOOP
      BEGIN
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING pair.keep_id, pair.dup_id;
      EXCEPTION WHEN unique_violation THEN
        -- Both accounts had the same membership, watch or favourite: move what's new, keep the original's for the rest.
        FOR r IN EXECUTE format('SELECT ctid FROM %s WHERE %I = $1', fk.tbl, fk.col) USING pair.dup_id LOOP
          BEGIN
            EXECUTE format('UPDATE %s SET %I = $1 WHERE ctid = $2', fk.tbl, fk.col) USING pair.keep_id, r.ctid;
          EXCEPTION WHEN unique_violation THEN
            EXECUTE format('DELETE FROM %s WHERE ctid = $1', fk.tbl) USING r.ctid;
          END;
        END LOOP;
      END;
    END LOOP;
    UPDATE users SET is_admin = is_admin OR pair.dup_admin, approved_at = coalesce(approved_at, pair.dup_approved) WHERE id = pair.keep_id;
    DELETE FROM users WHERE id = pair.dup_id;
  END LOOP;
END $$;
