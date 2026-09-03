-- Voegt een aan/uit-schuif toe voor de nachtelijke Excel-back-up
-- (api/src/scripts/exportAllDoelenbomen.ts, gepland via cron — zie
-- deploy/README.md "Nachtelijke Excel-backup"): tot nu toe exporteerde dat
-- script onvoorwaardelijk élke doelenboom van élke tenant. Zelfde patroon als
-- wipe_on_empty (zie db/init.sql): een tenant-breed veld dat alleen dient als
-- standaardwaarde bij het aanmaken van een nieuwe doelenboom, en een eigen,
-- onafhankelijk instelbare vlag per doelenboom die de daadwerkelijke
-- aan/uit-schakelaar is.
--
-- Default true op beide kolommen (bewust "opt-out" i.p.v. "opt-in"): een
-- bestaande doelenboom valt door deze migratie dus niet per ongeluk buiten de
-- back-up, en een nieuwe doelenboom evenmin.
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staan de kolommen er al goed bij in
-- db/init.sql.
--
-- Gebruik (lokaal):
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0025_nightly_export_toggle.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent ("add column if not exists"): veilig meerdere keren te draaien.

begin;

alter table tenants add column if not exists nightly_export_enabled boolean not null default true;
alter table doelenbomen add column if not exists nightly_export_enabled boolean not null default true;

commit;
