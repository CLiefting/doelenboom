import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOEL-45: `doelenboom -local -stop`. Het script wordt echt uitgevoerd, met een nagebootste `docker`
// die alleen zijn argumenten logt (er is in de testomgeving geen Docker nodig).

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'scripts', 'doelenboom-cli.sh');

// DOEL-132: opts.accBuilt = er is al eens een acceptatierun geweest (.acceptatie/acc.env +
// bewijs); opts.running = de web-container van de gekozen omgeving draait al.
// Nagebootst: docker, open (browser) en scripts/acceptatie.sh; alles logt in dezelfde log.
// DOEL-135: opts.input = wat je typt (bevestiging), opts.updated = wat psql teruggeeft
// op "update … returning email" (leeg = geen account), opts.env = extra omgevingsvariabelen.
function run(args: string[], opts: { accBuilt?: boolean; running?: boolean; acceptatieFails?: boolean; kluis?: boolean; input?: string; updated?: string; env?: Record<string, string> } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doelenboom-cli-'));
  try {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const log = path.join(tmp, 'docker.log');
    const stub = (file: string, body: string) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); };
    stub(path.join(bin, 'docker'), [
      'echo "$@" >> "$DOCKER_LOG"',
      'case "$*" in *"ps --status running -q web"*) [ -n "$STUB_RUNNING" ] && echo abc123 ;; esac',
      'case "$*" in *" psql "*) cat >> "$DOCKER_LOG.stdin"; printf "%s\\n" "$STUB_UPDATED" ;; esac',
      'exit 0',
    ].join('\n'));
    stub(path.join(bin, 'open'), 'echo "open $*" >> "$DOCKER_LOG"');
    stub(path.join(bin, 'ssh'), 'echo "ssh $*" >> "$DOCKER_LOG"\ncat >> "$DOCKER_LOG.stdin"\nprintf "%s\\n" "$STUB_UPDATED"');
    mkdirSync(path.join(tmp, 'scripts'));
    stub(path.join(tmp, 'scripts', 'acceptatie.sh'), `echo "acceptatie.sh $*" >> "$DOCKER_LOG"\nexit ${opts.acceptatieFails ? 1 : 0}`);
    // DOEL-133: kluis.sh nagebootst; opts.kluis = de kluis is ingericht.
    stub(path.join(tmp, 'scripts', 'kluis.sh'), 'echo "kluis.sh $*" >> "$DOCKER_LOG"');
    writeFileSync(path.join(tmp, 'docker-compose.kluis.yml'), 'services: {}\n');
    if (opts.kluis) {
      mkdirSync(path.join(tmp, 'kluis-home'));
      writeFileSync(path.join(tmp, 'kluis-home', 'kluis.env'), 'KLUIS_POSTGRES_PASSWORD=x\n');
    }
    writeFileSync(path.join(tmp, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(tmp, 'docker-compose.acc.yml'), 'services: {}\n');
    if (opts.accBuilt) {
      mkdirSync(path.join(tmp, '.acceptatie'));
      writeFileSync(path.join(tmp, '.acceptatie', 'acc.env'), 'ACC_POSTGRES_PASSWORD=x\n');
      writeFileSync(path.join(tmp, '.acceptatie', 'bewijs-abc.txt'), 'commit=abc\nbuild_version=4.4.7 (abc1234, 02-11-2026 10:00)\nresultaat=GOEDGEKEURD\n');
      writeFileSync(path.join(tmp, '.acceptatie', 'sysadmin.txt'), 'Acceptatie-sysadmin: charles@example.nl\nWachtwoord: oudwachtwoord\n');
    }
    const r = spawnSync('bash', [cli, ...args], {
      cwd: tmp,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, DOELENBOOM_DIR: tmp, DOCKER_LOG: log, STUB_RUNNING: opts.running ? '1' : '',
        KLUIS_HOME: path.join(tmp, 'kluis-home'), STUB_UPDATED: opts.updated ?? '', DOELENBOOM_RESET_EMAIL: '', VPS: '', ...opts.env,
      },
      input: opts.input ?? '',
      encoding: 'utf8',
    });
    let calls: string[] = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* docker niet aangeroepen */ }
    let stdin = '';
    try { stdin = readFileSync(`${log}.stdin`, 'utf8'); } catch { /* geen psql */ }
    const readIf = (rel: string) => { try { return readFileSync(path.join(tmp, rel), 'utf8'); } catch { return null; } };
    const modeOf = (rel: string) => { try { return statSync(path.join(tmp, rel)).mode & 0o777; } catch { return -1; } };
    const files = {
      dev: readIf('.ontwikkeling/sysadmin.txt'), acc: readIf('.acceptatie/sysadmin.txt'), kluis: readIf('kluis-home/sysadmin.txt'),
      devMode: modeOf('.ontwikkeling/sysadmin.txt'), devDirMode: modeOf('.ontwikkeling'), accMode: modeOf('.acceptatie/sysadmin.txt'),
    };
    return { status: r.status, out: r.stdout, err: r.stderr, calls, stdin, files };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('doelenboom-cli: -stop (DOEL-45)', () => {
  // DOEL-132: standaard is nu acceptatie; deze tests gaan over de ontwikkelomgeving (-dev).
  it('-local -dev -stop stopt de stack (docker compose stop) en start niets', () => {
    const r = run(['-local', '-dev', '-stop']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('compose stop'), `verwacht "compose stop", kreeg: ${r.calls.join(' | ')}`);
    assert.ok(!r.calls.some((c) => c.includes(' up ') || c.startsWith('compose up')), 'stop mag niets starten');
    assert.ok(!r.calls.some((c) => c.includes(' down') || c.startsWith('compose down')), 'stop mag geen down doen (volume/containers behouden)');
    assert.match(r.out, /Klaar\./);
  });

  it('-local -dev -restart werkt nog: bouwt en start (docker compose up -d --build)', () => {
    const r = run(['-local', '-dev', '-restart']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.some((c) => c === 'compose up -d --build'), r.calls.join(' | '));
  });

  it('-stop zonder omgeving wordt geweigerd', () => {
    const r = run(['-stop']);
    assert.equal(r.status, 1);
    assert.match(r.err, /-local of -prod/);
    assert.equal(r.calls.length, 0);
  });

  it('-prod -stop wordt geweigerd (productie blijft handwerk, zie deploy/README.md)', () => {
    const r = run(['-prod', '-stop']);
    assert.equal(r.status, 1);
    assert.match(r.err, /Productie-acties zijn nog niet geautomatiseerd/);
    assert.equal(r.calls.length, 0);
  });

  it('-local -dev -stop -rebuild wordt geweigerd: -rebuild hoort bij -restart', () => {
    const r = run(['-local', '-dev', '-stop', '-rebuild']);
    assert.equal(r.status, 1);
    assert.match(r.err, /hoort bij -restart/);
    assert.equal(r.calls.length, 0);
  });

  it('een onbekende optie noemt -stop bij de bekende opties', () => {
    const r = run(['-local', '-bestaatniet']);
    assert.equal(r.status, 1);
    assert.match(r.err, /Bekende opties:.*-stop/);
  });
});

// Regressietests voor DOEL-132: `doelenboom -local [-acc | -dev | -ont] ...`, standaard acceptatie.
// Op de oude code falen deze tests: die kende -acc/-dev/-ont niet en opende altijd :5173.
describe('doelenboom-cli: lokale omgeving kiezen (DOEL-132)', () => {
  const accCompose = /^compose -p doelenboom-acc -f \S+\/docker-compose\.acc\.yml --env-file \S+\/\.acceptatie\/acc\.env /;

  it('-local -open zonder keuze = acceptatie: draait hij al, dan alleen http://localhost:8088 openen', () => {
    const r = run(['-local', '-open'], { accBuilt: true, running: true });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('open http://localhost:8088'), r.calls.join(' | '));
    assert.ok(!r.calls.some((c) => c.includes(' up ')), `niets starten als hij al draait: ${r.calls.join(' | ')}`);
  });

  it('-local -acc -open, acceptatie draait niet: starten zonder bouwen, dan openen', () => {
    const r = run(['-local', '-acc', '-open'], { accBuilt: true });
    assert.equal(r.status, 0, r.err + r.out);
    const up = r.calls.find((c) => c.includes(' up '));
    assert.ok(up && accCompose.test(up) && up.endsWith('up -d --no-build'), r.calls.join(' | '));
    assert.ok(!r.calls.some((c) => / build\b|--build\b/.test(c)), 'acceptatie mag hier niet gebouwd worden');
    assert.ok(r.calls.indexOf(up!) < r.calls.indexOf('open http://localhost:8088'));
    assert.match(r.out, /Laatste acceptatierun: 4\.4\.7 \(abc1234, 02-11-2026 10:00\) \(GOEDGEKEURD\)/);
  });

  it('acceptatie nog nooit opgebouwd: duidelijke melding, niets gestart of geopend', () => {
    const r = run(['-local', '-open']);
    assert.equal(r.status, 1);
    assert.match(r.err, /nog nooit opgebouwd/);
    assert.match(r.err, /doelenboom -local -acc -restart/);
    assert.ok(!r.calls.some((c) => c.includes(' up ') || c.startsWith('open ')), r.calls.join(' | '));
  });

  it('-local -restart (acceptatie) = scripts/acceptatie.sh, geen eigen docker-build', () => {
    const r = run(['-local', '-restart']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('acceptatie.sh'), r.calls.join(' | '));
    assert.ok(!r.calls.some((c) => c.startsWith('compose') && /up|build/.test(c)), r.calls.join(' | '));
  });

  it('-local -restart -open: na een geslaagde acceptatie http://localhost:8088 openen; mislukt hij, dan niet', () => {
    const ok = run(['-local', '-restart', '-open'], { accBuilt: true, running: true });
    assert.equal(ok.status, 0, ok.err + ok.out);
    assert.ok(ok.calls.indexOf('acceptatie.sh') < ok.calls.indexOf('open http://localhost:8088'), ok.calls.join(' | '));
    const bad = run(['-local', '-restart', '-open'], { accBuilt: true, running: true, acceptatieFails: true });
    assert.notEqual(bad.status, 0);
    assert.ok(!bad.calls.some((c) => c.startsWith('open ')), 'na een afgekeurde acceptatie geen browser');
  });

  it('-local -stop (acceptatie): stopt het acceptatieproject, niet de ontwikkelomgeving', () => {
    const r = run(['-local', '-stop'], { accBuilt: true });
    assert.equal(r.status, 0, r.err + r.out);
    const stop = r.calls.find((c) => c.endsWith(' stop'));
    assert.ok(stop && accCompose.test(stop), r.calls.join(' | '));
    assert.ok(!r.calls.includes('compose stop'), 'de ontwikkelomgeving hoort niet gestopt te worden');
  });

  for (const flag of ['-dev', '-ont']) {
    it(`-local ${flag} -open: draait hij al, dan alleen http://localhost:5173 openen`, () => {
      const r = run(['-local', flag, '-open'], { running: true });
      assert.equal(r.status, 0, r.err + r.out);
      assert.ok(r.calls.includes('open http://localhost:5173'), r.calls.join(' | '));
      assert.ok(!r.calls.some((c) => c.includes('doelenboom-acc') || c.includes(' up ')), r.calls.join(' | '));
    });
  }

  it('-local -ont -open, ontwikkeling draait niet: eerst bouwen en starten (zoals -restart), dan openen', () => {
    const r = run(['-local', '-ont', '-open']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('compose up -d --build'), r.calls.join(' | '));
    assert.ok(r.calls.indexOf('compose up -d --build') < r.calls.indexOf('open http://localhost:5173'));
  });

  it('-acc en -dev (of -ont) samen: geweigerd', () => {
    for (const args of [['-local', '-acc', '-dev', '-open'], ['-local', '-ont', '-acc', '-open']]) {
      const r = run(args);
      assert.equal(r.status, 1);
      assert.match(r.err, /niet meerdere/);
      assert.equal(r.calls.length, 0);
    }
  });

  it('-dev -ont samen mag (zelfde omgeving)', () => {
    const r = run(['-local', '-dev', '-ont', '-open'], { running: true });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('open http://localhost:5173'));
  });

  it('-rebuild bij acceptatie: geweigerd (acceptatie.sh migreert zelf)', () => {
    const r = run(['-local', '-rebuild', '-restart']);
    assert.equal(r.status, 1);
    assert.match(r.err, /-rebuild hoort bij de ontwikkelomgeving/);
    assert.equal(r.calls.length, 0);
  });

  it('-acc/-dev zonder -local: geweigerd', () => {
    for (const args of [['-acc', '-open'], ['-prod', '-dev', '-stop']]) {
      const r = run(args);
      assert.equal(r.status, 1);
      assert.equal(r.calls.length, 0);
    }
  });

  it('de foutmelding bij een onbekende optie noemt -acc, -dev en -ont', () => {
    const r = run(['-local', '-test']);
    assert.match(r.err, /-local \[-acc \| -dev \| -ont \| -kluis\]/);
  });
});

// Regressietests voor DOEL-133: `doelenboom -local -kluis ...` (rode driehoek
// VAULT, :8089). Op de oude code falen deze tests: -kluis was een onbekende optie.
describe('doelenboom-cli: de kluis (DOEL-133)', () => {
  it('-kluis -open, kluis draait niet: starten via kluis.sh --start (niets bouwen), status tonen, :8089 openen', () => {
    const r = run(['-local', '-kluis', '-open'], { kluis: true });
    assert.equal(r.status, 0, r.err + r.out);
    const at = (s: string) => { const i = r.calls.indexOf(s); assert.notEqual(i, -1, `${s}: ${r.calls.join(' | ')}`); return i; };
    assert.ok(at('kluis.sh --start') < at('kluis.sh --status'));
    assert.ok(at('kluis.sh --status') < at('open http://localhost:8089'));
    assert.ok(!r.calls.some((c) => /build|acceptatie\.sh/.test(c)), r.calls.join(' | '));
  });

  it('-kluis -open, kluis draait al: alleen status en openen', () => {
    const r = run(['-local', '-kluis', '-open'], { kluis: true, running: true });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(!r.calls.includes('kluis.sh --start'), r.calls.join(' | '));
    assert.ok(r.calls.includes('open http://localhost:8089'));
  });

  it('-kluis -restart = stoppen en starten met dezelfde images; -kluis -stop = alleen stoppen', () => {
    const r = run(['-local', '-kluis', '-restart'], { kluis: true });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.indexOf('kluis.sh --stop') < r.calls.indexOf('kluis.sh --start'), r.calls.join(' | '));
    const s = run(['-local', '-kluis', '-stop'], { kluis: true });
    assert.equal(s.status, 0, s.err + s.out);
    assert.ok(s.calls.includes('kluis.sh --stop') && !s.calls.includes('kluis.sh --start'), s.calls.join(' | '));
    assert.ok(!s.calls.includes('compose stop'), 'de ontwikkelomgeving hoort niet gestopt te worden');
  });

  it('kluis niet ingericht: duidelijke melding, niets gestart of geopend', () => {
    const r = run(['-local', '-kluis', '-open']);
    assert.equal(r.status, 1);
    assert.match(r.err, /nog niet ingericht/);
    assert.match(r.err, /scripts\/kluis\.sh --init/);
    assert.ok(!r.calls.some((c) => c.startsWith('open ') || c.startsWith('kluis.sh')), r.calls.join(' | '));
  });

  it('-rebuild bij de kluis en -kluis samen met -acc/-dev: geweigerd', () => {
    const rb = run(['-local', '-kluis', '-rebuild', '-restart'], { kluis: true });
    assert.equal(rb.status, 1);
    assert.match(rb.err, /-rebuild hoort niet bij de kluis/);
    for (const other of ['-acc', '-dev', '-ont']) {
      const r = run(['-local', '-kluis', other, '-open'], { kluis: true });
      assert.equal(r.status, 1, other);
      assert.match(r.err, /niet meerdere/);
    }
  });
});

// Regressietests voor DOEL-135: `doelenboom … -reset` zet een nieuw willekeurig
// wachtwoord voor de sysadmin. Ontwikkeling en acceptatie direct; kluis en
// productie pas na "ja" (standaard nee). Op de oude code falen deze tests:
// -reset was een onbekende optie.
describe('doelenboom-cli: -reset (DOEL-135)', () => {
  const PW = /Wachtwoord: ([A-Za-z0-9]{24})\n/;
  const sqlFor = (email: string) => new RegExp(
    `^update users set password_hash = crypt\\('[A-Za-z0-9]{24}', gen_salt\\('bf', 12\\)\\), must_change_password = false where email = '${email.replace(/\./g, '\\.')}' returning email;$`, 'm');

  it('acceptatie (standaard): adres uit .acceptatie/sysadmin.txt, nieuw wachtwoord daarin, getoond', () => {
    const r = run(['-local', '-reset'], { accBuilt: true, updated: 'charles@example.nl' });
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.stdin, sqlFor('charles@example.nl'));
    assert.ok(r.calls.some((c) => /^compose -p doelenboom-acc -f \S+docker-compose\.acc\.yml --env-file \S+acc\.env exec -T db psql -U doelenboom -d doelenboom -X -q -At -v ON_ERROR_STOP=1$/.test(c)), r.calls.join(' | '));
    const pw = PW.exec(r.files.acc ?? '')?.[1];
    assert.ok(pw && pw !== 'oudwachtwoord', r.files.acc ?? '');
    assert.match(r.files.acc!, /^Acceptatie-sysadmin: charles@example\.nl$/m);
    assert.equal(r.files.accMode, 0o600);
    assert.match(r.out, new RegExp(`Wachtwoord: ${pw}`));
  });

  it('(A02) het wachtwoord gaat via de standaardinvoer, niet als argument (processenlijst)', () => {
    const r = run(['-local', '-reset'], { accBuilt: true, updated: 'charles@example.nl' });
    const pw = PW.exec(r.files.acc ?? '')![1];
    assert.ok(r.stdin.includes(pw));
    assert.ok(!r.calls.some((c) => c.includes(pw)), 'wachtwoord staat in een commandoregel');
  });

  it('ontwikkeling: -email=… , dev-database, .ontwikkeling/sysadmin.txt (0600 in map 0700)', () => {
    const r = run(['-local', '-dev', '-reset', '-email=admin@code072.nl'], { updated: 'admin@code072.nl' });
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.stdin, sqlFor('admin@code072.nl'));
    assert.ok(r.calls.includes('compose exec -T db psql -U doelenboom -d doelenboom -X -q -At -v ON_ERROR_STOP=1'), r.calls.join(' | '));
    assert.match(r.files.dev ?? '', /^Ontwikkel-sysadmin: admin@code072\.nl\nWachtwoord: [A-Za-z0-9]{24}\n$/);
    assert.equal(r.files.devMode, 0o600);
    assert.equal(r.files.devDirMode, 0o700);
  });

  it('DOELENBOOM_RESET_EMAIL als er geen -email is', () => {
    const r = run(['-local', '-dev', '-reset'], { updated: 'x@example.nl', env: { DOELENBOOM_RESET_EMAIL: 'x@example.nl' } });
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.stdin, sqlFor('x@example.nl'));
  });

  it('geen adres bekend: vraagt om -email, verandert niets', () => {
    const r = run(['-local', '-dev', '-reset']);
    assert.equal(r.status, 1);
    assert.match(r.err, /-email=/);
    assert.equal(r.stdin, '');
  });

  it('(A03) ongeldig adres (SQL-injectie): geweigerd vóór er iets wordt aangeroepen', () => {
    const r = run(['-local', '-dev', '-reset', "-email=x'; drop table users; --@example.nl"]);
    assert.equal(r.status, 1);
    assert.match(r.err, /Geen geldig e-mailadres/);
    assert.equal(r.stdin, '');
    assert.equal(r.files.dev, null);
  });

  it('account bestaat niet: foutmelding en het oude sysadmin.txt blijft staan', () => {
    const r = run(['-local', '-reset'], { accBuilt: true, updated: '' });
    assert.equal(r.status, 1);
    assert.match(r.err, /Geen account charles@example\.nl gevonden in acceptatie/);
    assert.match(r.files.acc ?? '', /Wachtwoord: oudwachtwoord/);
  });

  for (const input of ['', '\n', 'nee\n', 'Ja\n', 'j\n']) {
    it(`kluis: zonder "ja" (${JSON.stringify(input)}) afgebroken, niets gewijzigd`, () => {
      const r = run(['-local', '-kluis', '-reset', '-email=c@example.nl'], { kluis: true, input, updated: 'c@example.nl' });
      assert.equal(r.status, 1);
      assert.match(r.out, /KLUIS \(VAULT/);
      assert.match(r.out, /standaard: nee/);
      assert.match(r.out, /Afgebroken; er is niets gewijzigd/);
      assert.equal(r.stdin, '');
      assert.equal(r.files.kluis, null);
    });
  }

  it('kluis: met "ja" wordt het wachtwoord gereset in ~/.doelenboom-kluis/sysadmin.txt', () => {
    const r = run(['-local', '-kluis', '-reset', '-email=c@example.nl'], { kluis: true, input: 'ja\n', updated: 'c@example.nl' });
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.some((c) => /^compose -p doelenboom-kluis .* exec -T db psql /.test(c)), r.calls.join(' | '));
    assert.match(r.files.kluis ?? '', /^Kluis-sysadmin: c@example\.nl\nWachtwoord: [A-Za-z0-9]{24}\n$/);
  });

  it('productie: zonder VPS geweigerd; zonder "ja" afgebroken', () => {
    const noVps = run(['-prod', '-reset', '-email=c@example.nl'], { input: 'ja\n' });
    assert.equal(noVps.status, 1);
    assert.match(noVps.err, /VPS=gebruiker@host/);
    const no = run(['-prod', '-reset', '-email=c@example.nl'], { env: { VPS: 'beheer@vps.example.test' }, input: '\n' });
    assert.equal(no.status, 1);
    assert.match(no.out, /PRODUCTIE/);
    assert.ok(!no.calls.some((c) => c.startsWith('ssh')), no.calls.join(' | '));
  });

  it('productie met "ja": via ssh (SQL op de standaardinvoer), wachtwoord één keer getoond, niets opgeslagen', () => {
    const r = run(['-prod', '-reset', '-email=c@example.nl'], { env: { VPS: 'beheer@vps.example.test' }, input: 'ja\n', updated: 'c@example.nl' });
    assert.equal(r.status, 0, r.err + r.out);
    const ssh = r.calls.find((c) => c.startsWith('ssh '))!;
    assert.match(ssh, /^ssh beheer@vps\.example\.test cd ~\/doelenboom && docker compose -f docker-compose\.yml -f docker-compose\.prod\.yml exec -T db psql /);
    const pw = /^ {2}([A-Za-z0-9]{24})$/m.exec(r.out)?.[1];
    assert.ok(pw, r.out);
    assert.ok(!ssh.includes(pw!));
    assert.match(r.stdin, sqlFor('c@example.nl'));
    assert.match(r.out, /wordt nergens opgeslagen/);
    assert.equal(r.files.dev, null);
    assert.ok(!r.calls.some((c) => c.startsWith('compose')), 'lokaal is niets aangeraakt');
  });

  it('-reset samen met -stop/-restart/-rebuild, of -email zonder -reset: geweigerd', () => {
    for (const args of [['-local', '-reset', '-stop'], ['-local', '-restart', '-reset'], ['-local', '-dev', '-reset', '-rebuild'], ['-local', '-dev', '-open', '-email=c@example.nl']]) {
      const r = run(args, { accBuilt: true });
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stdin, '');
    }
  });

  it('-prod zonder -reset blijft geweigerd (productie blijft handwerk)', () => {
    const r = run(['-prod', '-stop']);
    assert.equal(r.status, 1);
    assert.match(r.err, /Productie-acties zijn nog niet geautomatiseerd/);
  });
});
