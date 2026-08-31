#!/usr/bin/env bash
# Legt (opnieuw) de canonieke momentopname van tenant "Demo" vast -- draai dit
# HANDMATIG wanneer je de vaste demo-inhoud bewust wilt bijwerken (bv. na het
# toevoegen van een nieuwe voorbeeldboom, of na het aanpassen van bestaande
# inhoud die je wilt laten blijven staan). Zie deploy/README.md ("Nachtelijke
# reset van tenant Demo").
#
# NOOIT via cron: de nachtelijke reset (deploy/reset-demo.sh) leest alleen de
# laatst vastgelegde momentopname en wijzigt 'm zelf nooit.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[$(date -Iseconds)] Momentopname van tenant Demo wordt vastgelegd"

docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api \
  node dist/scripts/snapshotDemoTenant.js

echo "[$(date -Iseconds)] Momentopname vastgelegd"
