#!/usr/bin/env bash
# DOEL-41: image-smoketest. Bouwt de productie-images van web en excel-service en
# start ze als de runtime-gebruiker, met de bron-bestanden op de SLECHTSTE
# rechten (600/700, zoals in een OneDrive-werkmap). Zo vangen we Dockerfile-
# rechtenfouten in CI, i.p.v. pas bij het uitrollen (DOEL-39: excel-service
# PermissionError; DOEL-40: nginx kon /etc/nginx/snippets niet openen).
#
# Wat er gecontroleerd wordt
#   - beide images draaien niet als root;
#   - web: nginx start, / en /tree.html geven 200 met CSP, Referrer-Policy en
#     Permissions-Policy (DOEL-30);
#   - excel-service: uvicorn start en /health geeft 200;
#   - api (DOEL-42): het image bouwt (incl. SBOM-stage), draait niet als root, draait op de
#     Node-major uit api/Dockerfile.prod en kan alle productie-dependencies laden.
#
# De repo wordt NIET aangepast: de build-contexten worden naar een tijdelijke
# map gekopieerd, en daar krijgen de bronbestanden de slechte rechten.
#
# Gebruik (vanuit de repo, lokaal of in CI):   bash scripts/image-smoke-test.sh
# Vereist: docker (met buildx), curl, tar. Duurt lokaal enkele minuten.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/docker-compose.yml" ] || { echo "Geen doelenboom-repo op $REPO" >&2; exit 1; }
cd "$REPO"

for c in docker curl tar; do command -v "$c" >/dev/null || { echo "FOUT: $c ontbreekt" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo "FOUT: Docker draait niet" >&2; exit 1; }

RUN_ID="smoke-$$"
WEB_IMG="doelenboom-web-$RUN_ID"; EXCEL_IMG="doelenboom-excel-$RUN_ID"; API_IMG="doelenboom-api-$RUN_ID"
SBOM_C="doelenboom-sbomsrc-$RUN_ID"
WEB_C="$WEB_IMG"; EXCEL_C="$EXCEL_IMG"
WEB_PORT="${SMOKE_WEB_PORT:-18080}"; EXCEL_PORT="${SMOKE_EXCEL_PORT:-18000}"
TMP="$(mktemp -d)"

cleanup() {
  docker rm -f "$WEB_C" "$EXCEL_C" "$SBOM_C" >/dev/null 2>&1 || true
  docker rmi -f "$WEB_IMG" "$EXCEL_IMG" "$API_IMG" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FOUT: $*" >&2
  for c in "$WEB_C" "$EXCEL_C"; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
      echo "--- logs van $c ---" >&2; docker logs --tail 40 "$c" >&2 || true
    fi
  done
  exit 1
}
step() { printf '\n== %s\n' "$*"; }

# Wacht tot een URL 200 geeft; toont de logs van de container als dat niet lukt.
wait_for_200() { # url container max_seconden
  local url="$1" container="$2" max="$3" i=0
  while [ "$i" -lt "$max" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
      fail "container $container draait niet meer (gestopt of crash-loop)"
    fi
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)" = "200" ] && return 0
    sleep 1; i=$((i + 1))
  done
  fail "$url gaf geen 200 binnen ${max}s"
}

assert_not_root() { # image
  local user; user="$(docker inspect -f '{{.Config.User}}' "$1")"
  case "$user" in ""|0|root|0:*|root:*) fail "image $1 draait als root (USER='$user')" ;; esac
  echo "  $1 draait als '$user'"
}

assert_header() { # url header-naam
  local headers; headers="$(curl -sI "$1" | tr -d '\r')"   # eerst opslaan: grep -q + pipefail geeft anders SIGPIPE-fouten
  printf '%s\n' "$headers" | grep -qi "^$2:" || fail "$1 mist header $2"
}

step "Build-contexten kopiëren met de slechtste bronrechten"
tar --exclude=node_modules --exclude=dist --exclude=.git -cf - api web excel-service scripts | tar -xf - -C "$TMP"
chmod -R go-rwx "$TMP/api" "$TMP/web" "$TMP/excel-service" "$TMP/scripts"
echo "  bronbestanden in $TMP: modus $(ls -ld "$TMP/web/nginx.conf" | cut -c1-10) (bedoeld: -rw-------)"

step "Images bouwen"
docker build -q -f "$TMP/web/Dockerfile.prod" -t "$WEB_IMG" "$TMP/web" >/dev/null
docker build -q --build-context "sbom_tools=$TMP/scripts" -t "$EXCEL_IMG" "$TMP/excel-service" >/dev/null
echo "  gebouwd"

step "API-image bouwen (de SBOM-stage vraagt de excel-service-image en web/package.json)"
# In docker-compose.yml is excel_sbom "service:excel-service"; hier halen we /sbom uit de zojuist
# gebouwde excel-image en geven dat als gewone build-context mee.
mkdir -p "$TMP/excel_sbom"
docker create --name "$SBOM_C" "$EXCEL_IMG" >/dev/null
docker cp "$SBOM_C:/sbom" "$TMP/excel_sbom/sbom" >/dev/null
docker rm -f "$SBOM_C" >/dev/null
docker build -q -f "$TMP/api/Dockerfile.prod" \
  --build-context "sbom_tools=$TMP/scripts" --build-context "web_src=$TMP/web" \
  --build-context "excel_sbom=$TMP/excel_sbom" -t "$API_IMG" "$TMP/api" >/dev/null
echo "  gebouwd"

step "Niet-root"
assert_not_root "$WEB_IMG"
assert_not_root "$EXCEL_IMG"
assert_not_root "$API_IMG"

step "web: nginx start en serveert met headers"
# nginx.conf verwijst naar http://api:4000; zonder die host weigert nginx te starten.
docker run -d --name "$WEB_C" --add-host api:127.0.0.1 -p "$WEB_PORT:8080" "$WEB_IMG" >/dev/null
wait_for_200 "http://127.0.0.1:$WEB_PORT/" "$WEB_C" 30
for path in / /tree.html; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$path")" = "200" ] || fail "web $path gaf geen 200"
  for h in Content-Security-Policy Referrer-Policy Permissions-Policy; do
    assert_header "http://127.0.0.1:$WEB_PORT$path" "$h"
  done
done
echo "  / en /tree.html: 200 met CSP, Referrer-Policy en Permissions-Policy"

step "excel-service: uvicorn start en /health"
docker run -d --name "$EXCEL_C" -p "$EXCEL_PORT:8000" "$EXCEL_IMG" >/dev/null
wait_for_200 "http://127.0.0.1:$EXCEL_PORT/health" "$EXCEL_C" 90
echo "  /health: 200"

step "api: Node-versie en dependencies"
want="$(sed -nE 's/^FROM node:([0-9]+).*/\1/p' "$REPO/api/Dockerfile.prod" | sort -u)"
case "$want" in ''|*$'\n'*) fail "api/Dockerfile.prod gebruikt geen of meerdere Node-majors: '$want'" ;; esac
have="$(docker run --rm "$API_IMG" node -p 'process.versions.node.split(".")[0]')" || fail "api-image start niet"
[ "$have" = "$want" ] || fail "api-image draait Node $have, Dockerfile.prod vraagt Node $want"
echo "  Node $have"
docker run --rm "$API_IMG" node --input-type=module -e "import fs from 'node:fs'; const deps = Object.keys(JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).dependencies); for (const m of deps) await import(m); console.log('  ' + deps.length + ' productie-dependencies geladen');" \
  || fail "api: productie-dependencies laden mislukt (als root-loze gebruiker node)"
docker run --rm "$API_IMG" node --check /app/dist/index.js || fail "api: dist/index.js is niet leesbaar of ongeldig"
docker run --rm "$API_IMG" sh -c 'ls /app/sbom | grep -q .' || fail "api: /app/sbom is leeg"
echo "  dist en SBOM aanwezig en leesbaar"

step "Alles in orde"
