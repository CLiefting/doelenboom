// Regressietests voor DOEL-102: release.sh moet migraties via
// scripts/db-migrate.sh draaien, niet los met psql.
//
// Aanleiding (11 oktober 2026, release v4.1.0): release.sh bepaalde de nieuwe
// migraties met `git diff` tussen de tags en voerde ze los uit met
// `psql < bestand`. Daardoor bleef schema_migrations op productie leeg en had
// een volgende `db-migrate.sh --prod` alle migraties opnieuw gedraaid (ook 0033,
// het probleem van DOEL-99).
//
// release.sh praat met de VPS en Docker en is daarom niet als geheel te draaien
// in een test; dit zijn broncontroles op het deel dat op de VPS draait.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(repo, 'scripts', 'release.sh'), 'utf8');
const code = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
const remoteRaw = (() => {
  const m = src.match(/<<'REMOTE'[^\n]*\n([\s\S]*?)\nREMOTE\n/);
  assert.ok(m, "remote deel (heredoc <<'REMOTE') niet gevonden in release.sh");
  return m[1] + '\n';
})();
const remote = code(remoteRaw);
const pos = (needle: string) => {
  const i = remote.indexOf(needle);
  assert.notEqual(i, -1, `"${needle}" ontbreekt in het remote deel van release.sh`);
  return i;
};

describe('DOEL-102: release.sh draait migraties via db-migrate.sh', () => {
  it('geen losse psql-migraties meer (psql < bestand)', () => {
    assert.doesNotMatch(remote, /psql[^\n]*<\s*"?\$/);
    assert.doesNotMatch(code(src), /--diff-filter=A[^\n]*db\/migrations/);
  });

  it('eerst een dry-run, vóór er iets verandert (docker load, up -d)', () => {
    const dry = pos('scripts/db-migrate.sh --prod --dry-run');
    assert.ok(dry < pos('./deploy/check-no-active-users.sh'), 'dry-run hoort vóór de controle op actieve gebruikers');
    assert.ok(dry < pos('docker load'), 'dry-run hoort vóór docker load');
  });

  it('toepassen met db-migrate.sh --prod vóór de nieuwe images starten', () => {
    const apply = remote.search(/scripts\/db-migrate\.sh --prod\s*\n/);
    assert.notEqual(apply, -1, 'scripts/db-migrate.sh --prod (zonder --dry-run) ontbreekt');
    assert.ok(apply > pos('docker load'), 'migraties na docker load');
    assert.ok(apply < pos('up -d'), 'migraties vóór up -d');
  });

  it('de remote shell stopt bij een fout (set -euo pipefail), zodat een geweigerde migratie de uitrol afbreekt', () => {
    assert.match(remote, /^set -euo pipefail$/m);
  });
});

// Regressietests voor DOEL-108: het remote deel moet zijn einde halen.
//
// Aanleiding (11 oktober 2026, release v4.2.0): release.sh meldde "Uitgerold",
// maar productie draaide nog 4.1.0. Het remote deel gaat via de standaardinvoer
// naar `ssh ... bash -s`; db-migrate.sh roept `docker compose exec -T` aan, en
// dat las de rest van het script weg. Bash zag "einde invoer" en stopte met
// exitcode 0, vóór docker load en up -d.
//
// Deze tests voeren het remote deel echt uit, op dezelfde manier (script via
// de standaardinvoer), met nagemaakte commando's. De nagemaakte db-migrate.sh
// leest de standaardinvoer leeg, net als de echte.
function runRemote(tag: string, apiVersion: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'doel108-'));
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'calls.log');
  const script = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // Leest de standaardinvoer leeg, zoals `docker compose exec -T db psql` doet.
  script(path.join(home, 'doelenboom', 'scripts', 'db-migrate.sh'), `cat > /dev/null\necho "db-migrate $*" >> "${log}"`);
  script(path.join(home, 'doelenboom', 'deploy', 'check-no-active-users.sh'), `cat > /dev/null\necho "check-users" >> "${log}"`);
  script(path.join(bin, 'git'), `echo "git $*" >> "${log}"`);
  script(path.join(bin, 'sleep'), 'exit 0');
  script(path.join(bin, 'docker'), [
    `echo "docker $*" >> "${log}"`,
    'case "$1" in',
    '  load) cat > /dev/null ;;',
    `  exec) printf '%s' '{"version":"${apiVersion}","gitRef":null}' ;;`,
    '  compose) case "$*" in *" ps") echo "doelenboom-api-1   running (healthy)" ;; esac ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  writeFileSync(path.join(home, 'doelenboom-images.tar.gz'), 'nep');
  try {
    const res = spawnSync('bash', ['-s', '--', tag], {
      input: remoteRaw, encoding: 'utf8', timeout: 20000,
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* niets aangeroepen */ }
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('DOEL-108: het remote deel van release.sh haalt zijn einde', () => {
  it('voert na de migratie-dry-run ook docker load, de migraties en up -d uit', () => {
    const r = runRemote('v9.9.9', '9.9.9 (abc1234, 11-10-2026 15:00)');
    assert.equal(r.status, 0, r.stderr);
    for (const call of ['db-migrate --prod --dry-run', 'check-users', 'docker load', 'db-migrate --prod\n', 'up -d', 'docker exec doelenboom-api-1']) {
      assert.ok(r.calls.includes(call), `"${call.trim()}" is niet uitgevoerd; wel:\n${r.calls}`);
    }
    assert.ok(r.calls.indexOf('docker load') < r.calls.indexOf('up -d'));
  });

  it('meldt als laatste regel dat het klaar is, met de tag', () => {
    const r = runRemote('v9.9.9', '9.9.9 (abc1234, 11-10-2026 15:00)');
    assert.match(r.stdout, /^REMOTE-KLAAR v9\.9\.9$/m);
    assert.match(r.stdout, /API-versie: \{"version":"9\.9\.9 /);
  });

  it('draait er na de uitrol een andere versie dan de tag, dan faalt het en meldt het niet "klaar"', () => {
    const r = runRemote('v9.9.9', '4.1.0 (97656bc, 11-10-2026 10:30)');
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /REMOTE-KLAAR/);
    assert.match(r.stdout + r.stderr, /PROBLEEM/);
    // Ook een versie die alleen met de tag begint telt niet (9.9.90 is niet 9.9.9).
    assert.notEqual(runRemote('v9.9.9', '9.9.90 (abc1234, x)').status, 0);
  });

  it('release.sh meldt alleen "Uitgerold" als het remote deel zijn laatste regel heeft bereikt', () => {
    const local = code(src);
    const check = local.indexOf('REMOTE-KLAAR $TAG');
    assert.notEqual(check, -1, 'controle op REMOTE-KLAAR ontbreekt');
    assert.match(local, /grep -qx "REMOTE-KLAAR \$TAG" "\$REMOTE_LOG" \|\| die /);
    assert.ok(local.lastIndexOf('REMOTE-KLAAR') < local.indexOf('echo "Uitgerold.'), 'controle hoort vóór de melding "Uitgerold"');
  });
});

// Regressietests voor DOEL-109: opnieuw draaien na een afgebroken uitrol.
//
// Aanleiding (11 oktober 2026, release v4.3.0): de controle op actieve
// gebruikers kwam pas in stap 6, ná taggen en bouwen. Er was iemand ingelogd,
// de uitrol stopte, en hetzelfde commando opnieuw gaf "Tag bestaat al".
//
// Deze tests draaien het echte release.sh in een wegwerp-repository (met een
// lokale "origin") en nagemaakte gh/docker/ssh/scp.
// DOEL-127: release.sh eist een goedgekeurd acceptatiebewijs voor HEAD; standaard
// schrijft de test er een (acceptatie: 'goed'), de andere varianten testen de poortwachter.
type AccState = 'goed' | 'geen' | 'afgekeurd' | 'oud' | 'andere-commit';
function runRelease(o: { tagAt?: 'head' | 'previous'; usersActive?: boolean; args?: string[]; acceptatie?: AccState }) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doel109-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const log = path.join(tmp, 'calls.log');
  const tag = 'v9.9.9';
  const script = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tmp, VPS: 'beheer@vps.example.test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: work, encoding: 'utf8', env });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    mkdirSync(work, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', path.join(tmp, 'origin.git')], { env });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(work, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(work, '.gitignore'), '*.tar.gz\n/.acceptatie/\n');
    script(path.join(work, 'scripts', 'release.sh'), src.replace(/^#!.*\n/, ''));
    script(path.join(work, 'scripts', 'build-version.sh'), `echo "9.9.9 (abc1234, 11-10-2026 17:00)"`);
    // DOEL-124: release.sh laadt de gedeelde wachtlogica voor de CI.
    mkdirSync(path.join(work, 'scripts', 'lib'), { recursive: true });
    writeFileSync(path.join(work, 'scripts', 'lib', 'wait-for-ci.sh'), readFileSync(path.join(repo, 'scripts', 'lib', 'wait-for-ci.sh'), 'utf8'));
    git('add', '-A');
    git('commit', '-q', '-m', 'eerste');
    git('commit', '-q', '--allow-empty', '-m', 'tweede');
    git('remote', 'add', 'origin', path.join(tmp, 'origin.git'));
    git('push', '-q', '-u', 'origin', 'main');
    const acc = o.acceptatie ?? 'goed';
    if (acc !== 'geen') {
      const head = git('rev-parse', 'HEAD');
      const now = Math.floor(Date.now() / 1000);
      mkdirSync(path.join(work, '.acceptatie'), { recursive: true });
      writeFileSync(path.join(work, '.acceptatie', `bewijs-${head}.txt`), [
        `commit=${acc === 'andere-commit' ? '0'.repeat(40) : head}`,
        'build_version=9.9.8 (abc1234, 25-10-2026 11:00)',
        'gecontroleerd_op=2026-10-25T11:00:00+0100',
        `gecontroleerd_epoch=${acc === 'oud' ? now - 73 * 3600 : now - 60}`,
        `kritiek=0`, `hoog=${acc === 'afgekeurd' ? 2 : 0}`, 'onbekend=0', 'gemiddeld=1', 'laag=0',
        `resultaat=${acc === 'afgekeurd' ? 'AFGEKEURD' : 'GOEDGEKEURD'}`,
      ].join('\n') + '\n');
    }
    if (o.tagAt) {
      git('tag', '-a', tag, '-m', tag, o.tagAt === 'head' ? 'HEAD' : 'HEAD~1');
      git('push', '-q', 'origin', tag);
    }
    script(path.join(bin, 'gh'), [
      `echo "gh $*" >> "${log}"`,
      'case "$1 $2" in "run list") echo 12345 ;; "run view") echo "RUN:completed:success" ;; esac',
      'exit 0',
    ].join('\n'));
    script(path.join(bin, 'docker'), `echo "docker $*" >> "${log}"\nexit 0`);
    script(path.join(bin, 'scp'), `echo "scp" >> "${log}"\nexit 0`);
    // ssh host 'commando' = de vroege controle; ssh host bash -s ... = de uitrol zelf.
    script(path.join(bin, 'ssh'), [
      `echo "ssh $*" >> "${log}"`,
      'case "$*" in',
      `  *check-no-active-users*) ${o.usersActive ? 'echo "LET OP: er is nu nog minstens één gebruiker actief ingelogd — NIET updaten."; exit 1' : 'echo "Geen actieve gebruikers ingelogd"; exit 0'} ;;`,
      'esac',
      'cat > /dev/null; exit 0',
    ].join('\n'));
    const res = spawnSync('bash', [path.join(work, 'scripts', 'release.sh'), tag, 'beschrijving', ...(o.args ?? ['--deploy'])], {
      cwd: work, encoding: 'utf8', timeout: 60000, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* niets aangeroepen */ }
    return { status: res.status, out: `${res.stdout}\n${res.stderr}`, calls, tags: git('tag', '--list') };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('DOEL-109: release.sh opnieuw draaien na een afgebroken uitrol', () => {
  it('iemand ingelogd: stopt in stap 1, vóór er een tag is gezet of iets is gebouwd', () => {
    const r = runRelease({ usersActive: true });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nog iemand ingelogd op productie/);
    assert.match(r.out, /Er is niets gewijzigd: geen tag, geen images/);
    assert.equal(r.tags, '', 'er is toch een tag gezet');
    assert.ok(!r.calls.includes('gh release') && !r.calls.includes('docker compose') && !r.calls.includes('scp'), r.calls);
  });

  it('tag staat al op deze commit: hetzelfde commando hervat vanzelf (geen "Tag bestaat al")', () => {
    const r = runRelease({ tagAt: 'head' });
    assert.doesNotMatch(r.out, /bestaat al/);
    assert.match(r.out, /de release wordt hervat/);
    assert.ok(!r.calls.includes('gh run') && !r.calls.includes('gh release'), `CI en GitHub Release horen overgeslagen te worden:\n${r.calls}`);
    assert.ok(r.calls.includes('docker compose') && r.calls.includes(' build '), `de images horen opnieuw gebouwd te worden:\n${r.calls}`);
    assert.ok(r.calls.includes('scp'), r.calls);
    // Daarna vraagt het script om bevestiging; zonder terminal stopt het daar.
    assert.ok(!r.calls.includes('bash -s'), 'zonder bevestiging mag er niet worden uitgerold');
  });

  it('hervatten en er is iemand ingelogd: stopt vóór het opnieuw bouwen', () => {
    const r = runRelease({ tagAt: 'head', usersActive: true });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nog iemand ingelogd op productie/);
    assert.ok(!r.calls.includes('docker compose'), r.calls);
  });

  it('tag op een andere commit blijft een fout, met uitleg', () => {
    const r = runRelease({ tagAt: 'previous' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /bestaat al, maar op een andere commit/);
    assert.ok(!r.calls.includes('docker compose') && !r.calls.includes('gh release'), r.calls);
  });

  it('zonder --deploy: geen controle op de VPS vooraf, en de gewone release werkt nog', () => {
    const r = runRelease({ args: [], usersActive: true });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.calls.includes('check-no-active-users'), r.calls);
    assert.equal(r.tags, 'v9.9.9');
    assert.ok(r.calls.includes('gh release create v9.9.9'), r.calls);
  });

  it('de controle vlak voor de herstart op de VPS is gebleven', () => {
    pos('./deploy/check-no-active-users.sh');
    const early = code(src).indexOf("ssh \"$VPS\" 'cd ~/doelenboom && ./deploy/check-no-active-users.sh'");
    assert.notEqual(early, -1, 'de vroege controle ontbreekt');
    assert.ok(early < code(src).indexOf('git tag -a'), 'de vroege controle hoort vóór het taggen');
  });
});

// Regressietests voor DOEL-127: release.sh tagt alleen wat eerst in de lokale
// acceptatieomgeving is goedgekeurd (scripts/acceptatie.sh). Op de oude
// release.sh (zonder poortwachter) falen de weigeringstests: die tagde gewoon.
describe('DOEL-127: release.sh weigert een commit zonder goedgekeurde acceptatie', () => {
  const refused = (r: ReturnType<typeof runRelease>, pattern: RegExp) => {
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, pattern);
    assert.equal(r.tags, '', 'er is toch een tag gezet');
    for (const c of ['gh run', 'gh release', 'docker compose', 'scp', 'ssh']) {
      assert.ok(!r.calls.includes(c), `"${c}" had niet mogen gebeuren:\n${r.calls}`);
    }
  };

  it('geen acceptatiebewijs: stopt vóór CI, tag, bouwen en de VPS', () => {
    refused(runRelease({ acceptatie: 'geen' }), /nog niet in acceptatie geweest\. Draai eerst:  bash scripts\/acceptatie\.sh/);
  });

  it('afgekeurde acceptatie: stopt, met de aantallen', () => {
    refused(runRelease({ acceptatie: 'afgekeurd' }), /AFGEKEURD \(kritiek 0, hoog 2, onbekend 0\)/);
  });

  it('bewijs van een andere commit telt niet', () => {
    refused(runRelease({ acceptatie: 'andere-commit' }), /hoort niet bij commit/);
  });

  it('bewijs ouder dan 72 uur telt niet (libraries opnieuw controleren)', () => {
    refused(runRelease({ acceptatie: 'oud' }), /73 uur oud \(maximaal 72\)/);
  });

  it('goedgekeurd en recent: de release gaat door en meldt de acceptatie', () => {
    const r = runRelease({ args: [], acceptatie: 'goed' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Acceptatie: GOEDGEKEURD op 2026-10-25T11:00:00\+0100/);
    assert.equal(r.tags, 'v9.9.9');
  });

  it('hervatten (tag staat al op deze commit) vraagt niet opnieuw om acceptatie', () => {
    const r = runRelease({ tagAt: 'head', acceptatie: 'geen' });
    assert.doesNotMatch(r.out, /nog niet in acceptatie/);
    assert.match(r.out, /de release wordt hervat/);
  });
});
