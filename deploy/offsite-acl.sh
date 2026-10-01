# shellcheck shell=bash
# Gedeeld hulpje voor deploy/backup-database.sh en deploy/export-all-doelenbomen.sh
# (DOEL-53): geeft het offsite-pullaccount alleen-lezen-toegang tot back-ups via
# een POSIX-ACL, ook nadat een `chmod` het ACL-masker heeft leeggemaakt.
#
# CL-NAS002 haalt ~/doelenboom/backups 's nachts op via rsync-over-SSH als het
# beperkte account OFFSITE_PULL_USER (standaard "doelenboom-pull", rrsync,
# alleen-lezen) — zie deploy/README.md, "Offsite-kopie (CL-NAS002)". Bestaat dat
# account of `setfacl` niet (bv. een lokale ontwikkelomgeving), dan doet dit
# niets. Een ACL-fout laat de back-up zelf NOOIT mislukken: alleen een
# waarschuwing in de log (de cron-log, en daarna de NAS-melding).
#
# Gebruik (na `. deploy/offsite-acl.sh`):
#   grant_offsite_read <pad> [--private]
#   find ... -print0 | grant_offsite_read_stdin [--private]
# --private: daarnaast groep en "other" expliciet op --- (databasedumps:
# eigenaar + pullaccount, verder niemand), ook in de standaard-ACL van mappen.

OFFSITE_PULL_USER="${OFFSITE_PULL_USER:-doelenboom-pull}"

_offsite_acl_enabled() {
  command -v setfacl >/dev/null 2>&1 || return 1
  id "$OFFSITE_PULL_USER" >/dev/null 2>&1 || return 1
  return 0
}

_offsite_acl_one() {
  local path="$1" private="$2" spec
  # rX: lezen; uitvoeren (= map openen) alleen voor mappen. m::rX: het masker
  # weer openzetten, anders blijft de regel hierboven effectief ---.
  spec="u:${OFFSITE_PULL_USER}:rX,m::rX"
  [ "$private" = "--private" ] && spec="${spec},g::---,o::---"
  setfacl -m "$spec" "$path" || return 1
  if [ -d "$path" ]; then
    # Standaard-ACL: nieuwe bestanden/mappen in deze map erven hetzelfde.
    setfacl -d -m "u::rwx,u:${OFFSITE_PULL_USER}:rX,m::rX" "$path" || return 1
    if [ "$private" = "--private" ]; then
      setfacl -d -m "g::---,o::---" "$path" || return 1
    fi
  fi
}

grant_offsite_read() {
  local path="$1" private="${2:-}"
  _offsite_acl_enabled || return 0
  _offsite_acl_one "$path" "$private" \
    || echo "[$(date -Iseconds)] WAARSCHUWING: kon offsite-leesrecht (ACL) niet zetten op ${path}" >&2
  return 0
}

grant_offsite_read_stdin() {
  local private="${1:-}" path failed=0
  if ! _offsite_acl_enabled; then cat >/dev/null; return 0; fi
  while IFS= read -r -d '' path; do
    _offsite_acl_one "$path" "$private" || failed=$((failed + 1))
  done
  if [ "$failed" -gt 0 ]; then
    echo "[$(date -Iseconds)] WAARSCHUWING: offsite-leesrecht (ACL) niet gezet op ${failed} pad(en)" >&2
  fi
  return 0
}
