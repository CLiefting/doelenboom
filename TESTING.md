# Testen & regressie

Drie sporen, gekozen op basis van waar geautomatiseerd testen het meeste
oplevert voor de inspanning:

1. **`api/test/`** — geautomatiseerde integratietests (Node's ingebouwde
   testrunner, `node:test`) tegen een echte, wegwerpbare Postgres-database.
   Dekt alle routes: auth, rollen/rechten (tenant-rol + per-doelenboom
   override + read-only), tenants, gebruikers, doelenbomen (incl. dupliceren),
   elementen, tags, organisatieonderdelen, relaties, producten/planning-items,
   projectstatus, sessies, dbstat, en de Excel-import/export-rondgang (die
   laatste alleen als excel-service bereikbaar is, zie hieronder).
2. **`excel-service/tests/`** — geautomatiseerde tests (pytest) voor de
   Excel-parser/-exporter: opschoningsregels, validatie/waarschuwingen,
   verticale-relatie-afleiding, en een round-trip-test (exporteren -> weer
   inlezen moet dezelfde inhoud opleveren) voor beide formaten ("oud"/"nieuw").
3. **[`docs/regressie-checklist.md`](docs/regressie-checklist.md)** —
   handmatige checklist voor `web/public/tree.html` (de vanilla-JS
   boomweergave) en de React-schermen eromheen. Bewust niet geautomatiseerd:
   `tree.html` is imperatieve DOM-manipulatie zonder testinfra, en browser-
   automatisering (Playwright e.d.) zou een fors eigen opzet-traject vergen.
   Doorlopen vóór elke productie-deploy.

Geen CI: dit zijn losse commando's die je zelf draait, passend bij de huidige
lokaal-bouwen-en-deployen-werkwijze (zie `deploy/README.md`).

## api/test/ draaien

Vereist een draaiende Postgres — de gewone lokale dev-database uit
`docker-compose.yml` (poort 5432, gebruiker/wachtwoord `doelenboom`) is
genoeg; de tests gebruiken een **eigen database** (`doelenboom_test`) op
diezelfde Postgres-server, dus je dev-data blijft onaangeroerd.

```bash
set -euo pipefail
cd ~/OneDrive/src/doelenboom
docker compose up -d db
cd api
npm test
```

`npm test` doet automatisch eerst een `pretest`-stap die `doelenboom_test`
volledig opnieuw opzet vanuit `db/init.sql` (zie `api/scripts/reset-test-db.ts`)
— elke run begint dus gegarandeerd schoon.

De Excel-import/export-tests hebben daarnaast een bereikbare excel-service
nodig — die heeft in `docker-compose.yml` bewust geen host-poort (alleen de
api-container praat er intern mee), dus draai 'm voor deze tests even los:

```bash
set -euo pipefail
cd ~/OneDrive/src/doelenboom/excel-service
python3.12 -m venv .venv && source .venv/bin/activate   # 3.12: zelfde als Dockerfile, en fastapi vereist >=3.10
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Zonder deze stap slaat de testsuite die specifieke tests netjes over (géén
gefaalde run) — de rest van de suite heeft excel-service niet nodig.

Overschrijfbaar via env-vars (defaults hierboven): `TEST_DATABASE_URL`,
`JWT_SECRET`, `EXCEL_SERVICE_URL`.

## excel-service/tests/ draaien

Geen database of draaiende service nodig — dit zijn pure unit-/round-trip-
tests op de parser/exporter-functies zelf.

```bash
set -euo pipefail
cd ~/OneDrive/src/doelenboom/excel-service
python3.12 -m venv .venv && source .venv/bin/activate   # 3.12: zelfde als Dockerfile, en fastapi vereist >=3.10
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

## Handmatige checklist

Zie [`docs/regressie-checklist.md`](docs/regressie-checklist.md). Doorlopen
op `http://localhost:5173` (lokale dev-stack, `docker compose up --build`)
met minstens twee accounts van verschillende rollen.

## Bij nieuwe functionaliteit

- Nieuwe API-route → nieuw/uitgebreid testbestand in `api/test/` (happy path
  + validatie + rechten-check op zijn minst).
- Nieuw Excel-veld → aliassen/velden bijwerken in zowel
  `excel-service/app/parser.py` als `exporter.py` (bestaande conventie, zie
  README) én een round-trip-assertie toevoegen in
  `excel-service/tests/test_roundtrip.py`.
- Nieuwe UI-functionaliteit in `tree.html` → een punt toevoegen aan
  `docs/regressie-checklist.md`.
