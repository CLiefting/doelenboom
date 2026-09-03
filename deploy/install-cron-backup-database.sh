#!/usr/bin/env bash
# Zet de crontab-regel voor de nachtelijke databaseback-up (deploy/
# backup-database.sh) niet-interactief neer op de VPS -- zelfde patroon als
# install-cron-export-all.sh/install-cron-reset-demo.sh: idempotent, alleen
# regels die exact "backup-database.sh" bevatten worden eerst verwijderd,
# waarna de actuele regel opnieuw wordt toegevoegd. Andere cronregels (Excel-
# back-up, demo-reset) blijven ongewijzigd staan.
#
# Gepland om 02:00 -- na de nachtelijke Excel-back-up (01:00) en de
# demo-tenant-reset (00:01), zodat ze niet gelijktijdig I/O-belasting geven.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINE="0 2 * * * ${REPO_DIR}/deploy/backup-database.sh >> ${HOME}/doelenboom-database-backup.log 2>&1"

existing="$(crontab -l 2>/dev/null || true)"
updated="$(printf '%s\n' "$existing" | grep -vF 'backup-database.sh' | grep -v '^$' || true)"

if [ -n "$updated" ]; then
  printf '%s\n%s\n' "$updated" "$LINE" | crontab -
else
  printf '%s\n' "$LINE" | crontab -
fi

echo "Crontab bijgewerkt. Huidige inhoud:"
crontab -l
