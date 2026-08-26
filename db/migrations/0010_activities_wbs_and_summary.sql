-- Migratie: activities.wbs en activities.is_summary toevoegen.
--
-- wbs: het WBS-nummer uit MS Project (bv. "2.1"), puur informatief — getoond
-- tussen haakjes in kleiner lettertype vóór de taaknaam in de activiteiten-
-- Gantt (zie web/public/tree.html: activityGanttHtml). Net als mpp_uid
-- alleen gezet door de import en met coalesce bewaard bij een handmatige
-- bewerking (zie api/src/routes/activities.ts) — NULL voor handmatig
-- aangemaakte activiteiten.
--
-- is_summary: bij MS Project-import 1-op-1 overgenomen van de taak z'n
-- Summary-vlag ("fase"/samenvattende taak, zie computeMppImportPlan), ook
-- handmatig te zetten via het activiteiten-formulier. Toont in de Gantt een
-- dunnere balk met eindmarkeringen (in een andere kleur) i.p.v. een gewone
-- balk — zelfde soort visualisatie als MS Project zelf voor een
-- samenvattende taak gebruikt.
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staan de kolommen er al bij in
-- db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0010_activities_wbs_and_summary.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists" mag zonder gevolgen twee keer
-- gedraaid worden. Bestaande, al eerder geïmporteerde activiteiten tonen
-- het nieuwe WBS-nummer/de dunnere fase-balk pas na een HERIMPORT (of
-- handmatige bewerking).

begin;

alter table activities add column if not exists wbs text;
alter table activities add column if not exists is_summary boolean not null default false;

commit;
