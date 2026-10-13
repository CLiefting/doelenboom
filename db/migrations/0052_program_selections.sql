-- Migratie: opgeslagen projectselecties voor de programma-PowerPoint (DOEL-112).
--
-- Een programmamanager kiest in het exportvenster een set projecten (bv.
-- "Stuurgroep OVpay") en kan die combinatie onder een naam bewaren om later
-- met één klik dezelfde set te exporteren. Een selectie is persoonlijk: per
-- gebruiker per doelenboom, alleen zichtbaar en te wijzigen door de eigenaar
-- (afgedwongen in api/src/routes/programPptx.ts). Verdwijnt vanzelf met de
-- doelenboom of het account (on delete cascade). Projectcodes worden bij het
-- opslaan gecontroleerd; een later verwijderd project valt bij het laden weg.
--
-- Grenzen ook in de API: naam 1-80 tekens, 1-50 projecten, venster 1-12
-- maanden, hooguit 50 selecties per gebruiker per boom.
--
-- Niet los draaien: gebruik scripts/db-migrate.sh (zie deploy/README.md,
-- "Databasemigraties"). Idempotent.
begin;

create table if not exists program_selections (
  id             bigserial primary key,
  doelenboom_id  bigint not null references doelenbomen(id) on delete cascade,
  user_id        bigint not null references users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 80),
  project_codes  text[] not null check (cardinality(project_codes) between 1 and 50),
  window_months  integer not null default 3 check (window_months between 1 and 12),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (doelenboom_id, user_id, name)
);

create index if not exists program_selections_owner_idx on program_selections (doelenboom_id, user_id);

commit;
