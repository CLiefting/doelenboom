-- Migratie: activities toevoegen (activiteiten-planning per project, met
-- start- en einddatum — anders dan products/mijlpalen, die maar één los
-- moment hebben. Zie api/src/routes/activities.ts). Draai dit één keer tegen
-- een BESTAANDE database (lokale dev-db én productie); voor VERSE
-- installaties staat de tabel er al bij in db/init.sql (draait automatisch
-- bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0007_activities.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "create table if not exists" mag zonder gevolgen twee keer
-- gedraaid worden.

begin;

create table if not exists activities (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  omschrijving text not null default ''
);
create index if not exists idx_activities_element on activities(element_id);

commit;
