#!/usr/bin/env bash
# check-install-scripts.sh (DOEL-118) — faalt als een npm-pakket met een
# install-script (preinstall/install/postinstall) niet in "allowScripts" van
# package.json staat. Supply-chain-hardening (OWASP Top 10 A08 Software and
# Data Integrity Failures): een nieuw pakket, of een nieuwe versie van een al
# goedgekeurd pakket, met een install-script loopt niet ongemerkt mee maar
# moet bewust worden goedgekeurd. Goedkeuringen staan met versie vast
# (esbuild@0.28.2), zie docs/dependency-updates.md.
#
# Gebruik (na `npm ci` in de betreffende map):
#   scripts/check-install-scripts.sh            # api en web
#   scripts/check-install-scripts.sh api        # één map (relatief aan de repo of absoluut)
#
# Vereist npm >= 11.19 (subcommando install-scripts). Een oudere npm is een
# fout, geen stille geslaagde controle. Werkt met de bash 3.2 van macOS.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ $# -gt 0 ] || set -- api web

fail=0
for d in "$@"; do
  case "$d" in /*) dir="$d" ;; *) dir="$REPO/$d" ;; esac
  [ -f "$dir/package.json" ] || { echo "FOUT: geen package.json in $d" >&2; exit 1; }
  [ -d "$dir/node_modules" ] || { echo "FOUT: $d/node_modules ontbreekt; draai eerst npm ci in $d" >&2; exit 1; }

  rc=0
  out="$(cd "$dir" && npm install-scripts ls 2>&1)" || rc=$?

  if grep -qi 'not yet covered by allowScripts' <<<"$out"; then
    echo "FOUT ($d): install-scripts zonder goedkeuring:" >&2
    printf '%s\n' "$out" >&2
    echo "Beoordeel het pakket (wat doet het script?) en keur het daarna bewust goed:" >&2
    echo "  (cd $d && npm install-scripts approve <pkg>)    # en commit de wijziging in package.json" >&2
    fail=1
  elif [ "$rc" -ne 0 ]; then
    echo "FOUT ($d): 'npm install-scripts ls' mislukte (npm $(npm -v); nodig: >= 11.19):" >&2
    printf '%s\n' "$out" >&2
    exit 1
  else
    echo "OK ($d): alle install-scripts zijn goedgekeurd (allowScripts)."
  fi
done
exit "$fail"
