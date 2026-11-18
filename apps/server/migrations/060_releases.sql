-- Release notes and the feature catalog: versioned releases of Thaliyola, each with the features it added, improved
-- or fixed, written by Administrators and people with Manage releases and read by everyone signed in.

-- 1. Releases: one per product version (plain major.minor.patch, as in package.json).
CREATE TABLE releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version       text NOT NULL UNIQUE CHECK (version ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'),
  title         text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  summary       text NOT NULL DEFAULT '' CHECK (length(summary) <= 8000),        -- Markdown
  released_on   date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  -- Where it came from: written in the app, drafted from CHANGELOG.md for a running version, or the starting catalog.
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'changelog', 'seed')),
  published_at  timestamptz,
  published_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The one "Thaliyola x.y.z: n new features" notification went out (publishing again after unpublishing is quiet).
  notified_at   timestamptz,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Newest first by version number, not by text ("1.10.0" after "1.9.0").
CREATE INDEX releases_by_version ON releases ((string_to_array(version, '.')::int[]) DESC);

-- 2. Features: what one release brought, with how to use it.
CREATE TABLE features (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id   uuid NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  area         text NOT NULL CHECK (area IN ('knowledge', 'review', 'security', 'inbox', 'projects', 'people', 'connections', 'skills', 'admin', 'mcp', 'platform')),
  kind         text NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'improved', 'fixed')),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),   -- Markdown
  how_to       text NOT NULL DEFAULT '' CHECK (length(how_to) <= 20000),        -- Markdown: where to find it, the steps
  app_route    text CHECK (app_route IS NULL OR app_route ~ '^#/[^\s]*$'),      -- "#/admin/audit"
  docs_url     text CHECK (docs_url IS NULL OR docs_url ~* '^https?://'),
  -- Who it's for (informational: everyone reads every feature).
  audience     text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'admins', 'project_admins')),
  tags         text[] NOT NULL DEFAULT '{}',
  position     int NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX features_release ON features (release_id, position);

-- 3. Each person's last seen release, for the "What's new" dot in the Help menu.
ALTER TABLE users ADD COLUMN last_seen_release text;

-- 3b. Versions Thaliyola drafted a release for by itself (the starting catalog, or CHANGELOG.md for the running
--     version), so a draft an admin deleted or renamed isn't made again on the next start.
CREATE TABLE release_autodrafts (
  version     text PRIMARY KEY,
  drafted_at  timestamptz NOT NULL DEFAULT now()
);

-- 4. Manage releases: an organisation permission. Administrators hold every permission; the stored list follows.
UPDATE roles SET permissions = array_append(permissions, 'manage_releases') WHERE key = 'admin' AND NOT ('manage_releases' = ANY (permissions));

-- 5. A notification kind for published releases, and screenshots of a feature as assets. Both checks are extended
--    from what they are now (other migrations add kinds too), so the order these run in doesn't matter.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'notifications_kind_check' AND conrelid = 'notifications'::regclass;
  IF def IS NOT NULL AND position('''release''' IN def) = 0 THEN
    EXECUTE 'ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check';
    EXECUTE 'ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check ' || replace(def, 'ARRAY[', 'ARRAY[''release''::text, ');
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'assets_target_kind_check' AND conrelid = 'assets'::regclass;
  IF def IS NOT NULL AND position('''feature''' IN def) = 0 THEN
    EXECUTE 'ALTER TABLE assets DROP CONSTRAINT assets_target_kind_check';
    EXECUTE 'ALTER TABLE assets ADD CONSTRAINT assets_target_kind_check ' || replace(def, 'ARRAY[', 'ARRAY[''feature''::text, ');
  END IF;
END $$;
