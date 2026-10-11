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

const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "auth status") [ "\${GH_AUTH:-ok}" = ok ] ;;
  "pr view")
    if [[ "$*" == *"--json state"* && "$*" != *"number"* ]]; then echo MERGED
    elif [ -n "\${GH_EXISTING_PR:-}" ]; then echo "$GH_EXISTING_PR"
    else echo "no pull requests found" >&2; exit 1; fi ;;
  "pr create") echo "https://github.com/CLiefting/doelenboom/pull/7" ;;
  "run list") echo 123 ;;
  "run watch") [ "\${GH_CI:-ok}" = ok ] ;;
  "pr checks") exit 0 ;;
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
  PR_MERGE_POLL_SECONDS: '0',
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
    const order = ['auth status', 'pr view', 'pr create', 'run list', 'run watch 123', 'pr checks 7', 'pr merge 7'];
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
    const r = run({ GH_CI: 'fail' });
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /CI is rood/);
    assert.ok(!r.calls.some((c) => c.startsWith('pr merge')), r.calls.join('\n'));
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feat/doel-101-test');
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
