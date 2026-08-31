# Deployment — doelenboom.code072.nl

De VPS (Hostnet, 185.107.90.64) is al gehard en de gedeelde infra
(`code072-infra`: Postgres + Traefik) draait daar al voor WWspeur — zie
`code072-infra/README.md` en `WWspeur/deploy/SERVER-BEHEER.md` voor die opzet.
Dit document beschrijft alleen wat *specifiek voor Doelenboom* bijkomt: geen
server-hardening, geen nieuwe infra-stack, gewoon een derde app-stack die
aanhaakt op het al bestaande gedeelde netwerk `code072-net` — precies het pad
dat `code072-infra/CUTOVER.md` onder "Later: schedulerpro.code072.nl" al
beschrijft.

`docker-compose.yml` (repo-root) blijft de lokaal geteste configuratie en
wordt niet aangepast. Op de VPS gebruik je 'm samen met
`docker-compose.prod.yml` (overlay: Traefik-routing, sluit host-poorten af,
bouwt `web` met de productie-Dockerfile) — zie stap 5.

Doelenboom krijgt een **eigen, geïsoleerde Postgres-container** binnen zijn
eigen stack (niet de gedeelde `code072-infra`-Postgres die WWspeur gebruikt)
— bewuste keuze, zie de toelichting bovenaan `docker-compose.prod.yml`.

**Images worden lokaal gebouwd, niet op de VPS.** Bij de eerste deploy-poging
bleek dat `up -d --build` op de VPS (tsc/vite-build voor `api`/`web`,
`pip install` voor `excel-service`, allemaal parallel) de server minutenlang
vrijwel onbereikbaar maakte, omdat WWspeur's backend daar tegelijk zware
scan-batches draait (Puppeteer/Chromium, tot ruim 2GB RAM) en de VPS geen
swap heeft. Daarom: `api`/`web`/`excel-service` bouw je op je eigen Mac (ruim
voldoende resources, en concurreert met niets), en zet je als kant-en-klare
images over naar de VPS — die hoeft dan alleen nog containers te *starten*,
niet te *bouwen*. Zie stap 5 hieronder.

## 1. DNS (in Mijn Hostnet)

`*.code072.nl` wijst al naar 185.107.90.64 (wildcard, zie
`WWspeur/deploy/SERVER-BEHEER.md`), dus `doelenboom.code072.nl` werkt
technisch al zonder nieuwe DNS-actie. Voeg 'm voor de duidelijkheid/consistentie
toch expliciet toe (zelfde patroon als `wwspeur.code072.nl` destijds):

| Host | Type | Waarde |
|---|---|---|
| `doelenboom.code072.nl` | A | 185.107.90.64 |

Wacht tot het doorgepropageerd is (`dig doelenboom.code072.nl` moet het
VPS-IP teruggeven) vóórdat je de stack start — Traefik vraagt bij het eerste
gebruik meteen een Let's Encrypt-certificaat aan (HTTP-01-challenge) en dat
mislukt als het DNS-record nog niet klopt.

## 2. Een eigen deploy key voor dit repo

De bestaande `~/.ssh/id_ed25519_deploy` op de VPS is een **read-only deploy
key van het `WWspeur`-repo specifiek** (GitHub-deploy keys gelden per repo) —
die kan dit repo niet clonen. Nieuwe key, alleen voor `doelenboom`:

```bash
ssh charles@185.107.90.64
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_deploy_doelenboom -N "" -C "doelenboom-vps-hostnet"
cat ~/.ssh/id_ed25519_deploy_doelenboom.pub
```

Voeg de public key toe op GitHub → `CLiefting/doelenboom` → Settings → Deploy
keys → Add deploy key. Naam bijv. `doelenboom-vps-hostnet`, **geen** write
access aanvinken (alleen lezen — zelfde afweging als bij WWspeur: bij
compromittatie van de VPS blijft de blast radius beperkt tot leestoegang op
dit ene repo).

`~/.ssh/config` op de VPS heeft `github.com` al gereserveerd voor de
WWspeur-key, dus een apart alias:

```bash
cat >> ~/.ssh/config <<'EOF'

Host github.com-doelenboom
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_deploy_doelenboom
  IdentitiesOnly yes
EOF
```

## 3. Repo ophalen

```bash
cd ~
git clone git@github.com-doelenboom:CLiefting/doelenboom.git
cd doelenboom
```

## 4. Env-bestand invullen

```bash
cp .env.example .env
nano .env
```

Vul in:
- `POSTGRES_PASSWORD` — nieuw, willekeurig wachtwoord (niet hergebruiken van
  WWspeur/code072-infra — dit is een aparte, eigen Postgres-instance).
- `JWT_SECRET` — **verplicht wijzigen**, nooit de dev-default. Genereren:
  ```bash
  python3 -c "import secrets; print(secrets.token_urlsafe(32))"
  ```

Bewaar beide waarden in een password manager (zelfde gewoonte als bij
WWspeur's `POSTGRES_PASSWORD`/`SECRET_KEY`).

## 5. Images bouwen (op je Mac) en overzetten naar de VPS

**Op je Mac**, in je lokale `doelenboom`-checkout:

```bash
cd ~/pad/naar/doelenboom   # je lokale dev-checkout, niet de VPS
export BUILD_VERSION="$(./scripts/build-version.sh)"   # anders toont de footer straks "dev" i.p.v. de release
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -f docker-compose.yml -f docker-compose.prod.yml build api web excel-service
docker save doelenboom-api:latest doelenboom-web:latest doelenboom-excel-service:latest \
  | gzip > doelenboom-images.tar.gz
scp doelenboom-images.tar.gz charles@185.107.90.64:~/
```

**`DOCKER_DEFAULT_PLATFORM=linux/amd64` is verplicht op een Apple
Silicon-Mac** (M1/M2/M3/...): zonder die variabele bouwt Docker standaard
voor `linux/arm64` (jouw Mac), terwijl de VPS `linux/amd64` is. De containers
starten dan wel, maar crashen meteen in een restart-lus (exec-format-
mismatch) — `docker compose ps` toont dan `Restarting` voor `api`/
`excel-service`, en compose waarschuwt expliciet met "platform ... does not
match the detected host platform". Op een Intel-Mac is de variabele niet
nodig, maar schaadt ook niet.

De `build` gebruikt automatisch de productie-Dockerfiles/build-args uit
`docker-compose.prod.yml` (nginx voor `web`, `VITE_API_URL=""`, etc.) omdat
je 'm meegeeft — precies dezelfde images die anders op de VPS gebouwd zouden
worden, alleen nu lokaal. `docker save`/`scp` duurt even (het archief is
enkele honderden MB); dat is normaal.

**Op de VPS**, na het overzetten:

```bash
ssh charles@185.107.90.64
docker load < ~/doelenboom-images.tar.gz
rm ~/doelenboom-images.tar.gz   # opgeruimd, images staan al in de lokale docker-store
cd ~/doelenboom
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api
```

Bewust **geen** `--build` hier: de `image:`-tags in `docker-compose.yml`
(`doelenboom-api:latest` etc.) zijn na `docker load` al aanwezig, dus compose
gebruikt die direct en start alleen containers — geen tsc/vite/pip-build op
de VPS zelf, dus geen concurrentie met wat WWspeur op datzelfde moment doet.
Alleen `db` (`postgres:18-alpine`) wordt hier nog gewoon van Docker Hub
gepulld — dat is een klein, kant-en-klaar image, geen build.

Wacht tot `db` "healthy" is en `api`/`web` gestart zijn (`api`-logs tonen
schema-aanmaak via `db/init.sql` + `db/seed.sql` op een verse database — zie
hoofd-README, sectie "Starten (lokaal)" voor wat je daar verwacht).

Vergeet je `-f docker-compose.prod.yml`, dan draait de app nog steeds, maar
dan met de dev-server (`vite --host`, geen nginx) en open host-poorten
5432/4000/5173 — dus niet bereikbaar via het domein. Gebruik daarom altijd
beide `-f`-vlaggen op de VPS. Scheelt typen, alias in `~/.bashrc`:

```bash
alias dbprod='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
```

## 6. Eerste inlog

Standaard sysadmin-account uit `db/seed.sql`: `admin@code072.nl` /
`changeme`. **Meteen wachtwoord wijzigen** na de eerste login (Gebruikersbeheer
→ eigen account, of gewoon de "Wachtwoord wijzigen"-link in de picker-header)
— dit gebeurt niet automatisch, `must_change_password` staat voor dit
seed-account op `false` (zie `db/seed.sql`).

## Controles achteraf

- `curl -I http://doelenboom.code072.nl` → redirect naar https (Traefik doet
  dit automatisch)
- `curl -I https://doelenboom.code072.nl` → 200, geldig certificaat
- `curl -sI https://doelenboom.code072.nl | grep -i strict-transport` →
  HSTS-header aanwezig (bevestigt dat `security-headers@file` werkt)
- Vanaf een andere machine: `nmap -p 22,80,443,4000,5432,5173 185.107.90.64`
  → alleen 22/80/443 open vanaf buiten; 4000/5432 alleen via
  `127.0.0.1` (SSH-tunnel), 5173 helemaal dicht
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config`
  → bevestigt dat `db`/`api` alleen op `127.0.0.1` publiceren en `web`
  helemaal niets, en dat `web`/`api` op `code072-net` zitten
- Log in op `https://doelenboom.code072.nl`, open een doelenboom, en
  controleer dat Excel-import/export en de boomweergave werken (raakt
  `excel-service` resp. de eigen Postgres-container)
- `/dbstat` en `/sessions` (als sysadmin) laden zonder errors

## Demo-tenant bijladen op een al-lopende database

`db/seed.sql` draait alleen automatisch bij de allereerste containerstart (lege
`db_data`). Was jouw stack (zoals hier) al eerder gestart met een oudere
seed-versie, dan komt de nieuwe tenant **Demo**/doelenboom **Gezond ouder** er
niet vanzelf bij. Eenmalig, zonder iets te wissen (de `if not exists`-guard in
`db/seed.sql` zorgt dat dit alleen de Demo-tenant toevoegt, andere tenants
zoals `kmar` blijven ongewijzigd staan):

```bash
cd ~/doelenboom
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U "${POSTGRES_USER:-doelenboom}" -d "${POSTGRES_DB:-doelenboom}" \
  -v ON_ERROR_STOP=1 < db/seed.sql
```

## Nachtelijke reset van de Demo-doelenboom

De Demo-doelenboom is bedoeld om vrij in te kunnen rondklikken/bewerken (alle
leden van de tenant Demo hebben admin-rechten) — daarom wordt de inhoud elke
nacht om 00:01 teruggezet naar de canonieke demo-data uit
`deploy/reset-demo.sql` (een kopie van het demo-gedeelte van `db/seed.sql`,
zonder de tenant/doelenboom zelf opnieuw aan te maken). Andere tenants worden
niet geraakt.

Eenmalig instellen op de VPS:

```bash
chmod +x ~/doelenboom/deploy/reset-demo.sh
crontab -e
```

Voeg toe:
```
1 0 * * * /home/charles/doelenboom/deploy/reset-demo.sh >> /home/charles/doelenboom-demo-reset.log 2>&1
```

Handmatig testen (mag altijd, ook overdag):
```bash
~/doelenboom/deploy/reset-demo.sh
tail -20 ~/doelenboom-demo-reset.log
```

Wijzig je later de demo-inhoud in `db/seed.sql`, werk dan ook
`deploy/reset-demo.sql` bij (zelfde INSERT-blokken) — zie de toelichting
bovenaan dat bestand.

## Nachtelijke Excel-backup

Elke nacht om 01:00 exporteert `api/src/scripts/exportAllDoelenbomen.ts`
(gecompileerd naar `dist/scripts/exportAllDoelenbomen.js`, draait in de
al-lopende `api`-container — geen aparte cronjob binnen Docker, geen extra
auth nodig) **elke doelenboom van elke tenant** als `.xlsx`, met exact
dezelfde inhoud als een handmatige export via de app (`GET /:id/export`,
zelfde `format=oud|nieuw`-keuze op basis van de kolomconfiguratie).

**Locatie:** `~/doelenboom/backups/<tenant-slug>/<doelenboom-slug>/` op de
VPS zelf (bind mount naar `/backups` in de container, zie
`docker-compose.prod.yml`) — bewust **niet** in Docker-volumes en **niet**
offsite; dat laatste staat nog open, zie "Backups" onderaan dit document.
Bestandsnaam: `<doelenboom-slug>_<JJJJ-MM-DD>.xlsx`.

**Bewaartermijn** (toegepast per doelenboom, elke nacht opnieuw op wat er dan
op schijf staat):
- jonger dan 30 dagen: elke nacht een bestand
- 30 dagen tot 1 jaar oud: alleen zondagen
- 1 jaar of ouder: alleen de eerste zondag van de maand, voor altijd

Eenmalig instellen op de VPS (na de eerstvolgende deploy die dit script
bevat — zie "Updates uitrollen" hieronder):

```bash
chmod +x ~/doelenboom/deploy/export-all-doelenbomen.sh ~/doelenboom/deploy/install-cron-export-all.sh
~/doelenboom/deploy/install-cron-export-all.sh
```

`install-cron-export-all.sh` zet de cronregel niet-interactief neer (geen
`crontab -e`-editor nodig) en is idempotent — bestaande regels (zoals de
demo-reset hierboven) blijven staan, en opnieuw draaien voegt de regel niet
nog een keer toe. Controleren: `crontab -l`.

Handmatig testen (mag altijd):
```bash
~/doelenboom/deploy/export-all-doelenbomen.sh
tail -40 ~/doelenboom-excel-backup.log
ls -R ~/doelenboom/backups | head -50
```

## Updates uitrollen

Zelfde principe als de eerste deploy (stap 5): bouw de nieuwe images op je
Mac, zet ze over, laad ze op de VPS, herstart alleen dan.

**Op je Mac:**
```bash
cd ~/pad/naar/doelenboom
git pull   # zorg dat je lokale checkout de wijziging heeft die je wilt uitrollen
export BUILD_VERSION="$(./scripts/build-version.sh)"   # anders toont de footer straks "dev" i.p.v. de release
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -f docker-compose.yml -f docker-compose.prod.yml build api web excel-service
docker save doelenboom-api:latest doelenboom-web:latest doelenboom-excel-service:latest \
  | gzip > doelenboom-images.tar.gz
scp doelenboom-images.tar.gz charles@185.107.90.64:~/
```

**Op de VPS:**
```bash
ssh charles@185.107.90.64
docker load < ~/doelenboom-images.tar.gz
rm ~/doelenboom-images.tar.gz
cd ~/doelenboom
git pull   # voor eventuele niet-image-wijzigingen (docker-compose*.yml, db/init.sql, README's)
./deploy/check-no-active-users.sh   # verplicht — zie hieronder
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Bewust geen `--build` op de VPS — zelfde reden als bij de eerste deploy. Was
de wijziging alléén in `api`/`web`/`excel-service`-code, dan volstaat
`docker load` + `up -d` (compose herstart alleen containers waarvan de image
veranderd is). Alleen als `docker-compose.yml`/`docker-compose.prod.yml`
zelf wijzigde, is de `git pull` op de VPS ook nodig vóór `up -d`.

### Verplichte check: geen actieve gebruikers vóór `up -d`

`docker compose ... up -d` herstart de `api`/`web`-containers zodra hun image
is vervangen — dat onderbreekt iedereen die op dat moment ingelogd is midden
in hun werk (de React-app verliest zijn state, een openstaande wijziging in
de boom kan verloren gaan). Draai daarom altijd eerst, ná `git pull` en vóór
`up -d`:

```bash
./deploy/check-no-active-users.sh
```

Dit script (`deploy/check-no-active-users.sh`) query't rechtstreeks de
`sessions`-tabel in de lopende `db`-container, met exact dezelfde
"actief"-definitie als het Login-overzicht in de app zelf (`GET
/api/sessions`, zie `api/src/routes/sessions.ts`): niet expliciet uitgelogd
(`ended_at is null`) én de laatste heartbeat niet langer dan 5 minuten
geleden. Twee uitkomsten:

- **Geen actieve gebruikers** → exit 0, meteen door naar `up -d`.
- **Wel iemand actief** → exit 1, met een lijst van welk(e) e-mailadres(sen)
  nu ingelogd zijn en sinds wanneer. **Niet updaten** in dat geval — wacht
  tot iedereen is uitgelogd (of stem eerst met ze af) en draai het script
  daarna opnieuw. Overweeg bij herhaaldelijk actieve gebruikers een update
  buiten kantooruren.

Een schemawijziging (`db/init.sql`) werkt **niet** met een simpele restart —
die scripts draaien alleen bij de allereerste containerstart op een lege
`db_data`-volume. Voor een schemawijziging in productie is een echte migratie
nodig (zie hoofd-README, "Ontwikkelstatus" — dit project heeft nog geen
migratietool, `init.sql` is bewust "plat"); tot die tijd: schemawijzigingen
handmatig met `docker compose exec db psql ...` doorvoeren, nooit
`down -v` op productiedata.

### Een los migratiebestand draaien (bv. `db/migrations/0017_...sql`)

Elk bestand in `db/migrations/` is bewust idempotent (`if not exists`,
`on conflict ... do nothing`) — veilig om per ongeluk twee keer te draaien,
en de exacte SQL die ook al in `db/init.sql` is gespiegeld (zie de
toelichting bovenaan elk migratiebestand), zodat een gloednieuwe installatie
en een bestaande productiedatabase op hetzelfde schema uitkomen. Zorg eerst
dat de VPS-checkout het bestand ook daadwerkelijk heeft (`git pull` — een
migratie die alleen lokaal bestaat, bestaat voor de VPS niet):

**Op de VPS:**
```bash
cd ~/doelenboom
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0017_legal_and_retention.sql
```

Draai dit vóór (of tegelijk met) het uitrollen van de nieuwe `api`/`web`-
images uit die release — de nieuwe applicatiecode verwacht de nieuwe kolommen
en tabellen (`legal_documents`, `legal_acceptances`, `account_retention_events`,
`users.last_login_at`/`inactivity_warning_sent_at`/`scheduled_deletion_at`)
al te bestaan. Zie ook `docs/juridische-documenten-en-retentie.md` voor wat
deze specifieke migratie toevoegt en waarom.

## Backups

Een echte databasebackup is nog niet ingericht (zelfde aandachtspunt als bij
WWspeur, zie `SERVER-BEHEER.md`) — de nachtelijke Excel-export hierboven
("Nachtelijke Excel-backup") is een aanvulling daarop, geen vervanging: het
is een dump van de zichtbare boom-inhoud per doelenboom, geen volledige
databasebackup (geen gebruikers/accounts/sessies/licenties), en staat alleen
lokaal op de VPS — bij verlies van de VPS zelf ben je ook deze kwijt. Voor nu
bewust geaccepteerd risico; aanbevolen vóór veel productiegebruik: dezelfde
soort offsite-kopie als hieronder voor de databasebackup, ook toepassen op
`~/doelenboom/backups/`.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec db \
  pg_dump -U doelenboom doelenboom > ~/doelenboom-backup-$(date +%Y%m%d-%H%M).sql
```

Periodiek (bv. cron) + offsite-kopie, zelfde aanpak als voorgesteld voor
WWspeur.
