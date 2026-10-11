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
