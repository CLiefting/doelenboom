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
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
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
create table if not exists tenant_users (
  id bigserial primary key,
  tenant_id bigint not null references tenants(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'gebruiker')),
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
  role text not null check (role in ('admin', 'gebruiker')),
  primary key (doelenboom_id, user_id)
);

create table if not exists elements (
  id bigserial primary key,
  doelenboom_id bigint not null references doelenbomen(id) on delete cascade,
  code text not null,
  type text not null check (type in (
    'Project', 'Capability', 'Operationele benefit', 'Sub-benefit',
    'Programmabaat', 'Strategische benefit', 'Strategisch doel', 'Missie'
  )),
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
  opmerking text not null default ''
);
create index if not exists idx_products_element on products(element_id);

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
