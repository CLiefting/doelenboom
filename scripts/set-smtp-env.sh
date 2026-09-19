#!/usr/bin/env bash
# Vult de SMTP_*-regels (MFA-e-mail, zie doelenboom_mfa_ontwerp.md in het
# project en api/src/email.ts) in je eigen .env in, zonder het wachtwoord
# ooit in een bestand te typen of ergens anders te laten staan dan in .env
# zelf — dit script vráágt het interactief (verborgen invoer, niet op het
# scherm zichtbaar, niet in je shell-geschiedenis).
#
# Gebruik (het script cd't zelf al naar ~/OneDrive/src/doelenboom, zie
# hieronder — vanaf welke map je het aanroept maakt dus niet uit):
#   chmod +x ~/OneDrive/src/doelenboom/scripts/set-smtp-env.sh
#   ~/OneDrive/src/doelenboom/scripts/set-smtp-env.sh
#
# Poort/beveiliging zijn de door Hostnet bevestigde waarden (587, STARTTLS —
# zie §9 in het ontwerpdocument) en staan hieronder vast. Host is instelbaar
# met smtp.hostnet.nl als standaard: sommige VPN's/firewalls blokkeren het
# door Hostnet voor webapplicaties gesuggereerde mailout.hostnet.nl specifiek
# (bekende bulkmail-relay), terwijl smtp.hostnet.nl (dezelfde mailbox, ander
# adres) gewoon doorkomt — functioneel gelijkwaardig voor dit lage volume.
set -euo pipefail

# Vaste, veilige locatie i.p.v. dynamische BASH_SOURCE-resolutie — zie
# doelenboom-cli.sh voor de achtergrond (Charles, 14 september 2026).
# DOEL-33: overschrijfbaar (DOELENBOOM_DIR) zodat de map buiten OneDrive kan staan.
REPO_DIR="${DOELENBOOM_DIR:-$HOME/OneDrive/src/doelenboom}"
if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "Kan doelenboom niet vinden op $REPO_DIR (geen docker-compose.yml daar)." >&2
  echo "Is de map leeg, verplaatst, of nog niet gesynchroniseerd (bv. door een OneDrive-issue)? Controleer dit eerst." >&2
  exit 1
fi
cd "$REPO_DIR"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Nieuw $ENV_FILE aangemaakt vanuit .env.example."
fi

DEFAULT_HOST="smtp.hostnet.nl"
read -r -p "SMTP-server [$DEFAULT_HOST]: " SMTP_HOST
SMTP_HOST="${SMTP_HOST:-$DEFAULT_HOST}"

DEFAULT_USER="no-reply@code072.nl"
read -r -p "SMTP-gebruikersnaam (mailbox waarmee ingelogd wordt) [$DEFAULT_USER]: " SMTP_USER
SMTP_USER="${SMTP_USER:-$DEFAULT_USER}"

# -s: verborgen invoer (niet op het scherm, niet in shell-geschiedenis).
read -r -s -p "SMTP-wachtwoord voor $SMTP_USER: " SMTP_PASSWORD
echo
if [ -z "$SMTP_PASSWORD" ]; then
  echo "Geen wachtwoord ingevoerd — gestopt, er is niets gewijzigd." >&2
  exit 1
fi

DEFAULT_FROM="no-reply.doelenboom@code072.nl"
read -r -p "Afzenderadres (alias, mag afwijken van de mailbox hierboven) [$DEFAULT_FROM]: " SMTP_FROM
SMTP_FROM="${SMTP_FROM:-$DEFAULT_FROM}"

# set_env_var: idempotent — vervangt de regel als de sleutel al voorkomt in
# .env, voegt 'm anders toe. Los grep/sed-paar i.p.v. één awk-eenregelig,
# vooral omdat macOS' BSD-sed (-i vereist hier een expliciete, ook al is die
# leeg, backup-extensie-parameter) anders is dan GNU-sed.
set_env_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_env_var SMTP_HOST "$SMTP_HOST"
set_env_var SMTP_PORT "587"
set_env_var SMTP_USER "$SMTP_USER"
set_env_var SMTP_PASSWORD "$SMTP_PASSWORD"
set_env_var SMTP_FROM "$SMTP_FROM"

unset SMTP_PASSWORD

echo "SMTP-instellingen bijgewerkt in $ENV_FILE (host=$SMTP_HOST poort=587 gebruiker=$SMTP_USER afzender=$SMTP_FROM)."
echo "Herstart de stack om dit te laten meetellen: unset DOCKER_DEFAULT_PLATFORM && doelenboom -local -restart"
