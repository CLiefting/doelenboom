-- Migratie: extra velden bij products (duur/eenheid, business value,
-- deadline) + nieuwe tabel product_dependencies — afhankelijkheden tussen
-- planning items (deliverables/mijlpalen) binnen hetzelfde project. Zie
-- web/public/tree.html (Afhankelijkheden-sectie in het product-formulier)
-- en api/src/routes/products.ts.
--
-- duur/duur_eenheid: doorlooptijd om het planning item te realiseren
-- (eenheid d/w/m/y). business_value: vrije numerieke inschatting van de
-- waarde die het oplevert, zonder vaste eenheid/valuta. deadline: de
-- uiterste opleverdatum, los van de bestaande verwachte_datum (planning) —
-- alle drie puur informatief, geen scheduling-engine die hier iets mee
-- herberekent.
--
-- product_dependencies: net als activity_dependencies (migratie 0011), maar
-- zonder type/lag_days — een planning item heeft geen startdatum (alleen een
-- verwachte/werkelijke opleverdatum, één moment), dus een FS/SS/FF/SF-type
-- heeft hier geen betekenis. Puur "successor hangt af van predecessor".
--
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staan de velden/tabel er al bij in
-- db/init.sql.
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0012_product_fields.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: "add column if not exists"/"create table if not exists" mogen
-- zonder gevolgen twee keer gedraaid worden.

begin;

alter table products add column if not exists duur integer;
alter table products add column if not exists duur_eenheid text not null default 'd';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_duur_eenheid_check'
  ) then
    alter table products add constraint products_duur_eenheid_check
      check (duur_eenheid in ('d', 'w', 'm', 'y'));
  end if;
end $$;
alter table products add column if not exists business_value numeric;
alter table products add column if not exists deadline date;

create table if not exists product_dependencies (
  id bigserial primary key,
  predecessor_id bigint not null references products(id) on delete cascade,
  successor_id bigint not null references products(id) on delete cascade,
  check (predecessor_id <> successor_id),
  unique (predecessor_id, successor_id)
);
create index if not exists idx_product_deps_predecessor on product_dependencies(predecessor_id);
create index if not exists idx_product_deps_successor on product_dependencies(successor_id);

commit;
