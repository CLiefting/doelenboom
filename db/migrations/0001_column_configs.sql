-- Migratie: configureerbare kolommen (column_configs/columns) — zie
-- docs/kolommen-configuratie-ontwerp.md. Draai dit één keer tegen een
-- BESTAANDE database (lokale dev-db én productie) die deze tabellen nog niet
-- heeft; voor VERSE installaties staan dezelfde tabellen al in db/init.sql
-- (dat draait automatisch bij de allereerste containerstart).
--
-- Gebruik (lokaal):
--   set -euo pipefail
--   cd ~/OneDrive/src/doelenboom
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0001_column_configs.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
--
-- Idempotent: mag zonder gevolgen twee keer gedraaid worden (create table
-- if not exists + de seed-loops slaan tenants/doelenbomen over die al een
-- config hebben).

begin;

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

-- Oude vaste typelijst vervalt — welke typen geldig zijn, hangt nu af van de
-- columns-configuratie per doelenboom (op API-niveau gevalideerd).
alter table elements drop constraint if exists elements_type_check;

-- Seed: voor elke tenant zonder tenant-default config, de huidige 8 vaste
-- kolommen (project..missie, exact zoals voorheen hardcoded in
-- web/public/tree.html: COL_LABELS/COL_COLORS/COL_ARROWS/COLUMN_HINTS/
-- TYPE_TO_COLKEY/NARROW_COLS) als tenant-default aanmaken — zo verandert er
-- voor bestaande tenants/doelenbomen zichtbaar niets, totdat iemand zelf iets
-- aanpast. Daarna voor elke doelenboom zonder eigen config een kopie van de
-- (dan al aangemaakte) tenant-default van die tenant.
do $$
declare
  t record;
  d record;
  new_config_id bigint;
begin
  for t in
    select id, name from tenants
    where id not in (select tenant_id from column_configs where scope = 'tenant_default')
  loop
    insert into column_configs (scope, tenant_id) values ('tenant_default', t.id)
      returning id into new_config_id;
    insert into columns
      (column_config_id, position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next)
    values
      (new_config_id, 0, 'Project', 'Project',
        'Welke projecten ontwikkelen deze capability?', '#3E6FA6', true, null, true, 'ontwikkelt'),
      (new_config_id, 1, 'Capability', 'Capability',
        'Welk vermogen wordt hiermee opgebouwd?', '#6B4C8A', true, null, false, 'ondersteunt'),
      (new_config_id, 2, 'Operationele benefit', 'Operationele benefit',
        'Welke operationele verbetering levert dit op? Wat verandert er in de dagelijkse uitvoering?',
        '#C05A2C', false, null, false, 'realiseert'),
      (new_config_id, 3, 'Sub-benefit', 'Sub-benefit ' || t.name,
        'Welk direct effect ontstaat hierdoor?', '#B8862E', false, null, false, 'versterkt'),
      (new_config_id, 4, 'Programmabaat', 'Programmabaat ' || t.name,
        'Welke waarde levert dit aan ' || t.name || '?', '#2E7D5B', false, null, false, 'draagt bij aan'),
      (new_config_id, 5, 'Strategische benefit', 'Strategisch benefit ' || t.name,
        'Wat betekent dit voor ' || t.name || '?', '#8FAADC', false, 10, false, 'ondersteunt'),
      (new_config_id, 6, 'Strategisch doel', 'Strategisch doel',
        'Welk doel ondersteunt dit?', '#2F5597', false, 12, false, 'geeft invulling aan'),
      (new_config_id, 7, 'Missie', 'Missie ' || t.name,
        'Waarom doen we dit uiteindelijk?', '#203864', false, 10, false, null);
  end loop;

  for d in
    select id, tenant_id from doelenbomen
    where id not in (select doelenboom_id from column_configs where scope = 'doelenboom')
  loop
    insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', d.tenant_id, d.id)
      returning id into new_config_id;
    insert into columns
      (column_config_id, position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next)
    select new_config_id, c.position, c.type_name, c.title, c.subtitle, c.color, c.is_narrow, c.node_font_size, c.is_project_role, c.relation_label_to_next
    from columns c
    join column_configs cc on cc.id = c.column_config_id
    where cc.scope = 'tenant_default' and cc.tenant_id = d.tenant_id;
  end loop;
end $$;

commit;
