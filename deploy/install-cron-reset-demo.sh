#!/usr/bin/env bash
# Zet de crontab-regel voor de nachtelijke tenant-Demo-reset (deploy/
# reset-demo.sh) niet-interactief neer op de VPS, i.p.v. de regel handmatig
# in `crontab -e` te moeten typen/plakken (die vraagt om een interactieve
# editor, die op een kale VPS-shell vaak ontbreekt). Idempotent: bestaande
# regels van deze crontab blijven ongewijzigd (ook een al aanwezige
# export-all-doelenbomen.sh-regel bijvoorbeeld), en opnieuw draaien voegt 'm
# niet nog een keer toe — alleen regels die exact "reset-demo.sh" bevatten
# worden eerst verwijderd, waarna de actuele regel opnieuw wordt toegevoegd.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINE="1 0 * * * ${REPO_DIR}/deploy/reset-demo.sh >> ${HOME}/doelenboom-demo-reset.log 2>&1"

existing="$(crontab -l 2>/dev/null || true)"
updated="$(printf '%s\n' "$existing" | grep -vF 'reset-demo.sh' | grep -v '^$' || true)"

if [ -n "$updated" ]; then
  printf '%s\n%s\n' "$updated" "$LINE" | crontab -
else
  printf '%s\n' "$LINE" | crontab -
fi

echo "Crontab bijgewerkt. Huidige inhoud:"
crontab -l
