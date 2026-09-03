#!/usr/bin/env bash
# Nachtelijke volledige databaseback-up (pg_dump) -- gepland via cron op de
# VPS, zie deploy/README.md ("Backups"). Dit is de aanvulling op de
# nachtelijke Excel-back-up (export-all-doelenbomen.sh): die exporteert per
# doelenboom alleen de zichtbare boominhoud, dit dumpt de HELE database
# (gebruikers/accounts/sessies/licenties/tenants/doelenbomen/alles) in één
# bestand. Draait, in tegenstelling tot export-all-doelenbomen.sh, niet
# binnen de api-container maar rechtstreeks vanaf de VPS-shell (`docker
# compose exec db pg_dump ...`) -- dat is ook het commando dat al in
# deploy/README.md stond, hier alleen als herhaalbaar, geplande cronjob i.p.v.
# een handmatig te typen eenmalig commando.
#
# Bewaartermijn: bewust eenvoudig gehouden (i.t.t. de oplopende
# dagelijks/wekelijks/maandelijks-opbouw van de Excel-back-up) -- een volledige
# databasedump is veel groter, dus hier gewoon de laatste
# BACKUP_RETENTION_DAYS dagen, elke nacht één bestand. Voor langere
# bewaartermijn/offsite-kopie: zie de "Backups"-sectie in deploy/README.md,
# dat blijft een open aandachtspunt.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BACKUP_DIR="${REPO_DIR}/backups/database"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="${BACKUP_DIR}/doelenboom-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Databaseback-up gestart -> ${OUT_FILE}"

docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  pg_dump -U "${POSTGRES_USER:-doelenboom}" "${POSTGRES_DB:-doelenboom}" \
  | gzip > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "[$(date -Iseconds)] Databaseback-up klaar (${SIZE})"

# Bewaartermijn toepassen (elke nacht opnieuw op wat er dan op schijf staat,
# zelfde idempotente aanpak als export-all-doelenbomen.ts).
find "$BACKUP_DIR" -maxdepth 1 -name 'doelenboom-*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete \
  | sed 's/^/[verwijderd, buiten bewaartermijn] /'

echo "[$(date -Iseconds)] Databaseback-up-script klaar"
