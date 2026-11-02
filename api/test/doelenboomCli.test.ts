import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function run(args: string[], opts: { accBuilt?: boolean; running?: boolean; acceptatieFails?: boolean } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doelenboom-cli-'));
  try {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const log = path.join(tmp, 'docker.log');
    const stub = (file: string, body: string) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); };
    stub(path.join(bin, 'docker'), [
      'echo "$@" >> "$DOCKER_LOG"',
      'case "$*" in *"ps --status running -q web"*) [ -n "$STUB_RUNNING" ] && echo abc123 ;; esac',
      'exit 0',
    ].join('\n'));
    stub(path.join(bin, 'open'), 'echo "open $*" >> "$DOCKER_LOG"');
    mkdirSync(path.join(tmp, 'scripts'));
    stub(path.join(tmp, 'scripts', 'acceptatie.sh'), `echo "acceptatie.sh $*" >> "$DOCKER_LOG"\nexit ${opts.acceptatieFails ? 1 : 0}`);
    writeFileSync(path.join(tmp, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(tmp, 'docker-compose.acc.yml'), 'services: {}\n');
    if (opts.accBuilt) {
      mkdirSync(path.join(tmp, '.acceptatie'));
      writeFileSync(path.join(tmp, '.acceptatie', 'acc.env'), 'ACC_POSTGRES_PASSWORD=x\n');
      writeFileSync(path.join(tmp, '.acceptatie', 'bewijs-abc.txt'), 'commit=abc\nbuild_version=4.4.7 (abc1234, 02-11-2026 10:00)\nresultaat=GOEDGEKEURD\n');
    }
    const r = spawnSync('bash', [cli, ...args], {
      cwd: tmp,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOELENBOOM_DIR: tmp, DOCKER_LOG: log, STUB_RUNNING: opts.running ? '1' : '' },
      encoding: 'utf8',
    });
    let calls: string[] = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* docker niet aangeroepen */ }
    return { status: r.status, out: r.stdout, err: r.stderr, calls };
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
      assert.match(r.err, /niet allebei/);
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
    assert.match(r.err, /-local \[-acc \| -dev \| -ont\]/);
  });
});
