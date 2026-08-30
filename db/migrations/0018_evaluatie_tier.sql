-- Migratie: "Evaluatie"-abonnement (gratis proeftier) + generalisering van
-- de tiers-tabel om zo'n tier zonder hardgecodeerde speciale gevallen te
-- kunnen uitdrukken — zie doelenboom_licentiemodel.md §9 en het verzoek van
-- Charles (30 augustus 2026): "voeg ook een 'Evaluatie' abonnement toe - 1
-- admin, 2 bomen. na 30 dagen verloopt deze. Alle modules zetten we in
-- Evaluatie aan - dit abonnement is GRATIS."
--
-- In plaats van de proefduur (TRIAL_DAYS = 14 in subscriptions.ts) en
-- "alleen aangevinkte modules" hard te coderen als uitzondering voor één
-- tier met een specifieke naam, krijgt `tiers` twee generieke, optionele
-- kolommen — consistent met het bestaande principe dat tiers volledig door
-- sysadmins beheerbaar zijn en er geen vaste, hardgecodeerde set is (zie
-- doelenboom_licentiemodel.md): een sysadmin kan zo later ook een andere
-- tier een afwijkende proefduur of "alle modules inbegrepen" geven, zonder
-- codewijziging.
--   - trial_days: proefperiode in dagen bij een nieuwe zelfbedieningsaanvraag
--     op deze tier (null = gebruik de standaard TRIAL_DAYS = 14, zie
--     subscriptions.ts createSubscriptionRequest).
--   - all_modules_included: bij een aanvraag op deze tier worden ALLE op dat
--     moment bestaande modules geactiveerd, ongeacht wat de aanvrager zelf
--     aanvinkte (zie subscriptions.ts createSubscriptionRequest).
--
-- Zaait vervolgens de Evaluatie-tier zelf (1 admin, 2 bomen, 30 dagen proef,
-- alle modules inbegrepen) en een € 0-prijsperiode ervoor (gratis, maar wel
-- met een gewone prijsperiode-rij — zo blijft de tier via de bestaande
-- "alleen tiers met een op dit moment geldige prijs"-filter zichtbaar op de
-- publieke aanvraagpagina, zie routes/subscriptions.ts GET
-- /subscription-tiers en tierPrices.ts).
--
-- Draai dit één keer tegen een BESTAANDE database; voor VERSE installaties
-- staat dit al in db/init.sql. Idempotent: kolommen met "if not exists", de
-- seed-inserts met "on conflict do nothing" / "where not exists".
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0018_evaluatie_tier.sql

alter table tiers add column if not exists trial_days integer;
alter table tiers add column if not exists all_modules_included boolean not null default false;

insert into tiers (name, max_admins, max_bomen, sort_order, trial_days, all_modules_included) values
  ('Evaluatie', 1, 2, -1, 30, true)
on conflict (name) do nothing;

insert into tier_prices (tier_id, price_eur, valid_from, valid_until)
select t.id, 0, '2026-01-01', '2026-12-31'
from tiers t
where t.name = 'Evaluatie'
  and not exists (select 1 from tier_prices tp where tp.tier_id = t.id);
