#!/usr/bin/env bash
# Nachtelijke reset van de Demo-doelenboom ("Gezond ouder") -- gepland via cron
# op de VPS, zie deploy/README.md. Voert deploy/reset-demo.sql uit tegen de
# lopende db-container (geen herstart nodig, de stack blijft gewoon draaien).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# .env staat alleen op de VPS (niet in git) en bevat POSTGRES_USER/POSTGRES_DB;
# cron draait niet met een login-shell, dus expliciet inladen.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-doelenboom}"
POSTGRES_DB="${POSTGRES_DB:-doelenboom}"

echo "[$(date -Iseconds)] Demo-reset gestart"

docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  < deploy/reset-demo.sql

echo "[$(date -Iseconds)] Demo-reset klaar"
