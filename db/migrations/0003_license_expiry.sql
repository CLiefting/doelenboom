-- Migratie: licentie-einddatum per tenant — zie doelenboom_licentiemodel.md
-- in het Doelenboom-project voor het volledige ontwerp. Draai dit één keer
-- tegen een BESTAANDE database (lokale dev-db én productie) die deze kolom
-- nog niet heeft; voor VERSE installaties staat 'ie al in db/init.sql (dat
-- draait automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0003_license_expiry.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: mag zonder gevolgen twee keer gedraaid worden (add column if
-- not exists).

begin;

-- license_end_date is bewust NULLABLE: null betekent "geen einddatum
-- ingesteld" (nooit verlopen) — de staat waarin elke tenant van vóór deze
-- migratie terechtkomt, zodat bestaande tenants niet per ongeluk in één klap
-- read-only worden. Nieuwe tenants krijgen vanaf nu bij het aanmaken
-- automatisch een default (einde van de aanmaakmaand + 12 maanden, zie
-- computeDefaultLicenseEndDate in api/src/license.ts en de POST /api/tenants
-- -route) — een sysadmin kan die datum daarna altijd verlengen/wijzigen/
-- wissen via PUT /api/tenants/:tenantId/license/end-date.
-- Handhaving (zie rbac.ts requireWritableDoelenboom): zodra license_end_date
-- in het verleden ligt, wordt de tenant read-only voor iedereen behalve
-- sysadmin — precies dezelfde plek waar doelenbomen.read_only vandaag al
-- hetzelfde effect heeft, dus geen apart handhavingspad nodig.
alter table tenants add column if not exists license_end_date date;

commit;
