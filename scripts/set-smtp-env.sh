#!/usr/bin/env bash
# Vult de SMTP_*-regels (MFA-e-mail, zie doelenboom_mfa_ontwerp.md in het project en
# api/src/email.ts) in je eigen .env in, zonder het wachtwoord ooit te tonen of in een bestand
# te typen: het wordt ofwel verborgen ingevoerd, ofwel uit het klembord gelezen.
#
# Gebruik (vanaf welke map dan ook; het script gaat zelf naar de repo, zie DOELENBOOM_DIR):
#   scripts/set-smtp-env.sh              # verborgen invoer (alleen in een echte terminal)
#   scripts/set-smtp-env.sh --klembord   # wachtwoord uit het klembord (macOS: pbpaste);
#                                        # kopieer het eerst uit je wachtwoordmanager
#
# Poort/beveiliging zijn de door Hostnet bevestigde waarden (587, STARTTLS — zie §9 in het
# ontwerpdocument) en staan hieronder vast. Host is instelbaar met smtp.hostnet.nl als
# standaard: sommige VPN's/firewalls blokkeren het door Hostnet voor webapplicaties
# gesuggereerde mailout.hostnet.nl specifiek (bekende bulkmail-relay), terwijl smtp.hostnet.nl
# (dezelfde mailbox, ander adres) gewoon doorkomt — functioneel gelijkwaardig voor dit lage volume.
set -euo pipefail

# Vaste, veilige locatie i.p.v. dynamische BASH_SOURCE-resolutie — zie doelenboom-cli.sh.
# DOEL-33/45: overschrijfbaar (DOELENBOOM_DIR); standaard buiten OneDrive.
REPO_DIR="${DOELENBOOM_DIR:-$HOME/src/doelenboom}"

USE_CLIPBOARD=0
for arg in "$@"; do
  case "$arg" in
    --klembord) USE_CLIPBOARD=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Onbekende optie: $arg (bekend: --klembord)" >&2; exit 1 ;;
  esac
done

if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "Kan doelenboom niet vinden op $REPO_DIR (geen docker-compose.yml daar)." >&2
  echo "Is de map verplaatst? Zet DOELENBOOM_DIR naar de juiste map." >&2
  exit 1
fi
cd "$REPO_DIR"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Nieuw $ENV_FILE aangemaakt vanuit .env.example."
fi

DEFAULT_HOST="smtp.hostnet.nl"
read -r -p "SMTP-server [$DEFAULT_HOST]: " SMTP_HOST
SMTP_HOST="${SMTP_HOST:-$DEFAULT_HOST}"

DEFAULT_USER="no-reply@code072.nl"
read -r -p "SMTP-gebruikersnaam (mailbox waarmee ingelogd wordt) [$DEFAULT_USER]: " SMTP_USER
SMTP_USER="${SMTP_USER:-$DEFAULT_USER}"

if [ "$USE_CLIPBOARD" = 1 ]; then
  command -v pbpaste >/dev/null 2>&1 || { echo "pbpaste ontbreekt (alleen macOS); gebruik verborgen invoer." >&2; exit 1; }
  SMTP_PASSWORD="$(pbpaste)"
  echo "Wachtwoord uit het klembord gelezen (${#SMTP_PASSWORD} tekens; niet getoond)."
else
  # Verborgen invoer werkt alleen in een echte terminal; anders kan het echoën niet uitgezet worden.
  if [ ! -t 0 ]; then
    echo "Geen echte terminal: verborgen invoer is niet mogelijk. Gebruik --klembord." >&2
    exit 1
  fi
  read -r -s -p "SMTP-wachtwoord voor $SMTP_USER (verborgen): " SMTP_PASSWORD
  echo
  echo "(${#SMTP_PASSWORD} tekens ontvangen; niet getoond)"
fi
if [ -z "$SMTP_PASSWORD" ]; then
  echo "Geen wachtwoord ingevoerd — gestopt, er is niets gewijzigd." >&2
  exit 1
fi
case "$SMTP_PASSWORD" in
  *[[:space:]\$\`\"\'\\#]*)
    echo "Het wachtwoord bevat spaties of een van \$ \` \" ' \\ # — die geven problemen in .env/compose." >&2
    echo "Kies bij Hostnet een wachtwoord met alleen letters, cijfers en - _ . ! @ % ^ * + = ~ , : ; ? / |" >&2
    echo "Er is niets gewijzigd." >&2
    exit 1 ;;
esac

DEFAULT_FROM="no-reply.doelenboom@code072.nl"
read -r -p "Afzenderadres (alias, mag afwijken van de mailbox hierboven) [$DEFAULT_FROM]: " SMTP_FROM
SMTP_FROM="${SMTP_FROM:-$DEFAULT_FROM}"

# set_env_var: idempotent — vervangt de regel als de sleutel al voorkomt in .env, voegt 'm anders
# toe. Met python i.p.v. sed: de waarde gaat via de omgeving en wordt letterlijk gebruikt (tekens
# als & | \ / zijn dan geen probleem). Bestandsrechten blijven behouden.
set_env_var() {
  KEY="$1" VAL="$2" python3 - "$ENV_FILE" <<'PY'
import os, re, sys, tempfile
p, key, val = sys.argv[1], os.environ["KEY"], os.environ["VAL"]
lines = open(p).read().split("\n")
if lines and lines[-1] == "":
    lines.pop()
for i, l in enumerate(lines):
    if re.match(r"\s*%s=" % re.escape(key), l):
        lines[i] = f"{key}={val}"
        break
else:
    lines.append(f"{key}={val}")
mode = os.stat(p).st_mode & 0o777
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(p)))
os.write(fd, ("\n".join(lines) + "\n").encode()); os.close(fd)
os.chmod(tmp, mode); os.replace(tmp, p)
PY
}

set_env_var SMTP_HOST "$SMTP_HOST"
set_env_var SMTP_PORT "587"
set_env_var SMTP_USER "$SMTP_USER"
set_env_var SMTP_PASSWORD "$SMTP_PASSWORD"
set_env_var SMTP_FROM "$SMTP_FROM"

unset SMTP_PASSWORD

echo "SMTP-instellingen bijgewerkt in $ENV_FILE (host=$SMTP_HOST poort=587 gebruiker=$SMTP_USER afzender=$SMTP_FROM)."
if [ "$USE_CLIPBOARD" = 1 ]; then
  echo "Tip: leeg het klembord (kopieer iets anders) zodat het wachtwoord er niet blijft staan."
fi
echo "Herstart de stack om dit te laten meetellen: unset DOCKER_DEFAULT_PLATFORM && doelenboom -local -restart"
