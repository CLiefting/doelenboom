-- Migratie: doelenboom_templates-tabel toevoegen + het systeembrede
-- standaardsjabloon "Batenboom" zaaien (zie api/src/doelenboomTemplates.ts
-- en het rolmodel-overzicht in api/src/rbac.ts). Draai dit één keer tegen
-- een BESTAANDE database (lokale dev-db én productie); voor VERSE
-- installaties staat dit al in db/init.sql (draait automatisch bij de
-- allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0014_doelenboom_templates.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: `create table if not exists`, en de seed-insert staat achter
-- een `where not exists`-check (geen unique-constraint om op te conflicten,
-- zie de toelichting bij de tabel hieronder).

begin;

-- Doelenboom-sjablonen (zie db/migrations/0014_doelenboom_templates.sql):
-- een herbruikbare momentopname van een kolomconfiguratie + voorbeeldelementen
-- + hun onderlinge relaties, waarmee een NIEUWE doelenboom snel met een
-- passende structuur gestart kan worden (bv. "Batenboom", of zelf opgeslagen
-- varianten als "Programma's & projecten"). tenant_id null = systeembreed
-- sjabloon (zichtbaar/bruikbaar voor elke tenant, alleen door een sysadmin
-- aan te maken/verwijderen); tenant_id gevuld = sjabloon van die ene tenant
-- (aan te maken/verwijderen door een tenant-admin of sysadmin, alleen
-- zichtbaar/bruikbaar binnen die tenant). Ontstaat via "opslaan als sjabloon"
-- vanuit een bestaande doelenboom (api/src/doelenboomTemplates.ts) — geen
-- aparte sjabloon-editor, wijzigen = opnieuw opslaan onder een (nieuwe) naam.
-- De drie snapshot-kolommen zijn bewust JSONB i.p.v. losse tabellen: er wordt
-- nooit op individuele velden ín een snapshot gequeryd (alleen als geheel
-- gelezen bij het toepassen op een nieuwe boom), dus normaliseren voegt hier
-- alleen complexiteit toe zonder queryvoordeel. elements_snapshot verwijst
-- in edges_snapshot naar elkaar via "code" (net als de echte elements-tabel)
-- i.p.v. numerieke id's, zodat een snapshot zelfstandig leesbaar/herbruikbaar
-- blijft zonder aan ooit-bestaan-hebbende database-id's gebonden te zijn.
create table if not exists doelenboom_templates (
  id bigserial primary key,
  tenant_id bigint references tenants(id) on delete cascade,
  name text not null,
  description text not null default '',
  columns_snapshot jsonb not null,
  elements_snapshot jsonb not null,
  edges_snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_doelenboom_templates_tenant on doelenboom_templates(tenant_id);

create table if not exists project_status (
  element_id bigint primary key references elements(id) on delete cascade,
  projectstatus text not null default '' check (
    projectstatus in ('', 'Backlog', 'Actief', 'On-hold', 'Gereed', 'Vervallen')
  ),
  rag text not null default '' check (rag in ('', 'Rood', 'Oranje', 'Groen')),
  toelichting text not null default '',
  gerapporteerd_op date,
  cluster_ppt text not null default ''
);

create table if not exists products (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  code text not null default '',
  name text not null,
  -- "Planning item"-type: 'deliverable' voor een regulier (initieel) product,
  -- 'mijlpaal' voor een mijlpaal — bepaalt o.a. het symbool op de tijdbalk
  -- boven de producten/deliverables-lijst in het projectpaneel (tree.html).
  type text not null default 'deliverable' check (type in ('deliverable', 'mijlpaal')),
  omschrijving text not null default '',
  pct_gereed int not null default 0 check (pct_gereed between 0 and 100),
  verwachte_datum date,
  werkelijke_datum date,
  opmerking text not null default '',
  -- Doorlooptijd om dit planning item te realiseren — puur informatief (geen
  -- scheduling-engine die hier iets mee herberekent, net als de rest van de
  -- planning in deze app). duur mag ontbreken (NULL, nog niet ingeschat);
  -- duur_eenheid heeft altijd een waarde maar is dan irrelevant.
  duur integer,
  duur_eenheid text not null default 'd' check (duur_eenheid in ('d', 'w', 'm', 'y')),
  -- Business value: vrije numerieke inschatting van de waarde die dit
  -- planning item oplevert (bv. story points of een score) — bewust zonder
  -- vaste eenheid/valuta, de gebruiker geeft er zelf betekenis aan.
  business_value numeric,
  -- Uiterste opleverdatum — los van verwachte_datum hierboven (dat is de
  -- PLANNING; dit is de harde grens waarbinnen het alsnog moet gebeuren).
  -- Puur informatief, geen eigen "te laat"-markering (isProductOverdue in
  -- tree.html blijft uitsluitend op verwachte_datum werken).
  deadline date
);
create index if not exists idx_products_element on products(element_id);

-- Afhankelijkheden tussen planning items (deliverables/mijlpalen) binnen
-- hetzelfde project — simpeler dan activity_dependencies hieronder: een
-- planning item heeft geen startdatum (alleen een verwachte/werkelijke
-- opleverdatum, één moment in de tijd), dus een FS/SS/FF/SF-type zoals bij
-- activiteiten heeft hier geen betekenis — puur "successor hangt af van
-- predecessor", zonder type of vertraging. Puur informatief (geen
-- scheduling-engine). Beide planning items moeten bij hetzelfde
-- project-element horen — afgedwongen in de API (routes/products.ts), niet
-- in dit schema (zou een extra join in de check vereisen).
create table if not exists product_dependencies (
  id bigserial primary key,
  predecessor_id bigint not null references products(id) on delete cascade,
  successor_id bigint not null references products(id) on delete cascade,
  check (predecessor_id <> successor_id),
  unique (predecessor_id, successor_id)
);
create index if not exists idx_product_deps_predecessor on product_dependencies(predecessor_id);
create index if not exists idx_product_deps_successor on product_dependencies(successor_id);

-- Activiteiten-planning per project: anders dan products/mijlpalen hierboven
-- (één los moment — verwachte/werkelijke datum) beslaat een activiteit een
-- PERIODE (start t/m eind), getoond als inklapbare Gantt-achtige sectie onder
-- de tijdlijn in het projectpaneel (tree.html) — zie api/src/routes/activities.ts.
-- mpp_uid: de stabiele Task-UID uit een MS Project-bestand, bewaard zodat een
-- herimport van hetzelfde plan bestaande activiteiten kan bijwerken/aanbieden-
-- om-te-verwijderen i.p.v. steeds dubbele rijen toe te voegen (zie
-- computeMppImportPlan in tree.html) — NULL voor handmatig aangemaakte
-- activiteiten, die een herimport nooit aanraakt.
-- is_milestone: bij MS Project-import 1-op-1 overgenomen van de taak z'n
-- Milestone-vlag (start = eind bij een mijlpaal); ook handmatig te zetten via
-- het activiteiten-formulier. Bepaalt of de Gantt-balk (activityGanttHtml)
-- een ruit-icoon toont i.p.v. een balkje van één dag.
-- wbs: het WBS-nummer uit MS Project (bv. "2.1"), puur informatief — getoond
-- tussen haakjes vóór de taaknaam in de Gantt-rij. Net als mpp_uid alleen
-- gezet door de import en met coalesce bewaard bij een handmatige bewerking
-- (zie routes/activities.ts) — NULL voor handmatig aangemaakte activiteiten.
-- is_summary: bij MS Project-import 1-op-1 overgenomen van de taak z'n
-- Summary-vlag ("fase"/samenvattende taak); ook handmatig te zetten. Toont in
-- de Gantt een dunnere balk met eindmarkeringen i.p.v. een gewone balk.
create table if not exists activities (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  omschrijving text not null default '',
  mpp_uid text,
  is_milestone boolean not null default false,
  wbs text,
  is_summary boolean not null default false
);
create index if not exists idx_activities_element on activities(element_id);
create index if not exists idx_activities_mpp_uid on activities(element_id, mpp_uid) where mpp_uid is not null;

-- Afhankelijkheden ("dependencies") tussen twee activiteiten binnen hetzelfde
-- project — denk aan MS Project: de opvolger (successor_id) mag pas van
-- start als de voorganger (predecessor_id) aan de voorwaarde van 'type'
-- voldoet. type: FS (Finish-Start, de gebruikelijke — opvolger start pas ná
-- afloop van de voorganger) is de default; SS/FF/SF bestaan voor
-- volledigheid maar worden nergens apart afgedwongen (puur informatief/
-- visueel, net als de rest van de planning in deze app — er is geen
-- scheduling-engine die datums automatisch herberekent). lag_days: vertraging
-- (positief) of overlap/voorsprong (negatief) in dagen t.o.v. het
-- afhankelijkheidspunt, eveneens puur informatief. Beide activiteiten moeten
-- bij hetzelfde project-element horen — afgedwongen in de API (routes/
-- activities.ts), niet in dit schema (dat zou een extra join in de check
-- vereisen). on delete cascade: een afhankelijkheid verdwijnt automatisch
-- zodra een van de twee betrokken activiteiten verwijderd wordt (los
-- verwijderen of via "Alles wissen").
create table if not exists activity_dependencies (
  id bigserial primary key,
  predecessor_id bigint not null references activities(id) on delete cascade,
  successor_id bigint not null references activities(id) on delete cascade,
  type text not null default 'FS' check (type in ('FS', 'SS', 'FF', 'SF')),
  lag_days integer not null default 0,
  check (predecessor_id <> successor_id),
  unique (predecessor_id, successor_id)
);
create index if not exists idx_activity_deps_predecessor on activity_dependencies(predecessor_id);
create index if not exists idx_activity_deps_successor on activity_dependencies(successor_id);

create table if not exists tags (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  code text not null,
  name text not null,
  categorie text not null default '',
  omschrijving text not null default '',
  unique (doelenboom_id, code)
);

create table if not exists element_tags (
  element_id bigint not null references elements(id) on delete cascade,
  tag_id bigint not null references tags(id) on delete cascade,
  toelichting text not null default '',
  primary key (element_id, tag_id)
);

create table if not exists org_units (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  code text not null,
  name text not null,
  omschrijving text not null default '',
  unique (doelenboom_id, code)
);

create table if not exists ob_org_relations (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  org_unit_id bigint not null references org_units(id) on delete cascade,
  relatietype text not null check (relatietype in ('Primair', 'Ondersteunend', 'Betrokken')),
  toelichting text not null default '',
  status text not null default 'Concept' check (status in ('Concept', 'Gevalideerd', 'Vervallen')),
  unique (element_id, org_unit_id)
);

create table if not exists excel_imports (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  uploaded_by bigint references users(id) on delete set null,
  filename text not null,
  uploaded_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'ok', 'warnings', 'failed', 'published')),
  report_json jsonb not null default '{}'::jsonb,
  parsed_json jsonb not null default '{}'::jsonb,
  published_at timestamptz
);
create index if not exists idx_imports_doelenboom on excel_imports(doelenboom_id);

-- Licentiemodel (zie doelenboom_licentiemodel.md en
-- doelenboom_licentie_datamodel.drawio in het Doelenboom-project, en
-- db/migrations/0002_licenses.sql voor de toelichting bij elk onderdeel
-- hieronder — hier verder niet herhaald, dit is dezelfde DDL zodat een verse
-- installatie meteen op v2 van het schema start).

create table if not exists tiers (
  id bigserial primary key,
  name text not null unique,
  max_admins integer not null check (max_admins > 0),
  max_bomen integer not null check (max_bomen > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists modules (
  id bigserial primary key,
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tenant_modules (
  tenant_id bigint not null references tenants(id) on delete cascade,
  module_id bigint not null references modules(id) on delete cascade,
  activated_at timestamptz not null default now(),
  primary key (tenant_id, module_id)
);

alter table tenants add column if not exists tier_id bigint references tiers(id) on delete set null;
alter table tenants add column if not exists lifetime_trees_created integer not null default 0;
-- Licentie-einddatum (zie db/migrations/0003_license_expiry.sql voor de
-- volledige toelichting) — null = geen einddatum ingesteld/nooit verlopen.
alter table tenants add column if not exists license_end_date date;

-- Open toegang (zie db/migrations/0013_tenant_open_access.sql): als gezet,
-- krijgt ELK account met een login — ook zonder een eigen tenant_users-rij —
-- automatisch minstens deze rol binnen deze tenant (zie getTenantRole in
-- api/src/rbac.ts). null (default) = huidig gedrag: alleen expliciete
-- tenant_users-leden hebben toegang. Bedoeld voor bv. de Demo-tenant, zodat
-- niet elk nieuw account er handmatig aan toegevoegd hoeft te worden. Een
-- expliciete tenant_users-rol voor een gebruiker wint altijd van deze open-
-- toegang-rol (zie getTenantRole) — dit kan dus nooit iemands eigen,
-- specifiek toegekende rol verlagen, alleen een ondergrens bieden voor wie
-- geen eigen rij heeft.
alter table tenants add column if not exists open_access_role text
  check (open_access_role in ('admin', 'gebruiker', 'bezoeker'));

alter table doelenbomen add column if not exists archived_at timestamptz;
create index if not exists idx_doelenbomen_tenant_active
  on doelenbomen(tenant_id) where archived_at is null;

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

-- Eén systeembrede mededeling (bv. een onderhoudsaankondiging), door een
-- sysadmin aan/uit te zetten met een eigen tekst — zie routes/announcement.ts.
-- Singleton-tabel (id altijd true, zie de check hieronder): er is precies één
-- rij, die steeds overschreven wordt in plaats van nieuwe rijen toe te voegen.
-- GET is bewust ongeauthenticeerd (ook zichtbaar vóór inloggen — juist dan wil
-- je bv. "gepland onderhoud, log op tijd uit" kunnen tonen), PUT is
-- sysadmin-only.
create table if not exists system_announcements (
  id boolean primary key default true check (id),
  message text not null default '',
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by bigint references users(id) on delete set null
);
insert into system_announcements (id) values (true) on conflict (id) do nothing;

-- Systeembreed standaardsjabloon "Batenboom": dezelfde 8 standaardkolommen
-- als standardColumns() in api/src/columnConfig.ts, alleen zonder de
-- tenantnaam-interpolatie die die functie toepast (een systeembreed sjabloon
-- is niet van één tenant, dus kan geen tenantnaam in de titels bakken).
-- Elementen/relaties: hetzelfde generieke "Voorbeeld van
-- <type>"-pad (V1..V8) dat seedExampleTree() tot nu toe hardcoded aanmaakte
-- — dit sjabloon vervangt die functie functioneel voor nieuwe doelenbomen
-- (zie api/src/routes/doelenbomen.ts), zonder dat het gedrag voor bestaande
-- gebruikers verandert. where not exists: idempotent, want deze insert heeft
-- geen unique-constraint om op te conflicten (zie doelenboom_templates
-- hierboven — geen unique(tenant_id, name), want tenant_id kan null zijn).
insert into doelenboom_templates (tenant_id, name, description, columns_snapshot, elements_snapshot, edges_snapshot)
select
  null,
  'Batenboom',
  'De standaard batenboom-structuur: van project via capabilities en benefits naar de missie.',
  $cols$[
    {"position":0,"typeName":"Project","title":"Project","subtitle":"Welke projecten ontwikkelen deze capability?","color":"#3E6FA6","isNarrow":true,"nodeFontSize":null,"isProjectRole":true,"relationLabelToNext":"ontwikkelt"},
    {"position":1,"typeName":"Capability","title":"Capability","subtitle":"Welk vermogen wordt hiermee opgebouwd?","color":"#6B4C8A","isNarrow":true,"nodeFontSize":null,"isProjectRole":false,"relationLabelToNext":"ondersteunt"},
    {"position":2,"typeName":"Operationele benefit","title":"Operationele benefit","subtitle":"Welke operationele verbetering levert dit op? Wat verandert er in de dagelijkse uitvoering?","color":"#C05A2C","isNarrow":false,"nodeFontSize":null,"isProjectRole":false,"relationLabelToNext":"realiseert"},
    {"position":3,"typeName":"Sub-benefit","title":"Sub-benefit","subtitle":"Welk direct effect ontstaat hierdoor?","color":"#B8862E","isNarrow":false,"nodeFontSize":null,"isProjectRole":false,"relationLabelToNext":"versterkt"},
    {"position":4,"typeName":"Programmabaat","title":"Programmabaat","subtitle":"Welke waarde levert dit op voor de organisatie?","color":"#2E7D5B","isNarrow":false,"nodeFontSize":null,"isProjectRole":false,"relationLabelToNext":"draagt bij aan"},
    {"position":5,"typeName":"Strategische benefit","title":"Strategisch benefit","subtitle":"Wat betekent dit voor de organisatie?","color":"#8FAADC","isNarrow":false,"nodeFontSize":10,"isProjectRole":false,"relationLabelToNext":"ondersteunt"},
    {"position":6,"typeName":"Strategisch doel","title":"Strategisch doel","subtitle":"Welk doel ondersteunt dit?","color":"#2F5597","isNarrow":false,"nodeFontSize":12,"isProjectRole":false,"relationLabelToNext":"geeft invulling aan"},
    {"position":7,"typeName":"Missie","title":"Missie","subtitle":"Waarom doen we dit uiteindelijk?","color":"#203864","isNarrow":false,"nodeFontSize":10,"isProjectRole":false,"relationLabelToNext":null}
  ]$cols$::jsonb,
  $els$[
    {"code":"V1","type":"Project","name":"Voorbeeld van Project","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":1},
    {"code":"V2","type":"Capability","name":"Voorbeeld van Capability","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":2},
    {"code":"V3","type":"Operationele benefit","name":"Voorbeeld van Operationele benefit","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":3},
    {"code":"V4","type":"Sub-benefit","name":"Voorbeeld van Sub-benefit","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":4},
    {"code":"V5","type":"Programmabaat","name":"Voorbeeld van Programmabaat","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":5},
    {"code":"V6","type":"Strategische benefit","name":"Voorbeeld van Strategische benefit","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":6},
    {"code":"V7","type":"Strategisch doel","name":"Voorbeeld van Strategisch doel","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":7},
    {"code":"V8","type":"Missie","name":"Voorbeeld van Missie","description":"","parentText":"","kpi":"","taakveld":"","subtaakveld":"","sortOrder":8}
  ]$els$::jsonb,
  $edg$[
    {"sourceCode":"V1","targetCode":"V2","weight":"primair","toelichting":"ontwikkelt"},
    {"sourceCode":"V2","targetCode":"V3","weight":"primair","toelichting":"ondersteunt"},
    {"sourceCode":"V3","targetCode":"V4","weight":"primair","toelichting":"realiseert"},
    {"sourceCode":"V4","targetCode":"V5","weight":"primair","toelichting":"versterkt"},
    {"sourceCode":"V5","targetCode":"V6","weight":"primair","toelichting":"draagt bij aan"},
    {"sourceCode":"V6","targetCode":"V7","weight":"primair","toelichting":"ondersteunt"},
    {"sourceCode":"V7","targetCode":"V8","weight":"primair","toelichting":"geeft invulling aan"}
  ]$edg$::jsonb
where not exists (select 1 from doelenboom_templates where tenant_id is null and name = 'Batenboom');

commit;
