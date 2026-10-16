#!/usr/bin/env bash
# pr-merge.sh — een feature/fix-branch van Doelenboom in één keer naar main
# (DOEL-101): pushen -> PR maken (of de open PR hergebruiken) -> wachten tot de
# CI van precies deze commit groen is -> mergen met merge-commit -> branch
# lokaal en op GitHub opruimen -> main bijwerken.
#
# Gebruik (op je Mac, vanaf de branch die naar main moet):
#   scripts/pr-merge.sh
#
# Vereist: gh (brew install gh; gh auth login). Werkt ook met de bash 3.2 van
# macOS.
#
# Het script stopt bij de eerste fout en past niets aan zolang een controle
# vooraf faalt. Is de CI rood, dan blijft de PR open staan en wordt er niets
# gemerged.
set -euo pipefail

die() { echo "FOUT: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ $# -eq 0 ] || die "pr-merge.sh kent geen argumenten; draai het vanaf de branch die naar main moet."

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "geen git-repository: $REPO"

step "1/5 Controles vooraf"
command -v gh >/dev/null       || die "gh ontbreekt:  brew install gh && gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is niet ingelogd:  gh auth login"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "je zit niet op een branch (detached HEAD)."
[ "$BRANCH" != "main" ] || die "je staat op main; maak eerst een branch feat/doel-NNN-... of fix/doel-NNN-..."
[[ "$BRANCH" =~ ^(feat|fix)/doel-[0-9]+(-[a-z0-9-]+)?$ ]] \
  || die "branchnaam '$BRANCH' volgt de afspraak niet: feat/doel-NNN-omschrijving of fix/doel-NNN-omschrijving (zie CLAUDE.md)."
[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "werkmap is niet schoon; commit of stash eerst."; }

git fetch -q origin main
AHEAD="$(git rev-list --count origin/main..HEAD)"
[ "$AHEAD" -gt 0 ] || die "deze branch heeft geen commits die nog niet op main staan."
git merge-base --is-ancestor origin/main HEAD \
  || die "deze branch loopt achter op main. Werk hem eerst bij:  git rebase origin/main  (en draai de tests opnieuw)."

SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short HEAD)"
echo "Branch $BRANCH, $AHEAD commit(s) voor op main, HEAD $SHORT"

step "2/5 Pushen en PR"
git push -u origin "$BRANCH"
PR="$(gh pr view "$BRANCH" --json number,state --jq 'select(.state == "OPEN") | .number' 2>/dev/null || true)"
if [ -n "$PR" ]; then
  echo "Bestaande PR #$PR wordt gebruikt."
else
  URL="$(gh pr create --base main --head "$BRANCH" --fill)"
  PR="${URL##*/}"
  [[ "$PR" =~ ^[0-9]+$ ]] || die "kon het PR-nummer niet bepalen uit: $URL"
  echo "PR #$PR aangemaakt: $URL"
fi

step "3/5 Wachten op CI voor $SHORT"
RUN_ID=""
for _ in $(seq 1 36); do   # maximaal 3 minuten wachten tot de run bestaat
  RUN_ID="$(gh run list --workflow CI --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$RUN_ID" ] && break
  sleep "${PR_MERGE_POLL_SECONDS:-5}"
done
[ -n "$RUN_ID" ] || die "geen CI-run gevonden voor $SHORT. Is de push aangekomen? PR #$PR blijft open."
gh run watch "$RUN_ID" --exit-status --interval 10 \
  || die "CI is rood voor $SHORT; niet gemerged. PR #$PR blijft open (gh run view $RUN_ID --log-failed)."
# Ook de overige checks op de PR (bv. Dependency-audit) moeten groen zijn.
gh pr checks "$PR" --watch --fail-fast --interval 10 \
  || die "niet alle checks op PR #$PR zijn groen; niet gemerged."
echo "CI groen."

step "4/5 Mergen (merge-commit)"
# --match-head-commit: alleen mergen als de PR nog precies op de geteste commit staat.
gh pr merge "$PR" --merge --delete-branch --match-head-commit "$SHA"
STATE="$(gh pr view "$PR" --json state --jq .state)"
[ "$STATE" = "MERGED" ] || die "PR #$PR staat op '$STATE' in plaats van MERGED; controleer op GitHub."

step "5/5 Opruimen en main bijwerken"
git checkout -q main
git pull --ff-only
git branch -D "$BRANCH" >/dev/null 2>&1 || true   # gh ruimt hem meestal al op
git fetch -q --prune origin
echo
echo "Klaar: PR #$PR gemerged; main staat op $(git rev-parse --short HEAD)."
