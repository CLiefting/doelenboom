-- Migratie: system_announcements toevoegen (systeembrede mededeling, bv. een
-- onderhoudsaankondiging, door een sysadmin aan/uit te zetten — zie
-- api/src/routes/announcement.ts). Draai dit één keer tegen een BESTAANDE
-- database (lokale dev-db én productie); voor VERSE installaties staat de
-- tabel er al bij in db/init.sql (draait automatisch bij de allereerste
-- containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0006_system_announcement.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "create table if not exists" + "on conflict do nothing" mogen
-- zonder gevolgen twee keer gedraaid worden.

begin;

create table if not exists system_announcements (
  id boolean primary key default true check (id),
  message text not null default '',
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by bigint references users(id) on delete set null
);
insert into system_announcements (id) values (true) on conflict (id) do nothing;

commit;
