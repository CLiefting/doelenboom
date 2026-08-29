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
