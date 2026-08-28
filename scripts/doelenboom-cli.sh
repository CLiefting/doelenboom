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
#   doelenboom -local -restart   # lokale stack herbouwen (gewijzigde images) en herstarten
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENVIRONMENT=""
ACTION=""

for arg in "$@"; do
  case "$arg" in
    -local) ENVIRONMENT="local" ;;
    -prod) ENVIRONMENT="prod" ;;
    -restart) ACTION="restart" ;;
    *)
      echo "Onbekende optie: $arg" >&2
      echo "Bekende opties: -local | -prod, -restart" >&2
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

case "$ACTION" in
  restart)
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
