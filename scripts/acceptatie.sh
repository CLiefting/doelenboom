#!/usr/bin/env bash
# acceptatie.sh — de stand van main in de lokale ACCEPTATIEOMGEVING zetten en
# keuren (DOEL-127). scripts/release.sh weigert een release zonder
# goedgekeurd bewijs voor precies die commit.
#
# Besluit Charles 25-10-2026: na de merge eerst lokaal accepteren, op dezelfde
# productie-images als de VPS (docker-compose.acc.yml), met een eigen database
# met testdata, en alleen met actuele, kwetsbaarheidsvrije libraries.
#
# Gebruik (op je Mac, op een bijgewerkte, schone main):
#   bash scripts/acceptatie.sh
#   ACC_SYSADMIN_EMAIL=jij@example.nl bash scripts/acceptatie.sh   # alleen bij de
#       allereerste start: de seed-sysadmin krijgt dit adres (MFA-mails komen daar)
#
# Wat het doet:
#   1. controles: Docker draait, op main, werkmap schoon, gelijk aan origin/main;
#   2. geheimen: .acceptatie/acc.env (willekeurig, chmod 600) bij de eerste keer;
#   3. images bouwen (Dockerfile.prod, eigen tags doelenboom-acc-*);
#   4. database starten; standaardwachtwoord van de seed-sysadmin vervangen
#      (de API weigert anders te starten in productiemodus, DOEL-23); migraties;
#   5. alles starten, health-check en versiecontrole (moet deze commit zijn);
#   6. wachten op de componentencontrole van DEZE build (draait automatisch
#      kort na het opstarten) en de kwetsbaarheden tellen;
#   7. bewijs schrijven: .acceptatie/bewijs-<commit>.txt met GOEDGEKEURD of
#      AFGEKEURD. Afgekeurd bij kritieke, hoge of "ernst onbekend"-
#      kwetsbaarheden in componenten die in productie draaien (zelfde regel
#      als de kwetsbaarhedenmail, DOEL-70).
# Daarna blijft de omgeving draaien op http://localhost:8088 om handmatig te
# testen. Stoppen: docker compose -p doelenboom-acc -f docker-compose.acc.yml stop
#
# Werkt met de bash 3.2 van macOS. Voor tests instelbaar: ACC_URL,
# ACC_POLL_SECONDS (10), ACC_MAX_POLLS (120 = 20 min), ACC_HEALTH_TRIES (60).
set -euo pipefail

die() { echo "FOUT: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ $# -eq 0 ] || die "acceptatie.sh kent geen argumenten."

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/docker-compose.acc.yml" ] || die "Geen docker-compose.acc.yml gevonden in $REPO"
cd "$REPO"
export DOELENBOOM_DIR="$REPO"

ACC_DIR="$REPO/.acceptatie"
ACC_ENV="$ACC_DIR/acc.env"
ACC_URL="${ACC_URL:-http://127.0.0.1:8088}"
POLL="${ACC_POLL_SECONDS:-10}"
MAX_POLLS="${ACC_MAX_POLLS:-120}"
HEALTH_TRIES="${ACC_HEALTH_TRIES:-60}"

compose() {
  local args=(docker compose -p doelenboom-acc -f docker-compose.acc.yml)
  # Eerst je gewone .env (SMTP), daarna acc.env (die wint bij dubbele namen).
  [ -f "$REPO/.env" ] && args+=(--env-file "$REPO/.env")
  args+=(--env-file "$ACC_ENV")
  "${args[@]}" "$@"
}
acc_sql() { compose exec -T db psql -U doelenboom -d doelenboom -X -q -At -v ON_ERROR_STOP=1 -c "$1" < /dev/null; }
# rand <lengte>: willekeurige letters/cijfers. Ruim genoeg bytes, want na het
# weghalen van '+', '/' en '=' blijft er minder over; de lengte wordt gecontroleerd.
rand() {
  local v
  v="$(openssl rand -base64 $(( $1 * 2 )) | tr -dc 'A-Za-z0-9' | cut -c1-"$1")"
  [ "${#v}" -eq "$1" ] || die "kon geen willekeurige waarde van $1 tekens maken."
  printf '%s' "$v"
}

step "1/7 Controles vooraf"
command -v docker >/dev/null  || die "docker ontbreekt"
docker info >/dev/null 2>&1   || die "Docker draait niet (start Docker Desktop: open -a Docker)"
command -v openssl >/dev/null || die "openssl ontbreekt"
command -v curl >/dev/null    || die "curl ontbreekt"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "Je staat niet op main. Acceptatie gaat altijd over de stand van main (die wordt gereleased)."
[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "Werkmap is niet schoon; commit of stash eerst."; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is niet gelijk aan origin/main; eerst:  git pull --ff-only"
SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
export BUILD_VERSION; BUILD_VERSION="$(./scripts/build-version.sh)"
case "$BUILD_VERSION" in *dirty*) die "BUILD_VERSION is 'dirty'." ;; esac
echo "Acceptatie van commit $SHORT, bouwversie $BUILD_VERSION"

step "2/7 Geheimen van de acceptatieomgeving"
mkdir -p "$ACC_DIR"; chmod 700 "$ACC_DIR"
if [ ! -f "$ACC_ENV" ]; then
  umask 077
  { echo "# DOEL-127: geheimen van de lokale acceptatieomgeving (niet in git)."
    echo "ACC_POSTGRES_PASSWORD=$(rand 32)"
    echo "ACC_JWT_SECRET=$(rand 64)"
  } > "$ACC_ENV"
  echo "Nieuw: $ACC_ENV (willekeurige database- en JWT-geheimen)."
else
  echo "Bestaand: $ACC_ENV"
fi
chmod 600 "$ACC_ENV"
grep -q '^ACC_POSTGRES_PASSWORD=.\{16,\}' "$ACC_ENV" && grep -q '^ACC_JWT_SECRET=.\{32,\}' "$ACC_ENV" \
  || die "$ACC_ENV mist ACC_POSTGRES_PASSWORD of ACC_JWT_SECRET (of ze zijn te kort)."
if grep -q '^SMTP_HOST=.' "$REPO/.env" 2>/dev/null; then
  echo "Mail: via SMTP uit .env, onderwerp begint met [ACCEPTATIE]."
else
  echo "Mail: geen SMTP_HOST in .env; MFA-codes staan dan in de API-log (docker logs doelenboom-acc-api-1)."
fi

step "3/7 Images bouwen (productie-Dockerfiles, tags doelenboom-acc-*)"
compose build --pull

step "4/7 Database en migraties"
compose up -d db
for i in $(seq 1 "$HEALTH_TRIES"); do
  acc_sql 'select 1' >/dev/null 2>&1 && break
  [ "$i" -lt "$HEALTH_TRIES" ] || die "database kwam niet op."
  sleep 2
done
# DOEL-23: de seed maakt admin@code072.nl met het documentatiewachtwoord; in
# productiemodus weigert de API dan te starten. Eenmalig vervangen door een
# willekeurig wachtwoord (alleen letters/cijfers, dus veilig in de SQL).
DEFAULTS="$(acc_sql "select count(*) from users where password_hash = crypt('changeme', password_hash)")"
if [ "$DEFAULTS" != "0" ]; then
  PW="$(rand 24)"
  [[ "$PW" =~ ^[A-Za-z0-9]{24}$ ]] || die "kon geen wachtwoord maken."
  if [ -n "${ACC_SYSADMIN_EMAIL:-}" ]; then
    [[ "$ACC_SYSADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "ACC_SYSADMIN_EMAIL is geen geldig e-mailadres."
    acc_sql "update users set email = '$ACC_SYSADMIN_EMAIL' where email = 'admin@code072.nl' and not exists (select 1 from users where email = '$ACC_SYSADMIN_EMAIL')" >/dev/null
  fi
  acc_sql "update users set password_hash = crypt('$PW', gen_salt('bf', 12)), must_change_password = false where password_hash = crypt('changeme', password_hash)" >/dev/null
  ADMIN="$(acc_sql "select email from users where is_sysadmin order by id limit 1")"
  umask 077
  printf 'Acceptatie-sysadmin: %s\nWachtwoord: %s\n' "$ADMIN" "$PW" > "$ACC_DIR/sysadmin.txt"
  chmod 600 "$ACC_DIR/sysadmin.txt"
  echo "Standaardwachtwoord vervangen; inloggegevens staan in $ACC_DIR/sysadmin.txt (alleen voor jou leesbaar)."
fi
DB_MIGRATE_PSQL="docker compose -p doelenboom-acc -f $REPO/docker-compose.acc.yml --env-file $ACC_ENV exec -T db psql -U doelenboom -d doelenboom" \
  bash scripts/db-migrate.sh

step "5/7 Starten en health-check"
T0="$(acc_sql "select now()")"
compose up -d
for i in $(seq 1 "$HEALTH_TRIES"); do
  curl -fsS "$ACC_URL/api/health" >/dev/null 2>&1 && break
  [ "$i" -lt "$HEALTH_TRIES" ] || die "acceptatie-API niet gezond op $ACC_URL (zie: docker logs doelenboom-acc-api-1)."
  sleep 2
done
VERSION="$(curl -fsS "$ACC_URL/api/version")"
echo "Draait: $VERSION"
[[ "$VERSION" == *"$SHORT"* ]] || die "acceptatie draait niet op commit $SHORT."

step "6/7 Componentencontrole van deze build afwachten"
STATE=""
for i in $(seq 1 "$MAX_POLLS"); do
  STATE="$(acc_sql "select coalesce((select git_commit from dependency_sbom_builds order by generated_at desc limit 1), '') || '|' || coalesce((select status from dependency_check_runs where started_at >= '$T0'::timestamptz order by started_at desc limit 1), '')")"
  COMMIT_IN_SBOM="${STATE%%|*}"; RUN_STATUS="${STATE#*|}"
  if [ -n "$COMMIT_IN_SBOM" ] && [[ "$SHA" == "$COMMIT_IN_SBOM"* ]]; then
    case "$RUN_STATUS" in
      success) break ;;
      partial|failed) die "componentencontrole is niet volledig gelukt ($RUN_STATUS); geen bewijs geschreven. Zie de pagina Softwarecomponenten op $ACC_URL/system-info en draai het script opnieuw." ;;
    esac
  fi
  [ "$i" -lt "$MAX_POLLS" ] || die "componentencontrole na $MAX_POLLS controles nog niet klaar (stand: ${STATE:-leeg}); geen bewijs geschreven."
  [ $((i % 6)) -eq 1 ] && echo "Controle loopt nog (${RUN_STATUS:-nog niet gestart})..."
  sleep "$POLL"
done
echo "Componentencontrole geslaagd."

BUILD_SQL="(select id from dependency_sbom_builds order by generated_at desc limit 1)"
LEVEL_SQL="upper(trim(coalesce(v.severity, '')))"
COUNTS="$(acc_sql "select
    count(*) filter (where $LEVEL_SQL = 'CRITICAL') || '|' ||
    count(*) filter (where $LEVEL_SQL = 'HIGH') || '|' ||
    count(*) filter (where $LEVEL_SQL not in ('CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW')) || '|' ||
    count(*) filter (where $LEVEL_SQL in ('MODERATE', 'MEDIUM')) || '|' ||
    count(*) filter (where $LEVEL_SQL = 'LOW')
  from dependency_vulnerabilities v join dependency_components c on c.id = v.component_id
  where c.build_id = $BUILD_SQL and c.scope = 'runtime'")"
IFS='|' read -r KRITIEK HOOG ONBEKEND GEMIDDELD LAAG <<< "$COUNTS"
for n in "$KRITIEK" "$HOOG" "$ONBEKEND" "$GEMIDDELD" "$LAAG"; do [[ "$n" =~ ^[0-9]+$ ]] || die "onverwachte telling: $COUNTS"; done
echo "Kwetsbaarheden in productiecomponenten: kritiek $KRITIEK, hoog $HOOG, ernst onbekend $ONBEKEND, gemiddeld $GEMIDDELD, laag $LAAG"

step "7/7 Bewijs vastleggen"
BLOCKING=$((KRITIEK + HOOG + ONBEKEND))
RESULT="GOEDGEKEURD"; [ "$BLOCKING" -eq 0 ] || RESULT="AFGEKEURD"
EVIDENCE="$ACC_DIR/bewijs-$SHA.txt"
umask 077
{ echo "commit=$SHA"
  echo "korte_commit=$SHORT"
  echo "build_version=$BUILD_VERSION"
  echo "gecontroleerd_op=$(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "gecontroleerd_epoch=$(date +%s)"
  echo "kritiek=$KRITIEK"; echo "hoog=$HOOG"; echo "onbekend=$ONBEKEND"
  echo "gemiddeld=$GEMIDDELD"; echo "laag=$LAAG"
  echo "resultaat=$RESULT"
} > "$EVIDENCE.tmp"
mv "$EVIDENCE.tmp" "$EVIDENCE"
echo "Bewijs: $EVIDENCE ($RESULT)"

if [ "$RESULT" != "GOEDGEKEURD" ]; then
  echo "Kwetsbare productiecomponenten:" >&2
  acc_sql "select distinct c.application_component || ': ' || c.name || ' ' || c.version || '  (' || coalesce(nullif(v.severity, ''), 'ernst onbekend') || ', ' || v.vulnerability_id || coalesce(', opgelost in ' || v.fixed_version, '') || ')'
    from dependency_vulnerabilities v join dependency_components c on c.id = v.component_id
    where c.build_id = $BUILD_SQL and c.scope = 'runtime' and $LEVEL_SQL not in ('MODERATE', 'MEDIUM', 'LOW')
    order by 1" >&2 || true
  die "acceptatie AFGEKEURD: $BLOCKING kritieke/hoge/onbekende kwetsbaarheid(en). Werk de libraries bij en draai acceptatie opnieuw; release.sh weigert deze commit."
fi

echo
echo "Acceptatie GOEDGEKEURD voor $SHORT. De omgeving draait op http://localhost:8088"
[ -f "$ACC_DIR/sysadmin.txt" ] && echo "Inloggen: zie $ACC_DIR/sysadmin.txt"
echo "Test handmatig (inloggen, tree.html, een Excel-export) en release daarna met scripts/release.sh."
echo "Stoppen: docker compose -p doelenboom-acc -f docker-compose.acc.yml stop"
