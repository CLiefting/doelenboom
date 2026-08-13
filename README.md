# Doelenboom platform

Multi-tenant platform-versie van de FPBB-doelenboom (KMar). Per tenant kunnen meerdere
doelenbomen bestaan; elke doelenboom wordt gevuld/bijgewerkt door een
`FPBB_doelenboom_referentietabel_*.xlsx`-bestand te uploaden, te laten valideren, en
daarna expliciet te publiceren. Zie `doelenboom_platform_architectuur.md` voor het
volledige ontwerp (datamodel, backlog, keuzes) en `doelenboom_datamodel.drawio` voor
het ERD.

## Architectuur ("Optie B": hybride stack)

| Service | Techniek | Rol |
|---|---|---|
| `db` | PostgreSQL 16 | Alle platformdata: tenants, doelenbomen, elementen, relaties, tags, org-eenheden, imports. |
| `excel-service` | Python (FastAPI + openpyxl) | Parseert en valideert een geüploade Excel; schrijft niets zelf naar de database, geeft alleen `{status, report, parsed}` terug. |
| `api` | Node.js/TypeScript (Express) | Authenticatie (JWT), tenants/doelenbomen-CRUD, boomweergave-endpoint, en het import-/publiceer-endpoint dat `excel-service` aanroept. |
| `web` | React + Vite | Login, tenant/doelenboom-picker, boomweergave, Excel-upload met rapport + publiceerknop. |

Excel-verwerking staat bewust in Python (rijke Excel-ecosystem, `openpyxl`), de rest in
Node/TypeScript (één taal voor API + frontend). Zie ook de eerdere taalafweging in de
architectuurdiscussie.

## Starten (lokaal)

1. Kopieer `.env.example` naar `.env` en pas **in elk geval `JWT_SECRET`** aan zodra dit
   niet meer puur lokaal draait.
2. `docker compose up --build`
3. Open http://localhost:5173

Bij de allereerste start voert Postgres automatisch `db/init.sql` (schema) en
`db/seed.sql` (de huidige productiedata: tenant **KMar**, doelenboom **FPBB**, 123
elementen, 284 relaties, tags, org-eenheden) uit — dit gebeurt alleen bij een lege
`db_data`-volume. Wil je opnieuw vanaf nul, verwijder dan het volume: `docker compose
down -v`.

**Schema-wijzigingen:** `project_status` heeft een kolom `cluster_ppt`, `tenants`
heeft er `wipe_on_empty`/`session_timeout_minutes` bij gekregen plus een nieuwe
`sessions`-tabel (zie "Sessies & automatisch leegmaken" hieronder), en `users` heeft
`full_control` vervangen door `is_sysadmin` plus een nieuwe `tenant_users`-tabel
(rol `admin`/`gebruiker` per tenant — zie "Gebruikersbeheer & rollen" hieronder).
Postgres draait `init.sql` alleen bij de éérste start van een lege volume — als je
hiervoor al een keer `docker compose up` had gedraaid, moet je `docker compose
down -v` uitvoeren (en dus opnieuw seeden) om deze wijzigingen mee te krijgen. Er is
nog geen migratietool voor incrementele schema-updates (zie Backlog).

### Inloggen

Er is één seed-gebruiker die sysadmin is (toegang tot alle tenants — zie
"Gebruikersbeheer & rollen" verderop):

- E-mail: `admin@code072.nl`
- Wachtwoord: `changeme`

**Verander dit wachtwoord voordat deze omgeving buiten je eigen laptop draait.** Er is
in v1 nog geen wachtwoord-wijzig-scherm; dat kan direct in de database via
`update users set password_hash = crypt('nieuw-wachtwoord', gen_salt('bf')) where
email = 'admin@code072.nl';`.

## Structuur

- `api/` — Express-API. `src/auth.ts` (login/JWT), `src/rbac.ts` (rolmodel:
  sysadmin/tenant-admin/tenant-gebruiker — zie "Gebruikersbeheer & rollen"),
  `src/routes/tenants.ts` (tenants + tenant-leden), `src/routes/users.ts`
  (accountbeheer, sysadmin-only), `src/routes/doelenbomen.ts`, `src/routes/tree.ts`
  (boomweergave-endpoint + `fetchTree()`, hergebruikt door export),
  `src/routes/imports.ts` (upload → excel-service → rapport → publiceren),
  `src/routes/exports.ts` (huidige data of lege template terug laten genereren door
  excel-service, als download teruggeven), `src/routes/elements.ts`, `tags.ts`,
  `orgUnits.ts`, `edges.ts` (CRUD — zie "CRUD" hieronder), `src/tenantWipe.ts`
  (sessie-gebaseerd leegmaken van tenants — zie "Sessies & automatisch leegmaken").
- `excel-service/` — FastAPI-app met twee endpoints: `POST /parse` (upload → rapport +
  data, formaat automatisch herkend) en `POST /export?format=oud|nieuw&mode=template|data`
  (data of lege structuur, in het gekozen formaat → .xlsx-bytes). `app/parser.py` bevat
  de kolom-/celopschoning en validatielogica voor beide formaten (zie hieronder),
  `app/cleaning.py` de losse opschoonregels, `app/exporter.py` de omgekeerde richting
  (tree-JSON → workbook, met dezelfde kolomkoppen als een echte upload).
- `web/` — React-SPA: `src/pages/LoginPage.tsx`, `PickerPage.tsx`, `TreePage.tsx`,
  `ImportPage.tsx`, `UserManagementPage.tsx` (tenants/leden/accounts beheren — zie
  "Gebruikersbeheer & rollen"). De boomweergave zelf draait in `web/public/tree.html`
  (zie hieronder) — `TreePage.tsx` is alleen een dunne iframe-wrapper.
- `db/init.sql` — volledig datamodel (12 tabellen, zie ERD).
- `db/seed.sql` — huidige FPBB-productiedata, geëxporteerd uit de losstaande
  `doelenboom.html`-tool die dit project voorafging.

## Boomweergave: waarom een los `tree.html` in plaats van React-componenten

`web/public/tree.html` is een aangepaste kopie van de losstaande `doelenboom.html`-tool
die dit project voorafging: exact dezelfde CSS en interactielogica (SVG-verbindingslijnen
die transitief doorroutéren langs verborgen kolommen, klik-highlight van het hele pad,
dubbelklik-focusmodus, zoeken met auto-reveal, kolommen in/uitklappen, tag/organisatie-
filterchips, RAG-marker op projecten, SVG-export), maar de vroeger hardcoded
`DETAILS`/`EDGES`/... worden nu bij het laden opgehaald bij `GET
/api/doelenbomen/:id/tree` in plaats van handmatig in het bestand gezet bij elke
Excel-update. `TreePage.tsx` bindt dit in als iframe en geeft het JWT-token door via
`postMessage` (nooit via de URL/adresbalk) zodra het iframe meldt dat het klaar is.
Deze aanpak hergebruikt bewust de al vele iteraties geteste UX 1-op-1, in plaats van
die logica opnieuw op te bouwen in React-componenten.

## Excel-import en -export

`excel-service` herkent bij het inlezen automatisch of het geüploade bestand het
**oude** of het **nieuwe** formaat is (zie hieronder) — aan de hand van of er een
tabblad `Relaties` bestaat (nieuw) of losse tabbladen `Capability-OB relaties`/
`Project-Capability relaties` (oud). Er hoeft dus niets aangevinkt te worden bij het
uploaden; het rapport toont achteraf welk formaat gedetecteerd is.

Voor het oude formaat leest `excel-service` de 9 tabbladen (Referentietabel,
Capability-OB relaties, Project-Capability relaties, Projecten, Producten, Tags,
Element-Tag relaties, Organisatieonderdelen, OB-Organisatie relaties) met
alias-gebaseerde kolomherkenning (case/spatie-ongevoelig; kolomkoppen zijn geverifieerd
tegen een echte upload, `FPBB_doelenboom_referentietabel_v15.xlsx` — bv. "Mogelijke KPI
/ indicator" i.p.v. kaal "KPI", en "Product / deliverable" met spaties rond de schuine
streep). Voor het nieuwe formaat gelden dezelfde Referentietabel- en
Projecten/Producten/Tags/Organisatieonderdelen-tabbladen, maar één generieke `Relaties`-
tab (Bron-ID, Doel-ID, Relatietype, Toelichting) in plaats van de twee relatietabbladen
en de "Bovenliggend element"-kolom, plus een `Volgorde`- en `Actief`-kolom op de
Referentietabel. Beide formaten passen dezelfde opschoonregels toe die gedurende dit
project handmatig zijn vastgesteld (lege tijd 00:00, Excel-epoch-datums, literal 0 in
tekstvelden, "Geen FPBB-KPI" → "-").

Rijen worden genegeerd (met een melding in het rapport, nooit stilzwijgend) als: het
Type onbekend is, `Type = "Project (historisch)"` (oud formaat; traceability-archief,
geen actuele portfolio), of — alleen bij het nieuwe formaat — `Actief = "Nee"` staat.
Daarnaast worden een aantal bekende Type-labelvarianten genormaliseerd (bv.
"Operationele baat" → "Operationele benefit").

**Oud formaat** — verticale relaties (Operationele benefit → Sub-benefit →
Programmabaat → Strategische benefit → Strategisch doel → Missie) worden afgeleid uit
"Bovenliggend element". Voor de meeste niveaus staat daar een simpele elementcode;
vanaf Programmabaat opwaarts bleek in de praktijk ook samengestelde tekst voor te
komen zoals `"A1 primair; A2 ondersteunend"` of `"A1/A3 ondersteunend"` (meerdere
ouders, optioneel met een Relatietype-woord erachter) en voor Strategisch doel het
woord `"Missie"` i.p.v. de code `M1`. Dit wordt structureel geparsed (gesplitst op
`;`/`/`, Relatietype-woord herkend, en een type-naam als "Missie" herleid naar het
enige element van dat type); wat daarna nog niet naar een bekende code herleid kan
worden, wordt gemeld in plaats van geraden. **Nieuw formaat** — al deze relaties
(inclusief de vroegere Capability-OB- en Project-Capability-relaties) staan gewoon als
rijen in de ene `Relaties`-tab; hier is dus geen tekst-parsing voor nodig.

Projectvelden die alleen op de Projecten-tab staan (Cluster PPT, en "Uitgebreide
beschrijving" als de Referentietabel-rij van dat project leeg is) worden in beide
formaten meegenomen.

**Nog niet automatisch gerepliceerd** (oud formaat): de specifieke handmatige
uitzondering voor kandidaat-capabilities (C32-C49) uit
`doelenboom_update_instructie.md` §2a — dit soort projectspecifieke uitzonderingen
moet je nu zelf herkennen in het validatierapport vóór je op "Doorvoeren" klikt.

**Publiceren = volledige vervanging, ook bij verwijderingen.** Elke import blijft
*voorstel, geen automatische schrijfactie*: pas na het bekijken van het rapport en een
expliciete "Doorvoeren"-klik worden elementen/relaties/tags/producten/org-eenheden van
een doelenboom eerst allemaal verwijderd en daarna opnieuw ingevoegd vanuit de nieuwe
upload. Een rij die in het geüploade bestand ontbreekt — of, alleen in het nieuwe
formaat, op `Actief = "Nee"` staat — komt dus niet terug en verdwijnt bij publiceren
definitief uit de database, inclusief alles wat er cascade aan hangt (relaties,
projectstatus, producten, tags-koppelingen, org-koppelingen). Dit is getest: zowel het
volledig verwijderen van een Referentietabel-rij als het op `Actief = "Nee"` zetten
ervan zorgt dat die rij (en relaties die ernaar verwijzen) niet meer in de geparste
data zit, met een duidelijke melding in het rapport.

**Export** ("Exporteer als Excel"-knop in de boomweergave) is een wizard van twee
stappen: eerst welk **formaat** (Oud of Nieuw), dan of het een lege **template**
(alleen kolomkoppen) of de **huidige data** van deze doelenboom moet worden.

- **Oud formaat** — de huidige productiestructuur (9 tabbladen, zoals
  `FPBB_doelenboom_referentietabel_v15.xlsx`). Met de echte productiedata getest als
  volledige rondgang — importeren, exporteren, en het geëxporteerde bestand opnieuw
  importeren geeft exact dezelfde elementen, relaties, projectstatussen, producten,
  tags en org-eenheden terug.
- **Nieuw formaat** — het voorstel uit `voorstel_excel_structuur_v2.md`: Capability-OB
  relaties, Project-Capability relaties én de vrije-tekst-relaties uit "Bovenliggend
  element" zijn samengevoegd tot één generieke **Relaties**-tab (Bron-ID, Doel-ID,
  Relatietype, Toelichting); Referentietabel bevat geen statuskolommen meer (alleen nog
  op Projecten) en heeft een expliciete **Volgorde**- en **Actief**-kolom; en er is een
  **`_Validatielijsten`**-tab met bijbehorende Data Validation-dropdowns op alle
  gesloten-lijstvelden (Type, Actief, Relatietype, Projectstatus, RAG-status,
  Org-relatiestatus) — getest door de gegenereerde workbook te openen en te
  controleren dat elke dropdown naar de juiste celrange verwijst. **Kan weer worden
  geïmporteerd**: `parser.py` herkent het nieuwe formaat automatisch (aan het tabblad
  `Relaties`) en leest het volledig in, inclusief `Volgorde` en `Actief`. Met een
  export van de echte productiedata getest als volledige rondgang — exporteren en
  direct weer importeren geeft byte-voor-byte dezelfde elementen, relaties,
  projectstatussen, producten, tags en org-eenheden terug als het origineel.

Beide formaten krijgen een **Configuratie**-tab (Doelenboom, Tenant, Formaat, Modus,
Geëxporteerd op, Geëxporteerd door — met het e-mailadres van de ingelogde gebruiker,
en Bron), zodat een los rondgestuurd Excel-bestand altijd herleidbaar is naar waar en
door wie het gegenereerd is.

Bekende, geaccepteerde beperking (beide formaten): de `Toelichting`-kolom op een
Element-Tag-relatie wordt nog niet bewaard (de databron had hiervoor in de geteste
export ook geen relaties, dus dit kwam niet tot uiting in de test, maar is een reëel
gat als je die kolom wél vult).

## CRUD (los van de Excel-import/export-flow)

Naast de Excel-import (volledige vervanging van een doelenboom) kun je losse
elementen ook direct aanmaken, bewerken en verwijderen — zonder rapport/publiceer-stap,
de wijziging is meteen zichtbaar. Dit wordt gefaseerd uitgebreid:

1. **Elementen — gebouwd.** In de boomweergave: een "+ Nieuw element"-knop in de
   sticky topbar (Type, Code, Naam, Uitgebreide beschrijving, KPI, Taakveld,
   Sub-taakveld), en "Bewerken"/"Verwijderen"-knoppen onderin het detail-paneel dat
   verschijnt als je dubbelklikt op een element. API: `POST/PUT/DELETE
   /api/doelenbomen/:id/elements(/:code)` in `api/src/routes/elements.ts`. Code mag
   bij bewerken mee veranderen (niets anders verwijst er tekstueel naar). Verwijderen
   toont eerst een bevestiging, en verwijdert via `on delete cascade` in `db/init.sql`
   automatisch ook alle relaties, projectstatus, producten en tag-/organisatie-
   koppelingen van dat element. Na opslaan/verwijderen herlaadt de boomweergave (het
   iframe reload't, wat de bestaande ready/init-postMessage-handshake met de
   React-ouder opnieuw triggert — zo blijft er precies één set event-listeners actief
   in plaats van steeds meer bij elke handmatige refresh).
   Een nieuw element krijgt nog geen relaties mee (dat is fase 4) en verschijnt dus
   in zijn kolom zonder verbindingslijnen totdat je die later toevoegt.
2. **Tags en organisatieonderdelen — gebouwd.** Een "Tags & organisatieonderdelen
   beheren"-knop onder de tag/org-filterbalk opent één modal met daarin de twee
   stamlijsten naast elkaar: elk met een overzicht (naam, categorie/omschrijving,
   code) met "Bewerken"/"Verwijderen" per rij, en een formulier eronder om een
   nieuwe toe te voegen (klikken op "Bewerken" vult ditzelfde formulier en zet de
   knop om naar "Wijzigingen opslaan"). Code is optioneel — laat je die leeg, dan
   genereert de API er automatisch één (`T1`, `T2`, ... resp. `O1`, `O2`, ...). API:
   `POST/PUT/DELETE /api/doelenbomen/:id/tags(/:code)` en
   `/api/doelenbomen/:id/org-units(/:code)` in `api/src/routes/tags.ts` en
   `orgUnits.ts`. Verwijderen ruimt via `on delete cascade` ook de koppelingen met
   elementen (`element_tags`/`ob_org_relations`) op. Dit is nog puur de stamlijst —
   een tag/organisatieonderdeel aan een element koppelen is een relatie en komt in
   fase 3.
3. **Relaties (verbindingen) — gebouwd.** In het detail-paneel (dubbelklik op een
   element) staat nu een "Verbindingen"-blok: alle uitgaande (→) en inkomende (←)
   relaties van dat element, met per relatie "Bewerken" (alleen relatietype en
   toelichting; bron/doel wijzigen is een nieuwe relatie) en "Verwijderen", plus een
   "+ Relatie"-knop die een modal opent met richting (dit element → ander element,
   of andersom), een dropdown met alle andere elementen, relatietype en toelichting.
   API: `POST /api/doelenbomen/:id/edges`, `PUT/DELETE
   /api/doelenbomen/:id/edges/:source/:target` in `api/src/routes/edges.ts` —
   relaties worden geïdentificeerd op (bron-code, doel-code), niet op een intern id.

Met dit alles is de volledige CRUD-uitbreiding (elementen, tags/organisatieonderdelen,
relaties) gebouwd en met jsdom getest, los van en aanvullend op de bestaande
Excel-import/export-flow. Alle schrijfacties hierboven zijn nu rolgebonden — zie
"Gebruikersbeheer & rollen" hieronder.

## Gebruikersbeheer & rollen

Drie rollen, van breed naar smal:

- **sysadmin** (`users.is_sysadmin = true`) — globaal, mag alles: tenants
  aanmaken, alle accounts beheren (aanmaken/wijzigen/verwijderen, sysadmin-vlag
  zetten), en binnen elke tenant lezen én schrijven. Geen `tenant_users`-rij
  nodig; geldt overal.
- **admin** (`tenant_users.role = 'admin'`) — mag lezen én wijzigen binnen de
  tenant(s) waar hij/zij deze rol heeft: elementen/relaties/tags/
  organisatieonderdelen aanmaken/bewerken/verwijderen, Excel importeren/
  publiceren, tenant-instellingen (`wipe_on_empty`/`session_timeout_minutes`)
  aanpassen, en leden van die tenant beheren (uitnodigen, rol wijzigen,
  verwijderen). Mag geen nieuwe tenants aanmaken en heeft geen toegang tot
  tenants waar hij/zij geen lid van is.
- **gebruiker** (`tenant_users.role = 'gebruiker'`) — alleen lezen binnen de
  tenant(s) waar hij/zij lid van is. De boomweergave verbergt voor deze rol alle
  schrijf-knoppen (nieuw element, bewerken/verwijderen, relaties, tags/
  organisatieonderdelen beheren, Excel importeren) via een `read-only`-class op
  `<body>` — de daadwerkelijke autorisatiegrens ligt echter op de API
  (`api/src/rbac.ts`), niet in de UI.

Eén account kan lid zijn van meerdere tenants, met eventueel een andere rol per
tenant. Rollen worden bij elk verzoek live opgezocht (niet in het JWT gebakken),
zodat een rolwijziging direct ingaat zonder dat de gebruiker opnieuw hoeft in te
loggen.

**Beheerscherm.** Sysadmins en tenant-admins zien een "Gebruikersbeheer"-knop
naast hun e-mailadres op het overzichtsscherm (`PickerPage.tsx` →
`UserManagementPage.tsx`). Sysadmins zien daar alle tenants (en kunnen nieuwe
aanmaken) en alle accounts; tenant-admins zien alleen de tenant(s) waar zij
admin van zijn en kunnen daar leden toevoegen/wijzigen/verwijderen (incl. een
gloednieuw account aanmaken als het e-mailadres nog niet bestaat).

**API-endpoints:**
- `GET/POST/PUT/DELETE /api/users(/:id)` — accountbeheer zelf (sysadmin-only) —
  `api/src/routes/users.ts`. Er blijft altijd minstens één sysadmin over (zowel
  bij degraderen als verwijderen wordt dat afgedwongen).
- `GET/POST/PUT/DELETE /api/tenants/:tenantId/members(/:userId)` —
  lidmaatschap + rol binnen één tenant (sysadmin of admin van die tenant) —
  `api/src/routes/tenants.ts`. `POST` maakt het account meteen aan als het
  e-mailadres nog niet bestaat.
- Alle bestaande content-routes (elements/tags/orgUnits/edges/imports/exports/
  tree/doelenbomen) zijn nu voorzien van `requireTenantRole('admin', …)` op
  schrijfacties en `requireTenantRole('gebruiker', …)` op leesacties — zie
  `api/src/rbac.ts` voor de middleware-factory.

**Nog niet getest tegen een echte database** — zelfde beperking als bij Sessies
hieronder: de sandbox heeft geen Docker/Postgres, dus dit is alleen via
`tsc --noEmit` en jsdom-tests geverifieerd, nog niet end-to-end.

## Sessies & automatisch leegmaken

Voor sommige tenants (bv. demo-/testomgevingen) wil je dat de data verdwijnt zodra
er niemand meer mee bezig is, in plaats van dat die blijft rondslingeren. Dat is
per tenant instelbaar via `tenants.wipe_on_empty` (standaard uit) en
`tenants.session_timeout_minutes` (standaard 30) — nu alleen te zetten via
`PUT /api/tenants/:id` (body `{ "wipeOnEmpty": true, "sessionTimeoutMinutes": 30 }`)
of rechtstreeks in de database; er is nog geen instellingenscherm in de UI.

**Hoe "actief" gemeten wordt.** Een JWT is stateless — de server weet niet uit
zichzelf of een browser nog open staat. Daarom komt er bij elke login een rij in
een nieuwe `sessions`-tabel (`db/init.sql`), en stuurt de React-app (`App.tsx`)
zolang de tab open is elke minuut een heartbeat (`POST /api/auth/heartbeat`) die
`last_seen_at` bijwerkt — dit gebeurt onafhankelijk van muisbewegingen, dus een
open-maar-inactieve tab blijft tellen als actief. "Iemand is nog actief op tenant
X" betekent: er bestaat nog een sessie van een sysadmin, of van een gebruiker met
een `tenant_users`-rij voor tenant X, waarvan `last_seen_at` binnen de
`session_timeout_minutes` van tenant X valt (`api/src/tenantWipe.ts`,
`tenantHasActiveAccess`) — zie "Gebruikersbeheer & rollen" hierboven voor het
volledige rolmodel.

**Twee manieren waarop een wipe afgaat:**
- **Expliciet uitloggen** (`PickerPage.tsx`) — bij een klik op "Uitloggen" wordt
  eerst `GET /api/auth/logout-preview` aangeroepen (puur informatief, geen
  bijeffecten): zou dit uitloggen ertoe leiden dat een tenant leegloopt? Zo ja, dan
  toont de UI eerst per betrokken doelenboom een "Excel downloaden"-knop, en pas
  daarna — als aparte stap — een expliciete waarschuwing ("data wordt definitief
  verwijderd, dit kan niet ongedaan gemaakt worden") met een aparte bevestiging.
  Pas na die bevestiging wordt `POST /api/auth/logout` aangeroepen, dat de sessie
  beëindigt én de wipe daadwerkelijk uitvoert.
- **Stilletjes gesloten browser** — zonder expliciete logout krijgt niemand een
  kans om te bevestigen of te exporteren; dat is een fundamentele beperking (er is
  simpelweg niemand meer om het te vragen). Een interne `setInterval` in de
  API (`sweepIdleTenants`, elke minuut) controleert daarom voor elke
  `wipe_on_empty`-tenant of er nog een sessie binnen diens timeout valt, en maakt
  de tenant leeg zodra dat niet meer zo is — zonder dat daar een expliciete
  logout-actie voor nodig is.

**Wat "leegmaken" precies doet:** alle elementen (en via cascade hun relaties,
projectstatus, producten, tag- en organisatiekoppelingen), tags, organisatieonderdelen
en Excel-importgeschiedenis van elke doelenboom onder die tenant worden verwijderd.
De tenant- en doelenboom-rijen zelf (incl. slug/URL) blijven bestaan, klaar voor een
volgende Excel-import.

**Nog niet getest tegen een echte database** (dit ontwikkel-sandbox heeft geen
Docker/Postgres beschikbaar) — de SQL is met een SQL-parser op syntax gecontroleerd
en de TypeScript-compilatie is schoon, maar een end-to-end test (inloggen, wachten
tot de timeout verstrijkt, verifiëren dat de wipe echt afgaat) moet nog bij jou
lokaal gebeuren na `docker compose down -v`.

## Ontwikkelstatus (v1, lokaal)

Gebouwd en getest: auth, tenants/doelenbomen-CRUD (TypeScript-compilatie),
Excel-import oud formaat (parser getest tegen een echte productie-upload, niet alleen
synthetische testdata — daarbij zijn drie echte bugs gevonden en gefixt: KPI- en
productnaam-kolomkoppen die niet matchten, en de samengestelde "Bovenliggend
element"-tekst vanaf Programmabaat opwaarts), Excel-export in beide formaten
(import→export→reimport-rondgang met de echte data geverifieerd, data blijft exact
gelijk), Excel-import nieuw formaat (automatische formaatherkenning, unified
`Relaties`-tab, `Volgorde`/`Actief`; met dezelfde echte data getest als volledige
export→reimport-rondgang, en apart getest dat een verwijderde rij of een rij met
`Actief = "Nee"` er na publiceren écht uit is — publiceren blijft immers een
volledige vervanging van de doelenboom-data), en de boomweergave.

De boomweergave (`web/public/tree.html`) is end-to-end getest: via jsdom is de
volledige pagina geladen met een fixture die de live productiedata nabootst (123
elementen, 284 relaties), en zijn kolomrendering, klik-highlight langs het volledige
pad, focus-modus, zoeken, tag-filter en de export-dialoog geverifieerd door
daadwerkelijk events te dispatchen en de resulterende DOM-state te controleren.

**Nog niet getest**: een volledige `docker compose up` met alle vier services samen
(dit ontwikkel-sandbox had geen Docker beschikbaar) — dat is de eerstvolgende stap bij
jou lokaal. Let op de schema-wijziging hierboven (Cluster PPT) als je al eerder had
gedraaid.

Gebruikersbeheer/rollen (sysadmin/admin/gebruiker, zie hierboven) is inmiddels
gebouwd, incl. tenant aanmaken vanuit de UI (sysadmin) en leden beheren
(sysadmin/tenant-admin) — ook dit nog niet end-to-end tegen een echte database
getest.

Nog niet gebouwd: eigen wachtwoord wijzigen vanuit de UI (kan nu alleen door een
sysadmin via Gebruikersbeheer, of rechtstreeks in de database), doelenboom
aanmaken vanuit de UI (kan nu alleen via de API), behoud van de
`Toelichting`-kolom op Element-Tag-relaties.
