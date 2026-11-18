-- Licences of dependency versions, looked up on deps.dev for SBOM exports and the licence check, and cached
-- (a published version's licence doesn't change). An empty array means deps.dev knows the version but no licence.

CREATE TABLE package_licenses (
  ecosystem  text NOT NULL,
  name       text NOT NULL,
  version    text NOT NULL,
  licenses   text[] NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ecosystem, name, version)
);
