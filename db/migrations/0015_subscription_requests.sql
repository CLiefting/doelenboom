-- Migratie: zelfbedieningsaanvraag voor nieuwe abonnementen ("Aanvragen"-
-- module, zie doelenboom_licentiemodel.md §2/§9 en api/src/subscriptions.ts).
-- Voegt toe: prijs+geldigheidsperiode op tiers, aanbiedingen (offers +
-- offer_tiers), de aanvraag-/verlengcyclus (subscription_requests) en een
-- aparte, losstaande logging-tabel (license_events) voor traceerbaarheid.
-- Draai dit één keer tegen een BESTAANDE database (lokale dev-db én
-- productie); voor VERSE installaties staat dit al in db/init.sql (draait
-- automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0015_subscription_requests.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: `add column if not exists`/`create table if not exists`, en de
-- prijs-seed-updates staan achter een `and price_eur is null`-check zodat een
-- latere, handmatig aangepaste prijs nooit teruggedraaid wordt door een
-- herhaalde run van deze migratie.

-- Zelfbedieningsaanvraag ("nieuw abonnement aanvragen") — zie
-- doelenboom_licentiemodel.md §2/§9 en db/migrations/0015_subscription_requests.sql
-- voor de volledige toelichting. Dit wijkt bewust af van de eerdere §7 ("geen
-- prijsveld — prijs wordt niet in de app opgeslagen"): voor de aanvraagpagina
-- moet een aanvrager een tarief + eventuele aanbieding kunnen zien, dus komt
-- er alsnog een prijsveld bij, met geldigheidsperiode.
alter table tiers add column if not exists price_eur numeric(10,2);
alter table tiers add column if not exists price_valid_from date;
alter table tiers add column if not exists price_valid_until date;

-- Tijdelijke aanbiedingen (bv. "eerste jaar 33% korting", "nu zonder BTW"),
-- per tier instelbaar (offer_tiers). kind='percentage' → value is een
-- kortingspercentage (bv. 33.00), kind='fixed_amount' → value is een vast
-- kortingsbedrag in euro, kind='btw_vrij' → value blijft leeg (puur een
-- BTW-vrijstelling, geen bedragswijziging op de basisprijs zelf).
create table if not exists offers (
  id bigserial primary key,
  name text not null,
  kind text not null check (kind in ('percentage', 'fixed_amount', 'btw_vrij')),
  value numeric(10,2),
  valid_from date not null,
  valid_until date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);

create table if not exists offer_tiers (
  offer_id bigint not null references offers(id) on delete cascade,
  tier_id bigint not null references tiers(id) on delete cascade,
  primary key (offer_id, tier_id)
);

-- Eén aanvraag = één nieuwe tenant (1:1, vandaar tenant_id unique). status:
-- 'proef' (net aangevraagd, nog geen betaling geregistreerd — tenants.
-- license_end_date staat dan op aanvraagdatum+14 dagen, zie subscriptions.ts),
-- 'actief' (betaling geregistreerd, license_end_date is de echte contractuele
-- einddatum + de coulancemaand, zie contract_end_date hieronder) of
-- 'afgewezen'. price_at_request/applied_offer_id zijn een snapshot t.t.v. de
-- aanvraag — puur informatief/voor traceerbaarheid, geen doorlopende koppeling
-- (een latere prijs- of aanbiedingswijziging raakt bestaande aanvragen niet).
create table if not exists subscription_requests (
  id bigserial primary key,
  tenant_id bigint not null unique references tenants(id) on delete cascade,
  tier_id bigint references tiers(id) on delete set null,
  organization_name text not null,
  applicant_name text not null,
  applicant_email text not null,
  requested_modules jsonb not null default '[]'::jsonb,
  status text not null default 'proef' check (status in ('proef', 'actief', 'afgewezen')),
  requested_at timestamptz not null default now(),
  price_at_request numeric(10,2),
  applied_offer_id bigint references offers(id) on delete set null,
  payment_registered_at timestamptz,
  payment_registered_by bigint references users(id) on delete set null,
  -- Ware contractuele einddatum (dus zónder de coulancemaand) — gezet bij de
  -- (eerste) betalingsregistratie en bij elke verlenging. tenants.
  -- license_end_date (de daadwerkelijke afdwingingsdatum, zie license.ts
  -- isLicenseExpired) wordt dan op contract_end_date + 1 maand gezet: het
  -- abonnement loopt na deze datum dus nog een maand door voordat de tenant
  -- écht op alleen-lezen gaat (zie doelenboom_licentiemodel.md §6).
  contract_end_date date,
  rejected_at timestamptz,
  rejected_by bigint references users(id) on delete set null,
  rejected_reason text
);
create index if not exists idx_subscription_requests_status on subscription_requests(status);

-- Losstaande logging-module: elke handeling in de aanvraag-/verlengcyclus
-- wordt hier vastgelegd, los van de "huidige stand" in subscription_requests/
-- tenants zelf — zodat alles achteraf traceerbaar blijft, ook nadat een status
-- alweer is overschreven. performed_by is null bij een handeling door de
-- aanvrager zelf (de publieke aanvraag) of een automatische afleiding; anders
-- de sysadmin die de actie uitvoerde.
create table if not exists license_events (
  id bigserial primary key,
  tenant_id bigint references tenants(id) on delete set null,
  subscription_request_id bigint references subscription_requests(id) on delete set null,
  event_type text not null check (event_type in (
    'aangevraagd', 'betaling_geregistreerd', 'afgewezen', 'verlengd'
  )),
  detail jsonb not null default '{}'::jsonb,
  performed_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_license_events_tenant on license_events(tenant_id);
create index if not exists idx_license_events_created on license_events(created_at desc);

update tiers set price_eur = 125, price_valid_from = '2026-01-01', price_valid_until = '2026-12-31' where name = 'Single-Use' and price_eur is null;
update tiers set price_eur = 250, price_valid_from = '2026-01-01', price_valid_until = '2026-12-31' where name = 'Brons' and price_eur is null;
update tiers set price_eur = 500, price_valid_from = '2026-01-01', price_valid_until = '2026-12-31' where name = 'Zilver' and price_eur is null;
update tiers set price_eur = 1000, price_valid_from = '2026-01-01', price_valid_until = '2026-12-31' where name = 'Goud' and price_eur is null;
update tiers set price_eur = 2000, price_valid_from = '2026-01-01', price_valid_until = '2026-12-31' where name = 'Diamant' and price_eur is null;
