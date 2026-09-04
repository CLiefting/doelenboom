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

## Nachtelijke reset van tenant Demo

De tenant Demo is bedoeld om vrij in te kunnen rondklikken/bewerken (alle
leden hebben admin-rechten) — daarom wordt elke nacht om 00:01 de VOLLEDIGE
tenant (alle doelenbomen, hun kolomconfiguraties, elementen/relaties/tags/
organisatieonderdelen, en project-info zoals deliverables/activiteiten/
projectstatus) teruggezet naar een eerder vastgelegde momentopname —
inclusief het weer verwijderen van een doelenboom die een bezoeker die dag
zelf heeft aangemaakt. Andere tenants worden niet geraakt, en de
inlog-accounts van de demo-gebruikers zelf blijven altijd bestaan.

Twee scripts (`api/src/scripts/snapshotDemoTenant.ts` /
`resetDemoTenant.ts`, draaien binnen de al-lopende api-container, geen
herstart nodig — zelfde patroon als de nachtelijke Excel-backup hieronder):

- **`deploy/snapshot-demo-tenant.sh`** — legt de HUIDIGE staat van tenant
  Demo vast als canonieke momentopname (JSON, weggeschreven naar
  `~/doelenboom/backups/demo-tenant-snapshot.json`, dezelfde bind mount als
  de Excel-backups). Draai dit **handmatig**, nooit via cron: alleen
  wanneer je de vaste demo-inhoud bewust wilt bijwerken (een nieuwe
  voorbeeldboom toevoegen, bestaande inhoud aanpassen). Generiek — pakt
  gewoon alles wat er op dat moment in de tenant staat, dus een later
  toegevoegde doelenboom wordt vanzelf meegenomen bij de eerstvolgende run.
- **`deploy/reset-demo.sh`** — zet tenant Demo terug naar de laatst
  vastgelegde momentopname. Dit is wat elke nacht via cron draait.

Eenmalig instellen op de VPS (na de eerstvolgende deploy die deze scripts
bevat):

```bash
chmod +x ~/doelenboom/deploy/reset-demo.sh ~/doelenboom/deploy/snapshot-demo-tenant.sh ~/doelenboom/deploy/install-cron-reset-demo.sh

# Leg de huidige staat vast als startpunt (zonder dit heeft reset-demo.sh
# nog niets om naar terug te zetten):
~/doelenboom/deploy/snapshot-demo-tenant.sh

~/doelenboom/deploy/install-cron-reset-demo.sh
```

`install-cron-reset-demo.sh` zet de cronregel niet-interactief neer (geen
`crontab -e`-editor nodig — die ontbreekt vaak op een kale VPS-shell) en is
idempotent, zelfde patroon als `install-cron-export-all.sh` hieronder:
bestaande regels blijven staan, opnieuw draaien voegt de regel niet nog een
keer toe. Controleren: `crontab -l`.

Handmatig testen (mag altijd, ook overdag — idempotent, eindigt altijd
exact in de snapshot-staat):
```bash
~/doelenboom/deploy/reset-demo.sh
tail -20 ~/doelenboom-demo-reset.log
```

Wil je de vaste demo-inhoud bewust bijwerken (nieuwe voorbeeldboom, aanpassing
aan een bestaande boom die moet blijven staan): breng die wijziging eerst zelf
aan in de app (of via een los data-script zoals
`deploy/vergunningen-boom-demo.sql`), en draai daarna
`~/doelenboom/deploy/snapshot-demo-tenant.sh` opnieuw om die staat als nieuwe
canonieke momentopname vast te leggen — anders wist de eerstvolgende
nachtelijke reset 'm weer.

## Nachtelijke Excel-backup

Elke nacht om 01:00 exporteert `api/src/scripts/exportAllDoelenbomen.ts`
(gecompileerd naar `dist/scripts/exportAllDoelenbomen.js`, draait in de
al-lopende `api`-container — geen aparte cronjob binnen Docker, geen extra
auth nodig) elke doelenboom van elke tenant als `.xlsx` (met exact
dezelfde inhoud als een handmatige export via de app, `GET /:id/export`,
zelfde `format=oud|nieuw`-keuze op basis van de kolomconfiguratie), **tenzij
dit voor die doelenboom is uitgezet**: instelbaar per doelenboom (en met een
tenant-brede standaardwaarde voor nieuw aan te maken doelenbomen) via het
schuifje "Meenemen in de nachtelijke Excel-back-up" in Tenantbeheer — zie
`doelenbomen.nightly_export_enabled`/`tenants.nightly_export_enabled` in
`db/init.sql`. Standaard staat dit **aan**.

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
./deploy/check-no-active-users.sh && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Let op de `&&`**: `check-no-active-users.sh` geeft bij een actieve gebruiker
wel exit 1 én een duidelijke waarschuwing, maar als je de commando's als losse
regels (zonder `&&`) plakt/uitvoert, loopt een terminal na die waarschuwing
gewoon door naar `up -d` — de exit code van een losstaande regel stopt niets.
Altijd met `&&` koppelen, niet als twee aparte commando's.

Bewust geen `--build` op de VPS — zelfde reden als bij de eerste deploy. Was
de wijziging alléén in `api`/`web`/`excel-service`-code, dan volstaat
`docker load` + `up -d` (compose herstart alleen containers waarvan de image
veranderd is). Alleen als `docker-compose.yml`/`docker-compose.prod.yml`
zelf wijzigde, is de `git pull` op de VPS ook nodig vóór `up -d`.

### Softwarecomponenten (SBOM): `sbom/`-map los overzetten

`scripts/generate-sbom.sh` schrijft naar `./sbom/` (bewust **niet** in git, zie
`.gitignore` — build-artefact, niet reproduceerbaar-identiek qua timestamp
tussen twee runs) en `docker-compose.yml` mount die map read-only in de
`api`-container (`SBOM_DIR=/app/sbom`, zie hierboven). Die map zit dus niet in
een `docker save`/`docker load`-image en ook niet in een `git pull` — zonder
extra actie toont de Softwarecomponenten-pagina op de VPS na een deploy
gewoon "geen SBOM beschikbaar" (netjes, geen crash, maar wel nutteloos).

Bewust **niet** op de VPS zelf genereren (zelfde reden als "images bouwen":
geen extra npm/pip-toolchain-belasting op de qua resources krappe, gedeelde
server) — in plaats daarvan lokaal genereren en meesturen met de images:

**Op de VPS eerst de INHOUD van de map leegmaken (niet de map zelf
verwijderen!)** — zie de twee waarschuwingen hieronder waarom het precies zo
moet — **daarna op je Mac**, ná `./scripts/generate-sbom.sh` (zie
hoofd-README):
```bash
ssh charles@185.107.90.64 'rm -rf ~/doelenboom/sbom/*'
scp -r sbom/. charles@185.107.90.64:~/doelenboom/sbom/
```

**Waarschuwing 1 — `scp -r` overschrijft NIET 1-op-1 als de doelmap al
bestaat:** `scp -r sbom host:~/doelenboom/sbom` (zónder de `/.`  hierboven)
plaatst de nieuwe bestanden, zodra `~/doelenboom/sbom` al bestaat (dus elke
keer ná de allereerste deploy), in een geneste submap
`~/doelenboom/sbom/sbom/...` in plaats van de bestaande `.json`-bestanden te
vervangen — `dependencyHealth.ts` leest dan stilzwijgend de oude,
nooit-bijgewerkte top-level bestanden, ook na een klik op "Nu controleren"
(die leest wél telkens vers van schijf, maar dan gewoon de verkeerde,
ongewijzigde bestanden). Geen foutmelding, geen crash — alleen een
Softwarecomponenten-pagina die na een deploy stilletjes de oude cijfers
blijft tonen. Vandaar `sbom/.` (de INHOUD van de lokale map, niet de map
zelf) als bron.

**Waarschuwing 2 — verwijder nooit de map `~/doelenboom/sbom` zelf, alleen
haar inhoud:** `docker-compose.yml`'s `./sbom:/app/sbom:ro` is een
bind-mount die bij het starten van de `api`-container aan die ene specifieke
map gekoppeld wordt. Verwijder je die map zelf (`rm -rf ~/doelenboom/sbom`)
en laat je scp 'm opnieuw aanmaken, dan blijft de al-draaiende container aan
de oude, inmiddels verwijderde map gekoppeld en ziet hij de nieuwe bestanden
niet — de Softwarecomponenten-pagina meldt dan zelfs "geen SBOM gevonden",
erger dan de oude cijfers uit waarschuwing 1. Dit is al één keer misgegaan in
productie. Is dit toch per ongeluk gebeurd, dan is de enige weg terug de
`api`-container herstarten zodat de bind-mount opnieuw gekoppeld wordt (zie
"Verplichte check: geen actieve gebruikers" hieronder — ook een `restart`
onderbreekt ingelogde gebruikers, dus eerst
`./deploy/check-no-active-users.sh` draaien):
```bash
./deploy/check-no-active-users.sh && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

**Op de VPS** is verder niets nodig — de map staat dan op de juiste plek
(`~/doelenboom/sbom`, wat `docker-compose.yml`'s `./sbom:/app/sbom:ro`
verwacht) vóórdat je `up -d` draait. Bij een latere dependency-wijziging dit
`rm -rf .../sbom/*` + `scp -r sbom/. ...`-tweetal herhalen (nooit de map zelf
verwijderen); een verse `sbom/`-set wordt pas zichtbaar in de app na een klik
op "Nu controleren".

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

## Nachtelijke databaseback-up

Elke nacht om 02:00 maakt `deploy/backup-database.sh` een volledige
`pg_dump` van de database (gzip-gecomprimeerd) — in tegenstelling tot de
Excel-back-up hierboven (die alleen de zichtbare boom-inhoud per doelenboom
dumpt) bevat dit ECHT alles: gebruikers/accounts/sessies/licenties/tenants/
doelenbomen/instellingen. Draait rechtstreeks vanaf de VPS-shell (niet
binnen de api-container), zelfde `pg_dump`-commando dat hiervoor als
handmatig uit te voeren stap in dit document stond.

**Locatie:** `~/doelenboom/backups/database/` op de VPS zelf. Bestandsnaam:
`doelenboom-<JJJJMMDD-UUMMSS>.sql.gz`.

**Bewaartermijn:** de laatste 14 dagen (instelbaar via de omgevingsvariabele
`BACKUP_RETENTION_DAYS`), elke nacht opnieuw toegepast op wat er dan op
schijf staat — bewust eenvoudiger dan de oplopende
dagelijks/wekelijks/maandelijks-opbouw van de Excel-back-up, want een
volledige databasedump is veel groter.

Eenmalig instellen op de VPS (na de eerstvolgende deploy die dit script
bevat):

```bash
chmod +x ~/doelenboom/deploy/backup-database.sh ~/doelenboom/deploy/install-cron-backup-database.sh
~/doelenboom/deploy/install-cron-backup-database.sh
```

Handmatig testen (mag altijd):
```bash
~/doelenboom/deploy/backup-database.sh
tail -20 ~/doelenboom-database-backup.log
ls -lh ~/doelenboom/backups/database/
```

Terugzetten (bv. na dataverlies of voor een lokale kopie van productiedata):
```bash
gunzip -c ~/doelenboom/backups/database/doelenboom-<tijdstip>.sql.gz | \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U doelenboom -d doelenboom
```

## MFA (tweestapsverificatie): SMTP-instellingen en herstel

Zie `doelenboom_mfa_ontwerp.md` (project) en `api/src/mfa.ts`/`api/src/email.ts`
voor het volledige ontwerp. Verplicht voor sysadmin-accounts, optioneel (zelf
aan/uit te zetten via "Mijn beveiliging") voor de rest.

**SMTP-relay instellen op de VPS:** vul in `.env` (naast `JWT_SECRET` etc.,
zie §4 hierboven) `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` en
eventueel `SMTP_FROM` in — zie `.env.example`. Voor Hostnet (bevestigd):
`SMTP_HOST=smtp.hostnet.nl`, `SMTP_PORT=587` (STARTTLS), `SMTP_USER=
no-reply@code072.nl` (de mailbox waarmee ingelogd wordt), `SMTP_FROM=
no-reply.doelenboom@code072.nl` (een alias van die mailbox — de afzender die
de ontvanger ziet, mag dus afwijken van `SMTP_USER`). Bewust `smtp.hostnet.nl`
i.p.v. het door Hostnet voor webapplicaties gesuggereerde `mailout.hostnet.nl`:
sommige VPN's/firewalls blokkeren die laatste specifiek (bekende
bulkmail-relay — zo ontdekt tijdens lokaal testen, zie `git log` op
`api/src/email.ts`), terwijl `smtp.hostnet.nl` (dezelfde mailbox, ander
adres) gewoon doorkomt en voor dit lage volume (incidentele inlogcodes)
functioneel gelijkwaardig is. Gebruik `scripts/set-smtp-env.sh` om dit
lokaal in te vullen zonder het wachtwoord ergens in een bestand of in de
chat te typen (vraagt het interactief, verborgen, en schrijft het alleen
naar je eigen `.env`). Staat `SMTP_HOST` leeg/ontbrekend, dan wordt er
**geen** e-mail verstuurd en komt de inlogcode alleen in de
`api`-container-log te staan
(`docker compose ... logs api`) — bruikbaar om de flow te testen, maar niet
geschikt voor productie: zet de SMTP-variabelen dus altijd vóór
productiegebruik.

**Een vergrendelde niet-sysadmin** (code niet ontvangen/bereikbaar): een
sysadmin zet MFA voor dat account uit via het bestaande Accountbeheer-scherm
(`PUT /api/users/:id`), zelfde plek als een wachtwoordreset.

**Een vergrendelde sysadmin:** bewust geen ingebouwd noodpad in de app (zou de
"verplicht voor sysadmins"-garantie ondermijnen als een andere sysadmin dit
voor een collega kon uitzetten) — herstel is, net als een vergeten
sysadmin-wachtwoord, een handmatige ingreep rechtstreeks op de database:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U doelenboom -d doelenboom -c \
  "update users set mfa_enabled = false where email = 'naam@voorbeeld.nl';"
```

Dit zet alleen de optionele `mfa_enabled`-vlag uit; voor een sysadmin is MFA
sowieso al verplicht ongeacht deze kolom (zie `mfaRequired` in `api/src/auth.ts`),
dus dit commando helpt daar **niet** — bij een vergrendelde sysadmin is de
enige weg terug tijdelijk inloggen met een ander sysadmin-account (indien
aanwezig) om de SMTP-instellingen/e-mailbezorging te herstellen, of anders
rechtstreeks in de database het account tijdelijk degraderen
(`update users set is_sysadmin = false where email = '...';`, daarna na
herstel weer terugzetten) — een bewuste, loggegevens-buiten-de-app-om-actie,
zelfde soort ingreep als de migratie-commando's hierboven.

## Openstaand aandachtspunt: offsite-kopie

De databaseback-up hierboven én de nachtelijke Excel-back-up staan beide
alleen lokaal op de VPS-schijf — bij verlies van de VPS zelf (hardware,
ongeval) ben je ook de back-ups kwijt. Voor nu bewust geaccepteerd risico;
aanbevolen vóór veel productiegebruik: periodiek (bv. met `rclone`/`rsync`,
in hetzelfde cron-patroon) een kopie van `~/doelenboom/backups/` naar een
andere locatie/opslagdienst wegschrijven. Zelfde aandachtspunt als bij
WWspeur, zie `SERVER-BEHEER.md`.
