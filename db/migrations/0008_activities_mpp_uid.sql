-- Migratie: activities.mpp_uid toevoegen — de stabiele Task-UID uit een MS
-- Project-bestand (zie web/public/tree.html: parseMppProjectXml/
-- computeMppImportPlan), bewaard per geïmporteerde activiteit zodat een
-- HERIMPORT van hetzelfde (bijgewerkte) plan bestaande activiteiten kan
-- BIJWERKEN en niet meer aangetroffen taken kan aanbieden om te VERWIJDEREN,
-- in plaats van bij elke import gewoon dubbele rijen toe te voegen. NULL voor
-- handmatig aangemaakte activiteiten — die worden door de import nooit
-- aangeraakt (zie api/src/routes/activities.ts).
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat de kolom er al bij in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0008_activities_mpp_uid.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists" mag zonder gevolgen twee keer
-- gedraaid worden.

begin;

alter table activities add column if not exists mpp_uid text;
-- Alleen relevant voor het opzoeken "welke bestaande activiteiten horen bij
-- dit project-element en zijn ooit uit MS Project geïmporteerd" (bij het
-- herkennen van bijwerken/verwijderen tijdens een herimport) — een partiële
-- index (where mpp_uid is not null) omdat de meeste activiteiten dit veld
-- niet hebben (handmatig aangemaakt).
create index if not exists idx_activities_mpp_uid on activities(element_id, mpp_uid) where mpp_uid is not null;

commit;
