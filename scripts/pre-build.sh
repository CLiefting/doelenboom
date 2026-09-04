#!/usr/bin/env bash
# Draait de volledige geautomatiseerde regressietest-suite (api/test/ +
# excel-service/tests/, incl. de Excel-import/export-rondgang — geen skips)
# en stopt meteen (set -e) zodra er iets faalt, zodat een kapotte build het
# nooit tot de daadwerkelijke `docker compose build` haalt. Bedoeld als eerste
# stap vóór een productie-release:
#
#   set -euo pipefail
#   cd ~/OneDrive/src/doelenboom
#   ./scripts/pre-build.sh
#   export BUILD_VERSION="$(./scripts/build-version.sh)"
#   docker compose up --build
#
# Dekt NIET de handmatige checklist (docs/regressie-checklist.md) — tree.html
# heeft bewust geen testinfra (zie TESTING.md), dus die moet je zelf blijven
# doorlopen vóór een productie-deploy. Dit script vervangt dat niet, het is
# een aanvullende vangnet-stap voor wat wél geautomatiseerd kan.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

UVICORN_PID=""
cleanup() {
  if [ -n "$UVICORN_PID" ] && kill -0 "$UVICORN_PID" 2>/dev/null; then
    kill "$UVICORN_PID" 2>/dev/null || true
    wait "$UVICORN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Eén Python-venv voor excel-service (runtime + testdependencies)"
if [ ! -d excel-service/.venv ]; then
  python3 -m venv excel-service/.venv
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

echo
echo "==> Software Bill of Materials genereren (scripts/generate-sbom.sh)"
# Ná de tests/venv-opzet hierboven (excel-service/.venv staat er dan al, incl.
# requirements-dev.txt/cyclonedx-bom) en vóór de daadwerkelijke
# `docker compose build` — zie doelenboom_sbom_ontwerp.md in het project. Een
# falende SBOM-generatie mag het hele pre-build-script niet laten stranden
# (de belangrijkste stap hierboven, de tests, is dan al geslaagd) — vandaar
# de eigen foutafhandeling i.p.v. gewoon set -e te laten stoppen.
if ! ./scripts/generate-sbom.sh; then
  echo "WAARSCHUWING: SBOM-generatie mislukt — de Softwarecomponenten-pagina" >&2
  echo "toont dan straks 'geen SBOM beschikbaar' totdat dit handmatig wordt" >&2
  echo "opgelost (draai './scripts/generate-sbom.sh' los om de fout te zien)." >&2
fi

echo
echo "Alle geautomatiseerde tests geslaagd."
echo "Vergeet niet ook docs/regressie-checklist.md door te lopen vóór een productie-deploy."
