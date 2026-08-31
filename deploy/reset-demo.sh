#!/usr/bin/env bash
# Nachtelijke reset van de VOLLEDIGE tenant "Demo" -- gepland via cron op de
# VPS, zie deploy/README.md ("Nachtelijke reset van tenant Demo"). Draait het
# gecompileerde script binnen de al-lopende api-container (geen herstart
# nodig, zelfde patroon als export-all-doelenbomen.sh): zet alle doelenbomen
# in tenant Demo (incl. een eventuele doelenboom die een bezoeker die dag
# zelf heeft aangemaakt) terug naar de laatst vastgelegde momentopname, zie
# deploy/snapshot-demo-tenant.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[$(date -Iseconds)] Demo-tenant-reset gestart"

docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api \
  node dist/scripts/resetDemoTenant.js

echo "[$(date -Iseconds)] Demo-tenant-reset klaar"
