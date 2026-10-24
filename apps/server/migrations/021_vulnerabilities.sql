-- Security: each repository's dependencies (from lockfiles agents or CI upload), vulnerabilities matched
-- against OSV.dev or reported by agents and people, and CISA's Known Exploited Vulnerabilities catalog.
-- Details are for a project's writers, owners and admins; readers see counts only.

ALTER TABLE components ADD COLUMN deps_scanned_at timestamptz, ADD COLUMN deps_sha text, ADD COLUMN deps_count integer;

CREATE TABLE dependencies (
  scope_id   uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component  text NOT NULL DEFAULT '',
  ecosystem  text NOT NULL,
  name       text NOT NULL,
  version    text NOT NULL,
  manifest   text NOT NULL DEFAULT '',
  PRIMARY KEY (scope_id, component, ecosystem, name, version)
);
CREATE INDEX dependencies_pkg ON dependencies (ecosystem, name, version);

-- One-time upload links handed to agents, so a lockfile upload needs no token in the shell.
CREATE TABLE dependency_uploads (
  token_hash text PRIMARY KEY,
  scope_id   uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component  text NOT NULL DEFAULT '',
  head_sha   text,
  created_by uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Cached OSV advisories (by id), refreshed when OSV reports a newer modified time.
CREATE TABLE osv_advisories (
  id         text PRIMARY KEY,
  modified   text,
  data       jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kev_catalog (
  cve        text PRIMARY KEY,
  name       text NOT NULL DEFAULT '',
  vendor     text NOT NULL DEFAULT '',
  product    text NOT NULL DEFAULT '',
  date_added date,
  due_date   date,
  ransomware boolean NOT NULL DEFAULT false
);

CREATE TABLE vulnerabilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id       uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  component      text NOT NULL DEFAULT '',
  source         text NOT NULL CHECK (source IN ('osv', 'reported')),
  advisory_id    text,
  aliases        text[] NOT NULL DEFAULT '{}',
  title          text NOT NULL,
  details        text NOT NULL DEFAULT '',
  ecosystem      text,
  package        text,
  version        text,
  fixed_versions text[] NOT NULL DEFAULT '{}',
  location       text,
  cwe            text,
  severity       text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'unknown')),
  cvss_score     numeric(3, 1),
  cvss_vector    text,
  refs           jsonb NOT NULL DEFAULT '[]',
  kev            boolean NOT NULL DEFAULT false,
  kev_due        date,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'fixed', 'accepted', 'false_positive')),
  status_note    text,
  reported_by    uuid REFERENCES users (id),
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users (id),
  announced_at   timestamptz
);
CREATE UNIQUE INDEX vulnerabilities_osv ON vulnerabilities (scope_id, component, advisory_id, package, version) WHERE source = 'osv';
CREATE INDEX vulnerabilities_open ON vulnerabilities (scope_id, severity) WHERE status IN ('open', 'acknowledged');

CREATE TABLE vulnerability_events (
  id               bigserial PRIMARY KEY,
  vulnerability_id uuid NOT NULL REFERENCES vulnerabilities (id) ON DELETE CASCADE,
  at               timestamptz NOT NULL DEFAULT now(),
  actor            uuid REFERENCES users (id),
  event            text NOT NULL,
  note             text
);
CREATE INDEX vulnerability_events_vuln ON vulnerability_events (vulnerability_id, at);

-- When background jobs last ran (daily OSV re-check, KEV refresh).
CREATE TABLE job_runs (
  name     text PRIMARY KEY,
  last_run timestamptz NOT NULL
);

-- Security alerts are a notification kind of their own (critical and actively exploited vulnerabilities).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('review', 'decided', 'change', 'watch', 'stale', 'comment', 'assigned', 'invite', 'security'));
