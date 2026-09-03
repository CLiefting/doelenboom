#!/usr/bin/env bash
# Vult de SMTP_*-regels (MFA-e-mail, zie doelenboom_mfa_ontwerp.md in het
# project en api/src/email.ts) in je eigen .env in, zonder het wachtwoord
# ooit in een bestand te typen of ergens anders te laten staan dan in .env
# zelf — dit script vráágt het interactief (verborgen invoer, niet op het
# scherm zichtbaar, niet in je shell-geschiedenis).
#
# Gebruik (vanuit de root van de repo-checkout, waar ook .env/.env.example
# staan):
#   chmod +x scripts/set-smtp-env.sh
#   ./scripts/set-smtp-env.sh
#
# Host/poort/beveiliging zijn de door Hostnet bevestigde waarden
# (mailout.hostnet.nl, 587, STARTTLS — zie §9 in het ontwerpdocument) en
# staan hieronder vast; alleen SMTP_USER/SMTP_PASSWORD zijn account-
# specifiek en worden hier gevraagd. Wil je andere waarden (bv. een andere
# relay), pas dan gewoon zelf de betreffende SMTP_*-regel(s) in .env aan na
# het draaien van dit script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Nieuw $ENV_FILE aangemaakt vanuit .env.example."
fi

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

set_env_var SMTP_HOST "mailout.hostnet.nl"
set_env_var SMTP_PORT "587"
set_env_var SMTP_USER "$SMTP_USER"
set_env_var SMTP_PASSWORD "$SMTP_PASSWORD"
set_env_var SMTP_FROM "$SMTP_FROM"

unset SMTP_PASSWORD

echo "SMTP-instellingen bijgewerkt in $ENV_FILE (host=mailout.hostnet.nl poort=587 gebruiker=$SMTP_USER afzender=$SMTP_FROM)."
echo "Herstart de stack om dit te laten meetellen: unset DOCKER_DEFAULT_PLATFORM && doelenboom -local -restart"
