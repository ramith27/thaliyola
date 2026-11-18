-- A structured design system per scope (project, team or library): colour palette with dark values,
-- typography, spacing, radii, shadows, breakpoints, components and principles. A project can be based on
-- another scope's system (usually the Library's) and override parts of it. Every change keeps a version.
-- Design decisions stay ordinary decision articles tagged "design".

CREATE TABLE design_systems (
  scope_id   uuid PRIMARY KEY REFERENCES scopes (id) ON DELETE CASCADE,
  based_on   uuid REFERENCES scopes (id) ON DELETE SET NULL,
  tokens     jsonb NOT NULL DEFAULT '{}',
  principles text NOT NULL DEFAULT '',
  source     text,
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (based_on IS NULL OR based_on <> scope_id)
);
CREATE INDEX design_systems_based_on ON design_systems (based_on);

CREATE TABLE design_system_versions (
  scope_id   uuid NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  tokens     jsonb NOT NULL,
  principles text NOT NULL,
  based_on   uuid,
  source     text,
  note       text,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, version)
);
