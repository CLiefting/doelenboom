-- Migratie: activities.is_milestone toevoegen — bij MS Project-import 1-op-1
-- overgenomen van de taak z'n Milestone-vlag, ook handmatig te zetten via het
-- activiteiten-formulier (zie web/public/tree.html: activityGanttHtml,
-- openActivityModal, computeMppImportPlan). Bepaalt of de activiteiten-Gantt
-- een ruit-icoon toont op de datum i.p.v. een balkje van één dag.
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat de kolom er al bij in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0009_activities_is_milestone.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists" mag zonder gevolgen twee keer
-- gedraaid worden. Bestaande rijen krijgen de default (false) — dus alle al
-- eerder geïmporteerde mijlpalen tonen pas na een HERIMPORT (of handmatige
-- bewerking) als ruit i.p.v. balkje; dat is bewust, om deze migratie zelf
-- eenvoudig en zonder MS Project-specifieke logica te houden.

begin;

alter table activities add column if not exists is_milestone boolean not null default false;

commit;
