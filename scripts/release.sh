#!/usr/bin/env bash
# Doelenboom-release in één keer: CI afwachten -> taggen -> GitHub Release ->
# images bouwen -> (optioneel) uitrollen naar de VPS.
#
# Gebruik (op je Mac; het script vindt de repo zelf, ook vanuit "Claude outputs/"):
#   bash "scripts/release.sh" v3.1.1 "beschrijving van de release"             # t/m bouwen + kopiëren
#   bash "scripts/release.sh" v3.1.1 "beschrijving van de release" --deploy    # ook uitrollen (vraagt bevestiging)
#   bash "scripts/release.sh" v3.1.1 "beschrijving" --hervat --deploy          # tag bestaat al: alleen images opnieuw bouwen/kopiëren/uitrollen
#
# Stopt de uitrol halverwege (bv. omdat er nog iemand ingelogd is), draai dan
# gewoon hetzelfde commando opnieuw: staat de tag al op deze commit, dan gaat
# het script vanzelf verder bij de images (DOEL-109). --hervat is alleen nog
# nodig als je niet op main staat (bv. na `git checkout <tag>`).
#
# Vereist: gh (brew install gh; gh auth login), docker, ssh-toegang tot de VPS.
# Omgevingsvariabelen (optioneel):
#   VPS=gebruiker@host     NOTES_FILE=pad/naar/release-notes.md
#
# Het script stopt bij de eerste fout en past niets aan als een controle faalt.
set -euo pipefail

TAG="${1:-}"; DESC="${2:-}"; DEPLOY="no"; RESUME="no"
VPS="${VPS:-}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

die() { echo "FOUT: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

for a in "${@:3}"; do
  case "$a" in
    --deploy) DEPLOY="yes" ;;
    --hervat) RESUME="yes" ;;   # tag en GitHub Release bestaan al: alleen images bouwen, kopiëren en (met --deploy) uitrollen
    *) die "Onbekende optie: $a" ;;
  esac
done

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Gebruik: release.sh vX.Y.Z \"beschrijving\" [--deploy]"
[ -n "$DESC" ] || die "Geef een beschrijving mee als tweede argument."
[ -n "$VPS" ] || die "Zet eerst VPS=gebruiker@host (bv. export VPS=... in je shell-profiel); het adres staat bewust niet in de publieke repo."

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/docker-compose.yml" ] || die "Geen doelenboom-repo gevonden op $REPO"
cd "$REPO"
export DOELENBOOM_DIR="$REPO"

step "1/6 Controles vooraf"
command -v gh >/dev/null     || die "gh ontbreekt:  brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is niet ingelogd:  gh auth login"
command -v docker >/dev/null || die "docker ontbreekt"
docker info >/dev/null 2>&1  || die "Docker draait niet"
[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "Werkmap is niet schoon (dan wordt de versie 'dirty')."; }
# DOEL-109: staat de tag al op HEAD (een eerdere poging kwam tot na het taggen),
# dan is dit een hervatting, ook zonder --hervat. Een tag op een ANDERE commit
# blijft hieronder een fout.
if [ "$RESUME" != "yes" ]; then
  git fetch --tags -q || true
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ]; then
    RESUME="yes"
    echo "Tag $TAG staat al op deze commit: de release wordt hervat (alsof --hervat is opgegeven)."
  fi
fi
if [ "$RESUME" = "yes" ]; then
  git fetch --tags -q || true
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "Tag $TAG bestaat niet; --hervat is alleen voor een bestaande release."
  SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
  [ "$(git rev-parse "$TAG^{commit}")" = "$SHA" ] || die "HEAD is niet de commit van $TAG. Ga eerst naar die commit:  git checkout $TAG"
  PREV="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"
  echo "HERVATTEN: $TAG op commit $SHORT (vorige tag: ${PREV:-geen}); CI, tag en GitHub Release worden overgeslagen."
else
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "Je staat niet op main."
  git pull --ff-only
  git fetch --tags -q
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG bestaat al, maar op een andere commit ($(git rev-parse --short "$TAG^{commit}")) dan main. Kies een nieuw versienummer, of ga naar die commit (git checkout $TAG) en gebruik --hervat."
  SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
  [ "$(git rev-parse origin/main)" = "$SHA" ] || die "main loopt achter of voor op origin/main; eerst pushen/pullen."
  PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  echo "Release $TAG op commit $SHORT (vorige tag: ${PREV:-geen})"
fi

# DOEL-109: met --deploy nu al kijken of er iemand ingelogd is, vóórdat er een
# tag wordt gezet en images worden gebouwd. De controle vlak voor de herstart
# (stap 6, op de VPS) blijft: tijdens het bouwen kan iemand inloggen.
if [ "$DEPLOY" = "yes" ]; then
  echo "Controle op de VPS: is er iemand ingelogd?"
  ssh "$VPS" 'cd ~/doelenboom && ./deploy/check-no-active-users.sh' < /dev/null \
    || die "er is nog iemand ingelogd op productie (of de VPS is niet bereikbaar); zie hierboven. Er is niets gewijzigd: geen tag, geen images. Draai hetzelfde commando opnieuw als iedereen is uitgelogd."
fi

if [ "$RESUME" != "yes" ]; then
step "2/6 Wachten op CI voor $SHORT"
RUN_ID=""
for _ in $(seq 1 36); do   # maximaal 3 minuten wachten tot de run bestaat
  RUN_ID="$(gh run list --workflow CI --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$RUN_ID" ] && break
  sleep 5
done
[ -n "$RUN_ID" ] || die "Geen CI-run gevonden voor $SHORT. Is de push aangekomen?"
gh run watch "$RUN_ID" --exit-status --interval 10 || die "CI is rood voor $SHORT; niet taggen."
echo "CI groen."

step "3/6 Taggen en GitHub Release"
git tag -a "$TAG" -m "$TAG: $DESC"
git push origin "$TAG"
if [ -n "${NOTES_FILE:-}" ]; then
  gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES_FILE"
else
  gh release create "$TAG" --verify-tag --title "$TAG" --notes "$DESC" --generate-notes
fi
fi

step "4/6 Images bouwen (linux/amd64)"
export BUILD_VERSION="$(./scripts/build-version.sh)"
echo "BUILD_VERSION = $BUILD_VERSION"
case "$BUILD_VERSION" in *dirty*) die "BUILD_VERSION is 'dirty'; niet bouwen voor productie." ;; esac
case "$BUILD_VERSION" in "${TAG#v} ("*) ;; *) die "BUILD_VERSION begint niet met ${TAG#v}." ;; esac
DOCKER_DEFAULT_PLATFORM=linux/amd64 "${COMPOSE[@]}" build api web excel-service
docker save doelenboom-api:latest doelenboom-web:latest doelenboom-excel-service:latest | gzip > doelenboom-images.tar.gz

step "5/6 Naar de VPS kopiëren"
scp doelenboom-images.tar.gz "$VPS":~/
rm -f doelenboom-images.tar.gz

if [ "$DEPLOY" != "yes" ]; then
  echo
  echo "Tag, GitHub Release en images staan klaar; de images staan op de VPS (~/doelenboom-images.tar.gz)."
  echo "Uitrollen: handmatig op de VPS (git pull, docker load, ./deploy/check-no-active-users.sh && scripts/db-migrate.sh --prod && up -d),"
  echo "of een volgende keer in één keer met --deploy."
  exit 0
fi

step "6/6 Uitrollen op $VPS"
# Migraties gaan via scripts/db-migrate.sh op de VPS (DOEL-102): dat script
# weet uit schema_migrations wat daar al gedraaid is. De dry-run op de VPS
# hieronder toont wat er gaat draaien, vóórdat er iets verandert.
echo "Migraties: scripts/db-migrate.sh --prod op de VPS (eerst een dry-run)."
read -r -p "Nu uitrollen naar productie? Typ 'ja' om door te gaan: " ANS < /dev/tty
[ "$ANS" = "ja" ] || die "Afgebroken; de images staan klaar op de VPS."

# DOEL-108: dit deel gaat via de standaardinvoer naar bash op de VPS. Een
# commando dat zelf de standaardinvoer leest (docker compose exec -T in
# db-migrate.sh) las zo de rest van het script weg: bash stopte dan zonder fout
# vóór docker load en up -d, en release.sh meldde toch "Uitgerold". Daarom:
#  - alles staat in main(): bash leest een functie eerst helemaal in;
#  - main draait met afgesloten standaardinvoer (< /dev/null);
#  - de laatste regel is REMOTE-KLAAR, en daar controleren we hieronder op.
REMOTE_LOG="$(mktemp)"
trap 'rm -f "$REMOTE_LOG"' EXIT
ssh "$VPS" bash -s -- "$TAG" <<'REMOTE' | tee "$REMOTE_LOG"
set -euo pipefail
main() {
  TAG="$1"
  cd ~/doelenboom
  dbprod() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
  git pull --ff-only
  # Migraties (DOEL-102): eerst tonen wat er gaat draaien. Ontbreekt de
  # boekhouding of is die leeg, dan stopt db-migrate.sh hier (exit 2) en is er
  # nog niets veranderd: zet dan eerst eenmalig een baseline (deploy/README.md).
  scripts/db-migrate.sh --prod --dry-run
  # Eerst controleren: liever niets veranderen dan gebruikers onderbreken.
  ./deploy/check-no-active-users.sh
  # Back-up-tag alleen zetten als die nog niet bestaat (bij hervatten wijst hij al naar de vorige stand).
  for i in api web excel-service; do
    docker image inspect "doelenboom-$i:pre-$TAG" >/dev/null 2>&1 || docker tag "doelenboom-$i:latest" "doelenboom-$i:pre-$TAG" 2>/dev/null || true
  done
  docker load < ~/doelenboom-images.tar.gz
  # Alleen wat nog niet in schema_migrations staat; elke migratie wordt pas
  # geregistreerd als hij helemaal geslaagd is.
  scripts/db-migrate.sh --prod
  dbprod up -d
  sleep 25
  dbprod ps
  if dbprod ps | grep -qiE 'restarting|unhealthy|exited'; then
    echo "PROBLEEM: een container is niet gezond. Terugrollen:"
    echo "  for i in api web excel-service; do docker tag doelenboom-\$i:pre-$TAG doelenboom-\$i:latest; done; dbprod up -d"
    exit 1
  fi
  # DOEL-108: niet alleen tonen maar ook controleren dat de API nu deze release
  # draait; "containers gezond" zegt niet dat de nieuwe images zijn gestart.
  # De API kan net na de herstart nog even niet antwoorden: maximaal 6 pogingen.
  VERSION_JSON=""
  for _ in 1 2 3 4 5 6; do
    VERSION_JSON="$(docker exec doelenboom-api-1 sh -c 'wget -qO- http://localhost:4000/api/version' 2>/dev/null || true)"
    [ -n "$VERSION_JSON" ] && break
    sleep 5
  done
  echo "API-versie: $VERSION_JSON"
  case "$VERSION_JSON" in
    *"\"version\":\"${TAG#v} ("*) ;;
    *) echo "PROBLEEM: de API draait niet versie ${TAG#v}. De uitrol is niet gelukt."; exit 1 ;;
  esac
  rm -f ~/doelenboom-images.tar.gz   # pas na een gezonde uitrol opruimen
  # Laatste regel: release.sh controleert hierop dat dit deel helemaal is uitgevoerd.
  echo "REMOTE-KLAAR $TAG"
}
main "$@" < /dev/null
REMOTE
grep -qx "REMOTE-KLAAR $TAG" "$REMOTE_LOG" || die "het uitrolscript op de VPS is niet helemaal uitgevoerd (geen REMOTE-KLAAR $TAG). Productie is mogelijk niet bijgewerkt; controleer https://doelenboom.code072.nl/api/version. Staat hierboven dat er nog iemand ingelogd is, wacht dan tot diegene is uitgelogd. Daarna hetzelfde commando opnieuw draaien: het script ziet dat $TAG al bestaat en gaat verder bij de images."

echo
echo "Uitgerold. Controleer nog: inloggen, tree.html, een Excel-export, en:"
echo "  curl -sI https://doelenboom.code072.nl/ | grep -iE 'content-security|referrer|permissions'"
