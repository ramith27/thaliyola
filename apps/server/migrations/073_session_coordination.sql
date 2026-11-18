-- Sessions coordinating, not just asking: work claims (who is editing what, so two sessions don't change
-- the same files), handoffs (pass work and context to another session), and asking everyone in a project
-- at once (one question per online session, grouped).

CREATE TABLE work_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  -- Which repository: repoKey() of the session's git remote (host/owner/name), so every clone matches.
  repo_key    text NOT NULL,
  -- A file path relative to the repository root, or a directory (claims everything under it).
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 500 AND path !~ '^/' AND path !~ '(^|/)\.\.(/|$)'),
  note        text NOT NULL DEFAULT '',
  -- true: claimed by the plugin because the session edited the file; false: claimed on purpose.
  auto        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz,
  UNIQUE (session_id, repo_key, path)
);
CREATE INDEX work_claims_active ON work_claims (repo_key, path) WHERE released_at IS NULL;

ALTER TABLE session_questions
  ADD COLUMN kind text NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'handoff')),
  -- Asking everyone: one question per session, sharing the first one's id.
  ADD COLUMN group_id uuid;
CREATE INDEX session_questions_group ON session_questions (group_id) WHERE group_id IS NOT NULL;
