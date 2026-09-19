#!/usr/bin/env bash
# Draait de volledige geautomatiseerde regressietest-suite (api/test/ +
# excel-service/tests/, incl. de Excel-import/export-rondgang — geen skips)
# en stopt meteen (set -e) zodra er iets faalt, zodat een kapotte build het
# nooit tot de daadwerkelijke `docker compose build` haalt. Bedoeld als eerste
# stap vóór een productie-release (het script cd't zelf al naar
# ~/OneDrive/src/doelenboom, zie hieronder — vanaf welke map je het aanroept
# maakt dus niet uit):
#
#   ~/OneDrive/src/doelenboom/scripts/pre-build.sh
#   export BUILD_VERSION="$(~/OneDrive/src/doelenboom/scripts/build-version.sh)"
#   (cd ~/OneDrive/src/doelenboom && docker compose up --build)
#
# Dekt NIET de handmatige checklist (docs/regressie-checklist.md) — tree.html
# heeft bewust geen testinfra (zie TESTING.md), dus die moet je zelf blijven
# doorlopen vóór een productie-deploy. Dit script vervangt dat niet, het is
# een aanvullende vangnet-stap voor wat wél geautomatiseerd kan.
set -euo pipefail

# Vaste, veilige locatie i.p.v. dynamische BASH_SOURCE-resolutie — zie
# doelenboom-cli.sh voor de achtergrond (Charles, 14 september 2026).
# DOEL-33: overschrijfbaar (DOELENBOOM_DIR) zodat de map buiten OneDrive kan staan.
REPO_DIR="${DOELENBOOM_DIR:-$HOME/OneDrive/src/doelenboom}"
if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "Kan doelenboom niet vinden op $REPO_DIR (geen docker-compose.yml daar)." >&2
  echo "Is de map leeg, verplaatst, of nog niet gesynchroniseerd (bv. door een OneDrive-issue)? Controleer dit eerst." >&2
  exit 1
fi
cd "$REPO_DIR"

UVICORN_PID=""
cleanup() {
  if [ -n "$UVICORN_PID" ] && kill -0 "$UVICORN_PID" 2>/dev/null; then
    kill "$UVICORN_PID" 2>/dev/null || true
    wait "$UVICORN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Eén Python-venv voor excel-service (runtime + testdependencies)"
# Expliciet python3.12 i.p.v. kaal python3: excel-service/Dockerfile bouwt op
# python:3.12-slim, en requirements.txt eist sinds de fastapi 0.133.0-upgrade
# (Softwarecomponenten-fix, Hoog-CVE's) Python >=3.10 — kaal python3 kan op
# een ontwikkelmachine best een oudere, nog wél ondersteunde versie zijn (bv.
# 3.9), wat pip install dan pas laat mislukken met een cryptische
# "Requires-Python"-foutmelding i.p.v. hier meteen duidelijk te maken wat er
# mist. Was er al een .venv van vóór deze eis, dan blijft die op de oude
# Python staan (een venv "upgrade" je niet in-place) — eenmalig
# `rm -rf excel-service/.venv` en opnieuw draaien lost dat op.
if ! command -v python3.12 >/dev/null 2>&1; then
  echo "python3.12 niet gevonden — nodig voor excel-service/.venv (zelfde versie als excel-service/Dockerfile, en vereist door fastapi>=0.129)." >&2
  echo "macOS met Homebrew: brew install python@3.12" >&2
  exit 1
fi
if [ ! -d excel-service/.venv ]; then
  python3.12 -m venv excel-service/.venv
fi
# Ook setuptools expliciet upgraden (niet alleen pip): dat wordt bij het
# aanmaken van de venv één keer bevroren op wat ensurepip op dat moment
# meelevert, en "pip install --upgrade pip" ververst 'm daarna niet vanzelf —
# vandaar dat een al langer bestaande .venv hier op een oude, kwetsbare
# setuptools (Hoog, zie Softwarecomponenten-pagina) kan blijven hangen.
excel-service/.venv/bin/pip install -q --upgrade pip setuptools
excel-service/.venv/bin/pip install -q -r excel-service/requirements.txt -r excel-service/requirements-dev.txt

echo
echo "==> Postgres-devdatabase opstarten (voor api/test/)"
docker compose up -d db
for i in $(seq 1 30); do
  status="$(docker compose ps db --format '{{.Health}}' 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then break; fi
  if [ "$i" -eq 30 ]; then
    echo "Postgres werd niet 'healthy' binnen 30s — controleer 'docker compose logs db'." >&2
    exit 1
  fi
  sleep 1
done

echo
echo "==> excel-service lokaal starten op :8000 (voor de Excel-rondgang in api/test/)"
# 'exec' in de subshell zodat die subshell zélf uvicorn wordt (geen extra
# tussenliggend proces) — dan is $! precies uvicorn's PID, en volstaat een
# simpele 'kill' in cleanup() zonder pgrep-geraad.
(cd excel-service && exec .venv/bin/uvicorn app.main:app --port 8000 >/tmp/doelenboom-excel-service-prebuild.log 2>&1) &
UVICORN_PID=$!
for i in $(seq 1 20); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 20 ]; then
    echo "excel-service werd niet bereikbaar binnen 20s — zie /tmp/doelenboom-excel-service-prebuild.log" >&2
    exit 1
  fi
  sleep 1
done

echo
echo "==> api/test/ (node:test, incl. Excel-import/export-rondgang)"
(cd api && npm test)

echo
echo "==> excel-service/tests/ (pytest)"
(cd excel-service && .venv/bin/pytest -q)

# Geen SBOM-stap meer hier: de Software Bill of Materials wordt sinds
# 19 september 2026 tijdens `docker compose build` zelf in de images gegenereerd
# (SBOM-stages in api/Dockerfile*, excel-service/Dockerfile — zie
# doelenboom_sbom_ontwerp.md in het project) en hoort daardoor altijd bij de
# gebouwde/gedeployde versie. scripts/generate-sbom.sh blijft bestaan voor de
# API draaien buiten Docker, maar hoort niet meer bij de release-flow.

echo
echo "Alle geautomatiseerde tests geslaagd."
echo "Vergeet niet ook docs/regressie-checklist.md door te lopen vóór een productie-deploy."
