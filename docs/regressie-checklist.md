# Handmatige regressie-checklist (UI)

Dit is het derde spoor van de regressietest-aanpak, naast de geautomatiseerde
suites in `api/test/` en `excel-service/tests/` (zie `TESTING.md` in de
projectroot). Dekt vooral `web/public/tree.html` — de vanilla-JS boomweergave
met iframe-architectuur, die (bewust, zie `TESTING.md`) niet geautomatiseerd
wordt getest — plus een korte pas over de React-schermen eromheen.

**Wanneer gebruiken:** vóór elke productie-deploy, en na elke wijziging aan
`tree.html` of de React-app die niet al gedekt is door de automatische
suites. Loop de secties die relevant zijn voor de wijziging door; bij twijfel:
alles.

**Hoe:** vink af in een kopie van dit bestand, of gewoon lokaal doorlopen op
`http://localhost:5173` na `docker compose up --build`. Log in met minstens
twee accounts van verschillende rollen (sysadmin + tenant-gebruiker) om
rol-afhankelijk gedrag te kunnen zien.

---

## 1. Inloggen & sessie (React-app)

- [ ] Inloggen met correcte gegevens lukt en toont de doelenboom-kiezer.
- [ ] Inloggen met onjuist wachtwoord/onbekend e-mailadres toont een foutmelding.
- [ ] Een account met `mustChangePassword` wordt gedwongen naar de
      wijzig-wachtwoord-pagina vóór verder iets anders te kunnen doen.
- [ ] Wachtwoord wijzigen met verkeerd huidig wachtwoord geeft een foutmelding;
      met correct huidig wachtwoord + nieuw wachtwoord (≥8 tekens) lukt het en
      kom je daarna in de app.
- [ ] Uitloggen toont (indien van toepassing) eerst de "wordt deze tenant
      leeggemaakt"-preview/waarschuwing vóór het daadwerkelijk uitloggen.
- [ ] Na verloop van de sessietijdout (of gesimuleerd door het token te laten
      verlopen) volgt een nette redirect naar de inlogpagina, geen kapotte staat.
- [ ] De versie-footer (rechtsonder, `v<versie>`) is zichtbaar op de login-,
      kiezer- en boomweergave.

## 2. Doelenboom-kiezer & tenant/gebruikersbeheer (React-app)

- [ ] De kiezer toont alleen doelenbomen van tenants waar de ingelogde
      gebruiker lid van is (sysadmin ziet alles).
- [ ] Een tenant-gebruiker (rol "gebruiker") ziet geen aanmaak-/beheerknoppen
      waar een tenant-admin die wel ziet.
- [ ] Tenant aanmaken (sysadmin-only) lukt; dubbele slug geeft een duidelijke
      foutmelding.
- [ ] Doelenboom aanmaken binnen een tenant (tenant-admin of sysadmin) lukt.
- [ ] Gebruikersbeheer: nieuw account aanmaken, rol toewijzen per tenant,
      rol wijzigen, lidmaatschap verwijderen — elk direct zichtbaar effect.
- [ ] Per-doelenboom rol-override instellen/wissen (zie
      `UserManagementPage.tsx`) wijzigt zichtbaar de effectieve rol van die
      gebruiker in díe ene doelenboom, andere doelenbomen blijven ongewijzigd.
- [ ] Sessies-overzicht (sysadmin) en DB-statistieken-overzicht (sysadmin)
      laden zonder fouten en tonen actuele data.
- [ ] Doelenboom dupliceren (sysadmin) — binnen dezelfde tenant én naar een
      nieuwe tenant — resulteert in een volledig gevulde kopie.

## 3. Excel-import (React-app, `ImportPage.tsx`)

- [ ] Upload van een geldig "oud"-formaat bestand toont een rapport
      (aantallen + eventuele waarschuwingen) zonder te publiceren.
- [ ] Upload van een bestand met fouten (bv. ontbrekende Referentietabel)
      toont de foutmelding en biedt geen publiceer-knop aan.
- [ ] Publiceren van een geslaagde import vervangt de inhoud van de doelenboom
      volledig (oude elementen die niet meer in het bestand staan, verdwijnen).
- [ ] Re-importeren van een eerder geëxporteerd bestand (rondgang) geeft een
      schoon rapport (geen onverwachte waarschuwingen).
- [ ] Excel-export (topbar in `tree.html`, zie hieronder) downloadt een
      `.xlsx`-bestand met een zinnige bestandsnaam.

## 4. Boomweergave — navigatie & weergave (`tree.html`)

- [ ] De boom laadt en toont alle kolommen/niveaus correct.
- [ ] Zoeken op naam/code springt naar en markeert het juiste element.
- [ ] Op een element klikken opent het detailpaneel met de juiste gegevens.
- [ ] Focus-modus (inzoomen op een tak) werkt en toont alleen relevante
      elementen; weer uitzoomen herstelt de volledige boom.
- [ ] **Na een opslaan-actie (element/tag/OE/edge/product/projectstatus)
      blijft de huidige focus behouden** — geen terugval naar de volledig
      uitgezoomde boom (dit was een eerder gefixte regressie, expliciet
      controleren).
- [ ] Legenda is altijd zichtbaar boven in de pagina en klopt met de
      kleuren/symbolen in de boom.
- [ ] Bouwrichting omdraaien (topbar-icoon, dubbele pijl): Missie komt links
      te staan en Project rechts (en andersom weer terug); verbindingslijnen
      en kolomrelatie-pijlen lopen na het omdraaien nog steeds netjes tussen
      de juiste vakken (geen rare terugbuigende lijnen).
- [ ] Na het omdraaien blijft "Kolom (links/rechts) tonen" werken en het
      label/pijltje van die knop past zich aan de richting aan; alleen Missie
      is standaard zichtbaar, ongeacht de gekozen richting.
- [ ] De gekozen bouwrichting blijft staan na een reload van dezelfde
      doelenboom (per-doelenboom onthouden), en is onafhankelijk per
      doelenboom (omdraaien in boom A wijzigt boom B niet).
- [ ] Kijkrichting/anker wisselen (topbar-icoon, cirkel met stralen): standaard
      start alleen Missie zichtbaar en onthult "Kolom (links) tonen" richting
      Project; na het wisselen start alleen Project zichtbaar en onthult die
      knop richting Missie. De fysieke links/rechts-positie van de kolommen
      verandert hierbij **niet** (in tegenstelling tot de bouwrichting-knop
      hierboven) — beide instellingen zijn onafhankelijk te combineren.
      "↺ Alleen Missie"/"↺ Alleen Project"-knop past zijn label/gedrag ook aan.
      Ook deze voorkeur blijft staan na een reload, per doelenboom.

## 5. Filters & beheer (topbar, `tree.html`)

- [ ] "Filters"-dropdown opent/sluit correct (ook bij klikken buiten de
      dropdown) en toont de tag-/organisatieonderdeel-filterchips.
- [ ] Filteren op één of meerdere tags/organisatieonderdelen beperkt de
      getoonde elementen correct; filters wissen herstelt de volledige boom.
- [ ] "Beheer"-knop (alleen zichtbaar met schrijfrechten) opent het
      tags/organisatieonderdelen-stamlijstbeheer; aanmaken/wijzigen/verwijderen
      van een tag of OE werkt en is meteen zichtbaar in de filters.
- [ ] Topbar blijft compact (geen onnodig hoge balk) op zowel smalle als brede
      vensters.

## 6. Element-CRUD (detailpaneel, `tree.html`)

- [ ] Nieuw element aanmaken (elk type) met verplichte velden gevalideerd.
- [ ] Element bewerken (incl. code hernoemen) slaat op en de boom werkt
      daarna nog steeds correct (relaties/tags/OE-koppelingen blijven intact).
- [ ] Element verwijderen vraagt bevestiging en verwijdert ook gekoppelde
      relaties/producten/tags/OE-koppelingen (cascade) uit de weergave.
- [ ] Tags en organisatieonderdelen koppelen/ontkoppelen aan een element werkt
      vanuit het detailpaneel (niet-Project-elementen) — en is **niet**
      dubbel zichtbaar op een Project-element (dat beheert dit alleen nog via
      de projectkaart, zie §7).
- [ ] Relaties (edges) toevoegen/wijzigen/verwijderen tussen twee elementen
      werkt, inclusief validatie tegen een zelf-relatie.
- [ ] Alleen gebruikers met schrijfrechten zien de bewerk-/aanmaak-/
      verwijderknoppen; een read-only gebruiker of read-only doelenboom toont
      overal alleen-lezen (geen kapotte knoppen, gewoon afwezig/uitgeschakeld).

## 7. Projectkaart (`tree.html`, Project-elementen)

- [ ] Header toont in één regel: nr + naam, projectstatus-badge, TAGS-chips,
      organisatieonderdeel-chips, in die volgorde.
- [ ] "Bewerken" op de status opent een modal voor projectstatus/RAG/
      toelichting/rapportagedatum/cluster PPT; opslaan werkt, wissen zet de
      status terug naar "nog niet gerapporteerd".
- [ ] Tijdlijn boven de producten-sectie toont maand- of kwartaalvlakken
      (kwartaal bij een lange periode), een "vandaag"-streepje binnen bereik,
      en per product/mijlpaal het juiste symbool op de juiste datum.
- [ ] Tijdlijn oogt compact en past bij de rest van de stijl (geen dominant/
      te groot element) — dit was een eerder expliciet gecorrigeerd punt.
- [ ] Nieuw planning item (deliverable of mijlpaal) aanmaken, met datumvelden
      die zichtbaar en correct blijven bij het heropenen van het bewerk-modal
      (eerder gefixte bug: datums bleven leeg staan).
- [ ] Producten-lijst: openstaande items bovenaan, gerealiseerde items
      (met werkelijke datum) onderaan, gescheiden door een zichtbare
      separator.
- [ ] Een product met een verstreken verwachte datum én geen werkelijke datum
      krijgt een rode "te laat"-rand/badge; zodra een werkelijke datum wordt
      ingevuld verdwijnt die markering.
- [ ] Product bewerken/verwijderen werkt en de tijdlijn/lijst werken meteen bij.

## 8. Project-tijdlijnenoverzicht (topbar-icoon, `tree.html`)

- [ ] Topbar-icoon (Gantt-balkjes) opent het overzicht; topbar/legenda/
      filters/boom verdwijnen, alleen het overzicht + "Terug naar boom"-icoon
      (boompictogram) blijven zichtbaar.
- [ ] Alle projecten met minstens één product met een verwachte/werkelijke
      datum staan op één gedeelde tijdas (geen los tegeltje per project);
      projecten zonder geplande data staan als aparte lijst onderaan.
- [ ] Projectstatus staat als klein, subtiel gekleurd label onder de
      projectnaam (niet als opvallende badge die naast/onder de naam wrapt).
- [ ] Het label "vandaag" staat één keer, in de gedeelde koprij boven de
      lijst — niet los herhaald per project-rij.
- [ ] Zonder een gemarkeerd pad in de boom (zie de klik-om-te-markeren-hint)
      toont het overzicht alle projecten. Markeer je een element (bv. een
      capability), dan toont het overzicht **alleen** de daarmee verbonden
      projecten, met een banner die vermeldt waarop gefilterd is + hoeveel
      van het totaal; "Wis markering" in die banner herstelt de volledige
      lijst.
- [ ] Op een project-rij klikken springt naar de boom, ingezoomd op dat
      project (net als dubbelklikken in de gewone boomweergave).
- [ ] **"Terug naar vorig scherm" vanuit die focus gaat terug naar het
      tijdlijnenoverzicht** (niet naar de volledige boom) als je er via een
      klik op een rij in het overzicht kwam — ook nog na een tussentijdse
      opslaan-actie (die de pagina herlaadt).
- [ ] Boompictogram (topbar) sluit het overzicht en toont weer de gewone
      boomweergave.

## 9. Excel-export & SVG-export (topbar, `tree.html`)

- [ ] Export "oud" formaat, sjabloon (leeg) — download lukt, tabbladen/headers
      kloppen als je het bestand opent.
- [ ] Export "oud" formaat, met data — alle huidige elementen/producten/tags/
      OE's/relaties staan erin.
- [ ] Export "nieuw" formaat (sjabloon + met data) — idem, incl. dropdown-
      validatie op de kolommen die dat moeten hebben (Type, Actief,
      Projectstatus, RAG, Product-type, Relatietype, Org-relatie-status).
- [ ] Elke export (beide formaten, beide modi) bevat een **"Kolommen"**-tab
      met één rij per geconfigureerde kolom (volgorde, type, titel,
      ondertitel, kleur, smal, projectrol, label naar volgende kolom,
      lettergrootte) — bij een doelenboom met een aangepaste kolomconfiguratie
      staan hier de eigen typen in, niet de 8 standaardtypes.
- [ ] Gedownloade bestandsnaam volgt het patroon
      `Doelenboom_<Tenant>_<Doelenboomnaam>_<JJMMDD>.xlsx` — met de
      leesbare **naam** van tenant/doelenboom (niet de slug).
- [ ] SVG-export zonder gemarkeerd pad: toont de volle (huidig zichtbare)
      boom zonder clipping, met de kolomkop-header op de juiste positie.
- [ ] SVG-export mét een gemarkeerd pad (klik op een vak): bevat **alleen**
      de gemarkeerde vakken en hun onderlinge verbindingen (geen volledige
      boom); kolomkoppen en kolomrelatie-pijlen blijven wel staan voor
      context. Bestandsnaam bevat de code van het gemarkeerde element
      (`doelenboom-pad-<code>.svg`).

## 10. Rollen & rechten — expliciete matrix

### 10.1 Testopstelling (eenmalig per testronde, als sysadmin)

- [ ] Nieuwe tenant aanmaken, specifiek voor deze testronde (bv. slug
      `regressietest`) — niet hergebruiken/vervuilen van een bestaande
      tenant.
- [ ] Binnen die tenant een nieuwe doelenboom aanmaken (leeg is prima, of
      importeer een klein testbestand — zie §3).
- [ ] Drie test-accounts aanmaken, **één per basisrol**, alle drie lid van
      deze tenant:
      - `regressietest-sysadmin@...` — rol **sysadmin** (systeembreed, niet
        tenant-gebonden, maar wel als lid toevoegen aan de tenant zodat er
        ook een "gewoon tenant-lidmaatschap"-pad getest wordt)
      - `regressietest-admin@...` — rol **tenant-admin** binnen
        `regressietest`
      - `regressietest-gebruiker@...` — rol **tenant-gebruiker** binnen
        `regressietest`
- [ ] Voor de laatste twee rijen van de matrix hieronder: op de nieuwe
      doelenboom een per-doelenboom rol-override instellen (Gebruikersbeheer,
      zie §2) — `regressietest-admin` → override "gebruiker",
      `regressietest-gebruiker` → override "admin".

### 10.2 Matrix — per account inloggen en verifiëren

| Rol                                   | Mag lezen | Mag schrijven | Opmerking |
|----------------------------------------|:---:|:---:|---|
| Sysadmin                                | ✅ | ✅ | Ook op read-only doelenbomen |
| Tenant-admin                            | ✅ | ✅ | Niet als doelenboom read-only staat |
| Tenant-gebruiker                        | ✅ | ❌ | Alleen-lezen overal |
| Tenant-admin met doelenboom-override "gebruiker" | ✅ | ❌ | Alleen in díe ene doelenboom |
| Tenant-gebruiker met doelenboom-override "admin" | ✅ | ✅ | Alleen in díe ene doelenboom |

- [ ] Voor elke rij: log in met het bijbehorende account uit §10.1 en
      controleer dat schrijfacties (element/tag/OE/edge/product/
      projectstatus aanmaken/wijzigen/verwijderen) precies aan/uit staan
      zoals in de tabel — én dat lezen (boom bekijken, exporteren) altijd
      lukt.
- [ ] Tenant-gebruiker/tenant-admin-met-override "gebruiker": bewerk-/
      aanmaak-/verwijderknoppen zijn **afwezig** (niet zichtbaar-maar-
      uitgeschakeld) in zowel de React-schermen als `tree.html`.
- [ ] Sysadmin ziet en kan schrijven op de nieuwe `regressietest`-doelenboom
      zonder er lid van te hoeven zijn (systeembrede toegang).
- [ ] Een tenant-admin kan een read-only doelenboom altijd zelf weer op
      schrijfbaar zetten (mag niet zichzelf buitensluiten).
- [ ] Opruimen: de `regressietest`-tenant (en daarmee alle drie accounts en
      de doelenboom, cascade) weer verwijderen na afloop van de testronde.

## 11. Kolomconfiguratie (React-app + `tree.html`)

Zie `docs/kolommen-configuratie-ontwerp.md` voor het volledige ontwerp. De
kern-CRUD (validatie, "kolom nog in gebruik"-blokkade, tenant-default vs.
doelenboom-config-onafhankelijkheid, dynamische Excel-Type-lijst) is al gedekt
door `api/test/columnConfig.test.ts` en `excel-service/tests/`; dit hier is
puur de UI-doorloop.

- [ ] Een **nieuwe** tenant aanmaken (sysadmin) en een nieuwe doelenboom
      daarbinnen: de boom toont meteen de 8 standaardkolommen (Project t/m
      Missie), precies zoals vóór de configureerbare kolommen.
- [ ] Gebruikersbeheer → tenant selecteren → "Standaardkolommen"
      (sysadmin-only, niet zichtbaar voor een tenant-admin): kolom
      toevoegen/verwijderen/herordenen (pijltjes)/hernoemen/kleur wijzigen/
      projectrol verplaatsen, opslaan lukt en toont de bijgewerkte lijst.
- [ ] Kolom toevoegen zonder titel, zonder geldige kleur, met een dubbele
      type-naam, of zonder (of met twee) een "Projectrol" aangevinkt: elk
      geeft een duidelijke foutmelding vóór het opslaan lukt.
- [ ] Een standaardkolommen-wijziging van de tenant-default heeft **geen**
      zichtbaar effect op een al bestaande doelenboom in diezelfde tenant
      (eigen, onafhankelijke kopie) — wél op een doelenboom die je daarna pas
      aanmaakt.
- [ ] Gebruikersbeheer → doelenboom → "Kolommen" (zichtbaar voor tenant-admin
      én sysadmin, niet voor een tenant-gebruiker/read-only account): toont de
      eigen kolommen van díe doelenboom, los van de tenant-default.
- [ ] Een kolom verwijderen/hernoemen waarvan nog elementen van dat type
      bestaan geeft een foutmelding met het aantal betrokken elementen; na
      die elementen te verwijderen/verplaatsen lukt het opslaan alsnog.
- [ ] Na het toevoegen van een nieuwe kolom (eigen type-naam): dat type
      verschijnt meteen als keuze in "Type" bij "+ Nieuw element" en bij
      "+ Relatie" in `tree.html` — een element van dat type aanmaken en zien
      verschijnen in de juiste kolom.
- [ ] `tree.html` van een doelenboom met een **aangepaste** kolomconfiguratie
      (andere titels/kleuren/volgorde/aantal kolommen dan de standaard 8):
      legenda, kolomkoppen, kolomrelatie-pijlen/labels, node-kleuren en de
      "Alleen `<laatste kolom>`"/bouwrichting-omdraaien/kijkrichting-knoppen
      tonen overal de juiste, eigen namen — geen restanten van "Project"/
      "Missie" als de kolommen zijn hernoemd.
- [ ] Bij zo'n aangepaste configuratie: de knop "Oud formaat" in het
      Excel-exportmenu is **uitgeschakeld** (met een tooltip die uitlegt
      waarom); "Nieuw formaat" werkt gewoon en de dropdown/validatielijst
      voor "Type" in het geëxporteerde bestand bevat exact de eigen
      kolommen, in de juiste volgorde.
- [ ] Een doelenboom met de ongewijzigde standaard 8 kolommen kan nog gewoon
      als "oud" formaat geëxporteerd worden (knop niet uitgeschakeld).
- [ ] Zo'n "nieuw"-formaat-export met eigen kolommen re-importeren in
      dezelfde doelenboom (upload → rapport → publiceren) geeft een schoon
      rapport, geen "Onbekend Type-label"-waarschuwingen voor de eigen
      types.
- [ ] Doelenboom dupliceren (sysadmin, zie §2): de kopie krijgt de **eigen**
      kolomconfiguratie van de bron mee (niet de huidige tenant-default, ook
      als die inmiddels afwijkt).

## 12. Algemeen / cross-cutting

- [ ] Geen JavaScript-fouten in de browserconsole tijdens een normale sessie
      (inloggen -> boom bekijken -> bewerken -> exporteren -> uitloggen).
- [ ] Reload van de pagina (F5) op elk scherm herstelt een werkende staat
      (geen "Failed to fetch" of witte pagina).
- [ ] Werkt in minstens twee browsers (bv. Chrome/Brave + Safari of Firefox).
- [ ] Response-tijden voelen niet merkbaar trager aan dan vóór de wijziging.
