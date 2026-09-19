#!/usr/bin/env bash
# Controleert de "geheimenhygiëne" van deze werkmap (DOEL-33, analyse M10):
# staat de repo in een cloud-gesynchroniseerde map (OneDrive/Dropbox/iCloud/
# Google Drive), en wat staat er dan aan geheimen in .env? Toont NOOIT een
# waarde — alleen of iets gezet is en of het een bekende dev-default is.
#
# Gebruik (vanuit de projectmap, of geef een map mee):
#   scripts/check-secrets.sh
#   scripts/check-secrets.sh /pad/naar/doelenboom
#
# Exitcode 1 alleen bij een FOUT (bv. een .env-bestand dat in git is beland);
# waarschuwingen (WAARSCHUWING) geven exitcode 0.
set -uo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR" || { echo "Map niet gevonden: $DIR" >&2; exit 2; }
DIR="$(pwd -P)"

fails=0
warns=0
ok()   { echo "OK            $*"; }
info() { echo "INFO          $*"; }
warn() { echo "WAARSCHUWING  $*"; warns=$((warns + 1)); }
fail() { echo "FOUT          $*"; fails=$((fails + 1)); }

# --- 1. Staat de map in een cloud-sync-map? -----------------------------------
synced=0
case "$DIR" in
  */OneDrive*|*/Library/CloudStorage/*|*/Dropbox*|*"/Google Drive"*|*/GoogleDrive*|*"/Mobile Documents/"*|*/iCloud*|*/Box/*|*/pCloud*)
    synced=1
    warn "De map staat in een gesynchroniseerde cloudmap ($DIR). Alles hierin — ook .env, .git en de image-tarballs — wordt naar de cloud gesynchroniseerd." ;;
  *) ok "De map staat niet in een bekende cloud-sync-map." ;;
esac

# --- 2. .env: rechten en inhoud (zonder waarden te tonen) ----------------------
env_value() { # env_value SLEUTEL -> waarde (zonder aanhalingstekens), of leeg
  grep -E "^$1=" .env 2>/dev/null | tail -n 1 | sed -E "s/^$1=//; s/^[\"']//; s/[\"']\$//"
}
if [ -f .env ]; then
  mode="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo '')"
  case "$mode" in
    ""|600|400|700) [ -n "$mode" ] && ok ".env heeft rechten $mode (alleen eigenaar)." ;;
    *) warn ".env heeft rechten $mode; maak dat alleen-eigenaar: chmod 600 .env" ;;
  esac

  smtp_pw="$(env_value SMTP_PASSWORD)"
  if [ -n "$smtp_pw" ]; then
    if [ "$synced" = 1 ]; then
      warn "SMTP_PASSWORD is gezet in een .env die in de cloud wordt gesynchroniseerd. Verplaats de map/.env (zie README, 'Geheimen en OneDrive') en overweeg het wachtwoord te roteren als OneDrive-toegang breder is dan alleen jij."
    else
      ok "SMTP_PASSWORD is gezet; de map wordt niet gesynchroniseerd."
    fi
  else
    ok "SMTP_PASSWORD is niet gezet in .env."
  fi

  jwt="$(env_value JWT_SECRET)"
  case "$jwt" in
    ""|dev-secret*|changeme|verander*) info "JWT_SECRET is leeg of een bekende dev-default — alleen acceptabel voor lokale ontwikkeling (productie weigert te starten)." ;;
    *) [ "${#jwt}" -lt 32 ] && warn "JWT_SECRET is korter dan 32 tekens." || ok "JWT_SECRET is gezet en niet de dev-default." ;;
  esac

  dbpw="$(env_value POSTGRES_PASSWORD)"
  case "$(printf '%s' "$dbpw" | tr '[:upper:]' '[:lower:]')" in
    ""|doelenboom|postgres|password|changeme) info "POSTGRES_PASSWORD is leeg of een bekende default — alleen acceptabel lokaal (productie weigert te starten, zie DOEL-31)." ;;
    *) ok "POSTGRES_PASSWORD is gezet en niet de default." ;;
  esac
else
  info "Geen .env in deze map."
fi

# --- 3. Zit er een .env* of sleutelbestand in git? -----------------------------
if git rev-parse --git-dir >/dev/null 2>&1; then
  tracked="$(git ls-files | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|id_rsa|credentials' | grep -vE '\.env\.example$|/test/|^docs/' || true)"
  if [ -n "$tracked" ]; then
    fail "Mogelijk geheime bestanden staan in git: $(echo "$tracked" | tr '\n' ' ')"
  else
    ok "Geen .env/sleutelbestanden in git."
  fi
  if [ -f .env ]; then
    git check-ignore -q .env && ok ".env wordt door git genegeerd." || fail ".env wordt NIET door git genegeerd (.gitignore)."
  fi
else
  info "Geen git-repository; git-controles overgeslagen."
fi

# --- 4. Grote build-artefacten in de map ---------------------------------------
tars="$(find . -maxdepth 1 -name '*.tar.gz' -size +1M 2>/dev/null | tr '\n' ' ')"
if [ -n "$tars" ]; then
  if [ "$synced" = 1 ]; then
    warn "Image-tarballs in een gesynchroniseerde map ($tars). Ze bevatten geen .env, maar kosten sync-ruimte; verplaats ze naar bv. ~/Library/Caches/doelenboom."
  else
    info "Image-tarballs aanwezig: $tars"
  fi
fi

echo
echo "Resultaat: $fails fout(en), $warns waarschuwing(en)."
[ "$fails" -eq 0 ]
