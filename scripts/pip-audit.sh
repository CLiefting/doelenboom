#!/usr/bin/env bash
# pip-audit voor de excel-service, met de gemotiveerde uitzonderingenlijst
# (DOEL-69). Gebruikt door .github/workflows/dependency-audit.yml en door de
# lokale verificatie vóór een PR. Verwacht dat `pip-audit` al geïnstalleerd is.
#
# BLOKKEREND op elke bevinding: pip-audit kent geen drempel per ernst. Is er
# voor een kwetsbaarheid (nog) geen fix, of raakt ze ons gebruik aantoonbaar
# niet, zet haar dan in excel-service/pip-audit-ignore.txt:
#
#   <kwetsbaarheid-id>  <JJJJ-MM-DD>  <motivatie, minstens 10 tekens>
#
# bv.  GHSA-xxxx-xxxx-xxxx  2026-10-02  Geen fix beschikbaar; raakt alleen websockets, die wij niet gebruiken (DOEL-123).
#
# Regels die met # beginnen en lege regels worden overgeslagen. Een regel
# zonder geldig id, datum of motivatie laat het script falen: een uitzondering
# zonder uitleg is geen uitzondering. Loop de lijst na bij elke update van
# requirements.txt en haal regels weg zodra de fix er is.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${PIP_AUDIT_DIR:-$ROOT/excel-service}"
IGNORE_FILE="${PIP_AUDIT_IGNORE_FILE:-$DIR/pip-audit-ignore.txt}"

args=()
if [ -f "$IGNORE_FILE" ]; then
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in ''|\#*) continue ;; esac
    [ -n "${line//[[:space:]]/}" ] || continue
    read -r id date reason <<<"$line"
    if ! [[ "$id" =~ ^(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|PYSEC-[0-9]{4}-[0-9]+|CVE-[0-9]{4}-[0-9]+)$ ]]; then
      echo "FOUT: $IGNORE_FILE regel $n: ongeldig kwetsbaarheid-id \"$id\" (verwacht GHSA-…, PYSEC-… of CVE-…)." >&2; exit 2
    fi
    if ! [[ "${date:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      echo "FOUT: $IGNORE_FILE regel $n: datum ontbreekt of is niet JJJJ-MM-DD." >&2; exit 2
    fi
    if [ "${#reason}" -lt 10 ]; then
      echo "FOUT: $IGNORE_FILE regel $n: motivatie ontbreekt of is te kort (minstens 10 tekens)." >&2; exit 2
    fi
    echo "Uitzondering: $id (sinds $date) — $reason"
    args+=(--ignore-vuln "$id")
  done <"$IGNORE_FILE"
fi

cd "$DIR"
# ${args[@]+…}: een lege array geeft onder `set -u` in oudere bash-versies een fout.
exec pip-audit -r requirements.txt ${args[@]+"${args[@]}"}
