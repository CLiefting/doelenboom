import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOEL-45: scripts/set-smtp-env.sh toont het wachtwoord nooit en zet het letterlijk in .env.
// Het script draait echt, in een tijdelijke map, met een nagebootste pbpaste.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'set-smtp-env.sh');

const ORIGINAL_ENV = 'JWT_SECRET=abc123\nSMTP_HOST=oud.example\nSMTP_PASSWORD=OudWachtwoord\nOVERIG=1\n';

function run(args: string[], clipboard: string | null, input = '\n\n\n', env0 = ORIGINAL_ENV) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'set-smtp-'));
  try {
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    if (clipboard !== null) {
      writeFileSync(path.join(bin, 'pbpaste'), '#!/bin/sh\nprintf %s "$PBPASTE_VALUE"\n');
      chmodSync(path.join(bin, 'pbpaste'), 0o755);
    }
    const dir = path.join(tmp, 'repo');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(path.join(dir, '.env'), env0, { mode: 0o600 });
    chmodSync(path.join(dir, '.env'), 0o600);
    const r = spawnSync('bash', [script, ...args], {
      input,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOELENBOOM_DIR: dir, PBPASTE_VALUE: clipboard ?? '' },
      encoding: 'utf8',
    });
    return {
      status: r.status,
      output: r.stdout + r.stderr,
      env: readFileSync(path.join(dir, '.env'), 'utf8'),
      mode: statSync(path.join(dir, '.env')).mode & 0o777,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('set-smtp-env.sh (DOEL-45)', () => {
  it('--klembord zet het wachtwoord letterlijk in .env (ook met & | \\ / tekens), laat de rest intact en toont het nooit', () => {
    const pw = 'Zx9-Tq7!mK&p2|wL/r8%v^Nc4*Y+b=6~,:;?';
    const r = run(['--klembord'], pw);
    assert.equal(r.status, 0, r.output);
    assert.ok(r.env.split('\n').includes(`SMTP_PASSWORD=${pw}`), r.env);
    assert.ok(r.env.includes('JWT_SECRET=abc123\n') && r.env.includes('OVERIG=1\n'), 'overige regels intact');
    assert.equal(r.env.match(/^SMTP_PASSWORD=/gm)?.length, 1, 'geen dubbele regel');
    assert.match(r.env, /^SMTP_HOST=smtp\.hostnet\.nl$/m);
    assert.match(r.env, /^SMTP_PORT=587$/m);
    assert.match(r.env, /^SMTP_USER=no-reply@code072\.nl$/m);
    assert.equal(r.mode, 0o600, 'rechten van .env blijven behouden');
    assert.ok(!r.output.includes(pw), 'het wachtwoord staat in de uitvoer');
    assert.match(r.output, new RegExp(`${pw.length} tekens`));
  });

  it('nogmaals draaien vervangt de regel (geen duplicaten)', () => {
    const r1 = run(['--klembord'], 'Eerste-ww.1');
    assert.equal(r1.status, 0, r1.output);
    const r2 = run(['--klembord'], 'Tweede-ww.2', '\n\n\n', r1.env);
    assert.equal(r2.status, 0, r2.output);
    assert.equal(r2.env.match(/^SMTP_PASSWORD=/gm)?.length, 1);
    assert.ok(r2.env.includes('SMTP_PASSWORD=Tweede-ww.2'));
  });

  it('een wachtwoord met spatie of $ wordt geweigerd; .env blijft ongewijzigd', () => {
    for (const bad of ['met spatie', 'abc$def', 'abc"def', "abc'def", 'abc#def', 'abc\\def']) {
      const r = run(['--klembord'], bad);
      assert.equal(r.status, 1, `${bad}: ${r.output}`);
      assert.equal(r.env, ORIGINAL_ENV, `${bad}: .env gewijzigd`);
      assert.ok(!r.output.includes(bad), `${bad}: staat in de uitvoer`);
    }
  });

  it('een leeg klembord wordt geweigerd; .env blijft ongewijzigd', () => {
    const r = run(['--klembord'], '');
    assert.equal(r.status, 1);
    assert.match(r.output, /Geen wachtwoord/);
    assert.equal(r.env, ORIGINAL_ENV);
  });

  it('zonder terminal en zonder --klembord weigert het script (geen zichtbaar wachtwoord)', () => {
    const r = run([], null);
    assert.equal(r.status, 1);
    assert.match(r.output, /--klembord/);
    assert.equal(r.env, ORIGINAL_ENV);
  });

  it('een onbekende optie wordt geweigerd', () => {
    const r = run(['--bestaatniet'], null);
    assert.equal(r.status, 1);
    assert.match(r.output, /Onbekende optie/);
  });
});
