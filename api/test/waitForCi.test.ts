// Regressietests voor DOEL-124: wachten op de CI (scripts/lib/wait-for-ci.sh)
// meldt een netwerkfout van gh niet meer als "CI is rood".
//
// Aanleiding (25 oktober 2026, PR #77): pr-merge.sh stopte met "FOUT: CI is
// rood" terwijl alle checks groen waren; `gh run watch --exit-status` was
// gestopt op "read: operation timed out". release.sh had dezelfde constructie.
// Beide scripts gebruiken nu de gedeelde lib. scripts/pr-merge.sh wordt als
// geheel getest in prMerge.test.ts; release.sh praat met Docker en de VPS, dus
// hier draait alleen zijn CI-stap (stap 2/6), letterlijk uit het script
// geknipt, met een nagemaakte gh. Op de oude release.sh faalt die test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = path.join(repo, 'scripts', 'lib', 'wait-for-ci.sh');
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');
const code = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

// Nagemaakte gh: de eerste N aanroepen van een soort mislukken zoals bij een
// time-out; --jq wordt niet uitgevoerd, de stub geeft direct het resultaat.
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
bump() { local f="$GH_LOG.$1" c; c=$(cat "$f" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "$f"; echo "$c"; }
netfail() {
  [ "$(bump "net-$1")" -le "$2" ] || return 1
  echo 'failed to get run: Get "https://api.github.com/repos/x/y/actions/runs/123": read: operation timed out' >&2
}
case "$1 $2" in
  "run list") netfail list "\${GH_NET_FAILS_LIST:-0}" && exit 1; echo 123 ;;
  "run watch") netfail run "\${GH_NET_FAILS:-0}" && exit 1; [ "\${GH_CI:-success}" = success ] ;;
  "run view")
    netfail run "\${GH_NET_FAILS:-0}" && exit 1
    if [ "$(bump view)" -le "\${GH_RUN_PENDING:-0}" ]; then echo "RUN:in_progress:"; else echo "RUN:completed:\${GH_CI:-success}"; fi ;;
  *) echo "gh-stub: onbekende aanroep: $*" >&2; exit 99 ;;
esac
`;

// Draait een stuk bash met de lib geladen (als die bestaat) en de stub op het PATH.
function runBash(body: string, extra: Record<string, string> = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wait-ci-'));
  try {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), GH_STUB);
    chmodSync(path.join(bin, 'gh'), 0o755);
    const ghLog = path.join(tmp, 'gh.log');
    const prelude = [
      'set -euo pipefail',
      'die() { echo "FOUT: $*" >&2; exit 1; }',
      "step() { printf '\\n== %s\\n' \"$*\"; }",
      `REPO=${JSON.stringify(repo)}`,
      `[ -f ${JSON.stringify(lib)} ] && source ${JSON.stringify(lib)}`,
      'SHA=0123456789abcdef; SHORT=0123456',
    ].join('\n');
    const r = spawnSync('bash', ['-c', `${prelude}\n${body}\necho STAP-KLAAR`], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog,
        CI_POLL_SECONDS: '0', CI_FIND_POLL_SECONDS: '0', ...extra },
    });
    let calls: string[] = [];
    try { calls = readFileSync(ghLog, 'utf8').trim().split('\n'); } catch { /* geen aanroepen */ }
    return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr, calls };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// De CI-stap van release.sh, letterlijk uit het script. In de oude versie
// stond hier `sleep 5`; dat wordt voor de test 0.
const releaseSrc = read('scripts/release.sh');
const releaseCiStep = (() => {
  const a = releaseSrc.indexOf('step "2/6 Wachten op CI');
  const b = releaseSrc.indexOf('step "3/6');
  assert.ok(a > 0 && b > a, 'CI-stap (2/6) niet gevonden in release.sh');
  return releaseSrc.slice(a, b).replace(/sleep 5/g, 'sleep 0');
})();

describe('DOEL-124: release.sh wacht op CI zonder netwerkfout als "rood" te melden', () => {
  it('groene CI: de stap komt erdoor', () => {
    const r = runBash(releaseCiStep);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /CI groen\./);
    assert.match(r.out, /STAP-KLAAR/);
  });

  it('netwerkfout tijdens het wachten: opnieuw proberen, daarna door (faalde op de oude release.sh)', () => {
    const r = runBash(releaseCiStep, { GH_NET_FAILS: '2' });
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.err, /CI is rood/);
    assert.match(r.out, /STAP-KLAAR/);
  });

  it('blijvend onbereikbaar: "status onbekend", niet "rood", en niet verder naar het taggen', () => {
    const r = runBash(releaseCiStep, { GH_NET_FAILS: '99', CI_GH_MAX_FAILURES: '3' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /3x op rij niet bereikbaar; CI-status van 0123456 onbekend\. Er is niets veranderd \(niet getagd\)/);
    assert.doesNotMatch(r.err, /CI is rood/);
    assert.doesNotMatch(r.out, /STAP-KLAAR/);
  });

  it('echt rode CI: "CI is rood" met de conclusie, niet getagd', () => {
    const r = runBash(releaseCiStep, { GH_CI: 'failure' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /CI is rood voor 0123456 \(failure\); niet getagd/);
    assert.doesNotMatch(r.out, /STAP-KLAAR/);
  });

  it('de CI-stap komt vóór het taggen, en geen van beide scripts gebruikt nog gh run watch of --watch', () => {
    const rel = code(releaseSrc);
    assert.ok(rel.indexOf('ci_wait_run') > 0 && rel.indexOf('ci_wait_run') < rel.indexOf('git tag -a'), 'ci_wait_run hoort vóór git tag -a');
    for (const f of ['scripts/release.sh', 'scripts/pr-merge.sh']) {
      const c = code(read(f));
      assert.match(c, /source "\$REPO\/scripts\/lib\/wait-for-ci\.sh"/, `${f} laadt de lib niet`);
      assert.doesNotMatch(c, /gh run watch|--watch/, `${f} gebruikt nog gh run watch / --watch`);
    }
  });
});

describe('DOEL-124: scripts/lib/wait-for-ci.sh', () => {
  it('ci_wait_run wacht een lopende run af en meldt de statuswissel één keer', () => {
    const r = runBash('ci_wait_run 123 0123456 "niet gemerged"', { GH_RUN_PENDING: '3' });
    assert.equal(r.status, 0, r.all);
    assert.equal((r.out.match(/CI: in_progress/g) || []).length, 1);
    assert.match(r.out, /CI: completed/);
  });

  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure']) {
    it(`ci_wait_run: conclusie "${conclusion}" telt als rood`, () => {
      const r = runBash('ci_wait_run 123 0123456 "niet gemerged"', { GH_CI: conclusion });
      assert.equal(r.status, 1, r.all);
      assert.match(r.err, new RegExp(`CI is rood voor 0123456 \\(${conclusion}\\)`));
    });
  }

  it('ci_find_run: netwerkfout bij het zoeken wordt opnieuw geprobeerd; een niet-numeriek antwoord telt niet als run-id', () => {
    const r = runBash('ci_find_run "$SHA" "$SHORT" "niet getagd"; echo "ID=$CI_RUN_ID"', { GH_NET_FAILS_LIST: '2' });
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /ID=123/);
  });

  it('ci_find_run: GitHub blijvend onbereikbaar → "onbekend", niet "geen run gevonden"', () => {
    const r = runBash('ci_find_run "$SHA" "$SHORT" "niet getagd"', { GH_NET_FAILS_LIST: '99', CI_GH_MAX_FAILURES: '2' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /2x op rij niet bereikbaar/);
  });
});
