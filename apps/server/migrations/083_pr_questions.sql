-- Questions asked in pull requests: a comment mentioning @thaliyola gets what the project knows, and the question is
-- relayed to the project's Claude sessions, whose answer is posted in the same thread. Opt-in per project.
ALTER TABLE scopes ADD COLUMN pr_questions text NOT NULL DEFAULT 'off' CHECK (pr_questions IN ('off', 'on'));

-- Where to post the answer to a relayed question: {connection_id, repository, number, provider, review_comment_id?, discussion_id?}.
ALTER TABLE session_questions ADD COLUMN reply_pr jsonb;

CREATE TABLE pr_questions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id            uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component           text NOT NULL,
  repo_key            text NOT NULL,
  provider            text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  number              integer NOT NULL,
  comment_id          text NOT NULL,
  author              text,
  question            text NOT NULL,
  path                text,
  line                integer,
  confidence          text,
  sources             integer NOT NULL DEFAULT 0,
  reply_comment_id    text,
  session_question_id uuid REFERENCES session_questions (id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'replied' CHECK (status IN ('replied', 'relayed', 'answered', 'declined', 'failed')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_key, comment_id)
);
CREATE INDEX pr_questions_scope ON pr_questions (scope_id, created_at DESC);
CREATE INDEX pr_questions_session_question ON pr_questions (session_question_id) WHERE session_question_id IS NOT NULL;
