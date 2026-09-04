-- Software Bill of Materials / dependency-health (CISO-aandachtspunt, zie
-- doelenboom_sbom_ontwerp.md in het project en api/src/dependencyHealth.ts).
-- Zie db/init.sql voor de uitgebreide toelichting per tabel.
begin;

create table if not exists dependency_sbom_builds (
  id bigserial primary key,
  build_version text not null,
  git_commit text,
  cyclonedx_spec_version text not null,
  sbom_serial_number text,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dependency_sbom_builds_generated on dependency_sbom_builds(generated_at desc);

create table if not exists dependency_components (
  id bigserial primary key,
  build_id bigint not null references dependency_sbom_builds(id) on delete cascade,
  application_component text not null check (application_component in ('api', 'web', 'excel-service')),
  application_part text not null check (application_part in ('frontend', 'backend')),
  ecosystem text not null check (ecosystem in ('npm', 'pypi')),
  name text not null,
  version text not null,
  purl text,
  dependency_type text not null check (dependency_type in ('direct', 'transitive')),
  scope text not null check (scope in ('runtime', 'development')),
  license text,
  latest_version text,
  update_category text not null default 'onbekend'
    check (update_category in ('actueel', 'patch', 'minor', 'major', 'onbekend')),
  version_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (build_id, application_component, name, version)
);
create index if not exists idx_dependency_components_build on dependency_components(build_id);
create index if not exists idx_dependency_components_update on dependency_components(build_id, update_category);

create table if not exists dependency_vulnerabilities (
  id bigserial primary key,
  component_id bigint not null references dependency_components(id) on delete cascade,
  vulnerability_id text not null,
  cve text,
  severity text,
  summary text,
  fixed_version text,
  source text not null default 'osv.dev',
  checked_at timestamptz not null default now(),
  unique (component_id, vulnerability_id)
);
create index if not exists idx_dependency_vulnerabilities_component on dependency_vulnerabilities(component_id);

create table if not exists dependency_check_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  triggered_by_user_id bigint references users(id) on delete set null,
  error text,
  components_checked integer,
  vulnerabilities_found integer
);
create index if not exists idx_dependency_check_runs_finished on dependency_check_runs(finished_at desc nulls last);

commit;
