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
-- Eén voorbeeldelement per kolom (V1..V9, "Voorbeeld van <Type>"), aan
-- elkaar geketend met edges V1->V2->...->V9 — zelfde conventie als het
-- systeembrede "Batenboom"-sjabloon (zie diens elements_snapshot/
-- edges_snapshot in db/init.sql), zodat de boom nooit volledig leeg start en
-- meteen laat zien wat er in elke kolom hoort.
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

  -- Voorbeeldelementen: één per kolom, code V1..V9 volgens dezelfde
  -- positie-volgorde als de kolommen hierboven (V1 = Task t/m V9 = Missie).
  insert into elements (doelenboom_id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order)
  values
    (v_doelenboom_id, 'V1', 'Task', 'Voorbeeld van Task', '', '', '', '', '', 1),
    (v_doelenboom_id, 'V2', 'User Story', 'Voorbeeld van User Story', '', '', '', '', '', 2),
    (v_doelenboom_id, 'V3', 'Feature', 'Voorbeeld van Feature', '', '', '', '', '', 3),
    (v_doelenboom_id, 'V4', 'Epic', 'Voorbeeld van Epic', '', '', '', '', '', 4),
    (v_doelenboom_id, 'V5', 'Capability', 'Voorbeeld van Capability', '', '', '', '', '', 5),
    (v_doelenboom_id, 'V6', 'Operationele Benefits', 'Voorbeeld van Operationele Benefits', '', '', '', '', '', 6),
    (v_doelenboom_id, 'V7', 'Benefits', 'Voorbeeld van Benefits', '', '', '', '', '', 7),
    (v_doelenboom_id, 'V8', 'Strategisch doel', 'Voorbeeld van Strategisch doel', '', '', '', '', '', 8),
    (v_doelenboom_id, 'V9', 'Missie', 'Voorbeeld van Missie', '', '', '', '', '', 9);

  -- Eén keten V1->V2->...->V9 (source = concreter, target = abstracter,
  -- zelfde richting als de kolommen zelf) -- toelichting = de
  -- relation_label_to_next van de bronkolom, zodat de pijltekst in de boom
  -- overeenkomt met wat er in de Kolommen-editor staat.
  insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
  select v_doelenboom_id, src.id, tgt.id, 'primair', label
  from (values
    ('V1','V2','draagt bij aan'),
    ('V2','V3','maakt deel uit van'),
    ('V3','V4','maakt deel uit van'),
    ('V4','V5','ontwikkelt'),
    ('V5','V6','realiseert'),
    ('V6','V7','draagt bij aan'),
    ('V7','V8','ondersteunt'),
    ('V8','V9','geeft invulling aan')
  ) as chain(src_code, tgt_code, label)
  join elements src on src.doelenboom_id = v_doelenboom_id and src.code = chain.src_code
  join elements tgt on tgt.doelenboom_id = v_doelenboom_id and tgt.code = chain.tgt_code;

  raise notice 'Doelenboom "Agile boom" (id=%) aangemaakt bij tenant Demo, met 9 kolommen en 9 voorbeeldelementen.', v_doelenboom_id;
end $$;
