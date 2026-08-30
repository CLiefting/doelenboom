-- Migratie: prijsgeschiedenis voor tiers en module-opslagpercentages (i.p.v.
-- één enkel prijsveld) — zie doelenboom_licentiemodel.md §9 en
-- api/src/tierPrices.ts / api/src/moduleSurcharges.ts. Een abonnement heeft
-- door de tijd heen meerdere prijzen (bv. € 125/jaar in 2026, een ander
-- tarief in 2027); hetzelfde geldt voor de opslag die een module toevoegt.
-- Vervangt de éénmalige prijsvelden op `tiers` (uit migratie 0015) door een
-- eigen geschiedenis-tabel per tier/module, en zet de bestaande waarden er
-- als eerste periode in over. Draai dit één keer tegen een BESTAANDE
-- database (die al 0015 heeft gehad); voor VERSE installaties staat dit al
-- in db/init.sql (draait automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0016_price_history.sql
--
-- Idempotent: alle create/index-statements met "if not exists", de
-- kolomoverzet met een DO-blok dat controleert of de oude kolommen nog
-- bestaan (dus een tweede keer draaien is een no-op voor dat deel), en de
-- seed-inserts met een "not exists"-guard.

create table if not exists tier_prices (
  id bigserial primary key,
  tier_id bigint not null references tiers(id) on delete cascade,
  price_eur numeric(10,2) not null,
  valid_from date not null,
  valid_until date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);
create index if not exists idx_tier_prices_tier on tier_prices(tier_id);

create table if not exists module_surcharges (
  id bigserial primary key,
  module_id bigint not null references modules(id) on delete cascade,
  surcharge_pct numeric(5,2) not null,
  valid_from date not null,
  valid_until date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);
create index if not exists idx_module_surcharges_module on module_surcharges(module_id);

-- Bestaande tier-prijzen (migratie 0015: tiers.price_eur/price_valid_from/
-- price_valid_until) overzetten als eerste periode, en de oude kolommen
-- opruimen. In een DO-blok zodat een tweede keer draaien (kolommen dan al
-- weg) geen fout geeft.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'tiers' and column_name = 'price_eur') then
    insert into tier_prices (tier_id, price_eur, valid_from, valid_until)
    select id, price_eur, coalesce(price_valid_from, '2026-01-01'), coalesce(price_valid_until, '2026-12-31')
    from tiers
    where price_eur is not null;

    alter table tiers drop column price_eur;
    alter table tiers drop column price_valid_from;
    alter table tiers drop column price_valid_until;
  end if;
end $$;

-- Initiële module-opslagpercentages, zoals met Charles bevestigd
-- (doelenboom_licentiemodel.md §3): Projecten 20%. Templating (10%) volgt
-- pas zodra die module een eigen rij in `modules` heeft. KPI/Backup/
-- Auditing: nog niet bepaald, bewust geen rij.
insert into module_surcharges (module_id, surcharge_pct, valid_from, valid_until)
select m.id, v.surcharge_pct, '2026-01-01', '2026-12-31'
from modules m
join (values ('projecten', 20)) as v(key, surcharge_pct)
  on v.key = m.key
where not exists (select 1 from module_surcharges ms where ms.module_id = m.id);
