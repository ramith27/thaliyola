-- Comments on proposals and full snapshots of every published version.
CREATE TABLE revision_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES revisions (id),
  author_id   uuid NOT NULL REFERENCES users (id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revision_comments_revision ON revision_comments (revision_id, created_at);

CREATE TABLE item_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CHECK (target_kind IN ('article', 'finding')),
  target_id   uuid NOT NULL,
  version     integer NOT NULL,
  title       text NOT NULL,
  content     jsonb NOT NULL,               -- article: {body_md}; finding: {symptoms, root_cause, fix, tags}
  summary     text NOT NULL DEFAULT '',
  author_id   uuid REFERENCES users (id),   -- who proposed it
  approver_id uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, version)
);

-- Existing items start their history at their current version.
INSERT INTO item_versions (target_kind, target_id, version, title, content, summary, author_id, created_at)
SELECT 'article', id, version, title, jsonb_build_object('body_md', body_md), 'Version at history start', created_by, updated_at FROM articles
 WHERE status IN ('published', 'possibly_stale', 'superseded');
INSERT INTO item_versions (target_kind, target_id, version, title, content, summary, author_id, created_at)
SELECT 'finding', id, version, title, jsonb_build_object('symptoms', symptoms, 'root_cause', root_cause, 'fix', fix, 'tags', tags), 'Version at history start', author_id, updated_at FROM findings
 WHERE status IN ('published', 'possibly_stale', 'superseded');
