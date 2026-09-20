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

function run(args: string[]) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'doelenboom-cli-'));
  try {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    const log = path.join(tmp, 'docker.log');
    writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "$@" >> "$DOCKER_LOG"\n');
    chmodSync(path.join(bin, 'docker'), 0o755);
    writeFileSync(path.join(tmp, 'docker-compose.yml'), 'services: {}\n');
    const r = spawnSync('bash', [cli, ...args], {
      cwd: tmp,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOELENBOOM_DIR: tmp, DOCKER_LOG: log },
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
  it('-local -stop stopt de stack (docker compose stop) en start niets', () => {
    const r = run(['-local', '-stop']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.ok(r.calls.includes('compose stop'), `verwacht "compose stop", kreeg: ${r.calls.join(' | ')}`);
    assert.ok(!r.calls.some((c) => c.includes(' up ') || c.startsWith('compose up')), 'stop mag niets starten');
    assert.ok(!r.calls.some((c) => c.includes(' down') || c.startsWith('compose down')), 'stop mag geen down doen (volume/containers behouden)');
    assert.match(r.out, /Klaar\./);
  });

  it('-local -restart werkt nog: bouwt en start (docker compose up -d --build)', () => {
    const r = run(['-local', '-restart']);
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

  it('-local -stop -rebuild wordt geweigerd: -rebuild hoort bij -restart', () => {
    const r = run(['-local', '-stop', '-rebuild']);
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
