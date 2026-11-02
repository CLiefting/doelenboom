// Regressietests voor DOEL-133: scripts/kluis.sh en scripts/kluis-backup.sh.
//
// De echte scripts draaien in een wegwerp-repository met een tag; docker,
// curl, age, nc, rsync, launchctl en osascript zijn nagemaakt en schrijven wat
// ze moesten doen in één log. Zo is na te gaan: inrichten (geheimen, rechten,
// geen demo-data), bijwerken (alleen goedgekeurde acceptatie-images met
// akkoord, eerst een back-up, dan omtaggen, migreren, starten), back-up
// (dump, Excel, bewaartermijn, versleuteld naar de NAS) en de hersteltest.
// Op de oude code falen al deze tests: de scripts bestonden niet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$1" in
  info) exit 0 ;;
  tag|rm) exit 0 ;;
  run) echo "container-id"; exit 0 ;;
  image)
    case "$*" in
      *"--format"*) echo "BUILD_VERSION=\${STUB_ACC_VERSION}"; echo "NODE_ENV=production" ;;
      *) [ -z "\${STUB_NO_IMAGE:-}" ] || exit 1 ;;
    esac
    exit 0 ;;
  exec)
    case "$*" in
      *"-i "*) cat > /dev/null ;;
      *"from doelenbomen"*) echo 3 ;;
      *"from elements"*) echo 42 ;;
    esac
    exit 0 ;;
esac
[ "$1" = compose ] || exit 0
case "$*" in
  *" ps --status running -q web"*) [ -n "\${STUB_RUNNING:-}" ] && echo abc123 ;;
  *" exec -T db pg_dump "*) printf -- '-- PostgreSQL database dump\\ncreate table x ();\\n' ;;
  *" exec -T db psql "*)
    sql="\${@: -1}"
    case "$sql" in
      "select 1") echo 1 ;;
      "select count(*) from users") echo "\${STUB_USERS:-0}" ;;
    esac ;;
esac
exit 0
`;

const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
case "$*" in
  */api/health*) echo '{"status":"ok"}' ;;
  */api/version*) echo "{\\"version\\":\\"9.9.9 (\${STUB_SHORT}, 02-11-2026 12:00)\\",\\"gitRef\\":null,\\"omgeving\\":\\"\${STUB_OMGEVING:-kluis}\\"}" ;;
esac
`;

type Opts = {
  env?: Record<string, string>;
  init?: boolean;              // eerst kluis.sh --init
  evidence?: 'goed' | 'geen' | 'zonder-akkoord';
  extraCommit?: boolean;       // HEAD staat na de tag
  accCommit?: string;          // commit in de BUILD_VERSION van de acceptatie-image
  offsite?: 'uit' | 'aan' | 'onbereikbaar' | 'onveilig';
};

function harness(o: Opts = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doel133-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const home = path.join(tmp, 'kluis-home');
  const backup = path.join(tmp, 'Backups', 'doelenboom-kluis');
  const agents = path.join(tmp, 'LaunchAgents');
  const calls = path.join(tmp, 'calls.log');
  const baseEnv: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tmp, CALLS: calls,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
    KLUIS_HOME: home, KLUIS_BACKUP_DIR: backup, KLUIS_LAUNCH_AGENTS: agents, KLUIS_HEALTH_TRIES: '2',
  };
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: work, encoding: 'utf8', env: baseEnv });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const script = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  mkdirSync(work, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(work, '.gitignore'), '/.acceptatie/\n');
  copyFileSync(path.join(repo, 'docker-compose.kluis.yml'), path.join(work, 'docker-compose.kluis.yml'));
  for (const s of ['kluis.sh', 'kluis-backup.sh']) script(path.join(work, 'scripts', s), readFileSync(path.join(repo, 'scripts', s), 'utf8'));
  script(path.join(work, 'scripts', 'build-version.sh'), '#!/usr/bin/env bash\necho "9.9.9 ($(git rev-parse --short HEAD), 02-11-2026 12:00)"\n');
  script(path.join(work, 'scripts', 'db-migrate.sh'), '#!/usr/bin/env bash\necho "db-migrate PSQL=$DB_MIGRATE_PSQL" >> "$CALLS"\n');
  mkdirSync(path.join(work, 'db'));
  writeFileSync(path.join(work, 'db', 'init.sql'), '-- schema\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'eerste');
  git('tag', '-a', 'v9.9.9', '-m', 'v9.9.9');
  const sha = git('rev-parse', 'HEAD');
  const short = git('rev-parse', '--short', 'HEAD');
  if (o.extraCommit) git('commit', '-q', '--allow-empty', '-m', 'na de tag');
  const ev = o.evidence ?? 'goed';
  if (ev !== 'geen') {
    mkdirSync(path.join(work, '.acceptatie'), { recursive: true });
    writeFileSync(path.join(work, '.acceptatie', `bewijs-${sha}.txt`), [
      `commit=${sha}`, 'resultaat=GOEDGEKEURD', ...(ev === 'goed' ? ['akkoord=ja'] : []),
    ].join('\n') + '\n');
  }
  script(path.join(bin, 'docker'), DOCKER_STUB);
  script(path.join(bin, 'curl'), CURL_STUB);
  script(path.join(bin, 'age'), '#!/usr/bin/env bash\necho "age $*" >> "$CALLS"\nout=""; while [ $# -gt 1 ]; do [ "$1" = -o ] && out="$2"; shift; done\n{ echo AGE-VERSLEUTELD; } > "$out"\n');
  script(path.join(bin, 'nc'), `#!/usr/bin/env bash\necho "nc $*" >> "$CALLS"\nexit ${o.offsite === 'onbereikbaar' ? 1 : 0}\n`);
  script(path.join(bin, 'rsync'), '#!/usr/bin/env bash\necho "rsync $*" >> "$CALLS"\nexit 0\n');
  script(path.join(bin, 'launchctl'), '#!/usr/bin/env bash\necho "launchctl $*" >> "$CALLS"\n');
  script(path.join(bin, 'osascript'), '#!/usr/bin/env bash\necho "osascript $*" >> "$CALLS"\n');
  const env: Record<string, string> = { ...baseEnv, STUB_ACC_VERSION: `9.9.8 (${o.accCommit ?? short}, 02-11-2026 10:00)`, STUB_SHORT: short, ...o.env };

  const run = (args: string[], extra: Record<string, string> = {}, file = 'kluis.sh') => {
    const res = spawnSync('bash', [path.join(work, 'scripts', file), ...args], { cwd: work, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60000 });
    return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
  };
  if (o.init) {
    const r = run(['--init'], { KLUIS_SYSADMIN_EMAIL: 'charles@example.nl' });
    assert.equal(r.status, 0, r.out);
    if (o.offsite && o.offsite !== 'uit') {
      const kenv = path.join(home, 'kluis.env');
      const pad = o.offsite === 'onveilig' ? 'x;touch /tmp/pwned' : 'doelenboom-kluis';
      writeFileSync(kenv, readFileSync(kenv, 'utf8')
        .replace(/^KLUIS_AGE_ONTVANGER=.*$/m, `KLUIS_AGE_ONTVANGER=age1${'q'.repeat(58)}`)
        .replace(/^KLUIS_NAS_PAD=.*$/m, `KLUIS_NAS_PAD=${pad}`));
      writeFileSync(path.join(home, 'nas_ed25519'), 'sleutel\n', { mode: 0o600 });
      writeFileSync(path.join(home, 'nas_known_hosts'), '[192.168.178.22]:62022 ssh-ed25519 AAAA\n');
    }
  }
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const mode = (p: string) => (existsSync(p) ? statSync(p).mode & 0o777 : -1);
  return {
    tmp, work, home, backup, agents, sha, short, run, read, mode,
    calls: () => read(calls) ?? '',
    clear: () => writeFileSync(calls, ''),
    dumps: () => (existsSync(path.join(backup, 'database')) ? readdirSync(path.join(backup, 'database')).sort() : []),
    status: () => read(path.join(backup, 'status.txt')) ?? '',
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function withHarness(o: Opts, fn: (h: ReturnType<typeof harness>) => void) {
  const h = harness(o);
  try { fn(h); } finally { h.cleanup(); }
}

describe('DOEL-133: kluis.sh --init', () => {
  it('zonder of met een ongeldig e-mailadres (A03): geweigerd, niets aangemaakt', () => withHarness({}, (h) => {
    assert.match(h.run(['--init']).out, /Geef het e-mailadres/);
    const bad = h.run(['--init'], { KLUIS_SYSADMIN_EMAIL: "x'); drop table users; --@example.nl" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /geen geldig e-mailadres/);
    assert.equal(existsSync(path.join(h.home, 'kluis.env')), false);
    assert.doesNotMatch(h.calls(), /drop table/);
  }));

  it('back-upmap in een cloudmap of in de repo: geweigerd', () => withHarness({}, (h) => {
    for (const dir of [path.join(h.tmp, 'OneDrive', 'x'), path.join(h.tmp, 'Library', 'Mobile Documents', 'x'), path.join(h.work, 'backups')]) {
      const r = h.run(['--init'], { KLUIS_SYSADMIN_EMAIL: 'c@example.nl', KLUIS_BACKUP_DIR: dir });
      assert.notEqual(r.status, 0, dir);
      assert.match(r.out, /cloudmap of in de repo/);
    }
    assert.equal(existsSync(path.join(h.home, 'kluis.env')), false);
  }));

  it('(A02) geheimen willekeurig en alleen voor de eigenaar; één sysadmin, geen demo-data; tweede keer geweigerd', () => withHarness({ init: true }, (h) => {
    const kenv = h.read(path.join(h.home, 'kluis.env'))!;
    assert.match(kenv, /^KLUIS_POSTGRES_PASSWORD=[A-Za-z0-9]{32}$/m);
    assert.match(kenv, /^KLUIS_JWT_SECRET=[A-Za-z0-9]{64}$/m);
    assert.match(kenv, /^KLUIS_NAS_HOST=192\.168\.178\.22$/m, 'offsite-doel is CL-NAS002');
    assert.equal(h.mode(path.join(h.home, 'kluis.env')), 0o600);
    assert.equal(h.mode(h.home), 0o700);
    for (const d of ['', 'database', 'excel', 'offsite']) assert.equal(h.mode(path.join(h.backup, d)), 0o700, d);
    assert.equal(h.mode(path.join(h.home, 'sysadmin.txt')), 0o600);
    assert.match(h.calls(), /insert into users \(email, password_hash, is_sysadmin, must_change_password\) values \('charles@example\.nl', crypt\('[A-Za-z0-9]{24}', gen_salt\('bf', 12\)\), true, false\)/);
    // Alleen db/init.sql in de initdb-map, nooit seed.sql (demo-tenant).
    const compose = readFileSync(path.join(h.work, 'docker-compose.kluis.yml'), 'utf8');
    assert.match(compose, /\.\/db\/init\.sql:\/docker-entrypoint-initdb\.d\/01-init\.sql:ro/);
    assert.doesNotMatch(compose, /seed\.sql:|\.\/db:\/docker-entrypoint-initdb\.d/);
    const again = h.run(['--init'], { KLUIS_SYSADMIN_EMAIL: 'c@example.nl' });
    assert.notEqual(again.status, 0);
    assert.match(again.out, /al ingericht/);
  }));
});

describe('DOEL-133: kluis.sh --bijwerken (altijd de versie van productie)', () => {
  const noUpdate = (h: ReturnType<typeof harness>) => {
    assert.doesNotMatch(h.calls(), /docker tag /);
    assert.doesNotMatch(h.calls(), /db-migrate/);
    assert.equal(existsSync(path.join(h.home, 'versie.env')), false);
  };

  it('zonder --init: geweigerd', () => withHarness({}, (h) => {
    const r = h.run(['--bijwerken']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nog niet ingericht/);
  }));

  it('niet op de commit van de tag: geweigerd (migraties moeten van die versie zijn)', () => withHarness({ init: true, extraCommit: true }, (h) => {
    const r = h.run(['--bijwerken', 'v9.9.9']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /niet op de commit van v9\.9\.9/);
    noUpdate(h);
  }));

  for (const ev of ['geen', 'zonder-akkoord'] as const) {
    it(`acceptatiebewijs ${ev}: geweigerd, niets omgetagd of gemigreerd`, () => withHarness({ init: true, evidence: ev }, (h) => {
      const r = h.run(['--bijwerken']);
      assert.notEqual(r.status, 0);
      assert.match(r.out, ev === 'geen' ? /Geen acceptatiebewijs/ : /geen akkoord/);
      noUpdate(h);
    }));
  }

  it('acceptatie-images van een andere commit: geweigerd', () => withHarness({ init: true, accCommit: 'abc1234' }, (h) => {
    const r = h.run(['--bijwerken']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /horen bij een andere commit \(9\.9\.8 \(abc1234/);
    noUpdate(h);
  }));

  it('goedgekeurd met akkoord: eerst back-up, dan omtaggen, migreren, starten; tweede keer niets', () => withHarness({ init: true }, (h) => {
    h.clear();
    const r = h.run(['--bijwerken']);
    assert.equal(r.status, 0, r.out);
    const c = h.calls();
    const at = (s: string) => { const i = c.indexOf(s); assert.notEqual(i, -1, `"${s}" ontbreekt:\n${c}`); return i; };
    assert.ok(at('exec -T db pg_dump') < at('docker tag doelenboom-acc-api:latest doelenboom-kluis-api:v9.9.9'));
    assert.ok(at('docker tag doelenboom-acc-web:latest doelenboom-kluis-web:v9.9.9') < at('db-migrate'));
    assert.ok(at('docker tag doelenboom-acc-excel-service:latest doelenboom-kluis-excel-service:v9.9.9') < at('db-migrate'));
    assert.match(c, /db-migrate PSQL=docker compose -p doelenboom-kluis -f \S+\/docker-compose\.kluis\.yml --env-file \S+\/kluis\.env exec -T db psql/);
    assert.ok(at('db-migrate') < c.lastIndexOf(' up -d\n'));
    assert.doesNotMatch(c, / build\b|--build|docker pull/, 'in de kluis wordt nooit gebouwd of gedownload');
    const versie = h.read(path.join(h.home, 'versie.env'))!;
    assert.match(versie, /^KLUIS_VERSIE=v9\.9\.9$/m);
    assert.match(versie, new RegExp(`^KLUIS_COMMIT=${h.sha}$`, 'm'));
    assert.match(versie, new RegExp(`^KLUIS_BUILD_VERSION="9\\.9\\.9 \\(${h.short}, 02-11-2026 12:00\\)"$`, 'm'));
    const dump = h.dumps().find((f) => f.endsWith('-voor-update.sql.gz'));
    assert.ok(dump, h.dumps().join(','));
    assert.equal(h.mode(path.join(h.backup, 'database', dump!)), 0o600);
    assert.ok(h.dumps().includes(`${dump}.sha256`));
    assert.match(r.out, /Kluis bijgewerkt naar v9\.9\.9/);
    h.clear();
    const again = h.run(['--bijwerken']);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /staat al op v9\.9\.9/);
    assert.doesNotMatch(h.calls(), /docker tag|pg_dump/);
  }));

  it('na het starten meldt het adres zich niet als kluis: fout', () => withHarness({ init: true, env: { STUB_OMGEVING: 'acceptatie' } }, (h) => {
    const r = h.run(['--bijwerken']);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /meldt zich niet als kluis/);
  }));
});

describe('DOEL-133: kluis.sh --start / --status', () => {
  it('--start zonder versie: geweigerd; --status toont dat de kluis achterloopt', () => withHarness({ init: true }, (h) => {
    assert.match(h.run(['--start']).out, /nog geen versie/);
    const s = h.run(['--status']);
    assert.match(s.out, /Kluis-versie:\s+nog geen/);
    assert.match(s.out, /loopt niet gelijk met productie\. Bijwerken:  bash scripts\/kluis\.sh --bijwerken v9\.9\.9/);
  }));
});

describe('DOEL-133: kluis-backup.sh', () => {
  const setVersie = (h: ReturnType<typeof harness>) =>
    writeFileSync(path.join(h.home, 'versie.env'), `KLUIS_VERSIE=v9.9.9\nKLUIS_COMMIT=${h.sha}\n`);

  it('volledige back-up (kluis draaide niet): starten, dump, Excel, weer stoppen; offsite nog niet ingesteld', () => withHarness({ init: true }, (h) => {
    setVersie(h);
    h.clear();
    const r = h.run([], {}, 'kluis-backup.sh');
    assert.equal(r.status, 0, r.out);
    const c = h.calls();
    const at = (s: string) => { const i = c.indexOf(s); assert.notEqual(i, -1, `"${s}" ontbreekt:\n${c}`); return i; };
    assert.ok(at(' up -d\n') < at('exec -T db pg_dump'));
    assert.ok(at('exec -T db pg_dump') < at('exec -T api node dist/scripts/exportAllDoelenbomen.js'));
    assert.ok(at('exportAllDoelenbomen') < at(' stop\n'));
    const dump = h.dumps().find((f) => /^doelenboom-kluis-\d{8}-\d{6}\.sql\.gz$/.test(f));
    assert.ok(dump);
    assert.equal(h.mode(path.join(h.backup, 'database', dump!)), 0o600);
    assert.match(h.status(), /^laatste_backup_resultaat=ok$/m);
    assert.match(h.status(), /^offsite_resultaat=niet ingesteld$/m);
    assert.doesNotMatch(c, /rsync/);
  }));

  it('draaide de kluis al, dan wordt hij niet gestopt', () => withHarness({ init: true, env: { STUB_RUNNING: '1' } }, (h) => {
    setVersie(h);
    h.clear();
    assert.equal(h.run([], {}, 'kluis-backup.sh').status, 0);
    assert.doesNotMatch(h.calls(), / up -d\n| stop\n/);
  }));

  it('(A02) offsite: alles eerst versleuteld met age, alleen offsite/ gaat naar CL-NAS002 met vaste sleutel en known_hosts', () => withHarness({ init: true, offsite: 'aan' }, (h) => {
    setVersie(h);
    mkdirSync(path.join(h.backup, 'excel', 't', 'b'), { recursive: true });
    writeFileSync(path.join(h.backup, 'excel', 't', 'b', 'b_2026-11-02.xlsx'), 'xlsx');
    h.clear();
    const r = h.run([], {}, 'kluis-backup.sh');
    assert.equal(r.status, 0, r.out);
    const c = h.calls();
    assert.match(c, /age -r age1q{58} -o \S+\/offsite\/database\/doelenboom-kluis-\S+\.sql\.gz\.age\.tmp /);
    assert.match(c, /age -r age1q{58} -o \S+\/offsite\/excel\/t\/b\/b_2026-11-02\.xlsx\.age\.tmp /);
    assert.equal(readFileSync(path.join(h.backup, 'offsite', 'excel', 't', 'b', 'b_2026-11-02.xlsx.age'), 'utf8'), 'AGE-VERSLEUTELD\n');
    const rs = c.split('\n').find((l) => l.startsWith('rsync '))!;
    assert.ok(rs, c);
    assert.match(rs, /-p 62022 /);
    assert.match(rs, /-o StrictHostKeyChecking=yes -o UserKnownHostsFile=\S+\/nas_known_hosts/);
    assert.match(rs, /-o BatchMode=yes/);
    assert.match(rs, /\/offsite\/ doelenboom-kluis@192\.168\.178\.22:doelenboom-kluis\/$/);
    assert.match(h.status(), /^offsite_resultaat=ok$/m);
    assert.match(h.status(), /^laatste_offsite_epoch=\d+$/m);
    h.clear();
    assert.equal(h.run([], {}, 'kluis-backup.sh').status, 0);
    assert.doesNotMatch(h.calls(), /age -r \S+ -o \S+b_2026-11-02\.xlsx/, 'al versleutelde bestanden niet opnieuw');
  }));

  it('NAS niet bereikbaar (Mac niet thuis): back-up gaat door, offsite overgeslagen', () => withHarness({ init: true, offsite: 'onbereikbaar' }, (h) => {
    setVersie(h);
    const r = h.run([], {}, 'kluis-backup.sh');
    assert.equal(r.status, 0, r.out);
    assert.match(h.status(), /^laatste_backup_resultaat=ok$/m);
    assert.match(h.status(), /^offsite_resultaat=overgeslagen: NAS niet bereikbaar$/m);
    assert.doesNotMatch(h.calls(), /rsync/);
  }));

  it('(A03) een NAS-pad met shell-tekens: geen rsync, offsite fout, melding', () => withHarness({ init: true, offsite: 'onveilig' }, (h) => {
    setVersie(h);
    h.run([], {}, 'kluis-backup.sh');
    assert.doesNotMatch(h.calls(), /rsync/);
    assert.match(h.status(), /^offsite_resultaat=fout: ongeldige NAS-instelling$/m);
    assert.match(h.calls(), /osascript .*offsite-kopie van de kluis is mislukt/);
  }));

  it('bewaartermijn: gewone dumps 14 dagen, dumps van vóór een update 30 dagen', () => withHarness({ init: true }, (h) => {
    setVersie(h);
    const db = path.join(h.backup, 'database');
    const old = (name: string, days: number) => {
      const p = path.join(db, name);
      writeFileSync(p, 'x');
      writeFileSync(`${p}.sha256`, 'x');
      const t = Date.now() / 1000 - days * 86400;
      utimesSync(p, t, t);
    };
    old('doelenboom-kluis-20261001-123000.sql.gz', 20);
    old('doelenboom-kluis-20261025-123000.sql.gz', 5);
    old('doelenboom-kluis-20261001-090000-voor-update.sql.gz', 20);
    old('doelenboom-kluis-20260901-090000-voor-update.sql.gz', 40);
    assert.equal(h.run([], {}, 'kluis-backup.sh').status, 0);
    const d = h.dumps();
    assert.ok(!d.includes('doelenboom-kluis-20261001-123000.sql.gz') && !d.includes('doelenboom-kluis-20261001-123000.sql.gz.sha256'));
    assert.ok(d.includes('doelenboom-kluis-20261025-123000.sql.gz'));
    assert.ok(d.includes('doelenboom-kluis-20261001-090000-voor-update.sql.gz'));
    assert.ok(!d.includes('doelenboom-kluis-20260901-090000-voor-update.sql.gz'));
  }));

  it('--controle: te oude back-up geeft een macOS-melding', () => withHarness({ init: true }, (h) => {
    setVersie(h);
    assert.equal(h.run([], {}, 'kluis-backup.sh').status, 0);
    h.clear();
    const fine = h.run(['--controle'], {}, 'kluis-backup.sh');
    assert.doesNotMatch(fine.out, /LET OP: Laatste back-up/);
    const later = String(Math.floor(Date.now() / 1000) + 3 * 86400);
    const r = h.run(['--controle'], { KLUIS_NU: later }, 'kluis-backup.sh');
    assert.match(r.out, /LET OP: Laatste back-up van de kluis is ouder dan 2 dagen/);
    assert.match(h.calls(), /osascript -e display notification "Laatste back-up van de kluis is ouder dan 2 dagen\."/);
  }));

  it('--installeer-planning: launchd dagelijks 12:30 met dit script', () => withHarness({ init: true }, (h) => {
    const r = h.run(['--installeer-planning'], {}, 'kluis-backup.sh');
    assert.equal(r.status, 0, r.out);
    const plist = h.read(path.join(h.agents, 'nl.code072.doelenboom-kluis-backup.plist'))!;
    assert.match(plist, /<key>Hour<\/key><integer>12<\/integer><key>Minute<\/key><integer>30<\/integer>/);
    assert.match(plist, new RegExp(`<string>${h.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/kluis-backup\\.sh</string>`));
    assert.match(h.calls(), /launchctl bootstrap gui\/\d+ \S+nl\.code072\.doelenboom-kluis-backup\.plist/);
  }));
});

describe('DOEL-133: kluis.sh --herstel-test', () => {
  it('zet de laatste dump terug in een wegwerpdatabase, telt en ruimt op', () => withHarness({ init: true }, (h) => {
    writeFileSync(path.join(h.home, 'versie.env'), `KLUIS_VERSIE=v9.9.9\nKLUIS_COMMIT=${h.sha}\n`);
    assert.equal(h.run([], {}, 'kluis-backup.sh').status, 0);
    h.clear();
    const r = h.run(['--herstel-test']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Teruggezet: 3 doelenbomen, 42 elementen\./);
    assert.match(r.out, /Hersteltest GESLAAGD/);
    const c = h.calls();
    assert.match(c, /docker run -d --rm --name doelenboom-kluis-hersteltest .*postgres:18-alpine/);
    assert.doesNotMatch(c.split('\n').find((l) => l.startsWith('docker run'))!, / -p | -v /, 'wegwerpdatabase zonder poort of volume');
    assert.ok(c.trimEnd().split('\n').at(-1)!.startsWith('docker rm -f doelenboom-kluis-hersteltest'), 'opgeruimd');
    assert.match(h.status(), /^laatste_hersteltest_op=.* \(3 doelenbomen, 42 elementen\)$/m);
  }));
});
