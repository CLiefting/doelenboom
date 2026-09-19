#!/usr/bin/env bash
# Doelenboom-release in één keer: CI afwachten -> taggen -> GitHub Release ->
# images bouwen -> (optioneel) uitrollen naar de VPS.
#
# Gebruik (op je Mac; het script vindt de repo zelf, ook vanuit "Claude outputs/"):
#   bash "scripts/release.sh" v3.1.1 "beschrijving van de release"             # t/m bouwen + kopiëren
#   bash "scripts/release.sh" v3.1.1 "beschrijving van de release" --deploy    # ook uitrollen (vraagt bevestiging)
#   bash "scripts/release.sh" v3.1.1 "beschrijving" --hervat --deploy          # tag bestaat al: alleen images opnieuw bouwen/kopiëren/uitrollen
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
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG bestaat al (gebruik --hervat om alleen de images opnieuw te leveren)."
  SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
  [ "$(git rev-parse origin/main)" = "$SHA" ] || die "main loopt achter of voor op origin/main; eerst pushen/pullen."
  PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  echo "Release $TAG op commit $SHORT (vorige tag: ${PREV:-geen})"
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
  echo "Uitrollen: handmatig op de VPS (git pull, docker load, migraties, ./deploy/check-no-active-users.sh && up -d),"
  echo "of een volgende keer in één keer met --deploy."
  exit 0
fi

step "6/6 Uitrollen op $VPS"
# Nieuwe migratiebestanden sinds de vorige tag (allemaal idempotent, zie deploy/README.md).
MIGS=""
if [ -n "$PREV" ]; then
  MIGS="$(git diff --name-only --diff-filter=A "$PREV" "$TAG" -- db/migrations | sort | tr '\n' ' ')"
fi
echo "Nieuwe migraties: ${MIGS:-geen}"
read -r -p "Nu uitrollen naar productie? Typ 'ja' om door te gaan: " ANS < /dev/tty
[ "$ANS" = "ja" ] || die "Afgebroken; de images staan klaar op de VPS."

ssh "$VPS" bash -s -- "$TAG" $MIGS <<'REMOTE'
set -euo pipefail
TAG="$1"; shift
cd ~/doelenboom
dbprod() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
git pull --ff-only
# Eerst controleren: liever niets veranderen dan gebruikers onderbreken.
./deploy/check-no-active-users.sh
# Back-up-tag alleen zetten als die nog niet bestaat (bij hervatten wijst hij al naar de vorige stand).
for i in api web excel-service; do
  docker image inspect "doelenboom-$i:pre-$TAG" >/dev/null 2>&1 || docker tag "doelenboom-$i:latest" "doelenboom-$i:pre-$TAG" 2>/dev/null || true
done
docker load < ~/doelenboom-images.tar.gz
for f in "$@"; do
  echo "migratie: $f"
  dbprod exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < "$f"
done
dbprod up -d
sleep 25
dbprod ps
if dbprod ps | grep -qiE 'restarting|unhealthy|exited'; then
  echo "PROBLEEM: een container is niet gezond. Terugrollen:"
  echo "  for i in api web excel-service; do docker tag doelenboom-\$i:pre-$TAG doelenboom-\$i:latest; done; dbprod up -d"
  exit 1
fi
echo -n "API-versie: "
docker exec doelenboom-api-1 sh -c 'wget -qO- http://localhost:4000/api/version'
echo
rm -f ~/doelenboom-images.tar.gz   # pas na een gezonde uitrol opruimen
REMOTE

echo
echo "Uitgerold. Controleer nog: inloggen, tree.html, een Excel-export, en:"
echo "  curl -sI https://doelenboom.code072.nl/ | grep -iE 'content-security|referrer|permissions'"
