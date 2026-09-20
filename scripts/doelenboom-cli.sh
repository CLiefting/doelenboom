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

for arg in "$@"; do
  case "$arg" in
    -local) ENVIRONMENT="local" ;;
    -prod) ENVIRONMENT="prod" ;;
    -restart) ACTION="restart" ;;
    -stop) ACTION="stop" ;;
    -zip) ACTION="zip" ;;
    -d) DELETE_ZIPS="1" ;;
    -rebuild) REBUILD_SCHEMA="1" ;;
    *)
      echo "Onbekende optie: $arg" >&2
      echo "Bekende opties: -local | -prod, -restart, -stop, -rebuild, -zip [-d]" >&2
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
if [ -z "$ACTION" ]; then
  echo "Geef een actie op: -restart, -stop of -zip" >&2
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

if [ "$ENVIRONMENT" = "prod" ]; then
  # Bewust nog niet geautomatiseerd: een productie-restart/-deploy raakt een
  # live omgeving (en soms een schemamigratie, zie db/migrations/) — dat blijft
  # voorlopig het bewuste, stap-voor-stap proces uit deploy/README.md i.p.v.
  # één commando dat per ongeluk te makkelijk te herhalen is.
  echo "Productie-acties zijn nog niet geautomatiseerd in dit script — volg deploy/README.md." >&2
  exit 1
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
    # BUILD_VERSION expliciet op 'dev' voor de lokale stack (footer toont dan
    # "vdev"), ONGEACHT een eventueel in deze shell geëxporteerde
    # BUILD_VERSION — bv. van scripts/build-version.sh, meestal geëxporteerd
    # vlak vóór een productie-build (zie deploy/README.md) in diezelfde
    # terminal-sessie. Zonder deze override zou zo'n export blijven hangen en
    # per ongeluk een productie-versienummer in de lokale footer laten zien,
    # ook al is dit gewoon een lokale dev-build. Een echte productie-build
    # blijft altijd BUILD_VERSION expliciet zetten (deploy/README.md, "Images
    # bouwen"), dus die is hier niet van afhankelijk.
    BUILD_VERSION=dev GIT_REF="$GIT_REF" docker compose up -d --build
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

echo
echo "Klaar."
