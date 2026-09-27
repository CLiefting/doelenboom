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
# Gebruik:
#   doelenboom -local -restart            # lokale stack herbouwen (gewijzigde images) en herstarten
#   doelenboom -local -rebuild -restart   # idem, én eerst alle (nieuwe) db/migrations/*.sql toepassen
#   doelenboom -local -stop               # lokale containers stoppen (database-data blijft bewaard)
#   (bij -restart/-stop: Docker Desktop wordt zo nodig automatisch gestart, zie DOEL-57)
#   doelenboom -local -open               # browser openen op http://localhost:5173 (app draait al)
#   doelenboom -local -restart -open      # herbouwen/herstarten, en daarna meteen de browser openen
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
ACTION=""
REBUILD_SCHEMA=""
DELETE_ZIPS=""
OPEN_BROWSER=""

for arg in "$@"; do
  case "$arg" in
    -local) ENVIRONMENT="local" ;;
    -prod) ENVIRONMENT="prod" ;;
    -restart) ACTION="restart" ;;
    -stop) ACTION="stop" ;;
    -zip) ACTION="zip" ;;
    -d) DELETE_ZIPS="1" ;;
    -rebuild) REBUILD_SCHEMA="1" ;;
    -open) OPEN_BROWSER="1" ;;
    *)
      echo "Onbekende optie: $arg" >&2
      echo "Bekende opties: -local | -prod, -restart, -stop, -open, -rebuild, -zip [-d]" >&2
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
  echo "-open werkt alleen met -local (opent http://localhost:5173)." >&2
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

if [ "$ACTION" = "restart" ] || [ "$ACTION" = "stop" ]; then
  ensure_docker_running
fi

# Alle db/migrations/*.sql tegen de lopende (of net gestarte) db-container
# toepassen, op volgorde van bestandsnaam (0001_..., 0002_..., ...). Elk
# bestand is bewust idempotent (if not exists / on conflict do nothing, zie
# deploy/README.md), dus opnieuw draaien van al toegepaste migraties is
# veilig — er is geen aparte "welke migraties zijn al gedraaid"-boekhouding
# nodig, gewoon telkens de hele map opnieuw.
run_migrations() {
  echo "==> Db-container starten (indien nodig) en wachten tot beschikbaar"
  docker compose up -d --build db
  until docker compose exec -T db pg_isready -U "$DB_USER" >/dev/null 2>&1; do
    sleep 1
  done

  echo "==> Migraties toepassen (db/migrations/*.sql)"
  local migration
  for migration in "$REPO_DIR"/db/migrations/*.sql; do
    echo "  - $(basename "$migration")"
    docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$migration"
  done
}

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
  APP_URL="http://localhost:5173"
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
