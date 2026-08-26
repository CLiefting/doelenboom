-- Migratie: nieuwe tabel activity_dependencies — afhankelijkheden tussen
-- twee activiteiten binnen hetzelfde project (denk aan MS Project: de
-- opvolger mag pas van start als de voorganger aan de voorwaarde van 'type'
-- voldoet). Zie web/public/tree.html (Afhankelijkheden-sectie in het
-- activiteiten-formulier, dependency-pijlen in activityGanttHtml) en
-- api/src/routes/activities.ts.
--
-- type: FS (Finish-Start — opvolger start pas ná afloop van de voorganger)
-- is de default en de meest gebruikte; SS/FF/SF bestaan voor volledigheid.
-- lag_days: vertraging (positief) of overlap/voorsprong (negatief) in dagen,
-- puur informatief — er is geen scheduling-engine die datums automatisch
-- herberekent, net als de rest van de planning in deze app.
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat de tabel er al bij in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0011_activity_dependencies.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "create table if not exists" mag zonder gevolgen twee keer
-- gedraaid worden.

begin;

create table if not exists activity_dependencies (
  id bigserial primary key,
  predecessor_id bigint not null references activities(id) on delete cascade,
  successor_id bigint not null references activities(id) on delete cascade,
  type text not null default 'FS' check (type in ('FS', 'SS', 'FF', 'SF')),
  lag_days integer not null default 0,
  check (predecessor_id <> successor_id),
  unique (predecessor_id, successor_id)
);
create index if not exists idx_activity_deps_predecessor on activity_dependencies(predecessor_id);
create index if not exists idx_activity_deps_successor on activity_dependencies(successor_id);

commit;
