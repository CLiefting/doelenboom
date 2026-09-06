#!/usr/bin/env bash
# doelenboom — kleine CLI-wrapper om de lokale (en later: productie-)stack te
# beheren zonder telkens de losse docker compose-commando's te hoeven
# onthouden. Uitbreidbaar: voeg een nieuwe -vlag toe aan de for-loop hieronder
# en een bijbehorende case in het ACTION-blok.
#
# Installeren als alias (eenmalig, in ~/.zshrc):
#   alias doelenboom="$HOME/OneDrive/src/doelenboom/scripts/doelenboom-cli.sh"
# Daarna: bron je shell opnieuw (nieuwe terminal, of `source ~/.zshrc`).
#
# Gebruik:
#   doelenboom -local -restart            # lokale stack herbouwen (gewijzigde images) en herstarten
#   doelenboom -local -rebuild -restart   # idem, én eerst alle (nieuwe) db/migrations/*.sql toepassen
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Zelfde credential-fallback als docker-compose.yml (${POSTGRES_USER:-doelenboom}
# e.d.) — hardcoded default "doelenboom", maar overschrijfbaar door dezelfde
# env-vars te exporteren als je .env afwijkt van .env.example.
DB_USER="${POSTGRES_USER:-doelenboom}"
DB_NAME="${POSTGRES_DB:-doelenboom}"

ENVIRONMENT=""
ACTION=""
REBUILD_SCHEMA=""

for arg in "$@"; do
  case "$arg" in
    -local) ENVIRONMENT="local" ;;
    -prod) ENVIRONMENT="prod" ;;
    -restart) ACTION="restart" ;;
    -rebuild) REBUILD_SCHEMA="1" ;;
    *)
      echo "Onbekende optie: $arg" >&2
      echo "Bekende opties: -local | -prod, -restart, -rebuild" >&2
      exit 1
      ;;
  esac
done

if [ -z "$ENVIRONMENT" ]; then
  echo "Geef een omgeving op: -local of -prod" >&2
  exit 1
fi
if [ -z "$ACTION" ]; then
  echo "Geef een actie op, bv. -restart" >&2
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

cd "$REPO_DIR"

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
    # BUILD_VERSION expliciet op 'dev' voor de lokale stack (footer toont dan
    # "vdev"), ONGEACHT een eventueel in deze shell geëxporteerde
    # BUILD_VERSION — bv. van scripts/build-version.sh, meestal geëxporteerd
    # vlak vóór een productie-build (zie deploy/README.md) in diezelfde
    # terminal-sessie. Zonder deze override zou zo'n export blijven hangen en
    # per ongeluk een productie-versienummer in de lokale footer laten zien,
    # ook al is dit gewoon een lokale dev-build. Een echte productie-build
    # blijft altijd BUILD_VERSION expliciet zetten (deploy/README.md, "Images
    # bouwen"), dus die is hier niet van afhankelijk.
    BUILD_VERSION=dev docker compose up -d --build
    echo
    docker compose ps
    ;;
esac

echo
echo "Klaar."
