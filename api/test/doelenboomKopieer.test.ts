// DOEL-104: scripts/doelenboom-kopieer.sh van begin tot eind.
//
// Het script praat met Docker (lokaal), ssh/scp en Docker op de VPS. Hier
// draait het ECHTE script met nagemaakte docker/ssh/scp die het werk
// doorgeven aan de echte export- en importcommando's tegen de testdatabase:
//  - ssh voert het meegegeven commando uit in een nagemaakte thuismap, met het
//    script op de standaardinvoer, precies zoals `ssh host "bash -s -- ..."`;
//  - de nagemaakte back-up leest de standaardinvoer leeg (zie DOEL-108).
// Zo is ook het quoten van waarden met spaties en tekens ("OVpay @ NS") echt getest.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { closePool, cleanupByPrefix, createUser, unique } from './helpers.js';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(api, '..');
const scriptPath = path.join(repo, 'scripts', 'doelenboom-kopieer.sh');
const src = readFileSync(scriptPath, 'utf8');

const PREFIX = unique('kopie');
const ADMIN = `${PREFIX}-admin@example.test`;
const SRC_TENANT = `${PREFIX} Bron`;
const SRC_BOOM = `OVpay @ NS's "boom"`;
let sourceBoomId = 0;

async function q(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows;
}

interface RunOptions { answer?: string; vps?: string | null; admin?: string | null; importAvailable?: boolean }

function run(args: string[], o: RunOptions = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doel104-'));
  const bin = path.join(tmp, 'bin');
  const vpsHome = path.join(tmp, 'vps-home');
  const container = path.join(tmp, 'container'); // de api-container: wel src, geen dist
  const log = path.join(tmp, 'calls.log');
  const script = (file: string, body: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  mkdirSync(container, { recursive: true });
  for (const name of ['src', 'node_modules', 'package.json', 'tsconfig.json']) symlinkSync(path.join(api, name), path.join(container, name));
  script(path.join(vpsHome, 'doelenboom', 'deploy', 'backup-database.sh'), `cat > /dev/null\necho "backup" >> "${log}"`);
  script(path.join(bin, 'scp'), [
    `echo "scp $*" >> "${log}"`,
    'src="$2"; dst="${3#*:}"',
    `cp "$src" "${vpsHome}/$dst"`,
  ].join('\n'));
  // ssh host "commando": het commando gaat door een shell, de standaardinvoer gaat mee.
  script(path.join(bin, 'ssh'), [
    `echo "ssh $1" >> "${log}"`,
    `cd "${vpsHome}" && HOME="${vpsHome}" exec bash -c "$2"`,
  ].join('\n'));
  script(path.join(bin, 'docker'), [
    `echo "docker $*" >> "${log}"`,
    '[ "$1" = "info" ] && exit 0',
    'while [ $# -gt 0 ] && [ "$1" != "api" ]; do shift; done',
    'shift',
    `cd "${container}"`,
    'case "$1" in',
    '  true) exit 0 ;;',
    `  test) exit ${o.importAvailable === false ? 1 : 0} ;;`,
    '  sh) exec "$@" ;;',
    '  node) shift; f="${1#dist/}"; shift; exec npx tsx "src/${f%.js}.ts" "$@" ;;',
    'esac',
    'echo "onverwachte docker-aanroep" >&2; exit 99',
  ].join('\n'));
  const answer = path.join(tmp, 'antwoord');
  writeFileSync(answer, `${o.answer ?? 'ja'}\n`);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: tmp,
    TMPDIR: tmp,
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    JWT_SECRET: process.env.JWT_SECRET ?? 'x',
    DOELENBOOM_KOPIEER_TTY: answer,
  };
  if (o.vps !== null) env.VPS = o.vps ?? 'beheer@vps.example.test';
  if (o.admin !== null) env.DOELENBOOM_ADMIN_EMAIL = o.admin ?? ADMIN;
  try {
    const res = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', timeout: 90000, env, cwd: tmp });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* niets aangeroepen */ }
    return {
      status: res.status, out: `${res.stdout}\n${res.stderr}`, calls,
      bundlesLeftOnVps: readdirSync(vpsHome).filter((f) => f.startsWith('doelenboom-kopie-')),
      localLeftovers: readdirSync(tmp).filter((f) => f.startsWith('tmp.')),
      strayFiles: [tmp, vpsHome, container, path.join(vpsHome, 'doelenboom')].flatMap((d) => readdirSync(d).filter((f) => f.startsWith('PWNED'))),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const elementCodes = async (tenantName: string, boomName: string) =>
  (await q(
    `select e.code from elements e join doelenbomen d on d.id = e.doelenboom_id join tenants t on t.id = d.tenant_id
     where t.name = $1 and d.name = $2 order by e.code`, [tenantName, boomName])).map((r) => r.code as string);

before(async () => {
  await createUser(ADMIN);
  const [tenant] = await q(`insert into tenants (slug, name) values ($1, $2) returning id`, [`${PREFIX}-bron`, SRC_TENANT]);
  const [boom] = await q(`insert into doelenbomen (tenant_id, slug, name) values ($1, 'ovpay-ns', $2) returning id`, [tenant.id, SRC_BOOM]);
  sourceBoomId = Number(boom.id);
  const [cfg] = await q(`insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', $1, $2) returning id`, [tenant.id, boom.id]);
  await q(`insert into columns (column_config_id, position, type_name, title, color) values ($1, 1, 'A', 'Ambitie', '#112233')`, [cfg.id]);
  const els = await q(
    `insert into elements (doelenboom_id, code, type, name) values ($1, 'A1', 'A', 'Eén'), ($1, 'A2', 'A', 'Twee') returning id`, [boom.id]);
  await q(`insert into edges (doelenboom_id, source_element_id, target_element_id) values ($1, $2, $3)`, [boom.id, els[0].id, els[1].id]);
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await closePool();
});

describe('doelenboom-kopieer.sh: hulp en parameters', () => {
  it('-h en --help lichten elke parameter toe en doen verder niets', () => {
    for (const flag of ['-h', '--help']) {
      const r = run([flag], { vps: null, admin: null });
      assert.equal(r.status, 0, r.out);
      for (const word of ['--tenant', '--boom', '--naar-tenant', '--naar-boom', '--naar-tenant-slug', '--naar-boom-slug',
        '--overschrijven', '--dry-run', '--admin', '--help', 'VPS=', 'DOELENBOOM_ADMIN_EMAIL', 'VOORBEELDEN']) {
        assert.ok(r.out.includes(word), `${word} ontbreekt in de uitleg`);
      }
      assert.equal(r.calls, '', 'help mag niets aanroepen');
    }
    // --help wint ook als er verder iets niet klopt.
    assert.equal(run(['--tenant', 'x', '--help'], { vps: null }).status, 0);
  });

  it('zonder parameters: de uitleg, met een foutcode', () => {
    const r = run([]);
    assert.equal(r.status, 1);
    assert.match(r.out, /GEBRUIK/);
  });

  it('foute of onvolledige parameters worden geweigerd vóór er iets wordt aangeroepen', () => {
    const cases: [string[], RunOptions, RegExp][] = [
      [['--tenant', 'a'], {}, /--boom ontbreekt/],
      [['--boom', 'b'], {}, /--tenant ontbreekt/],
      [['--tenant', 'a', '--boom', 'b', '--bestaat-niet'], {}, /Onbekende optie: --bestaat-niet/],
      [['--tenant', 'a', '--boom'], {}, /--boom mist een waarde/],
      [['--tenant', '--boom', 'b'], {}, /--tenant mist een waarde/],
      [['--tenant', 'a', '--boom', 'b', '--naar-boom-slug', 'Niet Goed'], {}, /slug mag alleen/],
      [['--tenant', 'a', '--boom', 'b', '--naar-tenant-slug', 'x;id'], {}, /slug mag alleen/],
      [['--tenant', 'a', '--boom', 'b'], { vps: null }, /Zet eerst VPS=/],
      [['--tenant', 'a', '--boom', 'b'], { admin: null }, /Geen admin-account/],
      [['--tenant', 'a', '--boom', 'b', '--admin', 'geen-adres'], {}, /geen e-mailadres/],
      [['--tenant', 'a\nb', '--boom', 'b'], {}, /stuurteken/],
    ];
    for (const [args, o, re] of cases) {
      const r = run(args, o);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, re);
      assert.equal(r.calls, '', `${args.join(' ')}: er is toch iets aangeroepen:\n${r.calls}`);
    }
  });
});

describe('doelenboom-kopieer.sh: kopiëren', () => {
  const T1 = `${PREFIX} NS`;

  it('--dry-run: toont het plan, wijzigt niets en ruimt de bundel op', async () => {
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', T1, '--naar-boom', 'OVpay', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PROEFRUN: alles is uitgevoerd en teruggedraaid/);
    assert.match(r.out, /WORDT AANGEMAAKT/);
    assert.match(r.out, /TELLING columns=1 elements=2 edges=1 /);
    assert.equal((await q('select count(*)::int as n from tenants where name = $1', [T1]))[0].n, 0);
    assert.deepEqual(r.bundlesLeftOnVps, []);
    assert.deepEqual(r.localLeftovers, []);
    assert.ok(!r.calls.includes('backup'));
  });

  it("antwoord anders dan 'ja': afgebroken, niets gewijzigd, bundel opgeruimd", async () => {
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', T1, '--naar-boom', 'OVpay'], { answer: 'nee' });
    assert.equal(r.status, 1);
    assert.match(r.out, /Afgebroken; er is op de VPS niets gewijzigd/);
    assert.equal((await q('select count(*)::int as n from tenants where name = $1', [T1]))[0].n, 0);
    assert.deepEqual(r.bundlesLeftOnVps, []);
  });

  it('andere namen op de VPS (met spaties en aanhalingstekens in de bron): tenant en boom aangemaakt, admin toegewezen', async () => {
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', T1, '--naar-boom', 'OVpay']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /IMPORT-OK/);
    assert.match(r.out, /Aantallen en controlesom van bron en doel komen overeen/);
    assert.deepEqual(await elementCodes(T1, 'OVpay'), ['A1', 'A2']);
    const [m] = await q(
      `select tu.role, t.slug from tenant_users tu join tenants t on t.id = tu.tenant_id join users u on u.id = tu.user_id
       where t.name = $1 and u.email = $2`, [T1, ADMIN]);
    assert.equal(m.role, 'admin');
    assert.deepEqual(r.bundlesLeftOnVps, []);
    assert.deepEqual(r.localLeftovers, []);
    assert.ok(!r.calls.includes('backup'), 'geen back-up nodig zonder --overschrijven');
    // De bron is alleen gelezen.
    assert.equal((await q('select count(*)::int as n from elements where doelenboom_id = $1', [sourceBoomId]))[0].n, 2);
  });

  it('bestaat al: geweigerd zonder --overschrijven; mét wordt eerst een back-up gemaakt en dan vervangen', async () => {
    await q(
      `insert into elements (doelenboom_id, code, type, name)
       select d.id, 'Z9', 'A', 'Alleen op de VPS' from doelenbomen d join tenants t on t.id = d.tenant_id where t.name = $1 and d.name = 'OVpay'`, [T1]);
    const args = ['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', T1, '--naar-boom', 'OVpay'];

    const refused = run(args);
    assert.equal(refused.status, 1);
    assert.match(refused.out, /bestaat al .*--overschrijven/);
    assert.match(refused.out, /Er is op de VPS niets gewijzigd/);
    assert.deepEqual(await elementCodes(T1, 'OVpay'), ['A1', 'A2', 'Z9']);
    assert.deepEqual(refused.bundlesLeftOnVps, []);

    const r = run([...args, '--overschrijven']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /inhoud VERVANGEN/);
    assert.deepEqual(await elementCodes(T1, 'OVpay'), ['A1', 'A2']);
    const lines = r.calls.split('\n');
    const backup = lines.indexOf('backup');
    const realImport = lines.findIndex((l) => l.includes('doelenboomImport.js') && !l.includes('--dry-run') && !l.includes(' test '));
    assert.ok(backup !== -1 && realImport !== -1 && backup < realImport, `back-up hoort vóór de echte import:\n${r.calls}`);
    assert.match(r.out, /IMPORT-OK/, 'na de back-up (die de standaardinvoer leegleest, DOEL-108) moet de import nog draaien');
  });

  it('zonder --naar-*: dezelfde namen op de VPS', async () => {
    // Zelfde database in de test, dus dezelfde namen = de bron zelf: dat is "bestaat al".
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM]);
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`Naar \\(.*\\): tenant "${SRC_TENANT}", doelenboom "OVpay @ NS's \\"boom\\""`));
    assert.match(r.out, /bestaat al/);
  });

  it('A03: een waarde met shell-tekens wordt nergens uitgevoerd, ook niet op de VPS', async () => {
    const evil = `x'; touch PWNED1; $(touch PWNED2) \`touch PWNED3\` "`;
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', T1, '--naar-boom', evil, '--naar-boom-slug', 'eng']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.strayFiles, [], 'er is een commando uit een parameter uitgevoerd');
    assert.deepEqual(await elementCodes(T1, evil), ['A1', 'A2'], 'de waarde hoort letterlijk als naam aan te komen');
  });

  it('VPS met een oudere versie (geen importcommando): duidelijke melding, niets gewijzigd', () => {
    const r = run(['--tenant', SRC_TENANT, '--boom', SRC_BOOM, '--naar-tenant', `${PREFIX} Oud`, '--naar-boom', 'K'], { importAvailable: false });
    assert.equal(r.status, 1);
    assert.match(r.out, /kent het importcommando nog niet/);
    assert.deepEqual(r.bundlesLeftOnVps, []);
  });

  it('onbekende lokale boom: stopt bij het exporteren, vóór er iets naar de VPS gaat', () => {
    const r = run(['--tenant', SRC_TENANT, '--boom', 'bestaat-niet']);
    assert.equal(r.status, 1);
    assert.match(r.out, /niet gevonden/);
    assert.ok(!r.calls.includes('scp') && !r.calls.includes('ssh'), r.calls);
  });
});

describe('doelenboom-kopieer.sh: opzet van het deel op de VPS (DOEL-108)', () => {
  const m = src.match(/<<'REMOTE'[^\n]*\n([\s\S]*?)\nREMOTE\n/);
  const remote = m ? m[1] : '';

  it('alles staat in main() met afgesloten standaardinvoer, en stopt bij een fout', () => {
    assert.ok(m, "remote deel (heredoc <<'REMOTE') niet gevonden");
    assert.match(remote, /^set -euo pipefail$/m);
    assert.match(remote, /^main "\$@" < \/dev\/null$/m);
    assert.match(remote, /echo "REMOTE-KLAAR \$MODE"\n\}/);
  });

  it('het lokale script controleert op REMOTE-KLAAR en op IMPORT-OK voor het "Gekopieerd" meldt', () => {
    assert.match(src, /grep -qx "REMOTE-KLAAR \$mode" "\$log" \|\| return 1/);
    assert.ok(src.indexOf("grep -q 'IMPORT-OK'") < src.indexOf('echo "Gekopieerd.'));
  });

  it('geen adres, account of wachtwoord van productie in het script', () => {
    assert.doesNotMatch(src, /[A-Za-z0-9._-]+@(gmail|code072)[A-Za-z0-9.-]*/);
    assert.doesNotMatch(src, /VPS="?\$\{VPS:-[^}]+\}/);
    assert.ok(existsSync(scriptPath));
  });
});
