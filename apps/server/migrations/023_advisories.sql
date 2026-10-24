-- The latest critical vulnerabilities worldwide (NVD, GitHub advisories, CISA KEV additions, and alerts admins publish),
-- matched to the projects that use the affected technology or package, with each project's response.

CREATE TABLE advisories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  sources      text[] NOT NULL DEFAULT '{}',
  name         text,
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  cve_ids      text[] NOT NULL DEFAULT '{}',
  ghsa_ids     text[] NOT NULL DEFAULT '{}',
  severity     text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'unknown')),
  cvss_score   numeric(3, 1),
  cvss_vector  text,
  technologies text[] NOT NULL DEFAULT '{}',
  products     text[] NOT NULL DEFAULT '{}',
  packages     jsonb NOT NULL DEFAULT '[]',
  kev          boolean NOT NULL DEFAULT false,
  kev_due      date,
  source_org   text,
  published_at timestamptz NOT NULL,
  modified_at  timestamptz,
  refs         jsonb NOT NULL DEFAULT '[]',
  manual       boolean NOT NULL DEFAULT false,
  covered_by   uuid REFERENCES advisories (id) ON DELETE SET NULL,
  hidden       boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advisories_recent ON advisories (published_at DESC) WHERE NOT hidden;
CREATE INDEX advisories_cves ON advisories USING gin (cve_ids);

-- How each affected project is handling an advisory.
CREATE TABLE advisory_responses (
  advisory_id uuid NOT NULL REFERENCES advisories (id) ON DELETE CASCADE,
  scope_id    uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('investigating', 'affected', 'not_affected', 'patched')),
  note        text,
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (advisory_id, scope_id)
);

-- Which projects were already told about an advisory.
CREATE TABLE advisory_notices (
  advisory_id uuid NOT NULL REFERENCES advisories (id) ON DELETE CASCADE,
  scope_id    uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (advisory_id, scope_id)
);

-- What a project runs on (runtimes, servers, databases, platforms), set by people or detected in reviews.
ALTER TABLE scopes ADD COLUMN technologies text[] NOT NULL DEFAULT '{}';
ALTER TABLE components ADD COLUMN technologies text[] NOT NULL DEFAULT '{}';
