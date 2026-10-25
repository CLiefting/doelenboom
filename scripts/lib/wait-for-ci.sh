# shellcheck shell=bash
# scripts/lib/wait-for-ci.sh — wachten op GitHub-CI, gedeeld door
# scripts/pr-merge.sh en scripts/release.sh (DOEL-124).
#
# Waarom zelf pollen: `gh run watch --exit-status` en `gh pr checks --watch`
# stoppen ook met een foutcode als GitHub even niet bereikbaar is (bv.
# "read: operation timed out"). De scripts meldden dat dan als "CI is rood".
# Hier telt een mislukte gh-aanroep als "onbereikbaar" en wordt opnieuw
# geprobeerd; pas na CI_GH_MAX_FAILURES keer op rij stopt het met "status
# onbekend". "CI is rood" alleen bij een echte conclusie van GitHub.
#
# Gebruik (na `set -euo pipefail` en met een eigen die()-functie):
#   source "$REPO/scripts/lib/wait-for-ci.sh"
#   ci_find_run "$SHA" "$SHORT" "niet taggen"        # zet CI_RUN_ID
#   ci_wait_run "$CI_RUN_ID" "$SHORT" "niet taggen"
#   ci_wait_pr_checks "$PR" "niet gemerged"          # alleen voor PR's
# Het derde argument zegt wat er NIET gebeurt bij een fout; het komt in de
# foutmelding. Werkt met de bash 3.2 van macOS.
#
# Instelbaar via de omgeving (de tests zetten ze laag):
#   CI_POLL_SECONDS (10), CI_GH_MAX_FAILURES (6), CI_MAX_POLLS (360 = 60 min),
#   CI_FIND_TRIES (36 = 3 min bij 5 s), CI_FIND_POLL_SECONDS (5).

CI_GH_FAILS=0

# _ci_unreachable <label> <hint> <uitvoer van de mislukte aanroep>
_ci_unreachable() {
  local max="${CI_GH_MAX_FAILURES:-6}"
  CI_GH_FAILS=$((CI_GH_FAILS + 1))
  echo "GitHub niet bereikbaar ($CI_GH_FAILS/$max), ik probeer het opnieuw: $(printf '%s' "$3" | head -n 1)" >&2
  [ "$CI_GH_FAILS" -lt "$max" ] \
    || die "GitHub ${max}x op rij niet bereikbaar; CI-status van $1 onbekend. Er is niets veranderd ($2). Draai het script later opnieuw."
}

# ci_find_run <sha> <label> <hint> — zet CI_RUN_ID op de CI-run van die commit.
ci_find_run() {
  local sha="$1" label="$2" hint="$3" out i
  CI_RUN_ID=""
  for i in $(seq 1 "${CI_FIND_TRIES:-36}"); do
    if out="$(gh run list --workflow CI --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>&1)"; then
      CI_GH_FAILS=0
      if [[ "$out" =~ ^[0-9]+$ ]]; then CI_RUN_ID="$out"; break; fi
    else
      _ci_unreachable "$label" "$hint" "$out"
    fi
    sleep "${CI_FIND_POLL_SECONDS:-5}"
  done
  [ -n "$CI_RUN_ID" ] || die "geen CI-run gevonden voor $label. Is de push aangekomen? ($hint)"
  echo "CI-run $CI_RUN_ID: https://github.com/CLiefting/doelenboom/actions/runs/$CI_RUN_ID"
}

# ci_wait_run <run-id> <label> <hint> — wacht tot de run klaar is; alleen
# "success" is goed.
ci_wait_run() {
  local run="$1" label="$2" hint="$3" out status conclusion last="" i
  for i in $(seq 1 "${CI_MAX_POLLS:-360}"); do
    if out="$(gh run view "$run" --json status,conclusion --jq '"RUN:" + .status + ":" + (.conclusion // "")' 2>&1)" \
       && [[ "$out" == RUN:* ]]; then
      CI_GH_FAILS=0
      status="$(printf '%s' "$out" | cut -d: -f2)"
      conclusion="$(printf '%s' "$out" | cut -d: -f3)"
      [ "$status" = "$last" ] || { echo "CI: $status"; last="$status"; }
      if [ "$status" = "completed" ]; then
        [ "$conclusion" = "success" ] \
          || die "CI is rood voor $label (${conclusion:-geen conclusie}); $hint (gh run view $run --log-failed)."
        echo "CI groen."
        return 0
      fi
    else
      _ci_unreachable "$label" "$hint" "$out"
    fi
    sleep "${CI_POLL_SECONDS:-10}"
  done
  die "CI-run $run is na ${CI_MAX_POLLS:-360} controles nog niet klaar; $hint."
}

# ci_wait_pr_checks <pr> <hint> — alle checks op de PR (ook bv. de
# Dependency-audit) moeten pass of skipping zijn. gh pr checks geeft bij
# lopende checks zelf een foutcode (8), dus alleen de uitvoer telt: geen
# "CHECKS:"-regel = de gh-aanroep is mislukt.
ci_wait_pr_checks() {
  local pr="$1" hint="$2" out list failed i
  for i in $(seq 1 "${CI_MAX_POLLS:-360}"); do
    out="$(gh pr checks "$pr" --json name,bucket --jq '"CHECKS:" + ([.[] | .name + "=" + .bucket] | join(";"))' 2>&1)" || true
    if [[ "$out" == CHECKS:* ]]; then
      CI_GH_FAILS=0
      list="${out#CHECKS:}"
      failed="$(printf '%s' "$list" | tr ';' '\n' | grep -E '=(fail|cancel)$' | sed 's/=.*//' | paste -sd, - || true)"
      [ -z "$failed" ] || die "niet alle checks op PR #$pr zijn groen ($failed); $hint."
      # Geen grep -q in een pipe: met pipefail kan een SIGPIPE de uitkomst omdraaien.
      case ";$list;" in
        *=pending\;*) ;;
        *) gh pr checks "$pr" 2>/dev/null || true   # overzicht voor in de terminal
           return 0 ;;
      esac
    else
      _ci_unreachable "PR #$pr" "$hint" "$out"
    fi
    sleep "${CI_POLL_SECONDS:-10}"
  done
  die "checks op PR #$pr zijn na ${CI_MAX_POLLS:-360} controles nog niet klaar; $hint."
}
