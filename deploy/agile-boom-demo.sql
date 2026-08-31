-- Eenmalig data-script: nieuwe doelenboom "Agile boom" bij tenant "Demo",
-- met een aangepaste 9-kolommenstructuur i.p.v. de standaard 8 kolommen —
-- zie het gesprek met Charles (31 augustus 2026) over de agile/SAFe-achtige
-- variant: Task -> User Story -> Feature -> Epic -> Capability ->
-- Operationele Benefits -> Benefits -> Strategisch doel -> Missie.
--
-- Dit is GEEN schemamigratie (geen DDL, geen db/migrations/-nummer) — puur
-- een content-aanmaak, zelfde patroon als db/seed.sql maar dan voor precies
-- déze ene doelenboom. Bewust buiten de normale API-aanmaakroute om (zoals
-- seed.sql dat ook al doet), dus column_configs/columns worden hier
-- expliciet gezaaid i.p.v. gekopieerd van de tenant-default.
--
-- Idempotent: als een doelenboom met slug 'agile-boom' al bij tenant 'demo'
-- bestaat, doet dit script niets (veilig om per ongeluk twee keer te
-- draaien, en dus ook veilig om identiek te draaien in test én productie).
--
-- Gebruik:
--   psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < deploy/agile-boom-demo.sql
-- (of via `docker compose exec -T db psql ...`, zie deploy/README.md)
do $$
declare
  v_tenant_id bigint;
  v_doelenboom_id bigint;
  v_config_id bigint;
begin
  select id into v_tenant_id from tenants where slug = 'demo';
  if v_tenant_id is null then
    raise exception 'Tenant met slug ''demo'' niet gevonden -- niets aangemaakt.';
  end if;

  if exists (select 1 from doelenbomen where tenant_id = v_tenant_id and slug = 'agile-boom') then
    raise notice 'Doelenboom ''agile-boom'' bestaat al bij tenant Demo -- niets gedaan.';
    return;
  end if;

  insert into doelenbomen (tenant_id, slug, name, stale_after_days)
  values (v_tenant_id, 'agile-boom', 'Agile boom', 60)
  returning id into v_doelenboom_id;

  -- Eigen, onafhankelijke kolomconfiguratie van déze doelenboom (scope
  -- 'doelenboom') -- de tenant-default van Demo (de standaard 8 kolommen)
  -- blijft ongewijzigd, dus andere/toekomstige doelenbomen bij deze tenant
  -- merken hier niets van.
  insert into column_configs (scope, tenant_id, doelenboom_id)
  values ('doelenboom', v_tenant_id, v_doelenboom_id)
  returning id into v_config_id;

  -- Positie 0 = meest concreet (uitvoering), oplopend naar Missie (8) --
  -- zelfde richting als de standaardkolommen (Project op positie 0).
  -- Projectrol op Epic: komt inhoudelijk het dichtst bij wat "Project" in
  -- de standaardstructuur betekent ("welke grote investering/verandering
  -- starten we") -- daaraan hangt de projectkaart/planning/tijdlijnen-
  -- functionaliteit. Kan achteraf via de Kolommen-editor naar een andere
  -- kolom verplaatst worden.
  insert into columns
    (column_config_id, position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next)
  values
    (v_config_id, 0, 'Task', 'Task', 'Wat doen we daarvoor?', '#7C93C4', false, null, false, 'draagt bij aan'),
    (v_config_id, 1, 'User Story', 'User Story', 'Wat heeft de gebruiker nodig?', '#5C7AB0', false, null, false, 'maakt deel uit van'),
    (v_config_id, 2, 'Feature', 'Feature', 'Wat leveren we concreet?', '#3E6FA6', false, null, false, 'maakt deel uit van'),
    (v_config_id, 3, 'Epic', 'Epic', 'Welke grote investering/verandering starten we?', '#2F5590', true, null, true, 'ontwikkelt'),
    (v_config_id, 4, 'Capability', 'Capability', 'Wat moeten we kunnen?', '#6B4C8A', true, null, false, 'realiseert'),
    (v_config_id, 5, 'Operationele Benefits', 'Operationele Benefits', 'Welke operationele verbetering levert dit op?', '#C05A2C', false, null, false, 'draagt bij aan'),
    (v_config_id, 6, 'Benefits', 'Benefits', 'Waarom willen we dit uiteindelijk bereiken?', '#B8862E', false, null, false, 'ondersteunt'),
    (v_config_id, 7, 'Strategisch doel', 'Strategisch doel', 'Welk doel ondersteunt dit?', '#2F5597', false, null, false, 'geeft invulling aan'),
    (v_config_id, 8, 'Missie', 'Missie', 'Waarom doen we dit uiteindelijk?', '#203864', false, null, false, null);

  raise notice 'Doelenboom "Agile boom" (id=%) aangemaakt bij tenant Demo, met 9 kolommen.', v_doelenboom_id;
end $$;
