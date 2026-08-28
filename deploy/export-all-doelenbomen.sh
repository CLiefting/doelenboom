#!/usr/bin/env bash
# Nachtelijke Excel-backup van alle doelenbomen -- gepland via cron op de VPS,
# zie deploy/README.md ("Nachtelijke Excel-backup"). Draait het gecompileerde
# script binnen de al-lopende api-container (geen herstart nodig): dat
# hergebruikt dezelfde database/fetchTree/excel-service-aanroep als een
# handmatige export via de app zelf (zie api/src/scripts/
# exportAllDoelenbomen.ts voor de bewaartermijn-logica).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[$(date -Iseconds)] Nachtelijke Excel-backup gestart"

docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api \
  node dist/scripts/exportAllDoelenbomen.js

echo "[$(date -Iseconds)] Nachtelijke Excel-backup klaar"
