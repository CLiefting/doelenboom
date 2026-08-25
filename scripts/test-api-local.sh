#!/usr/bin/env bash
# Eén commando om de api/test/-suite lokaal te draaien tegen de Docker-db,
# met een harde stop bij de eerste fout (set -e) i.p.v. halverwege door te
# denderen op een kapotte toestand. Vangt specifiek de valkuil op die dit
# bestand heeft opgeleverd: als er op poort 5432 een ANDERE Postgres draait
# dan de Docker-container van dit project (bv. een lokaal geïnstalleerde
# Postgres.app/Homebrew-Postgres), praat "localhost:5432" straks met dié
# server i.p.v. met Docker — met een verwarrende "role doelenboom does not
# exist" als gevolg, ook al is de Docker-db zelf prima in orde. Zie ook
# TESTING.md.
#
# Gebruik:
#   ./scripts/test-api-local.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Poort 5432 controleren op vreemde luisteraars..."
# lsof geeft exit-code 1 als er niets op de poort luistert — dat is hier prima
# (dan start Docker zelf straks gewoon de eerste luisteraar), dus die ene
# aanroep bewust buiten "set -e" houden.
listeners="$(lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$listeners" ]; then
  # "COMMAND" van elke regel die niet met docker/com.docker begint = verdachte,
  # niet-Docker luisteraar op dezelfde poort.
  vreemde="$(echo "$listeners" | tail -n +2 | awk '{print $1}' | grep -v -i '^com\.docke' || true)"
  if [ -n "$vreemde" ]; then
    echo "FOUT: er luistert iets anders dan Docker op poort 5432:" >&2
    echo "$listeners" >&2
    echo "" >&2
    echo "Dat is vermoedelijk een lokaal geïnstalleerde Postgres die conflicteert" >&2
    echo "met de Docker-db van dit project. Zet 'm eerst uit (bv. 'brew services" >&2
    echo "stop postgresql' of de Postgres.app afsluiten) en probeer opnieuw." >&2
    exit 1
  fi
fi

echo "==> Docker-db starten (of bevestigen dat 'ie al draait)..."
docker compose up -d db

echo "==> Wachten tot de db 'healthy' is..."
tries=0
until [ "$(docker compose ps db --format '{{.Health}}' 2>/dev/null)" = "healthy" ]; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "FOUT: db werd na 30 seconden nog niet 'healthy'. 'docker compose ps' en" >&2
    echo "'docker compose logs db' voor meer info." >&2
    exit 1
  fi
  sleep 1
done
echo "    db is healthy."

echo "==> Rol/toegang bevestigen vóór de testsuite start..."
docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" -d "${POSTGRES_DB:-doelenboom}" -c '\du' >/dev/null

echo "==> npm test draaien..."
cd api
npm test

echo "==> Klaar — alle tests zijn gedraaid zonder dat het script vroegtijdig stopte."
