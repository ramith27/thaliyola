-- PR briefings: when a pull (merge) request opens or gets new commits, Thaliyola comments on it with what it
-- already knows about the changed files: docs whose facts cite them, contracts and their consumers, known issues,
-- vulnerabilities, design drift, and other sessions working there. Opt-in per project; the git connection's token
-- must be able to write PR comments. Nothing on the server reads the code: only file paths are matched.

-- Per project: 'off', 'relevant' (comment only when there is something to say) or 'always'.
ALTER TABLE scopes ADD COLUMN pr_briefings text NOT NULL DEFAULT 'off' CHECK (pr_briefings IN ('off', 'relevant', 'always'));

-- A git connection's webhook secret (sealed like its token), for pull-request events.
ALTER TABLE connections ADD COLUMN webhook_secret text, ADD COLUMN webhook_secret_hint text;

CREATE TABLE pr_briefings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id    uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component   text NOT NULL,
  repo_key    text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  number      integer NOT NULL,
  title       text NOT NULL DEFAULT '',
  url         text,
  author      text,
  head_sha    text,
  files       text[] NOT NULL DEFAULT '{}',
  briefing    jsonb NOT NULL DEFAULT '{}',
  items       integer NOT NULL DEFAULT 0,
  comment_id  text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'skipped', 'failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_key, number)
);
CREATE INDEX pr_briefings_scope ON pr_briefings (scope_id, updated_at DESC);
