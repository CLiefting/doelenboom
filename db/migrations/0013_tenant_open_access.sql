-- Migratie: tenants.open_access_role toevoegen (zie api/src/rbac.ts
-- getTenantRole voor het volledige rolmodel). Draai dit één keer tegen een
-- BESTAANDE database (lokale dev-db én productie); voor VERSE installaties
-- staat de kolom er al bij in db/init.sql (draait automatisch bij de
-- allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0013_tenant_open_access.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: `add column if not exists`, geen data-wijziging — de kolom
-- staat na deze migratie voor elke bestaande tenant op null (= huidig
-- gedrag, niemand krijgt er ongevraagd toegang bij totdat een sysadmin of
-- tenant-admin het expliciet aanzet via Tenantbeheer).

begin;

alter table tenants add column if not exists open_access_role text
  check (open_access_role in ('admin', 'gebruiker', 'bezoeker'));

commit;
