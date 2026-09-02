-- Fix: excel_imports.status stond alleen 'warnings' (meervoud) toe, terwijl
-- excel-service altijd 'warning' (enkelvoud) teruggeeft (zie app/parser.py/
-- project_workbook.py: status = 'ok' | 'warning' | 'failed') en
-- routes/imports.ts die waarde ongewijzigd doorzet naar deze kolom bij het
-- uploaden van een Excel-bestand. Elke upload die waarschuwingen opleverde
-- (bijna elk "echt" bestand, i.t.t. een brandschoon testbestand) crashte
-- daardoor op de insert (check-constraint-violation) — en omdat die insert
-- niet in een try/catch zat, crashte dat het hele Node-proces, waardoor de
-- hele site plat ging tot een handmatige herstart (zie routes/imports.ts,
-- inmiddels ook gefixt: die insert faalt nu netjes met een 500 i.p.v. het
-- hele proces mee te trekken).
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat de check-constraint er al goed
-- bij in db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0024_fix_excel_imports_status_check.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: droppen+opnieuw-toevoegen van dezelfde constraint mag zonder
-- gevolgen meerdere keren gedraaid worden. Rijen die ooit met de kapotte
-- (nooit succesvol ingezette) 'warnings'-waarde zouden zijn weggeschreven
-- bestaan sowieso niet — de insert faalde immers altijd — dus er is niets om
-- eerst te migreren, alleen de constraint zelf hoeft gerepareerd.

begin;

alter table excel_imports drop constraint if exists excel_imports_status_check;
alter table excel_imports
  add constraint excel_imports_status_check
  check (status in ('pending', 'ok', 'warning', 'failed', 'published'));

commit;
