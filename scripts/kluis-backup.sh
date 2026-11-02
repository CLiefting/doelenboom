#!/usr/bin/env bash
# kluis-backup.sh — back-up van de lokale KLUIS (DOEL-133), "net als productie".
#
#   productie (VPS)                         kluis (deze Mac)
#   databasedump elke nacht, 14 dagen       databasedump dagelijks 12:30, 14 dagen
#   Excel per doelenboom (dagelijks 30 d,   idem, met hetzelfde script
#     wekelijks 1 jr, maandelijks altijd)     (exportAllDoelenbomen in de kluis-API)
#   NAS haalt op (pull, 07:00)              Mac stuurt versleuteld naar CL-NAS002
#                                             zodra die bereikbaar is (push)
#
# Een laptop is geen vaste server: de NAS kan hem niet ophalen. Daarom stuurt de
# Mac zelf, en alleen VERSLEUTELD (age; de privésleutel staat in je
# wachtwoordkluis, niet op deze Mac). Op de Mac zelf beschermt FileVault.
#
# Gebruik:
#   bash scripts/kluis-backup.sh                 volledige back-up (wat launchd dagelijks draait)
#   bash scripts/kluis-backup.sh --voor-update   alleen een databasedump (kluis.sh --bijwerken)
#   bash scripts/kluis-backup.sh --controle      laatste back-up/offsite te oud? (melding)
#   bash scripts/kluis-backup.sh --installeer-planning   launchd-taak dagelijks 12:30
#   bash scripts/kluis-backup.sh --verwijder-planning    die taak weer weghalen
#   bash scripts/kluis-backup.sh -h
#
# launchd start een gemiste run (Mac sliep om 12:30) zodra de Mac weer wakker
# is. Stond de Mac uit, dan waarschuwen --controle, `kluis.sh --status` en
# `doelenboom -local -kluis -open` als de laatste back-up te oud is.
#
# Instellingen in ~/.doelenboom-kluis/kluis.env (kluis.sh --init). Voor tests:
# KLUIS_HOME, KLUIS_LAUNCH_AGENTS, KLUIS_DOCKER_TIMEOUT, KLUIS_NU (epoch).
set -euo pipefail

die() { echo "FOUT: $*" >&2; exit 1; }
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >&2; }  # naar stderr: stdout is voor uitkomsten
usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
KLUIS_HOME="${KLUIS_HOME:-$HOME/.doelenboom-kluis}"
KLUIS_ENV="$KLUIS_HOME/kluis.env"
VERSIE_ENV="$KLUIS_HOME/versie.env"
LABEL="nl.code072.doelenboom-kluis-backup"
LAUNCH_AGENTS="${KLUIS_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
MAX_BACKUP_DAGEN=2
MAX_OFFSITE_DAGEN=7

val() { [ -f "$2" ] || return 0; sed -n "s/^$1=//p" "$2" | head -n 1 | sed 's/^"\(.*\)"$/\1/'; }
nu() { echo "${KLUIS_NU:-$(date +%s)}"; }
notify() {  # vaste teksten, geen aanhalingstekens erin
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"$1\" with title \"Doelenboom-kluis (VAULT)\"" >/dev/null 2>&1 || true
}

[ -f "$KLUIS_ENV" ] || { [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "--verwijder-planning" ] || die "De kluis is nog niet ingericht (bash scripts/kluis.sh --init)."; }
BACKUP_DIR="$(val KLUIS_BACKUP_DIR "$KLUIS_ENV")"
STATUS="${BACKUP_DIR:-/nonexistent}/status.txt"

set_status() {  # set_status SLEUTEL waarde
  local tmp="$STATUS.tmp"
  umask 077
  { [ -f "$STATUS" ] && grep -v "^$1=" "$STATUS" || true; echo "$1=$2"; } > "$tmp"
  mv "$tmp" "$STATUS"
}

compose() {
  local args=(docker compose -p doelenboom-kluis -f "$REPO/docker-compose.kluis.yml")
  [ -f "$REPO/.env" ] && args+=(--env-file "$REPO/.env")
  args+=(--env-file "$KLUIS_ENV")
  [ -f "$VERSIE_ENV" ] && args+=(--env-file "$VERSIE_ENV")
  "${args[@]}" "$@"
}

ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  command -v open >/dev/null 2>&1 || die "Docker draait niet."
  log "Docker Desktop starten..."
  open -a Docker
  local waited=0 max="${KLUIS_DOCKER_TIMEOUT:-180}"
  until docker info >/dev/null 2>&1; do
    [ "$waited" -lt "$max" ] || die "Docker Desktop is na ${max}s nog niet bereikbaar."
    sleep 3; waited=$((waited + 3))
  done
}

# ---- databasedump -------------------------------------------------------------
dump_database() {  # dump_database <achtervoegsel>
  local suffix="$1" ts out
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$BACKUP_DIR/database/doelenboom-kluis-$ts$suffix.sql.gz"
  umask 077
  mkdir -p "$BACKUP_DIR/database"; chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/database"
  log "Databasedump -> $out"
  compose exec -T db pg_dump -U doelenboom doelenboom < /dev/null | gzip > "$out.tmp"
  gzip -t "$out.tmp" || die "Databasedump is beschadigd."
  [ "$(gunzip -c "$out.tmp" | head -c 100000 | grep -c 'PostgreSQL database dump' || true)" -ge 1 ] || die "Databasedump lijkt leeg of onvolledig."
  mv "$out.tmp" "$out"
  chmod 600 "$out"
  ( cd "$(dirname "$out")" && shasum -a 256 "$(basename "$out")" > "$(basename "$out").sha256" && chmod 600 "$(basename "$out").sha256" )
  echo "$out"
}

prune_database() {
  # Gewone dumps 14 dagen (zoals productie), dumps van vóór een update 30 dagen.
  find "$BACKUP_DIR/database" -maxdepth 1 -name 'doelenboom-kluis-*.sql.gz' ! -name '*-voor-update.sql.gz' -mtime +14 \
    -exec rm -f {} {}.sha256 \;
  find "$BACKUP_DIR/database" -maxdepth 1 -name 'doelenboom-kluis-*-voor-update.sql.gz' -mtime +30 \
    -exec rm -f {} {}.sha256 \;
}

# ---- offsite: versleutelen en naar CL-NAS002 ---------------------------------------
offsite() {
  local recipient pad host port user key known
  recipient="$(val KLUIS_AGE_ONTVANGER "$KLUIS_ENV")"; pad="$(val KLUIS_NAS_PAD "$KLUIS_ENV")"
  host="$(val KLUIS_NAS_HOST "$KLUIS_ENV")"; port="$(val KLUIS_NAS_PORT "$KLUIS_ENV")"
  user="$(val KLUIS_NAS_USER "$KLUIS_ENV")"; key="$(val KLUIS_NAS_SLEUTEL "$KLUIS_ENV")"
  known="$KLUIS_HOME/nas_known_hosts"
  if [ -z "$recipient" ] || [ -z "$pad" ]; then
    log "Offsite: nog niet ingesteld (KLUIS_AGE_ONTVANGER/KLUIS_NAS_PAD leeg in $KLUIS_ENV)."
    set_status offsite_resultaat "niet ingesteld"
    return 0
  fi
  # OWASP A03: deze waarden gaan in commando's; alleen verwachte vormen.
  [[ "$recipient" =~ ^age1[0-9a-z]{58}$ ]] || { set_status offsite_resultaat "fout: ongeldige KLUIS_AGE_ONTVANGER"; return 1; }
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] && [[ "$port" =~ ^[0-9]{1,5}$ ]] && [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [[ "$pad" =~ ^[A-Za-z0-9/._-]+$ ]] \
    || { set_status offsite_resultaat "fout: ongeldige NAS-instelling"; return 1; }
  command -v age >/dev/null 2>&1 || { set_status offsite_resultaat "fout: age ontbreekt (brew install age)"; return 1; }

  # Versleutelen: elk bronbestand krijgt één keer een .age-kopie in offsite/.
  umask 077
  local rel n=0
  while IFS= read -r rel; do
    [ -f "$BACKUP_DIR/offsite/$rel.age" ] && continue
    mkdir -p "$(dirname "$BACKUP_DIR/offsite/$rel")"
    age -r "$recipient" -o "$BACKUP_DIR/offsite/$rel.age.tmp" "$BACKUP_DIR/$rel"
    mv "$BACKUP_DIR/offsite/$rel.age.tmp" "$BACKUP_DIR/offsite/$rel.age"
    n=$((n + 1))
  done < <(cd "$BACKUP_DIR" && find database excel -type f \( -name '*.sql.gz' -o -name '*.xlsx' \) | LC_ALL=C sort)
  # Lokale .age zonder bron (opgeruimd volgens de bewaartermijn) ook weg; op de
  # NAS blijven ze staan (het NAS-account mag alleen schrijven).
  while IFS= read -r rel; do
    [ -f "$BACKUP_DIR/${rel%.age}" ] || rm -f "$BACKUP_DIR/offsite/$rel"
  done < <(cd "$BACKUP_DIR/offsite" && find . -type f -name '*.age' | sed 's#^\./##')
  log "Offsite: $n nieuw bestand(en) versleuteld."

  [ -f "$key" ] && [ -f "$known" ] || { set_status offsite_resultaat "fout: NAS-sleutel of $known ontbreekt"; return 1; }
  if ! nc -z -w 3 "$host" "$port" >/dev/null 2>&1; then
    log "Offsite: CL-NAS002 ($host) niet bereikbaar; volgende keer opnieuw."
    set_status offsite_resultaat "overgeslagen: NAS niet bereikbaar"
    return 0
  fi
  local ssh_cmd="ssh -i $key -p $port -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$known"
  if rsync -a --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= -e "$ssh_cmd" "$BACKUP_DIR/offsite/" "$user@$host:$pad/"; then
    set_status offsite_resultaat "ok"
    set_status laatste_offsite_epoch "$(nu)"
    set_status laatste_offsite_op "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    log "Offsite: naar $host:$pad gestuurd."
  else
    set_status offsite_resultaat "fout: rsync naar de NAS mislukt"
    return 1
  fi
}

# ---- bewaking ---------------------------------------------------------------------
controle() {  # 0 = alles op tijd, 1 = te oud (met melding)
  local nu_s b o msg="" rc=0
  nu_s="$(nu)"
  b="$(val laatste_backup_epoch "$STATUS")"; o="$(val laatste_offsite_epoch "$STATUS")"
  echo "Laatste back-up:  $(val laatste_backup_op "$STATUS") ($(val laatste_backup_resultaat "$STATUS"))"
  echo "Laatste offsite:  $(val laatste_offsite_op "$STATUS") ($(val offsite_resultaat "$STATUS"))"
  echo "Laatste hersteltest: $(val laatste_hersteltest_op "$STATUS")"
  if ! [[ "$b" =~ ^[0-9]+$ ]] || [ $(( (nu_s - b) / 86400 )) -ge "$MAX_BACKUP_DAGEN" ]; then
    msg="Laatste back-up van de kluis is ouder dan $MAX_BACKUP_DAGEN dagen."; rc=1
  elif ! [[ "$o" =~ ^[0-9]+$ ]] || [ $(( (nu_s - o) / 86400 )) -ge "$MAX_OFFSITE_DAGEN" ]; then
    msg="Laatste offsite-kopie van de kluis is ouder dan $MAX_OFFSITE_DAGEN dagen."; rc=1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "LET OP: $msg"
    notify "$msg"
  fi
  return "$rc"
}

# ---- volledige back-up ---------------------------------------------------------------
LOCK="$KLUIS_HOME/backup.lock"   # globaal: de EXIT-trap draait buiten de functie
volledig() {
  local started="" ok=1
  if ! mkdir "$LOCK" 2>/dev/null; then
    # Een slot van meer dan 6 uur oud is van een afgebroken run.
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then rmdir "$LOCK"; mkdir "$LOCK"; else die "Er loopt al een kluis-back-up."; fi
  fi
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
  log "Kluis-back-up gestart"
  ensure_docker

  if [ -z "$(compose ps --status running -q web 2>/dev/null)" ]; then
    started="1"
    if [ -f "$VERSIE_ENV" ]; then
      log "De kluis draaide niet; tijdelijk starten (er wordt niets gebouwd)."
      compose up -d
    else
      log "De kluis heeft nog geen versie; alleen de database starten."
      compose up -d db
    fi
    local i
    for i in $(seq 1 60); do
      compose exec -T db pg_isready -U doelenboom < /dev/null >/dev/null 2>&1 && break
      [ "$i" -lt 60 ] || die "de kluis-database kwam niet op."
      sleep 2
    done
  fi

  dump_database "" >/dev/null || ok=0
  if [ "$ok" -eq 1 ] && [ -f "$VERSIE_ENV" ]; then
    log "Excel per doelenboom (zelfde script als productie)"
    local i
    for i in $(seq 1 30); do
      compose exec -T api true < /dev/null >/dev/null 2>&1 && break
      sleep 2
    done
    compose exec -T api node dist/scripts/exportAllDoelenbomen.js < /dev/null || ok=0
  fi
  prune_database
  [ -n "$started" ] && { log "De kluis weer stoppen (draaide niet)."; compose stop >/dev/null 2>&1 || true; }

  if [ "$ok" -eq 1 ]; then
    set_status laatste_backup_resultaat "ok"
    set_status laatste_backup_epoch "$(nu)"
    set_status laatste_backup_op "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  else
    set_status laatste_backup_resultaat "fout"
    notify "De kluis-back-up is mislukt. Zie ~/.doelenboom-kluis/backup.log"
    die "Kluis-back-up mislukt."
  fi
  offsite || notify "De offsite-kopie van de kluis is mislukt. Zie ~/.doelenboom-kluis/backup.log"
  controle >/dev/null || true
  log "Kluis-back-up klaar"
}

installeer_planning() {
  local plist="$LAUNCH_AGENTS/$LABEL.plist"
  mkdir -p "$LAUNCH_AGENTS" "$KLUIS_HOME"
  # PATH: Docker Desktop, Homebrew (age, rsync) en het systeem.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/scripts/kluis-backup.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$KLUIS_HOME/backup.log</string>
  <key>StandardErrorPath</key><string>$KLUIS_HOME/backup.log</string>
</dict>
</plist>
PLIST
  chmod 644 "$plist"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Gepland: dagelijks 12:30 ($plist). Een gemiste run draait zodra de Mac weer wakker is."
  echo "Log: $KLUIS_HOME/backup.log"
}

verwijder_planning() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENTS/$LABEL.plist"
  echo "Planning verwijderd."
}

case "${1:-}" in
  "") volledig ;;
  --voor-update)
    ensure_docker
    out="$(dump_database "-voor-update")"
    echo "Back-up vóór de update: $out"
    ;;
  --controle) controle || true ;;
  --noteer-hersteltest)
    [[ "${2:-}" =~ ^[0-9]+$ ]] && [[ "${3:-}" =~ ^[0-9]+$ ]] || die "--noteer-hersteltest verwacht twee aantallen."
    set_status laatste_hersteltest_op "$(date '+%Y-%m-%dT%H:%M:%S%z') ($2 doelenbomen, $3 elementen)"
    ;;
  --installeer-planning) installeer_planning ;;
  --verwijder-planning) verwijder_planning ;;
  -h|--help) usage ;;
  *) usage >&2; die "Onbekende optie: $1" ;;
esac
