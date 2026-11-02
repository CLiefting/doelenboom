#!/usr/bin/env bash
# doelenboom — kleine CLI-wrapper om de lokale (en later: productie-)stack te
# beheren zonder telkens de losse docker compose-commando's te hoeven
# onthouden. Uitbreidbaar: voeg een nieuwe -vlag toe aan de for-loop hieronder
# en een bijbehorende case in het ACTION-blok.
#
# Installeren als alias (eenmalig, in ~/.zshrc):
#   alias doelenboom="${DOELENBOOM_DIR:-$HOME/src/doelenboom}/scripts/doelenboom-cli.sh"
# Daarna: bron je shell opnieuw (nieuwe terminal, of `source ~/.zshrc`).
#
# Lokale omgeving kiezen (DOEL-132): -acc (standaard), -dev (synoniem: -ont) of -kluis.
#   acceptatie   http://localhost:8088  gele driehoek "ACC"   (docker-compose.acc.yml)
#   ontwikkeling http://localhost:5173  groene driehoek "ONT" (docker-compose.yml)
#   kluis        http://localhost:8089  rode driehoek "VAULT" (docker-compose.kluis.yml, DOEL-133):
#                gevoelige doelenbomen, altijd dezelfde versie als productie
#
# Gebruik:
#   doelenboom -local -open               # acceptatie openen; draait hij niet, dan eerst starten met de
#                                         # images van de laatste acceptatierun (er wordt niets gebouwd)
#   doelenboom -local -restart            # acceptatie opnieuw opbouwen en keuren = bash scripts/acceptatie.sh
#                                         # (alleen op een bijgewerkte, schone main; schrijft het bewijs)
#   doelenboom -local -stop               # acceptatie stoppen (de acceptatiedatabase blijft bewaard)
#   doelenboom -local -dev -open          # ontwikkelomgeving openen; draait hij niet, dan eerst bouwen en starten
#   doelenboom -local -dev -restart       # ontwikkelomgeving herbouwen (gewijzigde images) en herstarten
#   doelenboom -local -dev -rebuild -restart  # idem, én eerst de nieuwe db/migrations/*.sql toepassen
#                                         # (alleen wat nog niet gedraaid is, zie scripts/db-migrate.sh)
#   doelenboom -local -dev -stop          # ontwikkelomgeving stoppen (database-data blijft bewaard)
#   doelenboom -local -ont ...            # hetzelfde als -dev
#   doelenboom -local -kluis -open        # kluis openen (zo nodig starten; waarschuwt als hij achterloopt
#                                         # op productie of als de laatste back-up te oud is)
#   doelenboom -local -kluis -restart     # kluis herstarten met dezelfde images (bouwt nooit; een nieuwe
#                                         # versie komt alleen via scripts/release.sh of scripts/kluis.sh --bijwerken)
#   doelenboom -local -kluis -stop        # kluis stoppen (de database blijft bewaard)
#   doelenboom -local -dev -restart -open # herbouwen/herstarten, en daarna meteen de browser openen
#   (Docker Desktop wordt zo nodig automatisch gestart, zie DOEL-57)
#   doelenboom -zip                       # ~/Downloads/db_backend.zip (api) en db_frontend.zip (web) maken,
#                                         # zonder node_modules, .env en .DS_Store
#   doelenboom -zip -d                    # die twee zips weer verwijderen
set -euo pipefail

# Vaste, veilige locatie i.p.v. dynamische BASH_SOURCE-resolutie (Charles, 14
# september 2026: "maak scripts veilig. zet daar cd ~/OneDrive/src/doelenboom
# altijd voor" — na een sessie vol OneDrive-verwarring waarbij dit project op
# meerdere plekken tegelijk kon staan, waarvan sommige leeg of verouderd. Een
# script dat zijn eigen locatie afleidt via BASH_SOURCE kan zo, afhankelijk
# van welke symlink/kopie toevallig actief was, stilzwijgend tegen de
# verkeerde/lege map aanpraten — met verwarrende fouten diep in docker compose
# tot gevolg i.p.v. meteen een duidelijke melding. Deze vaste cd + expliciete
# check hieronder falen liever meteen en luid.
# DOEL-33: overschrijfbaar (DOELENBOOM_DIR) zodat de map buiten OneDrive kan staan.
REPO_DIR="${DOELENBOOM_DIR:-$HOME/src/doelenboom}"
if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "Kan doelenboom niet vinden op $REPO_DIR (geen docker-compose.yml daar)." >&2
  echo "Is de map leeg, verplaatst, of nog niet gesynchroniseerd (bv. door een OneDrive-issue)? Controleer dit eerst." >&2
  exit 1
fi
cd "$REPO_DIR"

# Zelfde credential-fallback als docker-compose.yml (${POSTGRES_USER:-doelenboom}
# e.d.) — hardcoded default "doelenboom", maar overschrijfbaar door dezelfde
# env-vars te exporteren als je .env afwijkt van .env.example.
DB_USER="${POSTGRES_USER:-doelenboom}"
DB_NAME="${POSTGRES_DB:-doelenboom}"

ENVIRONMENT=""
# DOEL-132: welke lokale omgeving (acc of dev); leeg = standaard acc.
LOCAL_ENV=""
ACTION=""
REBUILD_SCHEMA=""
DELETE_ZIPS=""
OPEN_BROWSER=""

set_local_env() {
  if [ -n "$LOCAL_ENV" ] && [ "$LOCAL_ENV" != "$1" ]; then
    echo "Kies één lokale omgeving: -acc, -dev (-ont) of -kluis, niet meerdere." >&2
    exit 1
  fi
  LOCAL_ENV="$1"
}

for arg in "$@"; do
  case "$arg" in
    -local) ENVIRONMENT="local" ;;
    -acc) set_local_env acc ;;
    -dev|-ont) set_local_env dev ;;
    -kluis) set_local_env kluis ;;
    -prod) ENVIRONMENT="prod" ;;
    -restart) ACTION="restart" ;;
    -stop) ACTION="stop" ;;
    -zip) ACTION="zip" ;;
    -d) DELETE_ZIPS="1" ;;
    -rebuild) REBUILD_SCHEMA="1" ;;
    -open) OPEN_BROWSER="1" ;;
    *)
      echo "Onbekende optie: $arg" >&2
      echo "Bekende opties: -local [-acc | -dev | -ont | -kluis] | -prod, -restart, -stop, -open, -rebuild, -zip [-d]" >&2
      exit 1
      ;;
  esac
done

if [ -n "$DELETE_ZIPS" ] && [ "$ACTION" != "zip" ]; then
  echo "-d hoort bij -zip (doelenboom -zip -d verwijdert de zips)." >&2
  exit 1
fi
# -zip werkt op de bronmap en heeft geen omgeving nodig.
if [ "$ACTION" != "zip" ] && [ -z "$ENVIRONMENT" ]; then
  echo "Geef een omgeving op: -local of -prod" >&2
  exit 1
fi
# DOEL-58: -open is een los modifier-flag (zelfde patroon als -rebuild/-d), geen
# eigen ACTION — zo werkt zowel "doelenboom -local -open" (app draait al, alleen
# een tabblad openen) als "doelenboom -local -restart -open" (herbouwen/herstarten
# en meteen erna de browser openen). Daarom telt een gezette -open hier ook mee
# als "er is iets te doen", naast de bestaande ACTION-opties.
if [ -z "$ACTION" ] && [ -z "$OPEN_BROWSER" ]; then
  echo "Geef een actie op: -restart, -stop, -open of -zip" >&2
  exit 1
fi
if [ "$ACTION" != "restart" ] && [ -n "$REBUILD_SCHEMA" ]; then
  echo "-rebuild (migraties toepassen) hoort bij -restart, niet bij -$ACTION." >&2
  exit 1
fi
if [ "$ACTION" = "zip" ] && [ -n "$ENVIRONMENT" ]; then
  echo "-zip werkt zonder -local of -prod." >&2
  exit 1
fi
if [ -n "$OPEN_BROWSER" ] && [ "$ENVIRONMENT" != "local" ]; then
  echo "-open werkt alleen met -local." >&2
  exit 1
fi
# DOEL-132: -acc/-dev/-ont kiezen een LOKALE omgeving; standaard acceptatie.
if [ -n "$LOCAL_ENV" ] && [ "$ENVIRONMENT" != "local" ]; then
  echo "-acc, -dev, -ont en -kluis horen bij -local (bv. doelenboom -local -dev -open)." >&2
  exit 1
fi
if [ "$ENVIRONMENT" = "local" ] && [ -z "$LOCAL_ENV" ]; then
  LOCAL_ENV="acc"
fi
if [ "$LOCAL_ENV" = "kluis" ] && [ -n "$REBUILD_SCHEMA" ]; then
  echo "-rebuild hoort niet bij de kluis: die krijgt migraties alleen via scripts/release.sh (scripts/kluis.sh --bijwerken)." >&2
  exit 1
fi
if [ "$LOCAL_ENV" = "acc" ] && [ -n "$REBUILD_SCHEMA" ]; then
  echo "-rebuild hoort bij de ontwikkelomgeving (doelenboom -local -dev -rebuild -restart); acceptatie past de migraties zelf toe." >&2
  exit 1
fi
if [ "$ACTION" = "stop" ] && [ -n "$OPEN_BROWSER" ]; then
  echo "-open na -stop heeft geen zin (de app staat dan juist stil)." >&2
  exit 1
fi

if [ "$ENVIRONMENT" = "prod" ]; then
  # Bewust nog niet geautomatiseerd: een productie-restart/-deploy raakt een
  # live omgeving (en soms een schemamigratie, zie db/migrations/) — dat blijft
  # voorlopig het bewuste, stap-voor-stap proces uit deploy/README.md i.p.v.
  # één commando dat per ongeluk te makkelijk te herhalen is.
  echo "Productie-acties zijn nog niet geautomatiseerd in dit script — volg deploy/README.md." >&2
  exit 1
fi

# DOEL-57: zonder dit gaf -restart/-stop een cryptische
# "failed to connect to the docker API at unix:///.../docker.sock ..."
# als Docker Desktop nog niet (volledig) opgestart was — geen Docker-fout,
# gewoon nog niet aan. `docker info` is de goedkope, snelle check die zowel
# de CLI als de daemon dekt; als die al slaagt doen we verder niets. Anders
# starten we Docker Desktop zelf (macOS: `open -a Docker`) en wachten we tot
# de daemon reageert, met een harde, uitlegbare timeout i.p.v. voor altijd
# te blijven hangen als het opstarten om wat voor reden dan ook vastloopt.
# Overschrijfbaar via DOELENBOOM_DOCKER_TIMEOUT, zelfde patroon als
# DOELENBOOM_DIR hierboven.
DOCKER_START_TIMEOUT="${DOELENBOOM_DOCKER_TIMEOUT:-90}"

ensure_docker_running() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  echo "==> Docker Desktop lijkt niet te draaien, wordt gestart..."
  if ! command -v open >/dev/null 2>&1; then
    echo "Kan Docker Desktop niet automatisch starten ('open' ontbreekt — dit is macOS-only)." >&2
    echo "Start Docker Desktop handmatig en probeer het opnieuw." >&2
    exit 1
  fi
  open -a Docker

  local waited=0
  until docker info >/dev/null 2>&1; do
    if [ "$waited" -ge "$DOCKER_START_TIMEOUT" ]; then
      echo "Docker Desktop is na ${DOCKER_START_TIMEOUT}s nog niet bereikbaar." >&2
      echo "Open Docker Desktop, controleer of hij goed opstart, en probeer het daarna opnieuw." >&2
      echo "(Langere timeout: DOELENBOOM_DOCKER_TIMEOUT=180 doelenboom ...)" >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "    Docker Desktop draait (na ${waited}s)."
}

if [ "$ACTION" = "restart" ] || [ "$ACTION" = "stop" ] || [ -n "$OPEN_BROWSER" ]; then
  ensure_docker_running
fi

# DOEL-132: de acceptatieomgeving (docker-compose.acc.yml) met dezelfde
# projectnaam en env-bestanden als scripts/acceptatie.sh. Gebouwd wordt
# acceptatie alleen door dat script (bewijs per commit, DOEL-127/131); hier
# alleen starten (--no-build), stoppen en openen.
ACC_ENV_FILE="$REPO_DIR/.acceptatie/acc.env"
acc_compose() {
  if [ ! -f "$ACC_ENV_FILE" ]; then
    echo "De acceptatieomgeving is hier nog nooit opgebouwd ($ACC_ENV_FILE ontbreekt)." >&2
    echo "Bouw en keur hem eerst:  doelenboom -local -acc -restart   (= bash scripts/acceptatie.sh)" >&2
    exit 1
  fi
  local args=(docker compose -p doelenboom-acc -f "$REPO_DIR/docker-compose.acc.yml")
  [ -f "$REPO_DIR/.env" ] && args+=(--env-file "$REPO_DIR/.env")
  args+=(--env-file "$ACC_ENV_FILE")
  "${args[@]}" "$@"
}
# DOEL-133: de kluis loopt via scripts/kluis.sh (geheimen in ~/.doelenboom-kluis).
KLUIS_HOME_DIR="${KLUIS_HOME:-$HOME/.doelenboom-kluis}"
kluis_compose() {
  [ -f "$KLUIS_HOME_DIR/kluis.env" ] || return 1
  local args=(docker compose -p doelenboom-kluis -f "$REPO_DIR/docker-compose.kluis.yml")
  [ -f "$REPO_DIR/.env" ] && args+=(--env-file "$REPO_DIR/.env")
  args+=(--env-file "$KLUIS_HOME_DIR/kluis.env")
  [ -f "$KLUIS_HOME_DIR/versie.env" ] && args+=(--env-file "$KLUIS_HOME_DIR/versie.env")
  "${args[@]}" "$@"
}
# Draait de web-container van deze omgeving al? (lege uitvoer = nee)
env_running() {
  if [ "$LOCAL_ENV" = "kluis" ]; then
    [ -n "$(kluis_compose ps --status running -q web 2>/dev/null)" ]
  elif [ "$LOCAL_ENV" = "acc" ]; then
    [ -n "$(acc_compose ps --status running -q web 2>/dev/null)" ]
  else
    [ -n "$(docker compose ps --status running -q web 2>/dev/null)" ]
  fi
}

# -open zonder -restart/-stop: draait de gekozen omgeving nog niet, dan eerst
# starten. Ontwikkeling: zoals -restart (bouwen en starten). Acceptatie: de
# images van de laatste acceptatierun starten, zonder te bouwen.
if [ "$LOCAL_ENV" = "kluis" ] && [ ! -f "$KLUIS_HOME_DIR/kluis.env" ]; then
  echo "De kluis is op deze Mac nog niet ingericht ($KLUIS_HOME_DIR/kluis.env ontbreekt)." >&2
  echo "Inrichten:  KLUIS_SYSADMIN_EMAIL=jij@example.nl bash scripts/kluis.sh --init" >&2
  exit 1
fi
if [ -n "$OPEN_BROWSER" ] && [ -z "$ACTION" ] && ! env_running; then
  if [ "$LOCAL_ENV" = "kluis" ]; then
    echo "==> De kluis draait niet; wordt gestart (er wordt niets gebouwd)"
    bash "$REPO_DIR/scripts/kluis.sh" --start
  elif [ "$LOCAL_ENV" = "dev" ]; then
    echo "==> De ontwikkelomgeving draait niet; wordt gebouwd en gestart"
    ACTION="restart"
  else
    echo "==> De acceptatieomgeving draait niet; wordt gestart met de images van de laatste acceptatierun"
    if ! acc_compose up -d --no-build; then
      echo "Starten lukte niet. Zijn de acceptatie-images er wel? Bouw en keur ze met:  doelenboom -local -acc -restart" >&2
      exit 1
    fi
    LAST="$(ls -t "$REPO_DIR"/.acceptatie/bewijs-*.txt 2>/dev/null | head -n 1 || true)"
    if [ -n "$LAST" ]; then
      echo "    Laatste acceptatierun: $(sed -n 's/^build_version=//p' "$LAST" | head -n 1) ($(sed -n 's/^resultaat=//p' "$LAST" | head -n 1))"
    fi
  fi
fi

# Nieuwe db/migrations/*.sql toepassen tegen de lopende (of net gestarte)
# db-container. DOEL-99: alleen migraties die nog niet in schema_migrations
# staan, via scripts/db-migrate.sh. Voorheen draaide -rebuild elke keer álle
# migraties opnieuw; dat brak bij 0033 zodra er nieuwere auditregels waren.
# Een bestaande database zonder boekhouding geeft hier een duidelijke fout
# met de eenmalige baseline-instructie; er wordt dan niets uitgevoerd.
run_migrations() {
  echo "==> Db-container starten (indien nodig) en wachten tot beschikbaar"
  docker compose up -d --build db
  until docker compose exec -T db pg_isready -U "$DB_USER" >/dev/null 2>&1; do
    sleep 1
  done

  DOELENBOOM_DIR="$REPO_DIR" "$REPO_DIR/scripts/db-migrate.sh"
}

# DOEL-133: de kluis herstarten/stoppen via scripts/kluis.sh (nooit bouwen).
if [ "$LOCAL_ENV" = "kluis" ] && [ "$ACTION" = "restart" ]; then
  bash "$REPO_DIR/scripts/kluis.sh" --stop
  bash "$REPO_DIR/scripts/kluis.sh" --start
  ACTION=""
fi
if [ "$LOCAL_ENV" = "kluis" ] && [ "$ACTION" = "stop" ]; then
  bash "$REPO_DIR/scripts/kluis.sh" --stop
  ACTION=""
fi
# DOEL-133: bij het openen van de kluis: loopt hij gelijk met productie, en is
# de laatste back-up recent genoeg? (alleen waarschuwen, niet tegenhouden)
if [ "$LOCAL_ENV" = "kluis" ] && [ -n "$OPEN_BROWSER" ]; then
  bash "$REPO_DIR/scripts/kluis.sh" --status || true
fi

# DOEL-132: acceptatie herstarten = opnieuw opbouwen en keuren via
# scripts/acceptatie.sh; stoppen via dezelfde compose-projectnaam.
if [ "$LOCAL_ENV" = "acc" ] && [ "$ACTION" = "restart" ]; then
  echo "==> Acceptatie opnieuw opbouwen en keuren (bash scripts/acceptatie.sh)"
  echo "    (Voor de ontwikkelomgeving: doelenboom -local -dev -restart)"
  bash "$REPO_DIR/scripts/acceptatie.sh"
  ACTION=""
fi
if [ "$LOCAL_ENV" = "acc" ] && [ "$ACTION" = "stop" ]; then
  echo "==> Acceptatieomgeving stoppen (de acceptatiedatabase blijft bewaard)"
  acc_compose stop
  echo
  acc_compose ps -a
  ACTION=""
fi

case "$ACTION" in
  restart)
    if [ -n "$REBUILD_SCHEMA" ]; then
      run_migrations
    fi

    echo "==> Lokale stack herbouwen (gewijzigde services) en herstarten"
    # GIT_REF: actuele branch@hash(-dirty) van deze checkout — los van
    # BUILD_VERSION hieronder, zodat de footer ("vdev") alsnog te herleiden is
    # naar een concrete git-stand. Zonder dit toonde de footer lokaal altijd
    # letterlijk "vdev", ongeacht welke branch/commit je net had uitgecheckt —
    # nutteloos als versheidscheck bij het debuggen (Charles, 11 september
    # 2026). Geen git-repo/geen commits? Dan valt dit terug op "unknown" (zie
    # ook de ARG-default in api/Dockerfile).
    GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    GIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || true)"
    GIT_DIRTY=""
    if [ -n "$GIT_HASH" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      GIT_DIRTY="-dirty"
    fi
    if [ -n "$GIT_HASH" ]; then
      GIT_REF="${GIT_BRANCH}@${GIT_HASH}${GIT_DIRTY}"
    else
      GIT_REF="unknown"
    fi
    # BUILD_VERSION voor de lokale stack: altijd een VERS berekende waarde,
    # ONGEACHT een eventueel in deze shell geëxporteerde BUILD_VERSION — bv.
    # van scripts/build-version.sh, meestal geëxporteerd vlak vóór een
    # productie-build (zie deploy/README.md) in diezelfde terminal-sessie.
    # Zonder deze override zou zo'n export blijven hangen en per ongeluk een
    # productie-versienummer in de lokale footer laten zien, ook al is dit
    # gewoon een lokale dev-build. Een echte productie-build blijft altijd
    # BUILD_VERSION expliciet zetten (deploy/README.md, "Images bouwen"),
    # dus die is hier niet van afhankelijk.
    # DOEL-60: hierboven stond onvoorwaardelijk de vaste string "dev", dus de
    # footer toonde altijd letterlijk "vdev" — geen enkel functioneel
    # versienummer, alleen dat het een dev-build was. Net als
    # scripts/build-version.sh voor productiebuilds zoeken we nu ook lokaal
    # de dichtstbijzijnde git-tag op en combineren die met "dev", bv.
    # "3.1.3 dev" (footer: "v3.1.3 dev (branch@hash)") — nog steeds duidelijk
    # een dev-build, maar met een aanknopingspunt op welke release dit
    # ongeveer is. Geen tags in de repo (of geen git-repo)? Dan blijft het
    # gewoon "dev", exact zoals voorheen.
    # Zelfde "|| true"-patroon als GIT_HASH hierboven: zonder een repo (of
    # zonder tags) faalt `git describe` met exit 128, en zonder deze fallback
    # zou set -euo pipefail dan het hele script laten stoppen — juist in het
    # geval waarvoor "dev" als fallback bedoeld is.
    GIT_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
    GIT_TAG="${GIT_TAG#v}"
    if [ -n "$GIT_TAG" ]; then
      LOCAL_VERSION="${GIT_TAG} dev"
    else
      LOCAL_VERSION="dev"
    fi
    BUILD_VERSION="$LOCAL_VERSION" GIT_REF="$GIT_REF" docker compose up -d --build
    echo
    docker compose ps
    ;;
  stop)
    # `stop` (geen `down`): de containers worden gestopt maar blijven bestaan, en het
    # database-volume blijft in elk geval bewaard. Handig vóór het verplaatsen van de map
    # (zie README, "Geheimen en OneDrive"); met -restart start je alles weer.
    echo "==> Lokale stack stoppen (de database-data blijft bewaard)"
    docker compose stop
    echo
    docker compose ps -a
    ;;
  zip)
    # Vervangt de oude ~/.zshrc-functie `doelenboomzip` (DOEL-51). Zips van de bronmappen api en
    # web om te delen (bv. in een chat). Bewust: bestaande zips eerst weg (`zip -r` op een bestaand
    # bestand voegt toe en laat verwijderde bestanden achter), en nooit .env of .DS_Store mee.
    ZIP_DIR="$HOME/Downloads"
    BACKEND_ZIP="$ZIP_DIR/db_backend.zip"
    FRONTEND_ZIP="$ZIP_DIR/db_frontend.zip"
    if [ -n "$DELETE_ZIPS" ]; then
      rm -f "$BACKEND_ZIP" "$FRONTEND_ZIP"
      echo "$BACKEND_ZIP en $FRONTEND_ZIP verwijderd."
    else
      command -v zip >/dev/null 2>&1 || { echo "zip ontbreekt." >&2; exit 1; }
      mkdir -p "$ZIP_DIR"
      make_zip() {  # make_zip <zipbestand> <map>
        rm -f "$1"
        zip -qr "$1" "$2" -x "*/node_modules/*" -x "*/.env" -x "*/.env.local" -x "*/.DS_Store"
        echo "  $1  ($(unzip -Z1 "$1" | grep -vc '/$') bestanden, $(du -h "$1" | cut -f1 | tr -d ' '))"
      }
      echo "==> Zips maken in $ZIP_DIR (zonder node_modules, .env en .DS_Store)"
      make_zip "$BACKEND_ZIP" api
      make_zip "$FRONTEND_ZIP" web
      echo "Opruimen met:  doelenboom -zip -d"
    fi
    ;;
esac

# DOEL-58: na een eventuele -restart (of als -open de enige "actie" was, zie
# hierboven) de browser openen op de lokale web-dev-server (zie README, "Open
# http://localhost:5173"). Geen wachtlus zoals ensure_docker_running: dit is
# puur een gemakscommando, en een browser die een paar seconden moet
# verversen tot vite/nginx klaar is, is geen fout om voor te stoppen.
if [ -n "$OPEN_BROWSER" ]; then
  # DOEL-132: acceptatie op 8088 (docker-compose.acc.yml), ontwikkeling op 5173.
  case "$LOCAL_ENV" in
    acc) APP_URL="http://localhost:8088" ;;
    kluis) APP_URL="http://localhost:8089" ;;  # DOEL-133
    *) APP_URL="http://localhost:5173" ;;
  esac
  echo "==> Browser openen op $APP_URL"
  if ! command -v open >/dev/null 2>&1; then
    echo "Kan de browser niet automatisch openen ('open' ontbreekt — dit is macOS-only)." >&2
    echo "Open handmatig: $APP_URL" >&2
    exit 1
  fi
  open "$APP_URL"
fi

echo
echo "Klaar."
