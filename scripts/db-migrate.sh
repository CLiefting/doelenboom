#!/usr/bin/env bash
# db-migrate.sh — past databasemigraties (db/migrations/*.sql) toe en houdt
# bij welke al gedraaid zijn, in de tabel schema_migrations (DOEL-99).
#
# Waarom: tot DOEL-99 draaide `doelenboom -local -rebuild` élke keer alle
# migraties opnieuw. Dat brak zodra een oude migratie een check-constraint
# opnieuw vastlegde die niet meer past bij nieuwere data (0033 en de
# audit_log-event-types). Nu draait elke migratie precies één keer per
# database.
#
# Gebruik (vanuit de repo-map, of met DOELENBOOM_DIR):
#   scripts/db-migrate.sh                  # nieuwe migraties toepassen (lokaal)
#   scripts/db-migrate.sh --status         # toon wat gedraaid is en wat nog openstaat
#   scripts/db-migrate.sh --dry-run        # toon alleen wat er zou draaien
#   scripts/db-migrate.sh --baseline 0050  # EENMALIG per bestaande database:
#                                          # registreer 0001 t/m 0050 als al gedraaid,
#                                          # zonder ze uit te voeren
#   scripts/db-migrate.sh --prod ...       # idem op de VPS (docker-compose.prod.yml erbij)
#
# Een gloednieuwe database (opgebouwd uit db/init.sql) heeft de boekhouding
# al: init.sql registreert alle migraties die erin gespiegeld zijn.
#
# Omgevingsvariabelen:
#   DOELENBOOM_DIR     repo-map (standaard: de huidige map)
#   POSTGRES_USER/DB   zelfde fallback als docker-compose.yml ("doelenboom")
#   DB_MIGRATE_PSQL    vervangt het psql-commando volledig (voor tests), bv.
#                      "psql postgres://user:pw@localhost:5432/db"
#   DB_MIGRATIONS_DIR  andere map met migraties (voor tests)
set -euo pipefail
export LC_COLLATE=C

REPO_DIR="${DOELENBOOM_DIR:-$PWD}"
MIGRATIONS_DIR="${DB_MIGRATIONS_DIR:-$REPO_DIR/db/migrations}"
DB_USER="${POSTGRES_USER:-doelenboom}"
DB_NAME="${POSTGRES_DB:-doelenboom}"
# Alleen deze vorm wordt geaccepteerd; de naam gaat als letterlijke tekst de
# SQL in (OWASP A03), dus nooit iets met quotes, spaties of padtekens.
NAME_RE='^[0-9]{4}_[a-z0-9_]+\.sql$'

MODE="apply"
BASELINE=""
PROD=""

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "FOUT: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE="status" ;;
    --dry-run) MODE="dry-run" ;;
    --baseline)
      MODE="baseline"
      shift
      [ $# -gt 0 ] || die "--baseline verwacht een migratienummer, bv. --baseline 0050"
      BASELINE="$1"
      ;;
    --prod) PROD="1" ;;
    -h|--help) usage; exit 0 ;;
    *) die "onbekende optie: $1 (zie --help)" ;;
  esac
  shift
done

[ -d "$MIGRATIONS_DIR" ] || die "map met migraties niet gevonden: $MIGRATIONS_DIR (draai dit vanuit de repo-map of zet DOELENBOOM_DIR)"

# --- psql-commando ---------------------------------------------------------
if [ -n "${DB_MIGRATE_PSQL:-}" ]; then
  read -r -a PSQL <<< "$DB_MIGRATE_PSQL"
else
  [ -f "$REPO_DIR/docker-compose.yml" ] || die "geen docker-compose.yml in $REPO_DIR (draai dit vanuit de repo-map of zet DOELENBOOM_DIR)"
  COMPOSE=(docker compose -f "$REPO_DIR/docker-compose.yml")
  if [ -n "$PROD" ]; then
    [ -f "$REPO_DIR/docker-compose.prod.yml" ] || die "geen docker-compose.prod.yml in $REPO_DIR"
    COMPOSE+=(-f "$REPO_DIR/docker-compose.prod.yml")
  fi
  PSQL=("${COMPOSE[@]}" exec -T db psql -U "$DB_USER" -d "$DB_NAME")
fi
# -X: geen ~/.psqlrc; ON_ERROR_STOP: stop bij de eerste fout.
PSQL+=(-X -q -v ON_ERROR_STOP=1)

sql() { "${PSQL[@]}" -At -c "$1"; }

# --- migratiebestanden ----------------------------------------------------
FILES=()
shopt -s nullglob
for path in "$MIGRATIONS_DIR"/*.sql; do   # glob is gesorteerd (LC_COLLATE=C hierboven)
  f="${path##*/}"
  [[ "$f" =~ $NAME_RE ]] || die "ongeldige bestandsnaam in $MIGRATIONS_DIR: '$f' (verwacht NNNN_naam.sql, alleen a-z, 0-9 en _). Er is niets uitgevoerd."
  FILES+=("$f")
done
shopt -u nullglob
[ "${#FILES[@]}" -gt 0 ] || die "geen migraties gevonden in $MIGRATIONS_DIR"

TABLE_DDL="create table if not exists schema_migrations (
  filename   text primary key check (filename ~ '^[0-9]{4}_[a-z0-9_]+\\.sql\$'),
  applied_at timestamptz not null default now(),
  method     text not null default 'run' check (method in ('run', 'baseline', 'init'))
);"

HAS_TABLE="$(sql "select to_regclass('public.schema_migrations') is not null")" \
  || die "kan de database niet bereiken (draait de db-container?)"

# --- baseline -------------------------------------------------------------
if [ "$MODE" = "baseline" ]; then
  [[ "$BASELINE" =~ ^[0-9]{4}$ ]] || die "--baseline verwacht een nummer van 4 cijfers, bv. 0050"
  MATCH=""
  for f in "${FILES[@]}"; do [ "${f:0:4}" = "$BASELINE" ] && MATCH="$f"; done
  [ -n "$MATCH" ] || die "er is geen migratie $BASELINE in $MIGRATIONS_DIR"
  if [ "$HAS_TABLE" = "t" ]; then
    COUNT="$(sql "select count(*) from schema_migrations")"
    [ "$COUNT" = "0" ] || die "deze database heeft al een migratieboekhouding ($COUNT regels); een baseline is niet nodig. Zie --status."
  fi
  VALUES=""
  N=0
  for f in "${FILES[@]}"; do
    [ "${f:0:4}" \> "$BASELINE" ] && break
    VALUES+="${VALUES:+,}('$f','baseline')"
    N=$((N + 1))
  done
  "${PSQL[@]}" <<SQL
set client_min_messages = warning;
begin;
$TABLE_DDL
insert into schema_migrations (filename, method) values $VALUES on conflict do nothing;
commit;
SQL
  echo "Baseline vastgelegd: $N migratie(s) t/m $MATCH geregistreerd als al gedraaid (niet uitgevoerd)."
  echo "Draai nu zonder --baseline om de nieuwere migraties toe te passen."
  exit 0
fi

if [ "$HAS_TABLE" != "t" ]; then
  cat >&2 <<EOF
FOUT: deze database heeft nog geen migratieboekhouding (tabel schema_migrations ontbreekt).
Er is niets uitgevoerd.

Dit is eenmalig per bestaande database. Stel vast welke migratie hier als
laatste is gedraaid en registreer t/m die migratie, bijvoorbeeld:

  scripts/db-migrate.sh ${PROD:+--prod }--baseline 0050

Twijfel je? Controleer dan de wijziging uit de laatste migratie (de toelichting
bovenaan elk bestand), bv. voor 0050: bestaat kolom app_settings.idle_timeout_minutes?
EOF
  exit 2
fi

# LET OP (macOS): /bin/bash is daar versie 3.2. Die meldt bij `set -u` een
# leeg array als "unbound variable"; PENDING kan leeg zijn, dus altijd als
# ${PENDING[@]+"${PENDING[@]}"} uitpakken (bewaakt door api/test/dbMigrate.test.ts).
APPLIED="$(sql "select filename from schema_migrations order by filename")"
is_applied() { grep -qxF "$1" <<< "$APPLIED"; }

PENDING=()
for f in "${FILES[@]}"; do is_applied "$f" || PENDING+=("$f"); done

if [ "$MODE" = "status" ]; then
  echo "Migraties in $MIGRATIONS_DIR: ${#FILES[@]}; geregistreerd: $(grep -c . <<< "$APPLIED" || true); openstaand: ${#PENDING[@]}"
  sql "select filename || '  (' || method || ', ' || to_char(applied_at, 'YYYY-MM-DD HH24:MI') || ')' from schema_migrations order by filename desc limit 5" | sed 's/^/  laatst: /'
  for f in ${PENDING[@]+"${PENDING[@]}"}; do echo "  open:   $f"; done
  # Geregistreerd maar het bestand bestaat (hier) niet: meestal een oudere checkout.
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    printf '%s\n' "${FILES[@]}" | grep -qxF "$a" || echo "  let op: $a staat geregistreerd, maar het bestand ontbreekt in deze checkout"
  done <<< "$APPLIED"
  exit 0
fi

if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "Database is bij: geen nieuwe migraties."
  exit 0
fi

if [ "$MODE" = "dry-run" ]; then
  echo "Zou ${#PENDING[@]} migratie(s) toepassen:"
  for f in ${PENDING[@]+"${PENDING[@]}"}; do echo "  - $f"; done
  exit 0
fi

echo "==> ${#PENDING[@]} nieuwe migratie(s) toepassen"
for f in ${PENDING[@]+"${PENDING[@]}"}; do
  echo "  - $f"
  # Bestand en registratie in één psql-sessie: door ON_ERROR_STOP wordt de
  # registratie alleen uitgevoerd als het hele bestand geslaagd is.
  { echo "set client_min_messages = warning;"; cat "$MIGRATIONS_DIR/$f"; printf "\ninsert into schema_migrations (filename, method) values ('%s', 'run');\n" "$f"; } \
    | "${PSQL[@]}" \
    || die "migratie $f is mislukt; die en eventuele latere migraties zijn NIET geregistreerd. Los de fout op en draai dit opnieuw."
done
echo "Klaar: ${#PENDING[@]} migratie(s) toegepast."
