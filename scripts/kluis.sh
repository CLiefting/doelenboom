#!/usr/bin/env bash
# kluis.sh — de lokale KLUIS-omgeving (DOEL-133): doelenbomen met gevoelige(re)
# informatie, alleen op deze Mac, op http://localhost:8089 (rode driehoek "VAULT").
#
# De kluis draait ALTIJD dezelfde versie als productie. scripts/release.sh
# --deploy roept na een geslaagde VPS-uitrol zelf `kluis.sh --bijwerken <tag>`
# aan. Er wordt hier nooit gebouwd: de kluis krijgt precies de acceptatie-images
# die voor die commit zijn goedgekeurd én waarop Charles akkoord gaf (DOEL-131).
#
# Gebruik:
#   KLUIS_SYSADMIN_EMAIL=jij@example.nl bash scripts/kluis.sh --init
#                                   eenmalig: geheimen, mappen, lege database, één sysadmin
#   bash scripts/kluis.sh --bijwerken [vX.Y.Z]
#                                   naar de versie van productie (standaard de nieuwste tag):
#                                   back-up, acceptatie-images overnemen, migraties, starten
#   bash scripts/kluis.sh --start   starten (zelfde images, niets bouwen)
#   bash scripts/kluis.sh --stop    stoppen (de database blijft bewaard)
#   bash scripts/kluis.sh --status  versie (ook t.o.v. productie), draait hij, back-ups
#   bash scripts/kluis.sh --herstel-test
#                                   laatste databaseback-up terugzetten in een wegwerpdatabase en tellen
#   bash scripts/kluis.sh -h        deze uitleg
#
# Bestanden (buiten git):
#   ~/.doelenboom-kluis/kluis.env     geheimen en instellingen (0600)
#   ~/.doelenboom-kluis/versie.env    welke versie de kluis draait
#   ~/.doelenboom-kluis/sysadmin.txt  inloggegevens van de kluis-sysadmin (0600)
#   ~/Backups/doelenboom-kluis/       back-ups (zie scripts/kluis-backup.sh)
#
# Werkt met de bash 3.2 van macOS. Voor tests instelbaar: KLUIS_HOME, KLUIS_URL,
# KLUIS_HEALTH_TRIES.
set -euo pipefail

die() { echo "FOUT: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/docker-compose.kluis.yml" ] || die "Geen docker-compose.kluis.yml gevonden in $REPO"
cd "$REPO"
export DOELENBOOM_DIR="$REPO"

KLUIS_HOME="${KLUIS_HOME:-$HOME/.doelenboom-kluis}"
KLUIS_ENV="$KLUIS_HOME/kluis.env"
VERSIE_ENV="$KLUIS_HOME/versie.env"
KLUIS_URL="${KLUIS_URL:-http://127.0.0.1:8089}"
HEALTH_TRIES="${KLUIS_HEALTH_TRIES:-60}"
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

compose() {
  local args=(docker compose -p doelenboom-kluis -f "$REPO/docker-compose.kluis.yml")
  # Eerst je gewone .env (SMTP), dan kluis.env en versie.env (die winnen).
  [ -f "$REPO/.env" ] && args+=(--env-file "$REPO/.env")
  args+=(--env-file "$KLUIS_ENV")
  [ -f "$VERSIE_ENV" ] && args+=(--env-file "$VERSIE_ENV")
  "${args[@]}" "$@"
}
kluis_sql() { compose exec -T db psql -U doelenboom -d doelenboom -X -q -At -v ON_ERROR_STOP=1 -c "$1" < /dev/null; }
# Waarde uit een KEY=waarde-bestand, zonder eventuele aanhalingstekens.
val() { [ -f "$2" ] || return 0; sed -n "s/^$1=//p" "$2" | head -n 1 | sed 's/^"\(.*\)"$/\1/'; }
rand() {
  local v
  v="$(openssl rand -base64 $(( $1 * 2 )) | tr -dc 'A-Za-z0-9' | cut -c1-"$1")"
  [ "${#v}" -eq "$1" ] || die "kon geen willekeurige waarde van $1 tekens maken."
  printf '%s' "$v"
}
need_docker() {
  command -v docker >/dev/null || die "docker ontbreekt"
  docker info >/dev/null 2>&1 || die "Docker draait niet (start Docker Desktop: open -a Docker)"
}
need_init() { [ -f "$KLUIS_ENV" ] || die "De kluis is nog niet ingericht. Eerst:  KLUIS_SYSADMIN_EMAIL=jij@example.nl bash scripts/kluis.sh --init"; }
need_versie() { [ -f "$VERSIE_ENV" ] || die "De kluis heeft nog geen versie. Eerst:  bash scripts/kluis.sh --bijwerken"; }
wait_db() {
  compose up -d db
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    kluis_sql 'select 1' >/dev/null 2>&1 && return 0
    [ "$i" -lt "$HEALTH_TRIES" ] || die "de kluis-database kwam niet op (zie: docker logs doelenboom-kluis-db-1)."
    sleep 2
  done
}
wait_health() {
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    curl -fsS "$KLUIS_URL/api/health" >/dev/null 2>&1 && return 0
    [ "$i" -lt "$HEALTH_TRIES" ] || die "de kluis-API is niet gezond op $KLUIS_URL (zie: docker logs doelenboom-kluis-api-1)."
    sleep 2
  done
}
newest_tag() { git tag --list 'v*' --sort=-v:refname | head -n 1; }

cmd_init() {
  step "Kluis inrichten"
  [ ! -f "$KLUIS_ENV" ] || die "De kluis is al ingericht ($KLUIS_ENV bestaat). Er is niets gewijzigd."
  local email="${KLUIS_SYSADMIN_EMAIL:-}"
  [ -n "$email" ] || die "Geef het e-mailadres van de kluis-sysadmin mee:  KLUIS_SYSADMIN_EMAIL=jij@example.nl bash scripts/kluis.sh --init"
  # OWASP A03: het adres gaat de SQL in, dus alleen deze vorm.
  [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "KLUIS_SYSADMIN_EMAIL is geen geldig e-mailadres."
  command -v openssl >/dev/null || die "openssl ontbreekt"
  need_docker

  local backup_dir="${KLUIS_BACKUP_DIR:-$HOME/Backups/doelenboom-kluis}"
  case "$backup_dir" in
    /*) ;;
    *) die "KLUIS_BACKUP_DIR moet een absoluut pad zijn." ;;
  esac
  # Gevoelige back-ups horen niet in een cloudmap of in de repo.
  case "$backup_dir" in
    *"/Library/Mobile Documents"*|*iCloud*|*OneDrive*|*Dropbox*|*"Google Drive"*|"$REPO"|"$REPO"/*)
      die "KLUIS_BACKUP_DIR ($backup_dir) staat in een cloudmap of in de repo. Kies een map buiten iCloud/OneDrive/Dropbox en buiten $REPO." ;;
  esac
  case "$backup_dir" in *[!A-Za-z0-9/._\ -]*) die "KLUIS_BACKUP_DIR bevat ongebruikelijke tekens." ;; esac

  umask 077
  mkdir -p "$KLUIS_HOME" "$backup_dir/database" "$backup_dir/excel" "$backup_dir/offsite"
  chmod 700 "$KLUIS_HOME" "$backup_dir" "$backup_dir/database" "$backup_dir/excel" "$backup_dir/offsite"
  { echo "# DOEL-133: geheimen en instellingen van de lokale kluis (niet in git, alleen voor jou leesbaar)."
    echo "KLUIS_POSTGRES_PASSWORD=$(rand 32)"
    echo "KLUIS_JWT_SECRET=$(rand 64)"
    echo "KLUIS_BACKUP_DIR=\"$backup_dir\""
    echo "# Offsite-kopie naar CL-NAS002 (zie deploy/README.md, \"Kluis\"). Leeg = geen offsite."
    echo "KLUIS_AGE_ONTVANGER="
    echo "KLUIS_NAS_HOST=192.168.178.22"
    echo "KLUIS_NAS_PORT=62022"
    echo "KLUIS_NAS_USER=doelenboom-kluis"
    echo "KLUIS_NAS_PAD="
    echo "KLUIS_NAS_SLEUTEL=\"$KLUIS_HOME/nas_ed25519\""
  } > "$KLUIS_ENV.tmp"
  chmod 600 "$KLUIS_ENV.tmp"
  mv "$KLUIS_ENV.tmp" "$KLUIS_ENV"
  echo "Nieuw: $KLUIS_ENV (willekeurige database- en JWT-geheimen)."
  echo "Back-ups komen in: $backup_dir"

  step "Lege kluis-database (alleen het schema, geen demo-data)"
  wait_db
  local pw users
  users="$(kluis_sql "select count(*) from users")"
  [ "$users" = "0" ] || die "De kluis-database bevat al gebruikers; er is geen sysadmin aangemaakt."
  pw="$(rand 24)"
  [[ "$pw" =~ ^[A-Za-z0-9]{24}$ ]] || die "kon geen wachtwoord maken."
  kluis_sql "insert into users (email, password_hash, is_sysadmin, must_change_password) values ('$email', crypt('$pw', gen_salt('bf', 12)), true, false)" >/dev/null
  printf 'Kluis-sysadmin: %s\nWachtwoord: %s\n' "$email" "$pw" > "$KLUIS_HOME/sysadmin.txt"
  chmod 600 "$KLUIS_HOME/sysadmin.txt"
  echo "Sysadmin $email aangemaakt; het wachtwoord staat in $KLUIS_HOME/sysadmin.txt (alleen voor jou leesbaar)."
  echo
  echo "Volgende stap: de kluis op de versie van productie zetten:  bash scripts/kluis.sh --bijwerken"
}

cmd_bijwerken() {
  local tag="${1:-}"
  step "Kluis bijwerken naar de versie van productie"
  need_init
  need_docker
  [ -n "$tag" ] || tag="$(newest_tag)"
  [[ "$tag" =~ $TAG_RE ]] || die "Geen geldige versie (verwacht vX.Y.Z): ${tag:-geen tag gevonden}."
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "Tag $tag bestaat niet."
  local sha short
  sha="$(git rev-parse "$tag^{commit}")"; short="$(git rev-parse --short "$sha")"
  [ "$(git rev-parse HEAD)" = "$sha" ] \
    || die "Je staat niet op de commit van $tag ($short). De migraties moeten van precies die versie komen:  git checkout $tag  (of na de release op main) en opnieuw."

  if [ "$(val KLUIS_COMMIT "$VERSIE_ENV")" = "$sha" ]; then
    echo "De kluis staat al op $tag ($short)."
    return 0
  fi

  # Alleen wat in acceptatie is goedgekeurd én waarop akkoord is gegeven (DOEL-131).
  local ev="$REPO/.acceptatie/bewijs-$sha.txt"
  [ -f "$ev" ] || die "Geen acceptatiebewijs voor $short. De kluis krijgt alleen een in acceptatie goedgekeurde versie."
  [ "$(val commit "$ev")" = "$sha" ] && [ "$(val resultaat "$ev")" = "GOEDGEKEURD" ] && [ "$(val akkoord "$ev")" = "ja" ] \
    || die "Het acceptatiebewijs van $short is niet goedgekeurd of heeft geen akkoord. De kluis is niet bijgewerkt."

  # De acceptatie-images moeten van precies deze commit zijn.
  local s acc_version
  for s in api web excel-service; do
    docker image inspect "doelenboom-acc-$s:latest" >/dev/null 2>&1 || die "Acceptatie-image doelenboom-acc-$s ontbreekt. Draai eerst:  bash scripts/acceptatie.sh"
  done
  acc_version="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' doelenboom-acc-api:latest | sed -n 's/^BUILD_VERSION=//p' | head -n 1)"
  [[ "$acc_version" == *"($short,"* ]] \
    || die "De acceptatie-images horen bij een andere commit (${acc_version:-onbekend}), niet bij $short. Draai acceptatie van $short opnieuw en daarna:  bash scripts/kluis.sh --bijwerken $tag"

  local build_version
  build_version="$(./scripts/build-version.sh)"
  case "$build_version" in *dirty*) die "Werkmap is niet schoon (BUILD_VERSION is 'dirty')." ;; esac
  case "$build_version" in *'"'*|*'$'*|*'`'*|*"\\"*) die "Onverwachte BUILD_VERSION: $build_version" ;; esac

  echo "Van: $(val KLUIS_VERSIE "$VERSIE_ENV") ($(val KLUIS_COMMIT "$VERSIE_ENV" | cut -c1-7))  naar: $tag ($short)"

  step "Eerst een back-up van de kluis-database"
  wait_db
  bash "$REPO/scripts/kluis-backup.sh" --voor-update

  step "Acceptatie-images van $short overnemen (er wordt niets gebouwd)"
  for s in api web excel-service; do
    docker tag "doelenboom-acc-$s:latest" "doelenboom-kluis-$s:$tag"
  done

  step "Migraties"
  DB_MIGRATE_PSQL="docker compose -p doelenboom-kluis -f $REPO/docker-compose.kluis.yml --env-file $KLUIS_ENV exec -T db psql -U doelenboom -d doelenboom" \
    bash scripts/db-migrate.sh

  step "Starten op $tag"
  umask 077
  { echo "# DOEL-133: versie van de kluis (geschreven door scripts/kluis.sh --bijwerken)."
    echo "KLUIS_VERSIE=$tag"
    echo "KLUIS_COMMIT=$sha"
    echo "KLUIS_BUILD_VERSION=\"$build_version\""
    echo "KLUIS_BIJGEWERKT_OP=$(date '+%Y-%m-%dT%H:%M:%S%z')"
  } > "$VERSIE_ENV.tmp"
  mv "$VERSIE_ENV.tmp" "$VERSIE_ENV"
  compose up -d
  wait_health
  local running
  running="$(curl -fsS "$KLUIS_URL/api/version")"
  [[ "$running" == *"$short"* ]] || die "De kluis draait niet op $short ($running)."
  [[ "$running" == *'"omgeving":"kluis"'* ]] || die "$KLUIS_URL meldt zich niet als kluis ($running)."
  echo "Kluis bijgewerkt naar $tag ($short): $running"
}

cmd_start() {
  need_init; need_versie; need_docker
  step "Kluis starten ($(val KLUIS_VERSIE "$VERSIE_ENV"), er wordt niets gebouwd)"
  compose up -d
  wait_health
  echo "De kluis draait op http://localhost:8089"
}

cmd_stop() {
  need_init; need_docker
  step "Kluis stoppen (de database blijft bewaard)"
  compose stop
}

cmd_status() {
  need_init
  local versie newest backup_dir status
  versie="$(val KLUIS_VERSIE "$VERSIE_ENV")"; newest="$(newest_tag)"
  echo "Kluis-versie:    ${versie:-nog geen}"
  echo "Productieversie: ${newest:-onbekend} (nieuwste tag)"
  if [ -n "$newest" ] && [ "$versie" != "$newest" ]; then
    echo "LET OP: de kluis loopt niet gelijk met productie. Bijwerken:  bash scripts/kluis.sh --bijwerken $newest"
  fi
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 && [ -n "$(compose ps --status running -q web 2>/dev/null)" ]; then
    echo "Draait:          ja, http://localhost:8089"
  else
    echo "Draait:          nee"
  fi
  backup_dir="$(val KLUIS_BACKUP_DIR "$KLUIS_ENV")"
  status="$backup_dir/status.txt"
  bash "$REPO/scripts/kluis-backup.sh" --controle || true
  [ -f "$status" ] && echo "Back-upstatus:   $status"
}

HERSTEL_CONTAINER="doelenboom-kluis-hersteltest"   # globaal: de EXIT-trap draait buiten de functie
cmd_herstel_test() {
  need_init; need_docker
  local backup_dir dump name="$HERSTEL_CONTAINER" pw i n_boom n_el
  backup_dir="$(val KLUIS_BACKUP_DIR "$KLUIS_ENV")"
  dump="$(ls -t "$backup_dir"/database/doelenboom-kluis-*.sql.gz 2>/dev/null | head -n 1 || true)"
  [ -n "$dump" ] || die "Geen databaseback-up gevonden in $backup_dir/database."
  step "Hersteltest met $(basename "$dump")"
  gzip -t "$dump" || die "$dump is beschadigd (gzip -t faalt)."
  if [ -f "$dump.sha256" ]; then
    [ "$(shasum -a 256 "$dump" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$dump.sha256")" ] || die "Controlesom van $dump klopt niet."
  fi
  pw="$(rand 24)"
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Wegwerpcontainer zonder poort en zonder volume: na de test is alles weg.
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_USER=doelenboom -e POSTGRES_DB=doelenboom postgres:18-alpine >/dev/null
  trap 'docker rm -f "$HERSTEL_CONTAINER" >/dev/null 2>&1 || true' EXIT
  for i in $(seq 1 "$HEALTH_TRIES"); do
    docker exec "$name" pg_isready -U doelenboom >/dev/null 2>&1 && break
    [ "$i" -lt "$HEALTH_TRIES" ] || die "wegwerpdatabase kwam niet op."
    sleep 2
  done
  gunzip -c "$dump" | docker exec -i "$name" psql -U doelenboom -d doelenboom -X -q -v ON_ERROR_STOP=1 >/dev/null
  n_boom="$(docker exec "$name" psql -U doelenboom -d doelenboom -X -At -c 'select count(*) from doelenbomen' < /dev/null)"
  n_el="$(docker exec "$name" psql -U doelenboom -d doelenboom -X -At -c 'select count(*) from elements' < /dev/null)"
  [[ "$n_boom" =~ ^[0-9]+$ ]] && [[ "$n_el" =~ ^[0-9]+$ ]] || die "onverwachte telling na terugzetten."
  echo "Teruggezet: $n_boom doelenbomen, $n_el elementen."
  bash "$REPO/scripts/kluis-backup.sh" --noteer-hersteltest "$n_boom" "$n_el"
  echo "Hersteltest GESLAAGD."
}

[ $# -ge 1 ] || { usage >&2; exit 1; }
case "$1" in
  --init) [ $# -eq 1 ] || die "--init kent geen extra argumenten."; cmd_init ;;
  --bijwerken) [ $# -le 2 ] || die "--bijwerken kent hooguit één versie."; cmd_bijwerken "${2:-}" ;;
  --start) cmd_start ;;
  --stop) cmd_stop ;;
  --status) cmd_status ;;
  --herstel-test) cmd_herstel_test ;;
  -h|--help) usage ;;
  *) usage >&2; die "Onbekende optie: $1" ;;
esac
