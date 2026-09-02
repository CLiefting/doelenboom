-- Migratie: product_dependencies krijgt type + lag_amount/lag_eenheid, zodat
-- afhankelijkheden tussen deliverables/mijlpalen (net als bij activiteiten)
-- een relatietype en een vertraging kunnen dragen. Zie web/public/tree.html
-- (Afhankelijkheden-sectie in het productformulier, dependency-pijlen in
-- activityGanttHtml) en api/src/routes/products.ts.
--
-- type: de API staat vooralsnog alleen 'FS' (Einde-na-begin) toe — de kolom
-- staat al klaar voor SS/FF/SF, zodat een latere uitbreiding geen nieuwe
-- migratie nodig heeft, alleen een ruimere validatie in products.ts.
-- lag_amount/lag_eenheid: vertraging in dagen/weken/maanden (geen jaren, dat
-- is onrealistisch binnen één project) — puur informatief, geen scheduling-
-- engine die hiermee rekent, net als lag_days bij activity_dependencies.
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat de tabel er al zo bij in
-- db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0023_product_dependencies_type_lag.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists" mag zonder gevolgen twee keer
-- gedraaid worden.

begin;

alter table product_dependencies
  add column if not exists type text not null default 'FS';
alter table product_dependencies
  add column if not exists lag_amount integer not null default 0;
alter table product_dependencies
  add column if not exists lag_eenheid text not null default 'd';

-- Check-constraints los toevoegen (alter table ... add column ... check kan
-- niet in dezelfde vorm herhaald worden) -- "not valid" bestaat niet nodig
-- hier: alle bestaande rijen voldoen al aan de default ('FS'/'d'), dus een
-- volledige validatie is goedkoop.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'product_dependencies_type_check'
  ) then
    alter table product_dependencies
      add constraint product_dependencies_type_check check (type in ('FS', 'SS', 'FF', 'SF'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'product_dependencies_lag_eenheid_check'
  ) then
    alter table product_dependencies
      add constraint product_dependencies_lag_eenheid_check check (lag_eenheid in ('d', 'w', 'm'));
  end if;
end $$;

commit;
