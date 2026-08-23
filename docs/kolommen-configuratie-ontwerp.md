# Ontwerp: configureerbare kolommen (concept, ter review)

Dit document is een ontwerp-schets naar aanleiding van de vraag om de
kolommen van de boomweergave configureerbaar te maken. **Er is nog geen
code gewijzigd** — dit is bedoeld om eerst af te stemmen vóór implementatie,
zoals afgesproken.

Gekozen richting (uit de voorvragen):

- Volledig vrije configuratie: kolommen toevoegen/verwijderen/herordenen,
  elementtypen vrij definiëren per tenant/doelenboom.
- Excel-import/export volgt mee (dynamische Type-lijst/dropdowns) — met één
  belangrijke nuance, zie §7.
- Rechten: sysadmin stelt de tenant-default in; tenant-admin kan die per
  doelenboom overrulen (zelfde patroon als de bestaande rol-overrides).
- Kolomrelaties blijven een lineaire keten (elke kolom heeft hooguit één
  "volgende" kolom) — geen vertakkingen.

---

## 1. Datamodel

Twee nieuwe tabellen: `column_configs` (een complete kolommenset) en
`columns` (de kolommen daarbinnen, met hun onderlinge volgorde/relatie).

```sql
create table column_configs (
  id bigserial primary key,
  scope text not null check (scope in ('tenant_default', 'doelenboom')),
  tenant_id bigint not null references tenants(id) on delete cascade,
  -- alleen gezet als scope = 'doelenboom'; uniek per doelenboom (elke
  -- doelenboom heeft precies één eigen, onafhankelijke config — geen live
  -- verwijzing naar de tenant-default, alleen een kopie bij aanmaken, zie §2)
  doelenboom_id bigint references doelenbomen(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id) where (scope = 'tenant_default'),
  unique (doelenboom_id) where (scope = 'doelenboom')
);

create table columns (
  id bigserial primary key,
  column_config_id bigint not null references column_configs(id) on delete cascade,
  position int not null,               -- 0-based volgorde, links → rechts
  type_name text not null,             -- "Project", "Capability", ... (vrij, uniek binnen de config)
  title text not null,                 -- kolomkop, bv. "Capability"
  subtitle text not null default '',   -- vraagzin onder de kop, bv. "Welk vermogen wordt hiermee opgebouwd?"
  color text not null,                 -- hex, bv. "#6B4C8A"
  is_narrow boolean not null default false,
  node_font_size int,                  -- nullable = standaardgrootte
  is_project_role boolean not null default false,  -- zie §3, precies 1 true per config
  relation_label_to_next text,         -- bv. "ontwikkelt" — null bij de laatste kolom (geen volgende)
  unique (column_config_id, position),
  unique (column_config_id, type_name)
);
```

`elements.type` blijft een gewoon tekstveld (belangrijk voor de
Excel-rondgang, die al op tekstwaarden draait), maar de huidige harde
`check (type in (...))`-constraint met de 8 vaste waarden vervalt. Validatie
dat een elements.type overeenkomt met een bestaande kolom van de doelenboom
verhuist naar de API-laag (bij aanmaken/wijzigen van een element, en bij
Excel-import).

## 2. Overerving & migratie

- Elke **tenant** krijgt één `column_configs`-rij met `scope='tenant_default'`.
- Elke **doelenboom** krijgt bij aanmaken een eigen `column_configs`-rij met
  `scope='doelenboom'`, geïnitialiseerd als een **kopie** van de op dat
  moment geldende tenant-default (niet een levende verwijzing — wijzig je de
  tenant-default later, dan verandert een al-bestaande doelenboom dus niet
  automatisch mee, precies zoals gevraagd: "de doelenboom heeft haar eigen
  kolommen").
- **Migratie van bestaande data**: eenmalig een `column_configs`-rij per
  bestaande tenant aanmaken (scope tenant_default) + een kopie per bestaande
  doelenboom, beide gevuld met de huidige 8 kolommen/kleuren/relatienamen
  precies zoals ze nu hardcoded in `tree.html` staan. Voor bestaande
  gebruikers verandert er dus **niets zichtbaars** totdat ze zelf iets
  aanpassen.

## 3. Impact op bestaande features

Een paar features zijn nu hardcoded aan specifiek "Project" of "Missie"
gekoppeld. Voorstel per stuk:

| Feature | Huidige aanname | Wordt |
|---|---|---|
| Projectkaart, planning-items, projectstatus, tijdlijnenoverzicht | `type === 'Project'` | `is_project_role`-vlag op de kolom (precies 1 per config verplicht) — de kolomnaam zelf mag dus wél hernoemd worden (bv. "Initiatief"), de speciale functionaliteit blijft aan die ene gemarkeerde kolom hangen. |
| Bouwrichting omdraaien (kolommen spiegelen) | werkt al generiek op de complete lijst | ongewijzigd, blijft werken |
| Kijkrichting/anker (vanuit Missie ↔ vanuit Project) | hardcoded op de sleutels `missie`/`project` | generaliseren naar "eerste kolom" ↔ "laatste kolom" in de geconfigureerde volgorde — zelfde knop, werkt met elke configuratie |
| "MISSIE ‹tenant›"-tekst in de laatste kolom, kolomkop-hint-teksten | hardcoded per kolomsleutel | worden gewoon de geconfigureerde `title`/`subtitle` — geen speciale casing meer nodig |
| SVG-export, golden-thread-export, focus-modus | werken al op de live DOM/kolomvolgorde | geen wijziging nodig, werken automatisch mee |

## 4. API

Nieuwe routes (onder `authRequired`, rollen zoals afgesproken):

- `GET /api/tenants/:id/column-config` / `PUT ...` — sysadmin-only, de
  tenant-default lezen/bijwerken (kolommen toevoegen/verwijderen/herordenen/
  hernoemen/kleur/relatienaam).
- `GET /api/doelenbomen/:id/column-config` / `PUT ...` — tenant-admin (of
  sysadmin) van die doelenboom.
- `GET /api/doelenbomen/:id/tree` (bestaande route) geeft de kolomconfig
  voortaan mee in de response, i.p.v. dat `tree.html` die hardcoded heeft.
- Validatie bij `PUT`: minstens 1 kolom, precies 1 met `is_project_role`,
  unieke `type_name` binnen de config, geen kolom verwijderen die nog
  elementen van dat type bevat (nette foutmelding, geen stille dataverlies).

## 5. tree.html

De huidige hardcoded `CANONICAL_COL_ORDER`/`COL_LABELS`/`COL_COLORS`/
`COL_ARROWS`/`COLUMN_HINTS`/`TYPE_TO_COLKEY`/`NARROW_COLS` verdwijnen en
worden vervangen door structuren die uit de `tree`-response komen (dus
per-doelenboom, al meteen bij het laden). Vrijwel alle recent gebouwde
features (bouwrichting, anker, golden-thread-export, tijdlijnenoverzicht)
blijven qua *gedrag* ongewijzigd — ze rekenen nu al met "de lijst kolommen",
niet met specifieke namen (op de twee punten uit §3 na).

Er komt een nieuw **beheerscherm** (vergelijkbaar met het bestaande
Tags/Organisatieonderdelen-beheer) waar een tenant-admin/sysadmin kolommen
kan toevoegen/verwijderen/herordenen (drag-and-drop of pijltjes) en per
kolom titel/ondertitel/kleur/relatienaam-naar-volgende kan bewerken.

## 6. Rechten

- Sysadmin: tenant-default overal bewerken.
- Tenant-admin: alleen de config van doelenbomen binnen de eigen tenant
  (met schrijfrechten, zelfde als nu voor overige beheertaken).
- Tenant-gebruiker: alleen lezen (de configuratie is nodig om de boom
  correct te renderen, dus wel meesturen in de tree-response, maar geen
  bewerkknoppen).

## 7. Excel-service — belangrijk aandachtspunt

De **"nieuw" Excel-formaat** (generieke Relaties-tab) kan de dynamische
Type-lijst goed aan: de `_Validatielijsten`-tab met de Type-dropdown wordt
dan gevuld vanuit de doelenboom-config i.p.v. de huidige hardcoded lijst
van 8 waarden, en parser.py valideert een geïmporteerd Type tegen diezelfde
config i.p.v. een vaste lijst.

Het **"oud" Excel-formaat** (huidige productiestructuur) zit hier
structureel anders in elkaar: dat formaat heeft **aparte tabbladen per
vast typepaar** ("Capability-OB relaties", "Project-Capability relaties")
en filtert daar hardcoded op de typenamen "Capability"/"Operationele
benefit"/"Project". Bij volledig vrije, hernoembare kolommen werkt dat
mechanisme niet meer zinvol — een tenant zou bv. "Capability" kunnen
hernoemen of een kolom kunnen toevoegen tussen Capability en Operationele
benefit, en dan bestaat er geen eenduidig "Capability-OB"-tabblad meer.

**Voorstel:** het "oud" formaat blijft beschikbaar, maar alléén voor
doelenbomen waarvan de kolomconfiguratie nog exact overeenkomt met de
oorspronkelijke 8 kolommen (dat is toch al de praktijksituatie voor nu
bestaande tenants, zie migratie in §2). Zodra een doelenboom een aangepaste
configuratie heeft, is voor die doelenboom alleen het "nieuw" formaat
beschikbaar (import én export) — met een duidelijke melding waarom. Dat
voorkomt dat we fors moeten investeren in een formaat dat in de code al als
"huidige productiestructuur, wordt op termijn vervangen door het nieuwe
formaat" wordt omschreven, terwijl het net het formaat is dat het minst
goed samengaat met vrije kolommen. Zeg je liever "oud" formaat helemaal
laten vervallen zodra dit gebouwd wordt, of toch investeren in ook daar
dynamische ondersteuning? Dat hoor ik graag.

## 8. Bouwvolgorde

Ook al gaat de uiteindelijke release in één keer live, bouw ik dit in
duidelijk afgebakende, elk-voor-zich-testbare stappen:

1. Schema (`column_configs`/`columns`) + migratiescript voor bestaande
   tenants/doelenbomen.
2. API-routes (lezen/schrijven configuratie) + validatie.
3. `tree.html` omzetten naar data-driven rendering (zonder nog een
   beheerscherm — eerst zeker weten dat de bestaande features identiek
   blijven werken met de gemigreerde default-config).
4. Beheerscherm voor kolommen bewerken.
5. Excel-service: dynamische Type-lijst voor het "nieuw" formaat +
   aanpassing "oud" formaat volgens de gekozen aanpak in §7.
6. Regressietests uitbreiden (`api/test/`, `excel-service/tests/`,
   `docs/regressie-checklist.md`) voor dit alles.

## 9. Openstaande punten ter bevestiging

1. **1-op-1 kolom↔type**: elke kolom toont precies één elementtype (zoals
   nu) — geen kolom met meerdere typen erin. Klopt dat?
2. **`is_project_role`-vlag**: exact één kolom moet dit zijn (voor
   projectkaart/planning/tijdlijnenoverzicht) — akkoord met deze beperking
   binnen een verder vrije configuratie?
3. **"Oud" Excel-formaat**: laten vervallen zodra de config afwijkt van de
   originele 8 kolommen (mijn voorstel, §7), volledig laten vervallen, of
   toch volledig dynamisch maken?
4. Nieuwe elementen kunnen alleen een type krijgen dat als kolom bestaat in
   de doelenboom — een kolom verwijderen die nog elementen bevat, blokkeren
   (met melding) i.p.v. die elementen stil laten "verdwijnen"?

Laat je het weten op deze 4 punten (en verder akkoord of niet), dan ga ik
los volgens de bouwvolgorde in §8.
