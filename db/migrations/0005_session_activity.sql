-- Migratie: sessions.last_activity_at toevoegen (15-minuten-inactiviteit-
-- uitlog-beveiliging, zie api/src/auth.ts requireAuth en de rolmodel-
-- toelichting bij de sessions-tabel in db/init.sql). Draai dit één keer tegen
-- een BESTAANDE database (lokale dev-db én productie); voor VERSE installaties
-- staat de kolom er al bij in db/init.sql (draait automatisch bij de
-- allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0005_session_activity.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists" mag zonder gevolgen twee keer
-- gedraaid worden. Bestaande sessies krijgen last_activity_at = now() (de
-- default) — hun 15-minuten-klok begint dus opnieuw vanaf het moment van deze
-- migratie, niet met terugwerkende kracht.

begin;

alter table sessions add column if not exists last_activity_at timestamptz not null default now();

commit;
