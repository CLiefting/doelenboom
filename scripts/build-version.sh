#!/usr/bin/env bash
# Print een BUILD_VERSION-string (git-hash + datum, evt. -dirty als er niet-
# gecommite wijzigingen zijn) op stdout — bedoeld om te gebruiken als:
#
#   export BUILD_VERSION="$(./scripts/build-version.sh)"
#
# vóór `docker compose build`/`up --build`, zowel lokaal als bij een
# productie-deploy (zie docker-compose.prod.yml/deploy/README.md). Zonder deze
# stap valt BUILD_VERSION terug op de vaste ARG-default "dev" (zie
# api/Dockerfile/Dockerfile.prod) — dan is in de footer van de app (GET
# /api/version) niet meer te zien welke commit je precies test/draait, alleen
# dat het "een dev-build" is. Geen git-repo gevonden (bv. een kale checkout
# zonder .git)? Dan blijft "dev" gewoon de uitkomst, geen foutmelding.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! git rev-parse --short HEAD >/dev/null 2>&1; then
  echo "dev"
  exit 0
fi

HASH="$(git rev-parse --short HEAD)"
# Leesbaar datum/tijdstip (dd-mm-jjjj uu:mm, lokale tijd van de machine die
# bouwt) i.p.v. een compact YYYYMMDD-HHMM-blok — zo is in de footer in één
# oogopslag te zien wannéér gebouwd is, niet alleen dat er een stempel is.
STAMP="$(date +%d-%m-%Y\ %H:%M)"
DIRTY=""
if [ -n "$(git status --porcelain)" ]; then
  DIRTY="-dirty"
fi
echo "${HASH}${DIRTY} (${STAMP})"
