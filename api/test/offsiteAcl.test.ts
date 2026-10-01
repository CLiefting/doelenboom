// Regressietest voor DOEL-53: de offsite-back-up naar CL-NAS002 faalde sinds
// DOEL-31 elke nacht met rsync-code 23 ("Interrupted" in DSM).
//
// Oorzaak (live vastgesteld op de VPS, 1 oktober 2026): CL-NAS002 haalt
// ~/doelenboom/backups op als het beperkte account "doelenboom-pull", dat via
// een POSIX-ACL leesrecht had. deploy/backup-database.sh doet `chmod 700/600`
// en het Excel-exportscript schrijft 0700/0600 — bij een bestand/map mét ACL
// maakt dat het ACL-masker leeg, dus `user:doelenboom-pull:r-x #effective:---`.
//
// Deze test draait beide host-scripts echt (met een nagebootste `docker`), in
// een tijdelijke map met dezelfde ACL-opzet als op de VPS, met een bestaand
// systeemaccount ("nobody") als pullaccount, en controleert met getfacl de
// EFFECTIEVE rechten. Vereist setfacl/getfacl en een bestandssysteem met ACL's
// (Linux; in CI geïnstalleerd, zie .github/workflows/ci.yml). Elders wordt hij
// overgeslagen, behalve als REQUIRE_ACL_TESTS=1 (CI): dan faalt hij.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PULL_USER = 'nobody';

function aclSupported(): string | null {
  for (const bin of ['setfacl', 'getfacl']) {
    if (spawnSync('sh', ['-c', `command -v ${bin}`]).status !== 0) return `${bin} ontbreekt`;
  }
  if (spawnSync('id', [PULL_USER]).status !== 0) return `account ${PULL_USER} bestaat niet`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'acl-probe-'));
  try {
    const r = spawnSync('setfacl', ['-m', `u:${PULL_USER}:r`, tmp]);
    return r.status === 0 ? null : 'bestandssysteem ondersteunt geen ACL\'s';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function skipOrFail(t: { skip: (msg: string) => void }): boolean {
  const reason = aclSupported();
  if (!reason) return false;
  if (process.env.REQUIRE_ACL_TESTS === '1') assert.fail(`ACL-test kan niet draaien: ${reason}`);
  t.skip(`ACL-test overgeslagen: ${reason}`);
  return true;
}

// Effectief recht van een ACL-regel volgens getfacl, bv. "r-x" of "---".
function effective(p: string, entry: string): string {
  const out = spawnSync('getfacl', ['-p', p], { encoding: 'utf8' }).stdout;
  for (const line of out.split('\n')) {
    if (!line.startsWith(entry + ':')) continue;
    const perms = line.split(':')[2].slice(0, 3);
    const m = line.match(/#effective:([rwx-]{3})/);
    return m ? m[1] : perms;
  }
  return '(geen regel)';
}

function setupRepo(): { tmp: string; bin: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'offsite-acl-'));
  mkdirSync(path.join(tmp, 'deploy'));
  for (const f of ['backup-database.sh', 'export-all-doelenbomen.sh', 'offsite-acl.sh']) {
    cpSync(path.join(repo, 'deploy', f), path.join(tmp, 'deploy', f));
  }
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  // Nagebootste docker: pg_dump-uitvoer, of (export) een nieuw .xlsx-bestand
  // met de rechten die het echte exportscript gebruikt (map 0700, bestand 0600).
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh
case "$*" in
  *exportAllDoelenbomen*)
    d="$OFFSITE_TEST_REPO/backups/tenant/boom/nieuw"; mkdir -p "$d"; chmod 700 "$d"
    f="$OFFSITE_TEST_REPO/backups/tenant/boom/boom_2026-10-02.xlsx"
    ( umask 077; echo xlsx > "$f" ); chmod 600 "$f" ;;
  *) echo "-- nagebootste pg_dump" ;;
esac
`
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  // Zelfde begintoestand als op de VPS: backups/ met een (standaard-)ACL voor het pullaccount.
  const backups = path.join(tmp, 'backups');
  mkdirSync(path.join(backups, 'database'), { recursive: true });
  mkdirSync(path.join(backups, 'tenant', 'boom'), { recursive: true });
  for (const d of [backups, path.join(backups, 'database'), path.join(backups, 'tenant'), path.join(backups, 'tenant', 'boom')]) {
    // Twee aanroepen: -d geldt voor álle -m's in dezelfde aanroep.
    assert.equal(spawnSync('setfacl', ['-m', `u:${PULL_USER}:rX`, d]).status, 0);
    assert.equal(spawnSync('setfacl', ['-d', '-m', `u:${PULL_USER}:rX`, d]).status, 0);
  }
  // Ook de bovenliggende tijdelijke map moet doorloopbaar zijn voor het pullaccount (zoals ~ op de VPS).
  spawnSync('setfacl', ['-m', `u:${PULL_USER}:x`, tmp]);
  const oldDump = path.join(backups, 'database', 'doelenboom-20200101-000000.sql.gz');
  writeFileSync(oldDump, 'oud');
  return { tmp, bin };
}

function run(tmp: string, bin: string, script: string) {
  const r = spawnSync('bash', ['-c', `umask 022; bash deploy/${script}`], {
    cwd: tmp,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OFFSITE_PULL_USER: PULL_USER, OFFSITE_TEST_REPO: tmp },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r;
}

describe('offsite-back-up: leesrecht voor het pullaccount blijft behouden (DOEL-53)', () => {
  it('backup-database.sh: map en alle dumps leesbaar voor het pullaccount, verder voor niemand', (t) => {
    if (skipOrFail(t)) return;
    const { tmp, bin } = setupRepo();
    try {
      run(tmp, bin, 'backup-database.sh');
      const dir = path.join(tmp, 'backups', 'database');
      assert.equal(effective(dir, `user:${PULL_USER}`), 'r-x', 'pullaccount moet de map kunnen openen');
      assert.equal(effective(dir, 'group:'), '---');
      assert.equal(effective(dir, 'other:'), '---');
      const dumps = readdirSync(dir);
      assert.equal(dumps.length, 2, 'oude + nieuwe dump');
      for (const f of dumps) {
        const p = path.join(dir, f);
        assert.equal(effective(p, `user:${PULL_USER}`), 'r--', `pullaccount moet ${f} kunnen lezen`);
        assert.equal(effective(p, 'group:'), '---', `groep mag ${f} niet lezen`);
        assert.equal(effective(p, 'other:'), '---', `other mag ${f} niet lezen`);
      }
      // Tweede nacht: blijft zo (idempotent), ook met de nieuwe dump erbij.
      run(tmp, bin, 'backup-database.sh');
      for (const f of readdirSync(dir)) {
        assert.equal(effective(path.join(dir, f), `user:${PULL_USER}`), 'r--');
      }
      // Als het pullaccount de map daadwerkelijk kan lezen (draaien we als root?), dan ook echt testen.
      if (process.getuid?.() === 0) {
        const r = spawnSync('su', ['-s', '/bin/sh', PULL_USER, '-c', `cat ${path.join(dir, dumps[0])} >/dev/null`]);
        assert.equal(r.status, 0, 'pullaccount kon de dump niet lezen');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('export-all-doelenbomen.sh: nieuwe .xlsx (0600) en mappen (0700) leesbaar voor het pullaccount', (t) => {
    if (skipOrFail(t)) return;
    const { tmp, bin } = setupRepo();
    try {
      run(tmp, bin, 'export-all-doelenbomen.sh');
      const boom = path.join(tmp, 'backups', 'tenant', 'boom');
      assert.equal(effective(path.join(boom, 'boom_2026-10-02.xlsx'), `user:${PULL_USER}`), 'r--');
      assert.equal(effective(path.join(boom, 'nieuw'), `user:${PULL_USER}`), 'r-x');
      // Het exportscript laat de database-map met rust (die regelt backup-database.sh, privé).
      assert.equal(effective(path.join(tmp, 'backups', 'database'), 'other:'), 'r-x', 'database/ niet aangeraakt door export');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('zonder pullaccount (bv. lokaal) doet het niets en faalt de back-up niet', (t) => {
    if (skipOrFail(t)) return;
    const { tmp, bin } = setupRepo();
    try {
      const r = spawnSync('bash', ['-c', 'bash deploy/backup-database.sh'], {
        cwd: tmp,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OFFSITE_PULL_USER: 'bestaat-niet-xyz' },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.doesNotMatch(r.stderr, /WAARSCHUWING/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
