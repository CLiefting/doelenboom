#!/usr/bin/env bash
# Kopieert één doelenboom van de LOKALE omgeving naar de VPS (DOEL-104).
#
#   scripts/doelenboom-kopieer.sh --tenant <lokaal> --boom <lokaal> [opties]
#   scripts/doelenboom-kopieer.sh --help
#
# Het script stopt bij de eerste fout. Op de VPS gebeurt de import in één
# transactie: lukt er iets niet, dan is daar niets veranderd.
set -euo pipefail

usage() {
  cat <<'HELP'
doelenboom-kopieer.sh — kopieert één doelenboom van lokaal naar de VPS.

GEBRUIK
  scripts/doelenboom-kopieer.sh --tenant <tenant> --boom <doelenboom> [opties]

VERPLICHT
  --tenant <naam|slug>        Tenant op de LOKALE omgeving.
  --boom <naam|slug>          Doelenboom binnen die tenant, lokaal.

DOEL OP DE VPS (optioneel; standaard dezelfde namen als lokaal)
  --naar-tenant <naam|slug>   Tenant op de VPS. Bestaat hij niet, dan wordt hij
                              aangemaakt met deze naam, met dezelfde modules als
                              de lokale tenant.
  --naar-boom <naam|slug>     Doelenboom op de VPS. Bestaat hij niet, dan wordt
                              hij aangemaakt met deze naam.
  --naar-tenant-slug <slug>   Slug voor een NIEUWE tenant (standaard afgeleid van
                              de naam: "OVpay @ NS" wordt "ovpay-ns").
  --naar-boom-slug <slug>     Slug voor een NIEUWE doelenboom (idem).

GEDRAG
  --overschrijven             De doelenboom bestaat al op de VPS: vervang de
                              inhoud. Zonder deze optie wordt dat geweigerd.
                              Er wordt eerst een databaseback-up gemaakt.
  --dry-run                   Alleen de proefrun: laat zien wat er zou gebeuren
                              en wijzigt niets op de VPS.
  --admin <e-mail>            Account dat admin wordt van de tenant op de VPS.
                              Standaard: $DOELENBOOM_ADMIN_EMAIL. Het account
                              moet op de VPS al bestaan. Is het al lid van de
                              tenant, dan blijft de bestaande rol staan.
  -h, --help                  Deze uitleg.

OMGEVINGSVARIABELEN
  VPS=gebruiker@host          Adres van de VPS (verplicht; zelfde als release.sh).
  DOELENBOOM_ADMIN_EMAIL      Standaardwaarde voor --admin.
  Beide staan bewust niet in de publieke repository; zet ze in je shell-profiel.

WAT ER GEBEURT
  1. Lokaal exporteren naar een tijdelijke bundel (lokaal wordt niets gewijzigd).
  2. Bundel naar de VPS kopiëren.
  3. Proefrun op de VPS: de import wordt volledig uitgevoerd en teruggedraaid.
     Je ziet wat er wordt aangemaakt, vervangen en hoeveel rijen er komen.
  4. Na 'ja': (bij --overschrijven eerst een back-up) de echte import.
  5. Aantallen en controlesom van bron en doel worden vergeleken; de bundel
     wordt aan beide kanten verwijderd.

WAT ER MEEGAAT
  Wel:  kolommen, controleregels en kenmerken van de boom, elementen, relaties,
        tags, organisatieonderdelen en hun koppelingen, projectstatus,
        afwijkingen, kenmerkwaarden, producten, activiteiten, afhankelijkheden.
  Niet: gebruikers en rollen, importhistorie, projecthistorie, auditlog.
        "Bijgewerkt door" wordt leeg: de lokale accounts bestaan op de VPS niet.

VOORBEELDEN
  # Zelfde namen op de VPS:
  scripts/doelenboom-kopieer.sh --tenant Demo --boom "Gezond ouder"

  # Lokaal tenant "OVpay" / boom "OVpay @ NS"  ->  VPS tenant "NS" / boom "OVpay":
  scripts/doelenboom-kopieer.sh --tenant OVpay --boom "OVpay @ NS" \
      --naar-tenant NS --naar-boom OVpay

  # Eerst alleen kijken, daarna een bestaande boom vervangen:
  scripts/doelenboom-kopieer.sh --tenant OVpay --boom "OVpay @ NS" --naar-tenant NS --naar-boom OVpay --dry-run
  scripts/doelenboom-kopieer.sh --tenant OVpay --boom "OVpay @ NS" --naar-tenant NS --naar-boom OVpay --overschrijven

VOORWAARDEN
  Lokaal en de VPS draaien dezelfde versie (zelfde databasemigraties), en de
  lokale stack draait (doelenboom -local -restart).
HELP
}

die() { echo "FOUT: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

TENANT=""; BOOM=""; TO_TENANT=""; TO_BOOM=""; TO_TENANT_SLUG=""; TO_BOOM_SLUG=""
OVERWRITE="nee"; DRY_RUN="nee"; ADMIN="${DOELENBOOM_ADMIN_EMAIL:-}"
VPS="${VPS:-}"

[ $# -gt 0 ] || { usage; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    -h|-help|--help) usage; exit 0 ;;
    --overschrijven) OVERWRITE="ja"; shift ;;
    --dry-run) DRY_RUN="ja"; shift ;;
    --tenant|--boom|--naar-tenant|--naar-boom|--naar-tenant-slug|--naar-boom-slug|--admin)
      [ $# -ge 2 ] || die "Optie $1 mist een waarde (zie --help)."
      case "$2" in --*) die "Optie $1 mist een waarde (zie --help)." ;; esac
      case "$1" in
        --tenant) TENANT="$2" ;;
        --boom) BOOM="$2" ;;
        --naar-tenant) TO_TENANT="$2" ;;
        --naar-boom) TO_BOOM="$2" ;;
        --naar-tenant-slug) TO_TENANT_SLUG="$2" ;;
        --naar-boom-slug) TO_BOOM_SLUG="$2" ;;
        --admin) ADMIN="$2" ;;
      esac
      shift 2 ;;
    *) die "Onbekende optie: $1 (zie --help)." ;;
  esac
done

[ -n "$TENANT" ] || die "--tenant ontbreekt (zie --help)."
[ -n "$BOOM" ] || die "--boom ontbreekt (zie --help)."
TO_TENANT="${TO_TENANT:-$TENANT}"
TO_BOOM="${TO_BOOM:-$BOOM}"
SLUG_RE='^[a-z0-9]+(-[a-z0-9]+)*$'
for s in "$TO_TENANT_SLUG" "$TO_BOOM_SLUG"; do
  [ -z "$s" ] || [[ "$s" =~ $SLUG_RE ]] || die "Een slug mag alleen kleine letters, cijfers en streepjes bevatten: $s"
done
# Geen regeleinden of andere stuurtekens in waarden die naar de VPS gaan.
for v in "$TENANT" "$BOOM" "$TO_TENANT" "$TO_BOOM" "$ADMIN"; do
  case "$v" in *[[:cntrl:]]*) die "Een opgegeven waarde bevat een stuurteken (regeleinde of tab)." ;; esac
done
[ -n "$ADMIN" ] || die "Geen admin-account: geef --admin <e-mail> of zet DOELENBOOM_ADMIN_EMAIL (zie --help)."
[[ "$ADMIN" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "--admin is geen e-mailadres: $ADMIN"
[ -n "$VPS" ] || die "Zet eerst VPS=gebruiker@host (bv. export VPS=... in je shell-profiel); het adres staat bewust niet in de publieke repo."

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/docker-compose.yml" ] || die "Geen doelenboom-repo gevonden op $REPO"
cd "$REPO"

IMPORT_ARGS=(--naar-tenant "$TO_TENANT" --naar-boom "$TO_BOOM" --admin "$ADMIN")
[ -z "$TO_TENANT_SLUG" ] || IMPORT_ARGS+=(--naar-tenant-slug "$TO_TENANT_SLUG")
[ -z "$TO_BOOM_SLUG" ] || IMPORT_ARGS+=(--naar-boom-slug "$TO_BOOM_SLUG")
[ "$OVERWRITE" != "ja" ] || IMPORT_ARGS+=(--overschrijven)

umask 077
WORK="$(mktemp -d)"
BUNDLE="$WORK/bundel.json"
REMOTE_NAME="doelenboom-kopie-$(date +%Y%m%d%H%M%S)-$$.json"
UPLOADED="nee"

# Draait het deel hieronder op de VPS. $1 = proef | echt | opruimen.
# DOEL-108: het script gaat via de standaardinvoer naar bash op de VPS; alles
# staat daarom in main(), main draait met afgesloten standaardinvoer, en de
# laatste regel (REMOTE-KLAAR) wordt hier gecontroleerd. De waarden gaan als
# argumenten mee, met %q gequote: ssh plakt argumenten aan elkaar tot één
# commandoregel, dus zonder quoting zou "OVpay @ NS" in drie stukken vallen.
remote() {
  local mode="$1" log="$WORK/remote-$1.log" quoted
  quoted="$(printf '%q ' "$mode" "$REMOTE_NAME" "$OVERWRITE" "${IMPORT_ARGS[@]}")"
  ssh "$VPS" "bash -s -- $quoted" <<'REMOTE' | tee "$log"
set -euo pipefail
main() {
  MODE="$1"; NAME="$2"; BACKUP="$3"; shift 3
  # Alleen het eigen bundelbestand in de thuismap, nooit een opgegeven pad.
  case "$NAME" in
    */*|.*) echo "PROBLEEM: ongeldige bundelnaam."; exit 1 ;;
    doelenboom-kopie-*.json) ;;
    *) echo "PROBLEEM: ongeldige bundelnaam."; exit 1 ;;
  esac
  BUNDLE="$HOME/$NAME"
  if [ "$MODE" = "opruimen" ]; then
    rm -f "$BUNDLE"
    echo "REMOTE-KLAAR $MODE"
    return 0
  fi
  cd ~/doelenboom
  dbprod() { docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
  [ -f "$BUNDLE" ] || { echo "PROBLEEM: bundel $NAME staat niet op de VPS."; exit 1; }
  chmod 600 "$BUNDLE"
  if ! dbprod exec -T api test -f dist/scripts/doelenboomImport.js; then
    echo "PROBLEEM: de versie op de VPS kent het importcommando nog niet. Rol eerst een release uit die DOEL-104 bevat."
    exit 1
  fi
  case "$MODE" in
    proef)
      dbprod exec -T api node dist/scripts/doelenboomImport.js "$@" --dry-run < "$BUNDLE"
      ;;
    echt)
      # De bundel gaat hoe dan ook weg, ook als de import faalt.
      trap 'rm -f "$BUNDLE"' EXIT
      if [ "$BACKUP" = "ja" ]; then
        # Overschrijven verwijdert inhoud: eerst een volledige databaseback-up.
        ./deploy/backup-database.sh
      fi
      dbprod exec -T api node dist/scripts/doelenboomImport.js "$@" < "$BUNDLE"
      ;;
    *) echo "PROBLEEM: onbekende stap $MODE."; exit 1 ;;
  esac
  # Laatste regel: het lokale script controleert hierop dat dit deel helemaal is uitgevoerd.
  echo "REMOTE-KLAAR $MODE"
}
main "$@" < /dev/null
REMOTE
  grep -qx "REMOTE-KLAAR $mode" "$log" || return 1
}

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$UPLOADED" = "ja" ]; then
    remote opruimen >/dev/null 2>&1 || echo "LET OP: de bundel ~/$REMOTE_NAME op de VPS kon niet worden verwijderd; doe dat met de hand." >&2
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

# Haalt één meldingsregel (TELLING ... of SHA256 ...) uit een logbestand.
field() { grep -o "$1 .*" "$2" | tail -n 1 || true; }

step "1/5 Controles vooraf"
command -v docker >/dev/null || die "docker ontbreekt"
docker info >/dev/null 2>&1 || die "Docker draait niet"
docker compose exec -T api true < /dev/null 2>/dev/null || die "De lokale stack draait niet. Start hem met: doelenboom -local -restart"
echo "Van (lokaal): tenant \"$TENANT\", doelenboom \"$BOOM\""
echo "Naar ($VPS): tenant \"$TO_TENANT\", doelenboom \"$TO_BOOM\"; admin $ADMIN; overschrijven: $OVERWRITE"

step "2/5 Lokaal exporteren"
# De lokale image is de ontwikkelversie (tsx, geen dist); een productie-image
# heeft dist. Bestaat geen van beide, dan is de lokale image te oud.
EXPORT_RC=0
docker compose exec -T api sh -c '
  if [ -f dist/scripts/doelenboomExport.js ]; then exec node dist/scripts/doelenboomExport.js "$@"
  elif [ -f src/scripts/doelenboomExport.ts ]; then exec npx tsx src/scripts/doelenboomExport.ts "$@"
  else echo "[doelenboom-export] FOUT: de lokale image kent het exportcommando nog niet. Herbouw met: doelenboom -local -restart" >&2; exit 3
  fi' sh --tenant "$TENANT" --boom "$BOOM" < /dev/null > "$BUNDLE" 2> "$WORK/export.log" || EXPORT_RC=$?
cat "$WORK/export.log" >&2
[ "$EXPORT_RC" -eq 0 ] || die "exporteren is mislukt (zie de melding hierboven)."
[ "$(head -c 11 "$BUNDLE")" = '{"sha256":"' ] || die "de export leverde geen bundel op."
SRC_COUNTS="$(field TELLING "$WORK/export.log")"
SRC_SHA="$(field SHA256 "$WORK/export.log")"
[ -n "$SRC_COUNTS" ] && [ -n "$SRC_SHA" ] || die "de export meldde geen aantallen of controlesom."
echo "Bundel: $(wc -c < "$BUNDLE" | tr -d ' ') bytes"

step "3/5 Bundel naar de VPS en proefrun"
UPLOADED="ja"
scp -q "$BUNDLE" "$VPS":"$REMOTE_NAME"
remote proef || die "de proefrun op de VPS is mislukt (zie hierboven). Er is op de VPS niets gewijzigd."
grep -q 'PROEFRUN-OK' "$WORK/remote-proef.log" || die "de proefrun meldde geen PROEFRUN-OK. Er is op de VPS niets gewijzigd."
[ "$(field TELLING "$WORK/remote-proef.log")" = "$SRC_COUNTS" ] || die "de aantallen van de proefrun wijken af van de export. Er is op de VPS niets gewijzigd."
[ "$(field SHA256 "$WORK/remote-proef.log")" = "$SRC_SHA" ] || die "de controlesom op de VPS wijkt af van de export. Er is op de VPS niets gewijzigd."

if [ "$DRY_RUN" = "ja" ]; then
  echo
  echo "Proefrun geslaagd (--dry-run): er is op de VPS niets gewijzigd."
  exit 0
fi

step "4/5 Importeren op $VPS"
[ "$OVERWRITE" != "ja" ] || echo "Er wordt eerst een databaseback-up gemaakt (deploy/backup-database.sh)."
# DOELENBOOM_KOPIEER_TTY is er alleen voor de tests (api/test/doelenboomKopieer.test.ts).
read -r -p "Bovenstaande nu echt uitvoeren op de VPS? Typ 'ja' om door te gaan: " ANS < "${DOELENBOOM_KOPIEER_TTY:-/dev/tty}"
[ "$ANS" = "ja" ] || die "Afgebroken; er is op de VPS niets gewijzigd."
remote echt || die "het importeren op de VPS is niet (helemaal) uitgevoerd. De import draait in één transactie: zonder IMPORT-OK hierboven is er niets gewijzigd."
UPLOADED="nee"   # het echte deel ruimt de bundel op de VPS zelf op
grep -q 'IMPORT-OK' "$WORK/remote-echt.log" || die "de VPS meldde geen IMPORT-OK."

step "5/5 Controle"
DST_COUNTS="$(field TELLING "$WORK/remote-echt.log")"
[ "$DST_COUNTS" = "$SRC_COUNTS" ] || die "de aantallen op de VPS wijken af van de export: bron '$SRC_COUNTS', doel '$DST_COUNTS'."
[ "$(field SHA256 "$WORK/remote-echt.log")" = "$SRC_SHA" ] || die "de controlesom op de VPS wijkt af van de export."
echo "Aantallen en controlesom van bron en doel komen overeen:"
echo "  ${SRC_COUNTS#TELLING }"
echo
echo "Gekopieerd. Controleer in de app op de VPS: tenant \"$TO_TENANT\", doelenboom \"$TO_BOOM\"."
