-- Migratie: prijsstrategie v3 — zie doelenboom_licentiemodel.md §2/§3/§9 v3
-- en Notitie_Prijsstrategie_Doelenboom_v0.1.docx (Charles, 7 september
-- 2026), met de volgende expliciet bevestigde keuzes:
--   - "gebruiker komt straks te vervallen. wordt Editor. Admin telt mee als
--     editor." (rolnaamswijziging zelf: zie 0037_editor_role_rename.sql,
--     vóór deze migratie draaien) — tiers.max_admins wordt hier max_editors,
--     en telt voortaan admin+editor samen (license.ts countActiveEditors).
--   - "aantal doelenbomen is niet onbeperkt maar beperkt tot 100 resp 250."
--     — Goud blijft op 100, Diamant naar 250 (i.p.v. de 100 van voorheen).
--   - Brons/Zilver-bomenlimiet volledig naar de notitie: 3 resp. 10 (was
--     10/25).
--   - Projecten-opslag: vaste bedragen per tier i.p.v. het generieke 20%-
--     percentage (nieuwe tabel module_tier_surcharges).
--   - Maandelijkse facturatie toegevoegd naast de bestaande jaarfacturatie
--     (tier_prices krijgt een period-kolom; subscription_requests een
--     billing_period-kolom die de contractcadans bepaalt, zie
--     subscriptions.ts).
--
-- De bestaande 2026-jaarprijzen van Brons/Zilver/Goud/Diamant (bevestigd 29
-- augustus 2026) worden NIET overschreven maar afgesloten per de dag vóór
-- deze migratie draait, met een nieuwe periode erna — zo blijft de volledige
-- prijsgeschiedenis zichtbaar in het licentiebeheerscherm (zelfde principe
-- als de rest van tier_prices, zie doelenboom_licentiemodel.md §9.6).
-- Single-Use/Evaluatie zijn geen onderdeel van de notitie en blijven
-- ongewijzigd (jaar-only, huidige prijs).
--
-- Idempotent waar praktisch (kolommen met "if not exists", seed-inserts met
-- "where not exists"); de valid_until-aanpassing op de oude jaarprijs-rijen
-- is dat niet 1-op-1 maar wel veilig te herhalen (de where-clause pakt na de
-- eerste keer gewoon 0 rijen omdat valid_until dan al is aangepast).
--
-- Draai dit één keer tegen een BESTAANDE database, NA
-- 0037_editor_role_rename.sql; voor VERSE installaties staat dit al in
-- db/init.sql (dat i.p.v. "oude periode afsluiten + nieuwe openen" gewoon
-- direct met de nieuwe prijzen zaait, want daar is geen oudere periode).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0038_prijsstrategie_v3.sql

-- --- 1. max_admins -> max_editors, nieuwe bomen-limieten ---

-- Alleen hernoemen als de oude kolomnaam nog bestaat: "rename column" heeft
-- geen "if exists"-variant in Postgres, en op een db die deze migratie al
-- eerder draaide (bv. bij het opnieuw afspelen van de volledige
-- db/migrations/*.sql-reeks, zie scripts/doelenboom-cli.sh) heet de kolom
-- dan al max_editors — een kale rename zou daar op een tweede run breken.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'tiers' and column_name = 'max_admins'
  ) then
    alter table tiers rename column max_admins to max_editors;
  end if;
end $$;

update tiers set max_bomen = 3 where name = 'Brons' and max_bomen = 10;
update tiers set max_bomen = 10 where name = 'Zilver' and max_bomen = 25;
update tiers set max_bomen = 250 where name = 'Diamant' and max_bomen = 100;

-- --- 2. tier_prices: period-kolom + nieuwe maand/jaar-periode ---

alter table tier_prices add column if not exists period text not null default 'jaar'
  check (period in ('maand', 'jaar'));
create index if not exists idx_tier_prices_tier on tier_prices(tier_id, period);

-- Sluit de lopende 2026-jaarprijs van Brons/Zilver/Goud/Diamant af per
-- gisteren (deze migratie draait 7 september 2026) — laat 'm verder intact
-- staan als geschiedenis. "and tp.valid_from < current_date" is cruciaal
-- voor herhaalbaarheid: zonder die voorwaarde pakt een tweede run van dit
-- bestand (zelfde dag of later, zie scripts/doelenboom-cli.sh) óók de rij
-- die de insert hieronder zelf al eerder aanmaakte (valid_from = vandaag,
-- valid_until = 2026-12-31, die voldoet óók aan "valid_until >= current_date")
-- en zet die dan terug naar valid_until = gisteren < valid_from = vandaag —
-- een ongeldige combinatie die de tier_prices_check-constraint schendt.
update tier_prices tp
set valid_until = (current_date - 1)
from tiers t
where tp.tier_id = t.id
  and t.name in ('Brons', 'Zilver', 'Goud', 'Diamant')
  and tp.period = 'jaar'
  and tp.valid_until >= current_date
  and tp.valid_from < current_date;

-- Nieuwe jaar- en maandprijzen vanaf vandaag t/m 31-12-2026 (zelfde
-- kalenderjaar-periodisering als de rest van dit prijsmodel). Voor Goud is
-- de ondergrens van de in de notitie nog open marge (€89–99) aangehouden —
-- definitief bepalen is vervolgstap 3 uit de notitie.
insert into tier_prices (tier_id, period, price_eur, valid_from, valid_until)
select t.id, v.period, v.price_eur, current_date, '2026-12-31'
from tiers t
join (values
  ('Brons', 'jaar', 190), ('Brons', 'maand', 19),
  ('Zilver', 'jaar', 490), ('Zilver', 'maand', 49),
  ('Goud', 'jaar', 890), ('Goud', 'maand', 89),
  ('Diamant', 'jaar', 2490), ('Diamant', 'maand', 249)
) as v(name, period, price_eur)
  on v.name = t.name
where not exists (
  select 1 from tier_prices tp
  where tp.tier_id = t.id and tp.period = v.period and tp.valid_from = current_date
);

-- --- 3. module_tier_surcharges: vaste Projecten-opslag per tier ---

create table if not exists module_tier_surcharges (
  id bigserial primary key,
  module_id bigint not null references modules(id) on delete cascade,
  tier_id bigint not null references tiers(id) on delete cascade,
  period text not null check (period in ('maand', 'jaar')),
  price_eur numeric(10,2) not null check (price_eur >= 0),
  valid_from date not null,
  valid_until date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);
create index if not exists idx_module_tier_surcharges_lookup on module_tier_surcharges(module_id, tier_id, period);

insert into module_tier_surcharges (module_id, tier_id, period, price_eur, valid_from, valid_until)
select m.id, t.id, v.period, v.price_eur, '2026-01-01', '2026-12-31'
from modules m
join tiers t on true
join (values
  ('Brons', 'jaar', 100), ('Brons', 'maand', 10),
  ('Zilver', 'jaar', 200), ('Zilver', 'maand', 20),
  ('Goud', 'jaar', 300), ('Goud', 'maand', 30),
  ('Diamant', 'jaar', 0), ('Diamant', 'maand', 0)
) as v(tier_name, period, price_eur)
  on v.tier_name = t.name
where m.key = 'projecten'
  and not exists (
    select 1 from module_tier_surcharges mts
    where mts.module_id = m.id and mts.tier_id = t.id and mts.period = v.period
  );

-- --- 4. subscription_requests: billing_period ---

alter table subscription_requests add column if not exists billing_period text not null default 'jaar'
  check (billing_period in ('maand', 'jaar'));
