// Regressietests voor DOEL-127: scripts/acceptatie.sh zet de stand van main in
// de lokale acceptatieomgeving en schrijft een bewijs dat release.sh eist.
//
// Het echte script draait in een wegwerp-repository (met lokale "origin");
// docker en curl zijn nagemaakt. De nep-docker beantwoordt de psql-aanroepen
// op basis van de SQL, zodat de stappen (bouwen, database, wachtwoord,
// migraties, starten, versie, componentencontrole, telling) na te gaan zijn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
[ "$1" = info ] && exit 0
[ "$1" = compose ] || exit 0
case "$*" in
  *" exec -T db psql "*)
    sql="\${@: -1}"
    case "$sql" in
      "select 1") echo 1 ;;
      *"crypt('changeme', password_hash)"*count*|*count*"crypt('changeme', password_hash)"*) echo "\${STUB_DEFAULTS:-1}" ;;
      "select now()") echo "2026-10-25 10:00:00+00" ;;
      *"select email from users"*) echo "\${ACC_SYSADMIN_EMAIL:-admin@code072.nl}" ;;
      *"dependency_check_runs"*) echo "\${STUB_SBOM_COMMIT}|\${STUB_RUN:-success}" ;;
      *"count(*) filter"*) echo "\${STUB_COUNTS:-0|0|0|1|0}" ;;
      *"select distinct"*) echo "api: kwetsbaar-pakket 1.0.0  (HIGH, GHSA-test-test-0001, opgelost in 1.0.1)" ;;
      *) : ;;
    esac ;;
esac
exit 0
`;

const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
case "$*" in
  */api/health*) echo '{"status":"ok"}' ;;
  */api/version*) echo "{\\"version\\":\\"9.9.9 (\${STUB_VERSION_COMMIT}, 25-10-2026 11:00)\\",\\"gitRef\\":null,\\"omgeving\\":\\"\${STUB_OMGEVING:-acceptatie}\\"}" ;;
esac
`;

// DOEL-131: akkoord = daarna nog een run met --akkoord (input = wat je typt).
type Akkoord = { input?: string; env?: Record<string, string>; twice?: boolean; withoutFirstRun?: boolean };
type Opts = { branch?: string; dirty?: boolean; env?: Record<string, string>; secondRun?: boolean; versionCommit?: string; sbomCommit?: string; akkoord?: Akkoord; args?: string[] };

function runAcceptatie(o: Opts = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doel127-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const calls = path.join(tmp, 'calls.log');
  const baseEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tmp, CALLS: calls,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
    ACC_POLL_SECONDS: '0', ACC_MAX_POLLS: '3', ACC_HEALTH_TRIES: '2',
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
  try {
    mkdirSync(work, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(tmp, 'origin.git')], { env: baseEnv });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(work, '.gitignore'), '/.acceptatie/\n');
    copyFileSync(path.join(repo, 'docker-compose.acc.yml'), path.join(work, 'docker-compose.acc.yml'));
    script(path.join(work, 'scripts', 'acceptatie.sh'), readFileSync(path.join(repo, 'scripts', 'acceptatie.sh'), 'utf8'));
    script(path.join(work, 'scripts', 'build-version.sh'), '#!/usr/bin/env bash\necho "9.9.9 ($(git rev-parse --short HEAD), 25-10-2026 11:00)"\n');
    script(path.join(work, 'scripts', 'db-migrate.sh'), '#!/usr/bin/env bash\necho "db-migrate PSQL=$DB_MIGRATE_PSQL" >> "$CALLS"\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'eerste');
    git('remote', 'add', 'origin', path.join(tmp, 'origin.git'));
    git('push', '-q', '-u', 'origin', 'main');
    if (o.branch) git('checkout', '-q', '-b', o.branch);
    if (o.dirty) writeFileSync(path.join(work, 'los.txt'), 'x\n');
    script(path.join(bin, 'docker'), DOCKER_STUB);
    script(path.join(bin, 'curl'), CURL_STUB);
    const sha = git('rev-parse', 'HEAD');
    const short = git('rev-parse', '--short', 'HEAD');
    const env = { ...baseEnv, STUB_VERSION_COMMIT: o.versionCommit ?? short, STUB_SBOM_COMMIT: o.sbomCommit ?? short, ...o.env };
    const exec = (extra: Record<string, string> = {}, args: string[] = [], input = '') => {
      const res = spawnSync('bash', [path.join(work, 'scripts', 'acceptatie.sh'), ...args], { cwd: work, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60000, input });
      return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
    };
    const first = o.akkoord?.withoutFirstRun ? { status: 0, out: '' } : exec({}, o.args ?? []);
    const accEnvBefore = existsSync(path.join(work, '.acceptatie', 'acc.env')) ? readFileSync(path.join(work, '.acceptatie', 'acc.env'), 'utf8') : '';
    const second = o.secondRun ? exec({ STUB_DEFAULTS: '0' }) : null;
    const akkoordRun = o.akkoord ? exec(o.akkoord.env ?? {}, ['--akkoord'], o.akkoord.input ?? 'akkoord\n') : null;
    const akkoordAgain = o.akkoord?.twice ? exec(o.akkoord.env ?? {}, ['--akkoord'], '') : null;
    const file = (rel: string) => path.join(work, '.acceptatie', rel);
    const readIf = (rel: string) => (existsSync(file(rel)) ? readFileSync(file(rel), 'utf8') : null);
    const mode = (rel: string) => (existsSync(file(rel)) ? (statSync(file(rel)).mode & 0o777) : -1);
    return {
      ...first, second, akkoordRun, akkoordAgain, sha, short, accEnvBefore,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      evidence: readIf(`bewijs-${sha}.txt`), accEnv: readIf('acc.env'), sysadmin: readIf('sysadmin.txt'),
      modes: { evidence: mode(`bewijs-${sha}.txt`), accEnv: mode('acc.env'), sysadmin: mode('sysadmin.txt'), dir: existsSync(path.join(work, '.acceptatie')) ? statSync(path.join(work, '.acceptatie')).mode & 0o777 : -1 },
      gitStatus: git('status', '--porcelain'),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('DOEL-127: scripts/acceptatie.sh', () => {
  it('schone main zonder kwetsbaarheden: bouwt, start, controleert en schrijft GOEDGEKEURD voor precies deze commit', () => {
    const r = runAcceptatie();
    assert.equal(r.status, 0, r.out);
    assert.ok(r.evidence, 'geen bewijsbestand');
    assert.match(r.evidence!, new RegExp(`^commit=${r.sha}$`, 'm'));
    assert.match(r.evidence!, /^resultaat=GOEDGEKEURD$/m);
    assert.match(r.evidence!, /^kritiek=0$/m);
    assert.match(r.evidence!, /^gemiddeld=1$/m, 'gemiddeld/laag worden wel vastgelegd, maar keuren niet af');
    assert.match(r.evidence!, /^gecontroleerd_epoch=\d+$/m);
    // Volgorde: bouwen → database → migraties → alles starten → versie.
    const at = (s: string) => { const i = r.calls.indexOf(s); assert.notEqual(i, -1, `"${s}" ontbreekt:\n${r.calls}`); return i; };
    assert.ok(at(' build') < at('up -d db'));
    assert.ok(at('up -d db') < at('db-migrate'));
    assert.ok(at('db-migrate') < r.calls.lastIndexOf('up -d'));
    assert.ok(r.calls.lastIndexOf('up -d') < at('/api/version'));
    assert.match(r.calls, /docker compose -p doelenboom-acc -f docker-compose\.acc\.yml/);
    assert.match(r.calls, /db-migrate PSQL=docker compose -p doelenboom-acc -f \S+\/docker-compose\.acc\.yml --env-file \S+\/acc\.env exec -T db psql/);
    assert.match(r.out, /Acceptatie GOEDGEKEURD/);
    assert.equal(r.gitStatus, '', 'het script mag de werkmap niet vuil maken (.acceptatie staat in .gitignore)');
  });

  it('(A02) geheimen: willekeurig, lang genoeg, alleen voor de eigenaar leesbaar; het wachtwoord komt niet in de uitvoer', () => {
    const r = runAcceptatie();
    assert.equal(r.status, 0, r.out);
    assert.match(r.accEnv!, /^ACC_POSTGRES_PASSWORD=[A-Za-z0-9]{32}$/m);
    assert.match(r.accEnv!, /^ACC_JWT_SECRET=[A-Za-z0-9]{64}$/m);
    assert.equal(r.modes.accEnv, 0o600);
    assert.equal(r.modes.sysadmin, 0o600);
    assert.equal(r.modes.dir, 0o700);
    const pw = /^Wachtwoord: (\S+)$/m.exec(r.sysadmin!)?.[1];
    assert.ok(pw && /^[A-Za-z0-9]{24}$/.test(pw), r.sysadmin!);
    assert.ok(!r.out.includes(pw!), 'het nieuwe sysadmin-wachtwoord staat in de uitvoer');
    for (const k of ['ACC_POSTGRES_PASSWORD', 'ACC_JWT_SECRET']) {
      const v = new RegExp(`^${k}=(\\S+)$`, 'm').exec(r.accEnv!)![1];
      assert.ok(!r.out.includes(v) && !r.calls.includes(v), `${k} lekt naar uitvoer of commando-regels`);
    }
    // Het standaardwachtwoord wordt vervangen (anders weigert de API in productiemodus te starten, DOEL-23).
    assert.match(r.calls, /update users set password_hash = crypt\('[A-Za-z0-9]{24}', gen_salt\('bf', 12\)\)/);
  });

  it('tweede keer: dezelfde geheimen, en een al vervangen wachtwoord wordt niet opnieuw gezet', () => {
    const r = runAcceptatie({ secondRun: true });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.second?.status, 0, r.second?.out);
    assert.equal(r.accEnv, r.accEnvBefore, 'acc.env is overschreven');
    assert.equal((r.calls.match(/update users set password_hash/g) || []).length, 1);
  });

  it('kritieke/hoge kwetsbaarheden: AFGEKEURD, met de pakketten, en het script faalt', () => {
    const r = runAcceptatie({ env: { STUB_COUNTS: '1|2|0|3|0' } });
    assert.notEqual(r.status, 0);
    assert.match(r.evidence!, /^resultaat=AFGEKEURD$/m);
    assert.match(r.evidence!, /^hoog=2$/m);
    assert.match(r.out, /kwetsbaar-pakket 1\.0\.0 {2}\(HIGH, GHSA-test-test-0001, opgelost in 1\.0\.1\)/);
    assert.match(r.out, /acceptatie AFGEKEURD: 3 kritieke\/hoge\/onbekende/);
  });

  it('"ernst onbekend" keurt ook af (zelfde regel als de kwetsbaarhedenmail)', () => {
    const r = runAcceptatie({ env: { STUB_COUNTS: '0|0|1|0|0' } });
    assert.notEqual(r.status, 0);
    assert.match(r.evidence!, /^resultaat=AFGEKEURD$/m);
  });

  it('componentencontrole mislukt of onvolledig: géén bewijs', () => {
    for (const run of ['failed', 'partial']) {
      const r = runAcceptatie({ env: { STUB_RUN: run } });
      assert.notEqual(r.status, 0);
      assert.match(r.out, new RegExp(`niet volledig gelukt \\(${run}\\)`));
      assert.equal(r.evidence, null, `bij ${run} is er toch een bewijs`);
    }
  });

  it('de controle hoort bij een andere build (oude SBOM): wachten en daarna zonder bewijs stoppen', () => {
    const r = runAcceptatie({ sbomCommit: 'abc1234' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /nog niet klaar/);
    assert.equal(r.evidence, null);
  });

  it('acceptatie draait een andere versie dan deze commit: stoppen, geen bewijs', () => {
    const r = runAcceptatie({ versionCommit: 'abc1234' });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /draait niet op commit/);
    assert.equal(r.evidence, null);
  });

  for (const [name, o, pattern] of [
    ['niet op main', { branch: 'feat/doel-127-x' }, /niet op main/],
    ['vuile werkmap', { dirty: true }, /niet schoon/],
  ] as const) {
    it(`weigert vooraf (${name}): niets gebouwd of gestart`, () => {
      const r = runAcceptatie(o);
      assert.notEqual(r.status, 0);
      assert.match(r.out, pattern);
      assert.doesNotMatch(r.calls, /compose .*(build|up)/);
      assert.equal(r.evidence, null);
    });
  }

  it('ACC_SYSADMIN_EMAIL: geldig adres wordt gebruikt; ongeldig (A03, SQL-injectie) wordt geweigerd', () => {
    const ok = runAcceptatie({ env: { ACC_SYSADMIN_EMAIL: 'charles@example.nl' } });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.calls, /update users set email = 'charles@example\.nl' where email = 'admin@code072\.nl'/);
    const bad = runAcceptatie({ env: { ACC_SYSADMIN_EMAIL: "x'; drop table users; --@example.nl" } });
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /geen geldig e-mailadres/);
    assert.doesNotMatch(bad.calls, /drop table/);
  });
});

// Regressietests voor DOEL-131: na het handmatig testen geef je met
// `acceptatie.sh --akkoord` je akkoord voor productie. Op de oude code falen
// deze tests: die kende geen argumenten ("acceptatie.sh kent geen argumenten").
describe('DOEL-131: scripts/acceptatie.sh --akkoord', () => {
  const ok = (r: { status: number | null; out: string } | null) => { assert.ok(r); assert.equal(r.status, 0, r.out); };
  const refused = (r: { status: number | null; out: string } | null, re: RegExp) => { assert.ok(r); assert.notEqual(r.status, 0, r.out); assert.match(r.out, re); };

  it('na een goedgekeurde run en "akkoord" typen: akkoord achteraan in het bewijs, eerdere regels ongewijzigd', () => {
    const r = runAcceptatie({ akkoord: {}, env: { GIT_COMMITTER_NAME: 't' } });
    ok(r);
    ok(r.akkoordRun);
    assert.match(r.akkoordRun!.out, /Akkoord vastgelegd voor/);
    assert.match(r.evidence!, /^resultaat=GOEDGEKEURD$/m);
    assert.match(r.evidence!, /^akkoord=ja$/m);
    assert.match(r.evidence!, /^akkoord_epoch=\d+$/m);
    assert.match(r.evidence!, /^akkoord_door=[A-Za-z0-9 ._@-]+$/m);
    const lines = r.evidence!.trim().split('\n');
    assert.equal(lines.at(-4), 'akkoord=ja', 'akkoord hoort achteraan te staan');
    assert.equal(r.modes.evidence, 0o600);
  });

  it('nog een keer --akkoord: meldt dat het al gegeven is, vraagt niets', () => {
    const r = runAcceptatie({ akkoord: { twice: true } });
    ok(r.akkoordAgain);
    assert.match(r.akkoordAgain!.out, /was al gegeven/);
    assert.equal((r.evidence!.match(/^akkoord=ja$/gm) || []).length, 1);
  });

  it('iets anders dan precies "akkoord" (of niets) typen: geen akkoord', () => {
    for (const input of ['ja\n', 'Akkoord\n', '\n', '']) {
      const r = runAcceptatie({ akkoord: { input } });
      refused(r.akkoordRun, /Geen akkoord gegeven/);
      assert.doesNotMatch(r.evidence!, /^akkoord=/m, `akkoord vastgelegd na ${JSON.stringify(input)}`);
    }
  });

  it('zonder acceptatierun: geen akkoord mogelijk', () => {
    const r = runAcceptatie({ akkoord: { withoutFirstRun: true } });
    refused(r.akkoordRun, /nog niet in acceptatie geweest/);
    assert.equal(r.evidence, null);
  });

  it('afgekeurde acceptatie: geen akkoord mogelijk', () => {
    const r = runAcceptatie({ env: { STUB_COUNTS: '0|1|0|0|0' }, akkoord: {} });
    refused(r.akkoordRun, /AFGEKEURD; daar kun je geen akkoord op geven/);
    assert.doesNotMatch(r.evidence!, /^akkoord=/m);
  });

  it('acceptatie draait inmiddels iets anders: geen akkoord (je hebt iets anders getest)', () => {
    const r = runAcceptatie({ akkoord: { env: { STUB_VERSION_COMMIT: 'abc1234' } } });
    refused(r.akkoordRun, /draait niet op commit/);
    assert.doesNotMatch(r.evidence!, /^akkoord=/m);
  });

  it('het adres meldt zich niet als acceptatie (bv. de dev-stack): geen akkoord', () => {
    const r = runAcceptatie({ akkoord: { env: { STUB_OMGEVING: 'ontwikkeling' } } });
    refused(r.akkoordRun, /niet als acceptatieomgeving/);
  });

  it('(A03) een git-naam met een regeleinde kan geen extra regel in het bewijs zetten', () => {
    // git config user.name wordt in de test via GIT_CONFIG_* op /dev/null gezet; we
    // controleren daarom het filter zelf in de brontekst én dat de uitkomst één regel is.
    const src = readFileSync(path.join(repo, 'scripts', 'acceptatie.sh'), 'utf8');
    assert.match(src, /tr -cd 'A-Za-z0-9 \._@-'/);
    const r = runAcceptatie({ akkoord: {} });
    assert.equal((r.evidence!.match(/^resultaat=/gm) || []).length, 1);
  });

  it('onbekende optie of twee opties: weigert, niets gebouwd', () => {
    const r = runAcceptatie({ args: ['--overslaan'] });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /Onbekende optie: --overslaan/);
    assert.doesNotMatch(r.calls, /compose .*(build|up)/);
    const h = runAcceptatie({ args: ['-h'] });
    assert.equal(h.status, 0, h.out);
    assert.match(h.out, /--akkoord/);
  });
});
