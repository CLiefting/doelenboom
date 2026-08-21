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

## 8. Excel-export (topbar, `tree.html`)

- [ ] Export "oud" formaat, sjabloon (leeg) — download lukt, tabbladen/headers
      kloppen als je het bestand opent.
- [ ] Export "oud" formaat, met data — alle huidige elementen/producten/tags/
      OE's/relaties staan erin.
- [ ] Export "nieuw" formaat (sjabloon + met data) — idem, incl. dropdown-
      validatie op de kolommen die dat moeten hebben (Type, Actief,
      Projectstatus, RAG, Product-type, Relatietype, Org-relatie-status).
- [ ] SVG-export van de boom (indien aanwezig in deze weergave) toont de volle
      boom zonder clipping, met de kolomkop-header op de juiste positie.

## 9. Rollen & rechten — expliciete matrix

Doorloop minstens deze combinaties (met echte, verschillende accounts):

| Rol                                   | Mag lezen | Mag schrijven | Opmerking |
|----------------------------------------|:---:|:---:|---|
| Sysadmin                                | ✅ | ✅ | Ook op read-only doelenbomen |
| Tenant-admin                            | ✅ | ✅ | Niet als doelenboom read-only staat |
| Tenant-gebruiker                        | ✅ | ❌ | Alleen-lezen overal |
| Tenant-admin met doelenboom-override "gebruiker" | ✅ | ❌ | Alleen in díe ene doelenboom |
| Tenant-gebruiker met doelenboom-override "admin" | ✅ | ✅ | Alleen in díe ene doelenboom |

- [ ] Voor elke rij: schrijfacties (element/tag/OE/edge/product/projectstatus
      aanmaken/wijzigen/verwijderen) zijn precies aan/uit zoals in de tabel.
- [ ] Een tenant-admin kan een read-only doelenboom altijd zelf weer op
      schrijfbaar zetten (mag niet zichzelf buitensluiten).

## 10. Algemeen / cross-cutting

- [ ] Geen JavaScript-fouten in de browserconsole tijdens een normale sessie
      (inloggen -> boom bekijken -> bewerken -> exporteren -> uitloggen).
- [ ] Reload van de pagina (F5) op elk scherm herstelt een werkende staat
      (geen "Failed to fetch" of witte pagina).
- [ ] Werkt in minstens twee browsers (bv. Chrome/Brave + Safari of Firefox).
- [ ] Response-tijden voelen niet merkbaar trager aan dan vóór de wijziging.
