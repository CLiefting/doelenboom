#!/usr/bin/env bash
# Zet de crontab-regel voor de nachtelijke Excel-backup (deploy/
# export-all-doelenbomen.sh) niet-interactief neer op de VPS, i.p.v. de regel
# handmatig in `crontab -e` te moeten typen/plakken. Idempotent: bestaande
# regels van deze crontab blijven ongewijzigd (ook een handmatig toegevoegde
# reset-demo.sh-regel bijvoorbeeld), en opnieuw draaien voegt 'm niet nog een
# keer toe — alleen regels die exact "export-all-doelenbomen.sh" bevatten
# worden eerst verwijderd, waarna de actuele regel opnieuw wordt toegevoegd.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINE="0 1 * * * ${REPO_DIR}/deploy/export-all-doelenbomen.sh >> ${HOME}/doelenboom-excel-backup.log 2>&1"

existing="$(crontab -l 2>/dev/null || true)"
updated="$(printf '%s\n' "$existing" | grep -vF 'export-all-doelenbomen.sh' | grep -v '^$' || true)"

if [ -n "$updated" ]; then
  printf '%s\n%s\n' "$updated" "$LINE" | crontab -
else
  printf '%s\n' "$LINE" | crontab -
fi

echo "Crontab bijgewerkt. Huidige inhoud:"
crontab -l
