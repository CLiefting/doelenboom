# Werkafspraken — Doelenboom (DOEL-55)

Deze afspraken gelden voor elke Claude Code-sessie in deze repository.

## Jira-plicht

Voor alles wat we aan Doelenboom doen komt een Jira-ticket in project **DOEL**
(https://schedulerpro.atlassian.net/browse/DOEL): features, bugs, fixes, uitrol,
documentatie, handleidingen en onderzoek. Geen losse code- of scriptwijziging zonder
ticket, ook niet voor "kleine" dingen — die worden dan een kleine taak.

- Nieuw werk: eerst een Jira-ticket (Taak of Bug), dan pas een branch.
- Ticketstatus volgt de voortgang (Nog doen → In uitvoering → Gereed); "Gereed" alleen
  als het werkend in productie staat (zie hieronder), niet al bij het mergen van de PR.
- Voeg bij afronding een comment toe met wat er is gedaan, welke PR/commit erbij hoort,
  en of het is uitgerold.

## Taal

Communicatie met Charles in het Nederlands.

## VERIFICATIEPLICHT

Beweringen over gedrag van de code, van tests, of van productie worden aangetoond,
niet aangenomen:

- Een fix voor een kwetsbaarheid of bug wordt eerst tegen de bestaande (falende) code
  bevestigd, met een regressietest die op de oude code aantoonbaar faalt en op de
  nieuwe slaagt.
- Geen "dit zou moeten werken" zonder het gedraaid te hebben: `tsc`, de volledige
  testsuite, en (bij Docker/rechten-gerelateerde wijzigingen) de image-smoketest.
- Beweringen over productie (staat het live, doet de fix wat hij moet doen) worden
  live gecontroleerd, niet aangenomen op basis van de deploy-uitvoer alleen.

## OWASP bij beveiligingswerk

Bij elke wijziging die met beveiliging te maken heeft: toetsen aan de OWASP Top 10, met
een bijbehorende regressietest. Zie eerdere tickets (DOEL-20 t/m DOEL-33, DOEL-38 e.v.)
voor het patroon: kwetsbaarheid eerst aantonen, dan fixen, dan de test die het aantoont.

## Git-werkwijze

- `main` is beschermd; wijzigingen via een eigen branch (`fix/doel-NNN-...` of
  `feat/doel-NNN-...`) en `scripts/pr-merge.sh` (pusht, wacht op groene CI, merget met
  merge-commit, ruimt de branch op).
- CI moet groen zijn: API-tests, web-tests, excel-service-tests, de image-smoketest,
  gitleaks en Semgrep (OWASP Top 10) zijn verplichte checks.
- Scripts die de repository wijzigen draaien één voor één, niet gebundeld — zeker rond
  git-operaties en deploys.
- Werk vanuit `${DOELENBOOM_DIR:-$HOME/src/doelenboom}` (zie README, "Geheimen en
  OneDrive"); nooit vanuit een cloud-gesynchroniseerde map (OneDrive/Dropbox/iCloud).

## Zie ook

- `README.md` — opzet, "Geheimen en OneDrive", CLI-gebruik (`doelenboom -local ...`).
- `deploy/README.md` — productie-uitrol (bewust nog handwerk, niet losgekoppeld van dit
  bestand geautomatiseerd).
- Jira-epics: DOEL-37 (Security) en DOEL-38 (OWASP compliance) voor de context achter
  de beveiligingstickets.
