-- Migratie: boekhouding van uitgevoerde migraties (DOEL-99).
--
-- Tot nu toe draaide `doelenboom -local -rebuild` elke keer álle migraties
-- opnieuw. Dat brak zodra een oude migratie een check-constraint opnieuw
-- vastlegde die niet meer past bij nieuwere data (0033 en de
-- audit_log-event-types). Voortaan registreert scripts/db-migrate.sh elke
-- uitgevoerde migratie in deze tabel en draait hij alleen wat nog ontbreekt.
--
-- method: 'run'      = uitgevoerd door scripts/db-migrate.sh
--         'baseline' = eenmalig als al gedraaid geregistreerd (bestaande database)
--         'init'     = onderdeel van db/init.sql (gloednieuwe database)
--
-- Niet los draaien: gebruik scripts/db-migrate.sh (zie deploy/README.md,
-- "Databasemigraties"). Een bestaande database krijgt deze tabel bij de
-- eenmalige baseline; deze migratie zelf is dan een no-op. Idempotent.
begin;

create table if not exists schema_migrations (
  filename   text primary key check (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$'),
  applied_at timestamptz not null default now(),
  method     text not null default 'run' check (method in ('run', 'baseline', 'init'))
);

commit;
