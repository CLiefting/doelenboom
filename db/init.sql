-- Doelenboom platform — datamodel v1
-- Zie doelenboom_datamodel.drawio voor het ERD. Deze migratie is bewust nog "plat"
-- (één init.sql, geen migratietool) — prima voor v1/lokaal; in een latere sprint
-- overzetten naar een echte migratietool (bv. node-pg-migrate of Prisma) zodra er
-- meerdere omgevingen/ontwikkelaars bijkomen.

create extension if not exists pgcrypto;

-- Rolmodel (v2): een gebruiker is óf sysadmin (is_sysadmin=true — globaal, mag
-- alles, incl. tenants aanmaken en alle gebruikers beheren), óf heeft per tenant
-- een rol via tenant_users (zie hieronder, na de tenants-tabel): 'admin' (mag
-- wijzigen binnen die tenant) of 'gebruiker' (alleen lezen). Eén account kan in
-- meerdere tenants zitten, met eventueel een andere rol per tenant.
create table if not exists users (
  id bigserial primary key,
  email text not null unique,
  password_hash text not null,
  is_sysadmin boolean not null default false,
  -- Gezet op true wanneer een sysadmin een account aanmaakt of een wachtwoord
  -- reset (dan kent de gebruiker zelf het wachtwoord niet als "van hemzelf").
  -- De frontend dwingt dan bij de eerstvolgende login een wachtwoordwijziging af
  -- (zie POST /api/auth/change-password) en zet 'm daarna terug op false.
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);

-- Eén rij per ingelogde sessie (niet per request) — nodig omdat een JWT zelf
-- stateless is en de server dus niet weet of een browser nog open staat.
-- last_seen_at wordt elke minuut bijgewerkt door een heartbeat vanuit de frontend
-- zolang de tab open is; ended_at wordt gezet bij een expliciete logout. Gebruikt
-- door de "tenant leegmaken bij vertrek laatste gebruiker"-functionaliteit
-- (api/src/tenantWipe.ts) — zie ook tenants.wipe_on_empty/session_timeout_minutes.
--
-- last_activity_at is bewust een APART veld van last_seen_at: last_seen_at
-- wordt door een blinde timer bijgewerkt (elke minuut, zolang de tab maar open
-- staat — ook zonder dat er iemand iets doet) en blijft dat ook, want de
-- wipe-functionaliteit hierboven moet "tab staat open" blijven betekenen.
-- last_activity_at wordt alleen bijgewerkt door échte gebruikersactiviteit
-- (muis/toetsenbord/scroll/touch, zie POST /api/auth/activity, gethrottled tot
-- max 1x/minuut vanuit de frontend) en is de basis voor de 15-minuten-
-- inactiviteit-uitlog-beveiliging (requireAuth in api/src/auth.ts).
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists idx_sessions_active on sessions(user_id) where ended_at is null;

create table if not exists tenants (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  -- Sinds meerdere doelenbomen per tenant mogelijk zijn (zie doelenbomen.
  -- wipe_on_empty hieronder) is dít hier niet meer de daadwerkelijke
  -- aan/uit-schakelaar voor het automatisch leegmaken — dat staat nu per
  -- doelenboom. Dit tenant-veld is alleen nog de standaardwaarde waarmee een
  -- nieuwe doelenboom in deze tenant wordt aangemaakt (zie POST
  -- /api/tenants/:tenantId/doelenbomen), zodat je 'm niet elke keer opnieuw
  -- hoeft te zetten.
  wipe_on_empty boolean not null default false,
  -- Na hoeveel minuten zonder actieve sessie deze tenant als "verlaten" geldt
  -- — dit blijft wél tenant-breed (een sessie heeft toegang tot de hele
  -- tenant, niet tot één specifieke doelenboom), zie tenantWipe.ts.
  session_timeout_minutes integer not null default 30 check (session_timeout_minutes > 0),
  created_at timestamptz not null default now()
);

-- Koppelt gebruikers aan tenants met een rol (zie het commentaar bij de
-- users-tabel). Sysadmins hebben hier bewust geen rij voor nodig — hun toegang
-- volgt uit users.is_sysadmin en geldt voor alle tenants.
-- Rolmodel (zie api/src/rbac.ts): 'admin' (boom-inhoud + instellingen),
-- 'gebruiker' (alleen losse boom-inhoud: elementen/relaties/tags-koppelingen/
-- projectstatus/producten, geen kolommen/instellingen/import), 'bezoeker'
-- (alleen lezen).
create table if not exists tenant_users (
  id bigserial primary key,
  tenant_id bigint not null references tenants(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'gebruiker', 'bezoeker')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists idx_tenant_users_user on tenant_users(user_id);

create table if not exists doelenbomen (
  id bigserial primary key,
  tenant_id bigint not null references tenants(id) on delete cascade,
  slug text not null,
  name text not null,
  -- Als true: alleen sysadmins mogen nog wijzigen (elementen/relaties/tags/
  -- organisatieonderdelen/imports) — tenant-admins en gebruikers krijgen dan
  -- overal read-only te zien, ook al zouden ze normaal wel schrijfrechten
  -- hebben (zie requireWritableDoelenboom in api/src/rbac.ts). Hernoemen/
  -- verwijderen van de doelenboom zelf, en deze vlag omzetten, blijft wél
  -- gewoon voor tenant-admins mogelijk — dat is geen "boom-inhoud" maar
  -- tenant-beheer.
  read_only boolean not null default false,
  -- Als true: zodra geen enkele actieve sessie meer toegang heeft tot de
  -- tenant van deze doelenboom (session_timeout_minutes, zie tenants
  -- hierboven en tenantWipe.ts), wordt de inhoud van déze doelenboom
  -- automatisch geleegd — andere doelenbomen in dezelfde tenant zonder deze
  -- vlag blijven met rust. Per doelenboom instelbaar (i.p.v. tenant-breed)
  -- sinds een tenant meerdere doelenbomen kan hebben; bij het aanmaken wordt
  -- 'm standaard gevuld met tenants.wipe_on_empty.
  wipe_on_empty boolean not null default false,
  -- Drempel (in dagen) voor de 'verouderd'-markering op projectelementen —
  -- zie project_status.updated_at hieronder en isStale() in tree.html. Eén
  -- vaste waarde per doelenboom, door een admin instelbaar (PUT
  -- /api/doelenbomen/:id), zie db/migrations/0020_project_status_review.sql
  -- voor de volledige toelichting.
  stale_after_days integer not null default 60 check (stale_after_days between 1 and 3650),
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- Overrulet, per doelenboom, de rol uit tenant_users voor die ene gebruiker —
-- bv. een tenant-admin die op één specifieke doelenboom als gebruiker (alleen
-- lezen) behandeld moet worden, of andersom. Geen rij hier = "gewoon de
-- tenant-rol" (het overgrote-meerderheid-geval). Een gebruiker moet nog altijd
-- lid van de tenant zijn (tenant_users) om hier überhaupt toegang te krijgen —
-- deze tabel kán geen toegang geven aan iemand die geen tenant-lid is, alleen
-- de rol bínnen een toegankelijke doelenboom bijstellen. Zie
-- getEffectiveRoleForDoelenboom in api/src/rbac.ts.
create table if not exists doelenboom_user_roles (
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'gebruiker', 'bezoeker')),
  primary key (doelenboom_id, user_id)
);

-- Configureerbare kolommen (zie docs/kolommen-configuratie-ontwerp.md).
-- Eén rij per "kolomset": ofwel de tenant-default (scope='tenant_default',
-- één per tenant — het sjabloon waarmee een nieuwe doelenboom start), ofwel
-- de eigen, onafhankelijke config van één specifieke doelenboom
-- (scope='doelenboom'). Een doelenboom-config is een KOPIE van de op dat
-- moment geldende tenant-default op het moment van aanmaken, geen levende
-- verwijzing — wijzig je de tenant-default later, dan verandert een
-- al-bestaande doelenboom dus niet automatisch mee.
create table if not exists column_configs (
  id bigserial primary key,
  scope text not null check (scope in ('tenant_default', 'doelenboom')),
  tenant_id bigint not null references tenants(id) on delete cascade,
  doelenboom_id bigint references doelenbomen(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'doelenboom') = (doelenboom_id is not null))
);
create unique index if not exists idx_column_configs_tenant_default
  on column_configs(tenant_id) where (scope = 'tenant_default');
create unique index if not exists idx_column_configs_doelenboom
  on column_configs(doelenboom_id) where (scope = 'doelenboom');

-- Eén rij per kolom binnen een column_configs-set, links-naar-rechts via
-- position (0-based). type_name is de vrije, door de tenant/doelenboom
-- gekozen naam van het elementtype dat in deze kolom getoond wordt (1-op-1:
-- elke kolom toont precies één type) — elements.type verwijst hiernaar via
-- de tekstwaarde, niet via een foreign key (zie toelichting bij elements
-- hieronder: dat blijft nodig voor de Excel-rondgang, die al op tekst draait).
-- is_project_role: precies één kolom per config moet dit zijn — daaraan
-- hangt de speciale functionaliteit (projectkaart, planning-items,
-- projectstatus, project-tijdlijnenoverzicht) vast, ongeacht hoe die kolom
-- genoemd is. relation_label_to_next is de tekst op de pijl naar de
-- eerstvolgende kolom (bv. "ontwikkelt") — null bij de laatste kolom, die
-- heeft geen volgende.
create table if not exists columns (
  id bigserial primary key,
  column_config_id bigint not null references column_configs(id) on delete cascade,
  position int not null,
  type_name text not null,
  title text not null,
  subtitle text not null default '',
  color text not null,
  is_narrow boolean not null default false,
  node_font_size int,
  is_project_role boolean not null default false,
  relation_label_to_next text,
  unique (column_config_id, position),
  unique (column_config_id, type_name)
);
create index if not exists idx_columns_config on columns(column_config_id);

create table if not exists elements (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  code text not null,
  -- Geen check-constraint meer op een vaste lijst (was: 'Project',
  -- 'Capability', ... — zie kolommen-configuratie-ontwerp.md): welke typen
  -- geldig zijn, hangt nu af van de columns-configuratie van de doelenboom
  -- (columns.type_name) en wordt op API-niveau gevalideerd, niet meer in de
  -- database — dat kan per doelenboom verschillen, een vaste check-constraint
  -- kan dat niet uitdrukken. Blijft een gewoon tekstveld (geen foreign key)
  -- omdat de Excel-import/export al op tekstwaarden draait.
  type text not null,
  name text not null,
  description text not null default '',
  parent_text text not null default '',
  kpi text not null default '',
  taakveld text not null default '',
  subtaakveld text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doelenboom_id, code)
);
create index if not exists idx_elements_doelenboom on elements(doelenboom_id);
create index if not exists idx_elements_type on elements(doelenboom_id, type);

create table if not exists edges (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  source_element_id bigint not null references elements(id) on delete cascade,
  target_element_id bigint not null references elements(id) on delete cascade,
  weight text check (weight in ('primair', 'ondersteunend') or weight is null),
  toelichting text not null default '',
  unique (source_element_id, target_element_id)
);
create index if not exists idx_edges_doelenboom on edges(doelenboom_id);
create index if not exists idx_edges_source on edges(source_element_id);
create index if not exists idx_edges_target on edges(target_element_id);

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
  cluster_ppt text not null default '',
  -- 'Laatst bijgewerkt' (door wie, wanneer) — ALLEEN door de server gezet
  -- (now() + de ingelogde gebruiker), bij elke PUT en bij de losse
  -- "markeer als gecontroleerd"-actie (POST .../project-status/touch, zie
  -- api/src/routes/projectStatus.ts). Bewust een ander veld dan
  -- gerapporteerd_op hierboven (dat is vrij invoerbaar door de gebruiker) —
  -- zie db/migrations/0020_project_status_review.sql voor de volledige
  -- toelichting, incl. waarom null hier meetelt als "verouderd".
  updated_at timestamptz,
  updated_by bigint references users(id) on delete set null
);

-- Generieke wijzigingshistorie per project-element (status, deliverables én
-- activiteiten door elkaar, nieuwste eerst) — zie
-- db/migrations/0022_project_history.sql voor de volledige toelichting.
-- Eén rij per create/update/delete/touch op project_status/products/
-- activities; voor altijd bewaard, geen opschoning.
create table if not exists project_history (
  id bigserial primary key,
  element_id bigint not null references elements(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by bigint references users(id) on delete set null,
  kind text not null check (kind in ('status', 'product', 'activity')),
  action text not null check (action in ('create', 'update', 'delete', 'touch')),
  label text not null default '',
  changes jsonb not null default '{}'::jsonb
);

create index if not exists idx_project_history_element
  on project_history (element_id, changed_at desc);

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
-- hetzelfde project — analoog aan activity_dependencies hieronder (type +
-- vertraging), maar de API staat vooralsnog alleen 'FS' toe (zie
-- routes/products.ts: "initieel alleen een EB/FS-relatie", Charles kan dit
-- later oprekken naar SS/FF/SF zonder nieuwe migratie omdat de kolom er al
-- klaar voor staat). Puur informatief (geen scheduling-engine, net als
-- activity_dependencies) — de pijl in de Activiteiten-Gantt (tree.html:
-- activityGanttHtml) is puur het passieve visuele resultaat, lag_amount/
-- lag_eenheid beïnvloeden de positie van die pijl niet.
--
-- lag_amount/lag_eenheid i.p.v. het kale lag_days van activity_dependencies:
-- Charles wilde de vertraging expliciet in dagen/weken/maanden kunnen
-- opgeven en zo ook weer terugzien (i.p.v. alles omgerekend naar dagen) —
-- zelfde opzet als duur/duur_eenheid op products hierboven, alleen zonder
-- 'y' (jaren): voor een vertraging tussen twee planning items binnen één
-- project is dat een onrealistische eenheid.
--
-- Beide planning items moeten bij hetzelfde project-element horen —
-- afgedwongen in de API (routes/products.ts), niet in dit schema (zou een
-- extra join in de check vereisen).
create table if not exists product_dependencies (
  id bigserial primary key,
  predecessor_id bigint not null references products(id) on delete cascade,
  successor_id bigint not null references products(id) on delete cascade,
  type text not null default 'FS' check (type in ('FS', 'SS', 'FF', 'SF')),
  lag_amount integer not null default 0,
  lag_eenheid text not null default 'd' check (lag_eenheid in ('d', 'w', 'm')),
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
  -- Generieke velden voor een "gratis proeftier" zoals Evaluatie (zie
  -- db/migrations/0018_evaluatie_tier.sql) i.p.v. dit hard te coderen als
  -- uitzondering voor één specifieke tiernaam — consistent met "tiers zijn
  -- volledig door sysadmins beheerbaar, geen vaste hardgecodeerde set".
  -- trial_days: proefduur in dagen bij een zelfbedieningsaanvraag op deze
  -- tier (null = standaard TRIAL_DAYS uit subscriptions.ts). all_modules_
  -- included: bij zo'n aanvraag worden ALLE bestaande modules geactiveerd,
  -- ongeacht wat de aanvrager zelf aanvinkte.
  trial_days integer,
  all_modules_included boolean not null default false,
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

-- Evaluatie: gratis proeftier (zie db/migrations/0018_evaluatie_tier.sql) —
-- 1 admin, 2 bomen, 30 dagen proefperiode, alle modules automatisch aan.
-- sort_order -1 zet 'm vóór Single-Use in de tier-lijst/aanvraagpagina.
insert into tiers (name, max_admins, max_bomen, sort_order, trial_days, all_modules_included) values
  ('Evaluatie', 1, 2, -1, 30, true)
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

-- Zelfbedieningsaanvraag ("nieuw abonnement aanvragen") — zie
-- doelenboom_licentiemodel.md §2/§9 en db/migrations/0015_subscription_requests.sql
-- + 0016_price_history.sql voor de volledige toelichting. Dit wijkt bewust af
-- van de eerdere §7 ("geen prijsveld — prijs wordt niet in de app
-- opgeslagen"): voor de aanvraagpagina moet een aanvrager een tarief +
-- eventuele aanbieding kunnen zien.
--
-- Prijs (en, voor modules, opslagpercentage) is GEEN los veld op tiers/
-- modules zelf: een abonnement heeft door de tijd heen meerdere tarieven
-- (bv. € 125/jaar in 2026, een ander tarief in 2027), dus dit is een eigen
-- geschiedenis-tabel — zie api/src/tierPrices.ts / api/src/moduleSurcharges.ts.
-- Meerdere (ook overlappende) periodes per tier/module zijn toegestaan; bij
-- overlap wint de meest recent gestarte periode (zie getCurrentTierPrice/
-- getCurrentModuleSurcharge) — de UI markeert duidelijk welke op dit moment
-- geldig is.
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
  -- Optioneel — zie db/migrations/0019_applicant_phone.sql: niet elke
  -- organisatie wil een telefoonnummer opgeven, dus bewust geen "not null".
  applicant_phone text,
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

-- Eerste geldige prijsperiode per tier (2026 kalenderjaar, bevestigde
-- tarieven — zie doelenboom_licentiemodel.md §2). "not exists"-guard i.p.v.
-- "on conflict" (er is geen unique constraint op tier_id — meerdere periodes
-- per tier zijn juist bedoeld) zodat dit blok alleen bij een verse tier-rij
-- zonder enige prijs iets invoegt, nooit een dubbele seed bij herhaald draaien.
insert into tier_prices (tier_id, price_eur, valid_from, valid_until)
select t.id, v.price_eur, '2026-01-01', '2026-12-31'
from tiers t
join (values ('Single-Use', 125), ('Brons', 250), ('Zilver', 500), ('Goud', 1000), ('Diamant', 2000), ('Evaluatie', 0)) as v(name, price_eur)
  on v.name = t.name
where not exists (select 1 from tier_prices tp where tp.tier_id = t.id);

-- Initiële module-opslagpercentages (doelenboom_licentiemodel.md §3):
-- Projecten 20%. Templating (10%, per het document) heeft nog geen eigen rij
-- in `modules` (de Sjablonenbeheer-feature is nu nog los van het
-- licentiemodel) — die opslag zaaien we pas zodra die module-rij bestaat.
-- KPI/Backup/Auditing: nog niet bepaald, bewust geen rij (zo'n module telt
-- dan simpelweg niet mee in de aanvraagprijs, zie moduleSurcharges.ts).
insert into module_surcharges (module_id, surcharge_pct, valid_from, valid_until)
select m.id, v.surcharge_pct, '2026-01-01', '2026-12-31'
from modules m
join (values ('projecten', 20)) as v(key, surcharge_pct)
  on v.key = m.key
where not exists (select 1 from module_surcharges ms where ms.module_id = m.id);

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

-- Juridische documenten (gebruiksvoorwaarden/privacyverklaring) met
-- versiebeheer + acceptatie, en het inactiviteitsbeleid voor gebruikers-
-- accounts (zie db/migrations/0017_legal_and_retention.sql voor de volledige
-- toelichting per tabel/kolom -- hieronder dezelfde definities, voor een
-- verse installatie).
create table if not exists legal_documents (
  id bigserial primary key,
  doc_type text not null check (doc_type in ('terms', 'privacy')),
  version text not null,
  effective_date date not null,
  published_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'published')),
  requires_reacceptance boolean not null default true,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_type, version)
);
create index if not exists idx_legal_documents_current on legal_documents(doc_type, status, published_at desc);

create table if not exists legal_acceptances (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  legal_document_id bigint not null references legal_documents(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  unique (user_id, legal_document_id)
);
create index if not exists idx_legal_acceptances_user on legal_acceptances(user_id);

alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists inactivity_warning_sent_at timestamptz;
alter table users add column if not exists scheduled_deletion_at timestamptz;
create index if not exists idx_users_scheduled_deletion on users(scheduled_deletion_at) where scheduled_deletion_at is not null;

create table if not exists account_retention_events (
  id bigserial primary key,
  user_id bigint references users(id) on delete set null,
  event_type text not null check (event_type in (
    'warning_scheduled', 'warning_sent', 'warning_send_failed',
    'deletion_cancelled_by_login', 'account_deleted', 'deletion_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_retention_events_user on account_retention_events(user_id);
create index if not exists idx_retention_events_created on account_retention_events(created_at desc);

-- Gebruiksvoorwaarden v0.3, letterlijk overgenomen -- zie de toelichting bij
-- migratie 0017. Status 'draft' (niet 'published'): de tekst is zelf nog een
-- niet-juridisch-getoetst concept ("Conceptversie 0.3", zie de tekst zelf) en
-- wordt daarom nu getoond maar niet als bindend afgedwongen -- zie
-- docs/juridische-documenten-en-retentie.md.
insert into legal_documents (doc_type, version, effective_date, published_at, status, content)
values ('terms', '0.3', '2026-08-30', null, 'draft', $doc$
Eigenaar: Code072.nl
Status: Concept – voor juridische toetsing
Datum: 30 augustus 2026
Documentenset: Gebruiksvoorwaarden; afzonderlijke privacyverklaring volgt

DOELENBOOM
Gebruiksvoorwaarden
Conceptversie 0.3

Werkdocument. Laat de definitieve voorwaarden vóór publicatie juridisch toetsen.

Deze conceptvoorwaarden zijn opgesteld voor de applicatie Doelenboom. Code072.nl is eigenaar van Doelenboom en is voornemens zich bij de Kamer van Koophandel te registreren als startende organisatie. Na registratie moeten de definitieve handelsnaam/rechtsvorm, het KvK-nummer, vestigingsadres en eventuele btw-gegevens worden toegevoegd. De aansprakelijkheid is in dit concept zo vergaand mogelijk uitgesloten, steeds voor zover dat onder dwingend Nederlands recht is toegestaan.

## 1. Algemeen
Deze gebruiksvoorwaarden zijn van toepassing op het gebruik van de applicatie Doelenboom en de daarbij behorende diensten die door Code072.nl beschikbaar worden gesteld.
Doelenboom is een applicatie waarmee organisaties doelen, resultaten, benefits, activiteiten, projecten en andere elementen kunnen vastleggen en de onderlinge relaties tussen deze elementen inzichtelijk kunnen maken.
Door gebruik te maken van Doelenboom gaat de gebruiker akkoord met deze gebruiksvoorwaarden.
Waar in deze voorwaarden wordt gesproken over organisatie, wordt bedoeld de organisatie waarvoor een omgeving binnen Doelenboom beschikbaar is gesteld. Onder gebruiker wordt verstaan iedere persoon die namens of met toestemming van een organisatie toegang heeft tot Doelenboom.

## 2. Doel en aard van Doelenboom
Doelenboom ondersteunt organisaties bij het structureren, vastleggen en visualiseren van doelen en de relaties tussen verschillende onderdelen van een organisatie, programma, portfolio of project.
De applicatie is uitsluitend een ondersteunend hulpmiddel voor analyse, communicatie, monitoring en besluitvorming. Doelenboom neemt geen besluiten namens de gebruiker of organisatie en de uitkomsten van Doelenboom gelden niet als zelfstandig advies.
De organisatie en de gebruiker blijven te allen tijde verantwoordelijk voor de interpretatie van de opgenomen informatie en voor alle beoordelingen, conclusies, keuzes, handelingen en besluiten die geheel of gedeeltelijk op deze informatie worden gebaseerd.

## 3. Toegang en gebruiksrecht
De organisatie krijgt gedurende de looptijd van de overeenkomst een niet-exclusief en niet-overdraagbaar recht om Doelenboom te gebruiken voor de eigen bedrijfs- of organisatiedoeleinden.
Het gebruiksrecht omvat uitsluitend de functionaliteiten die binnen de overeengekomen omgeving en het gekozen abonnement of de gemaakte afspraken beschikbaar zijn.
Zonder voorafgaande toestemming van Code072.nl is het niet toegestaan toegang tot Doelenboom aan derden te verkopen of commercieel beschikbaar te stellen, de applicatie geheel of gedeeltelijk te kopiëren anders dan voor zover wettelijk toegestaan, de broncode of technische werking door reverse engineering te achterhalen voor zover een verbod wettelijk is toegestaan, beveiligingsmaatregelen te omzeilen of Doelenboom te gebruiken op een wijze die de werking of beveiliging kan verstoren.

## 4. Gebruikersaccounts en autorisaties
Toegang tot Doelenboom vindt plaats via persoonlijke gebruikersaccounts. Een gebruikersaccount mag uitsluitend worden gebruikt door de persoon aan wie het account is verstrekt.
Gebruikers zijn verantwoordelijk voor het zorgvuldig omgaan met hun toegangsgegevens. De organisatie bepaalt welke personen toegang krijgen tot haar omgeving en welke rechten of rollen aan deze personen worden toegekend.
De organisatie is verantwoordelijk voor het tijdig aanpassen of intrekken van toegangsrechten wanneer deze niet langer noodzakelijk zijn. Vermoedens van misbruik of ongeautoriseerde toegang dienen zo spoedig mogelijk te worden gemeld.

### 4.1 Inactieve gebruikersaccounts
Een gebruikersaccount dat gedurende een aaneengesloten periode van twaalf (12) maanden niet is gebruikt, wordt door Code072.nl automatisch verwijderd.
Voor het bepalen van de periode van inactiviteit wordt uitgegaan van de laatste succesvolle aanmelding van de gebruiker of, indien binnen Doelenboom een andere betrouwbare registratie van relevant gebruik wordt gehanteerd, het laatst geregistreerde relevante gebruik.
Code072.nl stuurt, voor zover het bij het gebruikersaccount geregistreerde e-mailadres bereikbaar is, circa dertig (30) dagen vóór de geplande verwijdering een waarschuwing per e-mail. De gebruiker wordt hiermee geïnformeerd dat het account wegens langdurige inactiviteit zal worden verwijderd en op welke datum de verwijdering is voorzien.
Wanneer de gebruiker vóór de aangekondigde verwijderdatum opnieuw succesvol inlogt op Doelenboom, wordt het account niet wegens inactiviteit verwijderd en begint de periode van twaalf (12) maanden opnieuw.
Het niet ontvangen, afleveren, openen of lezen van de waarschuwing voorkomt de automatische verwijdering niet. De gebruiker is zelf verantwoordelijk voor het actueel houden van het aan het account gekoppelde e-mailadres.
Na verwijdering van een inactief gebruikersaccount kan de gebruiker niet langer met dit account inloggen. Indien opnieuw toegang tot Doelenboom nodig is, dient een nieuw account te worden aangemaakt of verstrekt.
Het verwijderen van een individueel gebruikersaccount betekent niet automatisch dat gegevens die de gebruiker namens een organisatie in Doelenboom heeft vastgelegd worden verwijderd. Deze gegevens kunnen onderdeel zijn van de gegevens van de organisatie en blijven in dat geval binnen de omgeving van de organisatie beschikbaar.
Persoonsgegevens die uitsluitend noodzakelijk waren voor het verwijderde gebruikersaccount worden verwijderd of geanonimiseerd, tenzij Code072.nl deze gegevens op grond van een wettelijke verplichting of een ander gerechtvaardigd doel langer dient te bewaren.

## 5. Gegevens van de organisatie
De gegevens die een organisatie of haar gebruikers in Doelenboom invoeren, blijven van de organisatie of de oorspronkelijke rechthebbende. Het gebruik van Doelenboom leidt niet tot overdracht van eigendomsrechten op deze gegevens aan Code072.nl.
Code072.nl mag deze gegevens verwerken voor zover dit noodzakelijk is voor het beschikbaar stellen, beveiligen, beheren en ondersteunen van Doelenboom, het maken van technische back-ups, het oplossen van storingen en het voldoen aan wettelijke verplichtingen.
De organisatie is verantwoordelijk voor de inhoud, juistheid, actualiteit en rechtmatigheid van de gegevens die zij in Doelenboom vastlegt.

## 6. Vertrouwelijkheid
Code072.nl behandelt informatie van organisaties vertrouwelijk en stelt deze niet beschikbaar aan andere organisaties of derden, tenzij dit noodzakelijk is voor de uitvoering van de dienstverlening, de organisatie hiervoor toestemming heeft gegeven of Code072.nl hiertoe wettelijk verplicht is.
Personen die voor technisch beheer of ondersteuning toegang tot klantgegevens nodig hebben, krijgen uitsluitend toegang voor zover dit noodzakelijk is voor hun werkzaamheden.
De organisatie blijft verantwoordelijk voor de beoordeling welke informatie binnen Doelenboom mag worden opgeslagen.

## 7. Persoonsgegevens en privacy
Bij het gebruik van Doelenboom kunnen persoonsgegevens worden verwerkt, waaronder bijvoorbeeld namen, zakelijke e-mailadressen, gebruikersrollen en technische gebruiks- en logininformatie.
Persoonsgegevens worden verwerkt overeenkomstig de toepasselijke privacywetgeving, waaronder de Algemene Verordening Gegevensbescherming (AVG).
Code072.nl publiceert voor Doelenboom een afzonderlijke privacyverklaring. In deze privacyverklaring wordt onder meer beschreven hoe wordt omgegaan met inactieve accounts, de waarschuwing voorafgaand aan verwijdering en het verwijderen of anonimiseren van accountgebonden persoonsgegevens.
Wanneer Code072.nl namens een organisatie persoonsgegevens verwerkt waarvoor die organisatie verwerkingsverantwoordelijke is, kunnen aanvullende afspraken worden vastgelegd in een verwerkersovereenkomst.

## 8. Informatiebeveiliging
Code072.nl treft passende technische en organisatorische maatregelen om Doelenboom en de daarin opgeslagen gegevens te beschermen tegen verlies, onbevoegde toegang, ongeoorloofde wijziging en andere vormen van onrechtmatige verwerking.
Geen enkel digitaal systeem kan volledige beveiliging of ononderbroken beschikbaarheid garanderen. Gebruikers en organisaties hebben daarom een eigen verantwoordelijkheid voor veilig gebruik, waaronder het beschermen van accounts en het zorgvuldig toekennen van autorisaties.
Het is niet toegestaan informatie in Doelenboom op te slaan waarvoor op grond van wetgeving, interne regelgeving of beveiligingsclassificatie een hoger beveiligingsniveau is vereist dan door Doelenboom wordt geboden, tenzij hierover vooraf uitdrukkelijke afspraken zijn gemaakt.

## 9. Beschikbaarheid, onderhoud en wijzigingen
Code072.nl streeft naar een zo hoog mogelijke beschikbaarheid en betrouwbare werking van Doelenboom, maar geeft geen garantie op ononderbroken of foutloze beschikbaarheid, tenzij hierover schriftelijk andere afspraken zijn gemaakt.
Doelenboom kan tijdelijk geheel of gedeeltelijk buiten gebruik worden gesteld voor onderhoud, beveiligingsupdates, verbeteringen of andere technische werkzaamheden. Waar redelijkerwijs mogelijk wordt gepland onderhoud vooraf aangekondigd.
Code072.nl mag Doelenboom aanpassen en verder ontwikkelen. Specifieke afspraken over beschikbaarheid, hersteltijden of ondersteuning kunnen afzonderlijk in een Service Level Agreement (SLA) worden vastgelegd.

## 10. Back-up en herstel
Code072.nl kan technische back-ups maken om herstel van de dienst na technische incidenten mogelijk te maken. Back-ups vormen niet automatisch een archiefvoorziening voor individuele gebruikers of organisaties.
De organisatie blijft verantwoordelijk voor gegevens die zij op grond van wet- of regelgeving zelfstandig dient te bewaren of archiveren.

## 11. Export van gegevens
De organisatie moet haar eigen gegevens binnen redelijke grenzen kunnen meenemen wanneer zij het gebruik van Doelenboom beëindigt. Voor zover de beschikbare functionaliteit dit ondersteunt, kunnen gegevens worden geëxporteerd in een gangbaar formaat.
Indien een volledige export niet via de applicatie beschikbaar is, kunnen hierover afzonderlijke afspraken worden gemaakt.

## 12. Beëindiging en verwijderen van gegevens
Na beëindiging van de overeenkomst wordt de toegang van de organisatie en haar gebruikers beëindigd. Tenzij anders overeengekomen krijgt de organisatie gedurende een redelijke termijn gelegenheid haar gegevens te exporteren.
Na het verstrijken van deze termijn mogen de gegevens uit de actieve systemen worden verwijderd. Gegevens kunnen gedurende een beperkte periode nog in technische back-ups aanwezig zijn en worden volgens het geldende back-up- en retentiebeleid verwijderd.

## 13. Intellectueel eigendom
Code072.nl is eigenaar van Doelenboom. Alle intellectuele eigendomsrechten op Doelenboom, waaronder de software, broncode, vormgeving, technische componenten, documentatie en andere door Code072.nl ontwikkelde onderdelen, blijven bij Code072.nl of diens eventuele licentiegevers.
De organisatie verkrijgt uitsluitend het in deze voorwaarden beschreven gebruiksrecht. Gegevens en inhoud die door de organisatie zelf in Doelenboom worden ingebracht, blijven van de organisatie of de betreffende rechthebbende.

## 14. Verboden gebruik
Het is niet toegestaan Doelenboom te gebruiken voor activiteiten die in strijd zijn met wet- of regelgeving, voor het verspreiden of opslaan van malware, voor ongeautoriseerde toegang tot systemen of gegevens, voor het zonder toestemming testen of omzeilen van beveiligingsmaatregelen, voor activiteiten die de werking voor andere gebruikers verstoren of voor het verwerken van gegevens waarvoor geen rechtmatige grondslag bestaat.
Bij ernstig of herhaald misbruik kan Code072.nl de toegang tijdelijk opschorten of beëindigen.

## 15. Ondersteuning
Code072.nl kan ondersteuning bieden bij technische vragen over het gebruik van Doelenboom. Tenzij uitdrukkelijk anders overeengekomen, omvat deze ondersteuning geen inhoudelijk organisatie-, programma-, portfolio-, management-, juridisch of ander professioneel advies.
Advies over het ontwerpen, inrichten of beoordelen van een doelenboom kan als afzonderlijke dienstverlening worden aangeboden.

## 16. Aansprakelijkheid en gebruik voor eigen risico
Het gebruik van Doelenboom geschiedt volledig voor rekening en risico van de organisatie en de gebruiker.
Doelenboom is uitsluitend een hulpmiddel voor het vastleggen, structureren, visualiseren en analyseren van door gebruikers ingevoerde informatie en de relaties tussen deze informatie. Doelenboom verstrekt geen zelfstandig organisatorisch, bedrijfskundig, financieel, juridisch of ander professioneel advies.
Code072.nl is niet verantwoordelijk voor de inhoud, juistheid, volledigheid, actualiteit of geschiktheid van gegevens die in Doelenboom worden opgenomen, noch voor de wijze waarop deze gegevens, relaties, visualisaties, analyses of andere resultaten worden geïnterpreteerd of gebruikt.
De organisatie en de gebruiker blijven te allen tijde volledig verantwoordelijk voor alle beoordelingen, conclusies, keuzes, handelingen en besluiten die geheel of gedeeltelijk worden gebaseerd op informatie uit Doelenboom.
Voor zover wettelijk toegestaan, is Code072.nl niet aansprakelijk voor enige schade die direct of indirect voortvloeit uit of verband houdt met het gebruik, de onmogelijkheid tot gebruik, de beschikbaarheid, tijdelijke onbeschikbaarheid, werking of resultaten van Doelenboom.
Deze uitsluiting omvat, voor zover wettelijk toegestaan, onder meer directe en indirecte schade, gevolgschade, bedrijfsschade, verlies van inkomsten of winst, verlies van gegevens, gemiste besparingen, reputatieschade en schade als gevolg van beslissingen die mede op basis van Doelenboom zijn genomen.
Code072.nl geeft geen garantie dat Doelenboom te allen tijde foutloos, volledig, ononderbroken of zonder verlies van gegevens beschikbaar zal zijn.
Geen bepaling in deze voorwaarden beperkt of sluit aansprakelijkheid uit voor zover een dergelijke beperking of uitsluiting op grond van dwingend Nederlands recht niet is toegestaan.

## 17. Overmacht
Code072.nl is niet aansprakelijk voor het niet of niet tijdig nakomen van verplichtingen wanneer dit het gevolg is van omstandigheden waarop Code072.nl redelijkerwijs geen invloed kan uitoefenen, waaronder storingen bij internet- of hostingproviders, grootschalige netwerkstoringen, cyberincidenten, stroomstoringen, overheidsmaatregelen en andere vormen van overmacht.

## 18. Duur, opschorting en beëindiging
De duur en wijze van beëindiging van het gebruik van Doelenboom worden vastgelegd in de overeenkomst of het abonnement met de organisatie.
Code072.nl kan de toegang tijdelijk opschorten wanneer dit noodzakelijk is vanwege een ernstig beveiligingsrisico, aantoonbaar misbruik, overtreding van deze voorwaarden, het niet nakomen van betalingsverplichtingen of een wettelijke verplichting. Waar redelijkerwijs mogelijk wordt de organisatie vooraf geïnformeerd.

## 19. Kosten en betaling
Indien voor het gebruik van Doelenboom kosten verschuldigd zijn, worden de prijs, abonnementsvorm, factureringsperiode en eventuele aanvullende diensten vastgelegd in de overeenkomst, offerte of abonnementsbevestiging.
Tenzij anders vermeld zijn bedragen exclusief btw. Code072.nl kan tarieven wijzigen; materiële prijswijzigingen bij lopende abonnementen worden vooraf aangekondigd overeenkomstig de gemaakte afspraken.

## 20. Wijziging van deze voorwaarden
Code072.nl kan deze gebruiksvoorwaarden wijzigen wanneer ontwikkelingen in Doelenboom, wet- en regelgeving of de dienstverlening daartoe aanleiding geven. Materiële wijzigingen worden vooraf bekendgemaakt.
De meest recente versie van de voorwaarden wordt beschikbaar gesteld via Doelenboom of de bijbehorende website.

## 21. Toepasselijk recht en geschillen
Op het gebruik van Doelenboom en deze gebruiksvoorwaarden is Nederlands recht van toepassing.
Partijen zullen proberen eventuele geschillen eerst in onderling overleg op te lossen. Indien dit niet mogelijk blijkt, wordt het geschil voorgelegd aan de bevoegde rechter in Nederland, tenzij dwingend recht anders bepaalt.

## 22. Aanvullende documenten
Deze gebruiksvoorwaarden kunnen onderdeel vormen van een bredere set afspraken. Afhankelijk van de dienstverlening kunnen daarnaast een overeenkomst, offerte of abonnementsbevestiging, de privacyverklaring van Doelenboom, een verwerkersovereenkomst, een Service Level Agreement (SLA) en aanvullende afspraken over informatiebeveiliging van toepassing zijn.
Bij tegenstrijdigheden tussen documenten geldt de rangorde zoals opgenomen in de overeenkomst met de organisatie.

## Openstaande punten vóór versie 1.0
- Definitieve juridische entiteit/handelsnaam van Code072.nl na KvK-registratie.
- KvK-nummer, vestigingsadres en eventuele btw-gegevens.
- Definitieve abonnements- en betalingsvoorwaarden.
- Concrete bewaartermijn na beëindiging van een organisatieomgeving en retentie van back-ups.
- Hostinglocatie en eventuele subverwerkers.
- Beveiligingsniveau en welke categorieën gegevens wel/niet mogen worden opgeslagen.
- Opstellen en publiceren van de afzonderlijke privacyverklaring, inclusief de 12-maandentermijn en waarschuwing circa 30 dagen vooraf.
- Beoordelen of voor zakelijke klanten een verwerkersovereenkomst nodig is.
- Juridische toets van de aansprakelijkheidsuitsluiting en de volledige voorwaarden vóór publicatie.
$doc$)
on conflict (doc_type, version) do nothing;

-- Privacyverklaring: er bestaat op dit moment nog geen door de opdrachtgever
-- aangeleverde/goedgekeurde privacytekst (zie §3 van de featureopdracht --
-- "gebruik een duidelijke concept/placeholder-status, verzin geen
-- privacytekst"). Dit is dus BEWUST geen echte privacyverklaring, maar een
-- expliciet gelabelde placeholder-rij (status 'draft', nooit 'published')
-- zodat GET /api/legal/privacy een duidelijk shown-as-concept-pagina
-- oplevert i.p.v. een kale 404 -- zie legal.ts getCurrentDocument (valt bij
-- geen gepubliceerde versie terug op de meest recente draft) en
-- LegalPage.tsx (toont de oranje conceptbanner zolang status != 'published').
insert into legal_documents (doc_type, version, effective_date, published_at, status, content)
values ('privacy', '0.1', '2026-08-30', null, 'draft', $doc$
Status: Concept -- nog niet vastgesteld

De privacyverklaring van Doelenboom is op dit moment nog niet opgesteld en dus nog niet inhoudelijk beschikbaar. Deze pagina is een placeholder totdat Code072.nl de definitieve privacyverklaring heeft opgesteld, juridisch heeft laten toetsen en heeft gepubliceerd.

Zodra de privacyverklaring beschikbaar is, verschijnt de volledige tekst op deze plek, met een eigen versienummer en ingangsdatum.
$doc$)
on conflict (doc_type, version) do nothing;


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
