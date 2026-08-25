-- Migratie: licentiemodel (tiers/modules per tenant) — zie
-- doelenboom_licentiemodel.md en doelenboom_licentie_datamodel.drawio in het
-- Doelenboom-project voor het volledige ontwerp. Draai dit één keer tegen een
-- BESTAANDE database (lokale dev-db én productie) die deze tabellen nog niet
-- heeft; voor VERSE installaties staan dezelfde tabellen al in db/init.sql
-- (dat draait automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0002_licenses.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: mag zonder gevolgen twee keer gedraaid worden (create table
-- if not exists / add column if not exists / on conflict do nothing).

begin;

-- Kernidee: een tenant (= klant/licentie in de praktijk, zie db/init.sql)
-- heeft optioneel een tier (limieten voor aantal admins en aantal actieve
-- doelenbomen) en een set geactiveerde modules. Tiers en modules zijn zelf
-- gewone, door sysadmins vrij te beheren (CRUD) tabellen — geen
-- hardgecodeerde enum — en dragen bewust geen prijsveld: prijzen vallen
-- buiten de app (extern/facturatieproces).

-- Eén rij per licentietier. tenants.tier_id (hieronder) wijst hiernaar.
-- "on delete set null" bij tenants.tier_id: een tier verwijderen ontneemt een
-- tenant dus zijn tier-koppeling (terug naar "geen licentie ingesteld" =
-- onbeperkt, zie license.ts) in plaats van de tenant te blokkeren/mee te
-- cascaden — een sysadmin die per ongeluk een tier verwijdert mag nooit in
-- één klap tenants kwijtraken.
create table if not exists tiers (
  id bigserial primary key,
  name text not null unique,
  max_admins integer not null check (max_admins > 0),
  max_bomen integer not null check (max_bomen > 0),
  -- Weergavevolgorde in de sysadmin-UI (bv. Single-Use < Brons < Zilver < ...)
  -- — puur presentatie, geen logica hangt hiervan af.
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Catalogus van optionele functionele modules. "key" is de stabiele,
-- programmatische identifier (bv. 'projecten') die in code gebruikt wordt
-- (zie api/src/license.ts hasModule/requireModule) — "name"/"description"
-- zijn vrij door de sysadmin te wijzigen zonder dat bestaande koppelingen
-- (tenant_modules) of code-checks breken.
create table if not exists modules (
  id bigserial primary key,
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Welke modules een tenant heeft geactiveerd. Simpele aan/uit-koppeling (geen
-- extra velden nodig zoals einddatum — dat kan later toegevoegd worden zodra
-- er behoefte aan is); activated_at is puur informatief.
create table if not exists tenant_modules (
  tenant_id bigint not null references tenants(id) on delete cascade,
  module_id bigint not null references modules(id) on delete cascade,
  activated_at timestamptz not null default now(),
  primary key (tenant_id, module_id)
);

-- tier_id is bewust NULLABLE: null betekent "geen licentiebeperking
-- ingesteld" (onbeperkt/legacy) — de staat waarin elke tenant van vóór deze
-- migratie terechtkomt, zodat bestaande tenants met meer admins/bomen dan
-- welke tier dan ook niet per ongeluk stuklopen. Een sysadmin wijst nadien
-- expliciet een tier toe via PUT /api/tenants/:tenantId/license/tier.
-- lifetime_trees_created telt alleen op (nooit omlaag, ook niet bij
-- archiveren/verwijderen van een doelenboom) — puur voor rapportage/upsell-
-- signalering, geen rol in de harde limiet (die kijkt naar actieve bomen,
-- zie license.ts assertCanCreateBoom) — zie doelenboom_licentiemodel.md §5.
alter table tenants add column if not exists tier_id bigint references tiers(id) on delete set null;
alter table tenants add column if not exists lifetime_trees_created integer not null default 0;

-- Nodig om "actieve" (niet-gearchiveerde) doelenbomen te kunnen tellen tegen
-- de tier-limiet, en om archiveren-als-alternatief-voor-verwijderen mogelijk
-- te maken (geeft ruimte terug binnen de limiet zonder data te verliezen).
-- null = actief (de bestaande, overgrote meerderheid van rijen na migratie).
alter table doelenbomen add column if not exists archived_at timestamptz;
create index if not exists idx_doelenbomen_tenant_active
  on doelenbomen(tenant_id) where archived_at is null;

-- Startcatalogus: de vijf tiers zoals afgesproken (zie
-- doelenboom_licentiemodel.md §2) en de eerste module ("Projecten" — status/
-- RAG/producten/planning, zie routes/products.ts, routes/projectStatus.ts en
-- de gating in routes/tree.ts).
insert into tiers (name, max_admins, max_bomen, sort_order) values
  ('Single-Use', 1, 5, 0),
  ('Brons', 2, 10, 1),
  ('Zilver', 5, 25, 2),
  ('Goud', 10, 100, 3),
  ('Diamant', 25, 100, 4)
on conflict (name) do nothing;

insert into modules (key, name, description) values
  (
    'projecten',
    'Projecten',
    'Uitgebreide projectmanagement-features: status, RAG-status, producten/deliverables en planning. ' ||
    'De Project-node en de koppeling naar Capability blijven altijd onderdeel van de basis-boom, ook zonder ' ||
    'deze module — alleen deze verdiepende laag zit erachter.'
  )
on conflict (key) do nothing;

-- Backfill: elke tenant die al bestond vóór het licentiemodel had de
-- Projecten-functionaliteit (status/RAG/producten/planning) altijd al —
-- module-gating is hier nieuw, dus zonder deze backfill zou het draaien van
-- deze migratie op een bestaande (bv. productie-)database die functionaliteit
-- in één klap voor iedereen laten verdwijnen. Nieuwe tenants, aangemaakt NA
-- deze migratie, krijgen de module bewust niet automatisch (dat is voortaan
-- een expliciete, optionele toewijzing door een sysadmin — zie
-- doelenboom_licentiemodel.md §3).
-- "not exists (... tenant_modules ...)" i.p.v. alleen "on conflict do
-- nothing": dit maakt de backfill een echte eenmalige actie, ook bij een
-- tweede keer draaien van dit script. "on conflict do nothing" alleen was
-- niet genoeg geweest — dat voorkomt enkel een dubbele rij voor een tenant
-- die de backfill al had, maar zou een module die een sysadmin daarna zelf
-- weer heeft uitgezet (dus geen rij meer voor die tenant) bij een herhaalde
-- run stiekem opnieuw aanzetten. Zodra er één rij voor deze module bestaat —
-- van de backfill zelf, of van een latere sysadmin-toewijzing — slaat dit
-- blok voorgoed niets meer over: dan is dit blijvend een no-op.
insert into tenant_modules (tenant_id, module_id)
select t.id, m.id from tenants t, modules m
where m.key = 'projecten'
  and not exists (select 1 from tenant_modules tm where tm.module_id = m.id)
on conflict do nothing;

commit;
