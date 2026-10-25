// Tests voor scripts/pr-merge.sh (DOEL-101).
//
// Het script draait echt, in een tijdelijke git-repository met een lokale
// "origin" (bare repository). Alleen `gh` is vervangen door een stub die elke
// aanroep logt; zo is te zien wat er wel en niet naar GitHub zou gaan.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptSrc = path.join(repo, 'scripts', 'pr-merge.sh');

// DOEL-124: de stub kan netwerkfouten nadoen (de eerste N aanroepen van een
// soort mislukken zoals gh dat doet bij een time-out) en een run die eerst
// nog loopt. --jq wordt niet uitgevoerd: de stub geeft direct het resultaat
// dat de jq-expressie in pr-merge.sh oplevert ("RUN:..." / "CHECKS:...").
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
bump() { local f="$GH_LOG.$1" c; c=$(cat "$f" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "$f"; echo "$c"; }
netfail() {   # netfail <soort> <aantal>: true (= faal nu) voor de eerste <aantal> aanroepen
  [ "$(bump "net-$1")" -le "$2" ] || return 1
  echo 'failed to get run: Get "https://api.github.com/repos/x/y/actions/runs/123": read tcp 10.0.0.1:52445->140.82.121.6:443: read: operation timed out' >&2
}
case "$1 $2" in
  "auth status") [ "\${GH_AUTH:-ok}" = ok ] ;;
  "pr view")
    if [[ "$*" == *"--json state"* && "$*" != *"number"* ]]; then echo MERGED
    elif [ -n "\${GH_EXISTING_PR:-}" ]; then echo "$GH_EXISTING_PR"
    else echo "no pull requests found" >&2; exit 1; fi ;;
  "pr create") echo "https://github.com/CLiefting/doelenboom/pull/7" ;;
  "run list") netfail list "\${GH_NET_FAILS_LIST:-0}" && exit 1; echo 123 ;;
  "run watch") netfail run "\${GH_NET_FAILS:-0}" && exit 1; [ "\${GH_CI:-ok}" = ok ] ;;
  "run view")
    netfail run "\${GH_NET_FAILS:-0}" && exit 1
    if [ "$(bump view)" -le "\${GH_RUN_PENDING:-0}" ]; then echo "RUN:in_progress:"
    elif [ "\${GH_CI:-ok}" = ok ]; then echo "RUN:completed:success"
    else echo "RUN:completed:\${GH_CI}"; fi ;;
  "pr checks")
    if [[ "$*" == *"--json"* ]]; then
      netfail checks "\${GH_NET_FAILS_CHECKS:-0}" && exit 1
      if [ "$(bump checks)" -le "\${GH_CHECKS_PENDING:-0}" ]; then echo "CHECKS:CI=pass;Dependency-audit=pending"; exit 8; fi
      echo "CHECKS:\${GH_CHECKS:-CI=pass;Dependency-audit=pass}"
    fi
    exit 0 ;;
  "pr merge") exit 0 ;;
  *) echo "gh-stub: onbekende aanroep: $*" >&2; exit 99 ;;
esac
`;

let tmp = '';
let work = '';
let remote = '';
let bin = '';
let ghLog = '';

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GH_LOG: ghLog,
  CI_POLL_SECONDS: '0',
  CI_FIND_POLL_SECONDS: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  ...extra,
});

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: work, env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function run(extra: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [path.join(work, 'scripts', 'pr-merge.sh'), ...args], { cwd: work, env: env(extra), encoding: 'utf8' });
  const calls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr, calls };
}

const remoteHas = (branch: string) =>
  spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;

function commit(file: string) {
  writeFileSync(path.join(work, file), `${file}\n`);
  git('add', file);
  git('commit', '-q', '-m', file);
}

describe('DOEL-101: scripts/pr-merge.sh', () => {
  before(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'pr-merge-')); });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    remote = path.join(tmp, 'origin.git');
    work = path.join(tmp, 'work');
    bin = path.join(tmp, 'bin');
    ghLog = path.join(tmp, 'gh.log');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gh'), GH_STUB);
    chmodSync(path.join(bin, 'gh'), 0o755);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    mkdirSync(work);
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', remote);
    mkdirSync(path.join(work, 'scripts'));
    copyFileSync(scriptSrc, path.join(work, 'scripts', 'pr-merge.sh'));
    // DOEL-124: pr-merge.sh laadt de gedeelde wachtlogica.
    mkdirSync(path.join(work, 'scripts', 'lib'));
    copyFileSync(path.join(repo, 'scripts', 'lib', 'wait-for-ci.sh'), path.join(work, 'scripts', 'lib', 'wait-for-ci.sh'));
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    git('push', '-q', '-u', 'origin', 'main');
    git('checkout', '-q', '-b', 'feat/doel-101-test');
    commit('wijziging.txt');
  });

  it('happy path: pusht, maakt een PR, wacht op CI en merget precies de geteste commit', () => {
    const sha = git('rev-parse', 'HEAD');
    const r = run();
    assert.equal(r.status, 0, r.all);
    assert.ok(remoteHas('feat/doel-101-test'), 'branch is niet gepusht');
    const order = ['auth status', 'pr view', 'pr create', 'run list', 'run view 123', 'pr checks 7', 'pr merge 7'];
    let last = -1;
    for (const step of order) {
      const i = r.calls.findIndex((c, idx) => idx > last && c.startsWith(step));
      assert.ok(i > last, `"${step}" ontbreekt of staat in de verkeerde volgorde: ${r.calls.join(' | ')}`);
      last = i;
    }
    assert.ok(r.calls.includes(`pr merge 7 --merge --delete-branch --match-head-commit ${sha}`), r.calls.join('\n'));
    assert.ok(r.calls.some((c) => c.startsWith(`run list --workflow CI --commit ${sha}`)));
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.match(r.out, /PR #7 gemerged/);
  });

  it('een bestaande open PR wordt hergebruikt in plaats van een nieuwe te maken', () => {
    const r = run({ GH_EXISTING_PR: '5' });
    assert.equal(r.status, 0, r.all);
    assert.ok(!r.calls.some((c) => c.startsWith('pr create')), r.calls.join('\n'));
    assert.ok(r.calls.some((c) => c.startsWith('pr merge 5 --merge')));
  });

  it('CI rood: niet mergen, PR blijft open, branch blijft bestaan', () => {
    const r = run({ GH_CI: 'failure' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /CI is rood voor \w+ \(failure\)/);
    assert.ok(!r.calls.some((c) => c.startsWith('pr merge')), r.calls.join('\n'));
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feat/doel-101-test');
  });

  // --- DOEL-124: netwerkfouten van gh zijn geen "CI rood" ---------------------
  const merged = (r: ReturnType<typeof run>) => r.calls.some((c) => c.startsWith('pr merge 7 --merge'));

  it('DOEL-124: netwerkfout tijdens het wachten op de CI wordt opnieuw geprobeerd, daarna gemerged', () => {
    const r = run({ GH_NET_FAILS: '2' });
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.err, /CI is rood/);
    assert.match(r.err, /GitHub niet bereikbaar \(1\/6\)/);
    assert.match(r.err, /GitHub niet bereikbaar \(2\/6\)/);
    assert.ok(merged(r), r.calls.join('\n'));
  });

  it('DOEL-124: blijft GitHub onbereikbaar, dan "status onbekend" (niet "rood") en niets gemerged', () => {
    const r = run({ GH_NET_FAILS: '99', CI_GH_MAX_FAILURES: '3' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /3x op rij niet bereikbaar; CI-status van \w+ onbekend/);
    assert.doesNotMatch(r.err, /CI is rood/);
    assert.ok(!merged(r), r.calls.join('\n'));
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feat/doel-101-test');
  });

  it('DOEL-124: een succesvolle gh-aanroep zet de teller weer op nul', () => {
    // 2 fouten, dan een lopende run, dan weer 2 fouten (via de checks): met
    // een maximum van 3 mag dat niet tot "onbereikbaar" leiden.
    const r = run({ GH_NET_FAILS: '2', GH_RUN_PENDING: '1', GH_NET_FAILS_CHECKS: '2', CI_GH_MAX_FAILURES: '3' });
    assert.equal(r.status, 0, r.all);
    assert.ok(merged(r));
  });

  it('DOEL-124: een run die nog loopt wordt afgewacht', () => {
    const r = run({ GH_RUN_PENDING: '3' });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.calls.filter((c) => c.startsWith('run view 123')).length >= 4, r.calls.join('\n'));
    assert.match(r.out, /CI: in_progress[\s\S]*CI: completed/);
    assert.ok(merged(r));
  });

  it('DOEL-124: netwerkfout bij het zoeken van de run wordt opnieuw geprobeerd', () => {
    const r = run({ GH_NET_FAILS_LIST: '2' });
    assert.equal(r.status, 0, r.all);
    assert.ok(merged(r));
  });

  it('DOEL-124: een rode PR-check (bv. Dependency-audit) blokkeert de merge en wordt genoemd', () => {
    const r = run({ GH_CHECKS: 'CI=pass;Dependency-audit=fail' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /niet alle checks op PR #7 zijn groen \(Dependency-audit\)/);
    assert.ok(!merged(r));
  });

  it('DOEL-124: lopende PR-checks worden afgewacht, netwerkfouten daar opnieuw geprobeerd', () => {
    const r = run({ GH_CHECKS_PENDING: '2', GH_NET_FAILS_CHECKS: '1' });
    assert.equal(r.status, 0, r.all);
    assert.ok(r.calls.filter((c) => c.startsWith('pr checks 7 --json')).length >= 4, r.calls.join('\n'));
    assert.ok(merged(r));
  });

  it('DOEL-124: een run die nooit klaar komt stopt na het maximum aantal controles, zonder merge', () => {
    const r = run({ GH_RUN_PENDING: '999', CI_MAX_POLLS: '5' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /na 5 controles nog niet klaar/);
    assert.ok(!merged(r));
  });

  // Controles vooraf: er mag niets gepusht of naar GitHub gestuurd zijn.
  const refusedBeforeAnything = (r: ReturnType<typeof run>, pattern: RegExp) => {
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, pattern);
    assert.ok(!remoteHas('feat/doel-101-test'), 'er is toch gepusht');
    assert.ok(!r.calls.some((c) => /^(pr|run) /.test(c)), `toch naar GitHub: ${r.calls.join(' | ')}`);
  };

  it('weigert op main', () => {
    git('checkout', '-q', 'main');
    refusedBeforeAnything(run(), /je staat op main/);
  });

  it('weigert een branchnaam die de afspraak niet volgt', () => {
    git('checkout', '-q', '-b', 'feature/iets');
    refusedBeforeAnything(run(), /volgt de afspraak niet/);
  });

  it('weigert met een vuile werkmap', () => {
    writeFileSync(path.join(work, 'los.txt'), 'niet gecommit\n');
    refusedBeforeAnything(run(), /werkmap is niet schoon/);
  });

  it('weigert als gh niet is ingelogd', () => {
    refusedBeforeAnything(run({ GH_AUTH: 'fail' }), /gh is niet ingelogd/);
  });

  it('weigert een branch zonder nieuwe commits', () => {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'fix/doel-101-leeg');
    const r = run();
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /geen commits/);
  });

  it('weigert een branch die achterloopt op main (eerst rebasen)', () => {
    git('checkout', '-q', 'main');
    commit('ander.txt');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feat/doel-101-test');
    refusedBeforeAnything(run(), /loopt achter op main/);
  });

  it('weigert onverwachte argumenten', () => {
    refusedBeforeAnything(run({}, ['--force']), /kent geen argumenten/);
  });
});
