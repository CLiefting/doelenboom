-- Eenmalig data-script: nieuwe doelenboom "Vergunningen (voorbeeld)" bij
-- tenant "Demo", met dezelfde agile/SAFe-achtige 9-kolommenstructuur als
-- "Agile boom" (zie deploy/agile-boom-demo.sql), maar dan volledig gevuld
-- met een realistisch, vertakt voorbeeld voor een overheidsorganisatie die
-- vergunningen afgeeft (omgevingsvergunningen en evenementenvergunningen).
--
-- Doel: laten zien hoe de agile-structuur er in de praktijk uitziet met
-- meerdere, samenkomende verhaallijnen (i.p.v. de kale 1-op-1-placeholder-
-- keten van "Agile boom") -- twee vergunningstrajecten die via gedeelde
-- capabilities, benefits en strategische doelen uiteindelijk bijdragen aan
-- dezelfde missie.
--
-- Dit is GEEN schemamigratie (geen DDL, geen db/migrations/-nummer) -- puur
-- content-aanmaak, zelfde patroon als deploy/agile-boom-demo.sql. Bewust
-- een eigen, onafhankelijke doelenboom (naast "Agile boom" blijft bestaan
-- als kale placeholder-referentie).
--
-- Idempotent: als een doelenboom met slug 'vergunningen-boom' al bij
-- tenant 'demo' bestaat, doet dit script niets (veilig om per ongeluk
-- twee keer te draaien, en dus ook veilig om identiek te draaien in test
-- én productie).
--
-- Gebruik:
--   psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < deploy/vergunningen-boom-demo.sql
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

  if exists (select 1 from doelenbomen where tenant_id = v_tenant_id and slug = 'vergunningen-boom') then
    raise notice 'Doelenboom ''vergunningen-boom'' bestaat al bij tenant Demo -- niets gedaan.';
    return;
  end if;

  insert into doelenbomen (tenant_id, slug, name, stale_after_days)
  values (v_tenant_id, 'vergunningen-boom', 'Vergunningen (voorbeeld)', 60)
  returning id into v_doelenboom_id;

  -- Zelfde 9-kolommenstructuur als deploy/agile-boom-demo.sql (eigen,
  -- onafhankelijke column_config -- niets gedeeld met "Agile boom" of de
  -- tenant-default van Demo).
  insert into column_configs (scope, tenant_id, doelenboom_id)
  values ('doelenboom', v_tenant_id, v_doelenboom_id)
  returning id into v_config_id;

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

  -- Elementen: een vertakte boom van 35 elementen. Twee vergunnings-
  -- trajecten (omgevingsvergunning: T1/T2, US1/US2, F1/F2, E1; en
  -- evenementenvergunning: T3/T4, US3/US4, F3/F4, E2) plus twee losstaande
  -- epics (regelchecker E3, handhaving-app E4) komen via gedeelde
  -- capabilities/benefits samen op één missie.
  insert into elements (doelenboom_id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order)
  values
    -- Missie
    (v_doelenboom_id, 'M1', 'Missie', 'Een veilige, leefbare en duurzame gemeente',
      'Inwoners en ondernemers kunnen erop vertrouwen dat vergunningen zorgvuldig, snel en rechtmatig worden verleend, met oog voor veiligheid en leefbaarheid.',
      '', '', '', '', 1),

    -- Strategisch doel
    (v_doelenboom_id, 'SD1', 'Strategisch doel', 'Vergunningverlening sneller en transparanter maken',
      'Aanvragers weten waar ze aan toe zijn en krijgen sneller duidelijkheid, zonder concessies aan zorgvuldigheid.',
      '', 'Gemiddelde doorlooptijd vergunningaanvraag (streefwaarde: -30% in 2 jaar)', '', '', 1),
    (v_doelenboom_id, 'SD2', 'Strategisch doel', 'Naleving en veiligheid bij vergunde activiteiten waarborgen',
      'Vergunningen worden zorgvuldig getoetst en nageleefd, zodat overlast en onveilige situaties worden voorkomen.',
      '', 'Percentage gecontroleerde vergunningen zonder overtreding', '', '', 2),

    -- Benefits
    (v_doelenboom_id, 'B1', 'Benefits', 'Hogere tevredenheid en vertrouwen bij aanvragers',
      'Kortere doorlooptijden en heldere communicatie verhogen het vertrouwen van inwoners en ondernemers in de gemeente.',
      '', 'Klanttevredenheidsscore vergunningenloket', '', '', 1),
    (v_doelenboom_id, 'B2', 'Benefits', 'Minder bezwaar- en beroepsprocedures',
      'Zorgvuldige toetsing vooraf voorkomt onvolledige of onterecht afgewezen aanvragen, en dus onnodige juridische procedures.',
      '', 'Aantal gegronde bezwaarschriften per 100 vergunningen', '', '', 2),
    (v_doelenboom_id, 'B3', 'Benefits', 'Minder incidenten en overlast',
      'Goed gehandhaafde vergunningsvoorwaarden verminderen overlast en onveilige situaties bij vergunde activiteiten.',
      '', 'Aantal meldingen van overlast bij vergunde evenementen/bouwactiviteiten', '', '', 3),

    -- Operationele Benefits
    (v_doelenboom_id, 'OB1', 'Operationele Benefits', 'Minder onvolledige aanvragen',
      'Digitale intake met verplichte velden en documentchecks voorkomt dat aanvragen onvolledig binnenkomen.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'OB2', 'Operationele Benefits', 'Minder handmatig beoordelingswerk',
      'Geautomatiseerde toetsing aan regelgeving neemt eenvoudige controles over van behandelaars, die zich zo kunnen richten op complexere afwegingen.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'OB3', 'Operationele Benefits', 'Eén centraal overzicht per locatie',
      'Alle vergunningen en voorwaarden per adres/locatie zijn centraal inzichtelijk, wat tegenstrijdige besluiten voorkomt.',
      '', '', '', '', 3),
    (v_doelenboom_id, 'OB4', 'Operationele Benefits', 'Realtime informatie voor toezichthouders',
      'Handhavers zien tijdens controles direct welke vergunning en voorwaarden gelden op een locatie.',
      '', '', '', '', 4),

    -- Capability
    (v_doelenboom_id, 'C1', 'Capability', 'Digitaal aanvragen en volgen van vergunningen',
      'Aanvragers kunnen volledig digitaal een vergunning aanvragen en de status daarvan volgen.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'C2', 'Capability', 'Geautomatiseerd toetsen van aanvragen',
      'Aanvragen worden automatisch getoetst aan geldende wet- en regelgeving, zoals het bestemmingsplan.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'C3', 'Capability', 'Mobiele ondersteuning voor toezicht en handhaving',
      'Toezichthouders kunnen ter plekke controles vastleggen en direct bij de juiste vergunningsgegevens.',
      '', '', '', '', 3),

    -- Epic
    (v_doelenboom_id, 'E1', 'Epic', 'Vernieuwing digitaal loket omgevingsvergunningen',
      'Vervangen van het huidige papieren/e-mailproces door een volledig digitaal aanvraagproces voor omgevingsvergunningen.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'E2', 'Epic', 'Vernieuwing digitaal loket evenementenvergunningen',
      'Digitaliseren van de aanvraag en advisering voor evenementenvergunningen, inclusief automatische adviesaanvragen.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'E3', 'Epic', 'Geautomatiseerde regelchecker vergunningsaanvragen',
      'Ontwikkelen van een systeem dat aanvragen automatisch toetst aan bestemmingsplan en andere regelgeving.',
      '', '', '', '', 3),
    (v_doelenboom_id, 'E4', 'Epic', 'Handhaving-app voor toezichthouders',
      'Ontwikkelen van een mobiele app waarmee toezichthouders controles digitaal kunnen vastleggen.',
      '', '', '', '', 4),

    -- Feature
    (v_doelenboom_id, 'F1', 'Feature', 'Online aanvraagformulier omgevingsvergunning',
      'Formulier met documentupload voor bouwtekeningen en foto''s, direct gekoppeld aan het zaaksysteem.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'F2', 'Feature', 'Statusvolgsysteem voor aanvragers',
      'Persoonlijk overzicht (''mijn aanvragen'') waarin aanvragers de voortgang van hun aanvraag kunnen volgen.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'F3', 'Feature', 'Online aanvraagformulier evenementenvergunning',
      'Formulier voor evenementengegevens zoals datum, locatie, bezoekersaantal en draaiboek.',
      '', '', '', '', 3),
    (v_doelenboom_id, 'F4', 'Feature', 'Automatische adviesaanvraag brandweer en politie',
      'Bij indiening van een evenementenaanvraag wordt automatisch advies opgevraagd bij brandweer en politie.',
      '', '', '', '', 4),
    (v_doelenboom_id, 'F5', 'Feature', 'Bestemmingsplan-toets',
      'Automatische controle of een aanvraag past binnen het geldende bestemmingsplan op de betreffende locatie.',
      '', '', '', '', 5),
    (v_doelenboom_id, 'F6', 'Feature', 'Digitaal controleformulier met foto en locatie',
      'Toezichthouders leggen controles vast met foto''s en gps-locatie, direct gekoppeld aan de vergunning.',
      '', '', '', '', 6),

    -- User Story
    (v_doelenboom_id, 'US1', 'User Story', 'Vergunning aanvragen zonder gemeentehuisbezoek',
      'Als inwoner wil ik mijn omgevingsvergunning online kunnen aanvragen, zodat ik niet naar het gemeentehuis hoef.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'US2', 'User Story', 'Status van mijn aanvraag volgen',
      'Als aanvrager wil ik de status van mijn aanvraag kunnen volgen, zodat ik weet waar ik aan toe ben.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'US3', 'User Story', 'Evenement aanmelden met alle benodigde informatie',
      'Als evenementenorganisator wil ik mijn aanvraag online kunnen indienen, inclusief plattegrond en draaiboek.',
      '', '', '', '', 3),
    (v_doelenboom_id, 'US4', 'User Story', 'Automatisch advies opvragen',
      'Als behandelaar wil ik automatisch advies van brandweer en politie kunnen opvragen, zodat ik niet handmatig hoef te bellen.',
      '', '', '', '', 4),
    (v_doelenboom_id, 'US5', 'User Story', 'Direct zien of een aanvraag past binnen het bestemmingsplan',
      'Als behandelaar wil ik automatisch zien of een aanvraag voldoet aan het bestemmingsplan, zodat ik sneller kan beoordelen.',
      '', '', '', '', 5),
    (v_doelenboom_id, 'US6', 'User Story', 'Controle ter plekke vastleggen',
      'Als toezichthouder wil ik ter plekke een controle kunnen vastleggen met foto''s en locatie, zodat dit direct in het dossier staat.',
      '', '', '', '', 6),

    -- Task
    (v_doelenboom_id, 'T1', 'Task', 'Bouw uploadcomponent voor bijlagen',
      'Component waarmee aanvragers bouwtekeningen en foto''s kunnen uploaden bij hun aanvraag.',
      '', '', '', '', 1),
    (v_doelenboom_id, 'T2', 'Task', 'Bouw statusoverzicht-pagina',
      'Pagina in het aanvragersportaal met de actuele status van lopende aanvragen.',
      '', '', '', '', 2),
    (v_doelenboom_id, 'T3', 'Task', 'Bouw formulier evenementengegevens',
      'Formulier voor datum, locatie, verwacht bezoekersaantal en overige evenementengegevens.',
      '', '', '', '', 3),
    (v_doelenboom_id, 'T4', 'Task', 'Koppel API met adviessysteem brandweer/politie',
      'Technische koppeling die automatisch adviesaanvragen verstuurt en antwoorden ontvangt.',
      '', '', '', '', 4),
    (v_doelenboom_id, 'T5', 'Task', 'Implementeer bestemmingsplan-check',
      'Geo-koppeling die een aanvraaglocatie automatisch toetst aan het geldende bestemmingsplan.',
      '', '', '', '', 5),
    (v_doelenboom_id, 'T6', 'Task', 'Bouw mobiele controle-app',
      'App voor handhavers met foto- en gps-registratie tijdens controles.',
      '', '', '', '', 6);

  -- Edges: 35 relaties, telkens source = concreter (lagere kolompositie),
  -- target = abstracter (hogere kolompositie) -- toelichting = de
  -- relation_label_to_next van de bronkolom. De vertakking/samenkomst zit
  -- 'm in meerdere sources naar dezelfde target (bv. F1 en F2 -> E1) en een
  -- enkele source naar meerdere targets (bv. C1 -> OB1 én OB3).
  insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
  select v_doelenboom_id, src.id, tgt.id, 'primair', label
  from (values
    -- Task -> User Story
    ('T1','US1','draagt bij aan'),
    ('T2','US2','draagt bij aan'),
    ('T3','US3','draagt bij aan'),
    ('T4','US4','draagt bij aan'),
    ('T5','US5','draagt bij aan'),
    ('T6','US6','draagt bij aan'),
    -- User Story -> Feature
    ('US1','F1','maakt deel uit van'),
    ('US2','F2','maakt deel uit van'),
    ('US3','F3','maakt deel uit van'),
    ('US4','F4','maakt deel uit van'),
    ('US5','F5','maakt deel uit van'),
    ('US6','F6','maakt deel uit van'),
    -- Feature -> Epic
    ('F1','E1','maakt deel uit van'),
    ('F2','E1','maakt deel uit van'),
    ('F3','E2','maakt deel uit van'),
    ('F4','E2','maakt deel uit van'),
    ('F5','E3','maakt deel uit van'),
    ('F6','E4','maakt deel uit van'),
    -- Epic -> Capability
    ('E1','C1','ontwikkelt'),
    ('E2','C1','ontwikkelt'),
    ('E3','C2','ontwikkelt'),
    ('E4','C3','ontwikkelt'),
    -- Capability -> Operationele Benefits
    ('C1','OB1','realiseert'),
    ('C1','OB3','realiseert'),
    ('C2','OB2','realiseert'),
    ('C3','OB4','realiseert'),
    -- Operationele Benefits -> Benefits
    ('OB1','B1','draagt bij aan'),
    ('OB2','B1','draagt bij aan'),
    ('OB3','B2','draagt bij aan'),
    ('OB4','B3','draagt bij aan'),
    -- Benefits -> Strategisch doel
    ('B1','SD1','ondersteunt'),
    ('B2','SD2','ondersteunt'),
    ('B3','SD2','ondersteunt'),
    -- Strategisch doel -> Missie
    ('SD1','M1','geeft invulling aan'),
    ('SD2','M1','geeft invulling aan')
  ) as chain(src_code, tgt_code, label)
  join elements src on src.doelenboom_id = v_doelenboom_id and src.code = chain.src_code
  join elements tgt on tgt.doelenboom_id = v_doelenboom_id and tgt.code = chain.tgt_code;

  raise notice 'Doelenboom "Vergunningen (voorbeeld)" (id=%) aangemaakt bij tenant Demo, met 9 kolommen, 35 elementen en 35 relaties.', v_doelenboom_id;
end $$;
