-- The docs check on pull requests: facts whose cited lines a pull request changes, moves or deletes, reported as a
-- commit status (thaliyola/docs). warn never blocks; block fails until someone acknowledges it in Thaliyola.
-- When the pull request merges, moved facts follow their code and changed ones are marked stale.
ALTER TABLE scopes ADD COLUMN pr_docs_check text NOT NULL DEFAULT 'off' CHECK (pr_docs_check IN ('off', 'warn', 'block'));

ALTER TABLE pr_briefings
  ADD COLUMN docs_check      jsonb,
  ADD COLUMN docs_state      text CHECK (docs_state IN ('success', 'failure', 'pending')),
  ADD COLUMN docs_ack_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN docs_ack_sha    text,
  ADD COLUMN merged_at       timestamptz,
  ADD COLUMN docs_applied_at timestamptz;
