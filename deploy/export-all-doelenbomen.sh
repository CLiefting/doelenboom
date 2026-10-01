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

# DOEL-53: het exportscript schrijft (sinds DOEL-31) mappen 0700 en bestanden
# 0600. In een map met een standaard-ACL geeft dat een leeg ACL-masker, waardoor
# het offsite-pullaccount (CL-NAS002, rrsync) de nieuwe .xlsx-bestanden niet
# meer kon lezen. Hier, op de host, het leesrecht voor dat account herstellen
# (de container kent dat account niet). Groep/other blijven ongemoeid.
. "${REPO_DIR}/deploy/offsite-acl.sh"
find "${REPO_DIR}/backups" -path "${REPO_DIR}/backups/database" -prune -o \( -type d -o -type f -name '*.xlsx' \) -print0 \
  | grant_offsite_read_stdin

echo "[$(date -Iseconds)] Nachtelijke Excel-backup klaar"
