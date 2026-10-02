// Regressietests voor DOEL-69: de dependency-audit (npm audit + pip-audit)
// blijft blokkerend, draait dagelijks op schema in een EIGEN workflow, en de
// uitzonderingenlijst van pip-audit bevat alleen gemotiveerde regels. Puur
// bestandscontroles + het echte scripts/pip-audit.sh met een nep-`pip-audit`
// op het PATH (geen netwerk, geen database).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('dependency-audit workflow (DOEL-69)', () => {
  const audit = stripComments(read('.github/workflows/dependency-audit.yml'));
  const ci = stripComments(read('.github/workflows/ci.yml'));

  it('draait dagelijks op schema, handmatig en als onderdeel van de CI', () => {
    assert.match(audit, /^on:\n\s+schedule:\n\s+- cron: '17 5 \* \* \*'/m);
    assert.match(audit, /^\s+workflow_dispatch:/m);
    assert.match(audit, /^\s+workflow_call:/m);
    assert.match(ci, /dependency-audit:\n\s+name: [^\n]+\n\s+uses: \.\/\.github\/workflows\/dependency-audit\.yml/);
  });

  it('heeft een eigen naam: een geplande run mag nooit als "CI"-run voor een commit tellen (release.sh/pr-merge.sh)', () => {
    assert.match(audit, /^name: Dependency-audit$/m);
    assert.match(ci, /^name: CI$/m);
    assert.doesNotMatch(ci, /schedule:/, 'geen schedule op de CI-workflow zelf');
  });

  it('alle audit-stappen zijn blokkerend en lopen alle drie', () => {
    assert.doesNotMatch(audit, /continue-on-error/);
    assert.equal((audit.match(/npm audit --audit-level=high/g) || []).length, 2, 'api en web');
    assert.match(audit, /working-directory: api\n\s+run: npm audit/);
    assert.match(audit, /working-directory: web\n\s+run: npm audit/);
    assert.match(audit, /bash scripts\/pip-audit\.sh/);
    assert.doesNotMatch(audit, /\|\| true|\|\| exit 0|set \+e/);
  });

  it('minimale rechten en vastgepinde versies (acties op commit-SHA, pip-audit op versie)', () => {
    assert.match(audit, /^permissions:\n\s+contents: read$/m);
    const uses = [...audit.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 3);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is niet op een commit-SHA gepind`);
    assert.match(audit, /pip install pip-audit==\d+\.\d+\.\d+/);
  });

  it('de audit-job in ci.yml heeft zelf geen stappen meer (één plek, geen afwijkende kopie)', () => {
    const job = ci.slice(ci.indexOf('  dependency-audit:'));
    assert.doesNotMatch(job, /steps:|npm audit|pip-audit/);
  });
});

describe('pip-audit uitzonderingenlijst en scripts/pip-audit.sh (DOEL-69)', () => {
  const ID = /^(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|PYSEC-\d{4}-\d+|CVE-\d{4}-\d+)$/;

  it('de echte uitzonderingenlijst bevat alleen regels met id, datum en motivatie', () => {
    const lines = read('excel-service/pip-audit-ignore.txt').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    for (const l of lines) {
      const [id, date, ...reason] = l.trim().split(/\s+/);
      assert.match(id, ID, l);
      assert.match(date ?? '', /^\d{4}-\d{2}-\d{2}$/, l);
      assert.ok(reason.join(' ').length >= 10, `motivatie ontbreekt: ${l}`);
    }
  });

  // Het echte script, met een nep-pip-audit die zijn argumenten afdrukt.
  function run(ignoreContent: string | null) {
    const dir = mkdtempSync(path.join(tmpdir(), 'pipaudit-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'pip-audit'), '#!/usr/bin/env bash\necho "ARGS:$*"\necho "CWD:$(pwd)"\nexit "${FAKE_EXIT:-0}"\n');
    chmodSync(path.join(bin, 'pip-audit'), 0o755);
    const svc = path.join(dir, 'svc');
    mkdirSync(svc);
    writeFileSync(path.join(svc, 'requirements.txt'), 'x==1\n');
    if (ignoreContent != null) writeFileSync(path.join(svc, 'pip-audit-ignore.txt'), ignoreContent);
    return (extraEnv: Record<string, string> = {}) =>
      spawnSync('bash', [path.join(ROOT, 'scripts', 'pip-audit.sh')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PIP_AUDIT_DIR: svc, ...extraEnv },
      });
  }

  it('zonder uitzonderingen: pip-audit -r requirements.txt, in de servicemap', () => {
    for (const content of [null, '', '# alleen commentaar\n\n   \n']) {
      const r = run(content)();
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ARGS:-r requirements\.txt$/m);
      assert.match(r.stdout, /^CWD:.*\/svc$/m);
    }
  });

  it('geldige uitzonderingen worden --ignore-vuln, met de motivatie in de uitvoer', () => {
    const r = run(
      '# kop\nGHSA-abcd-1234-efgh  2026-10-02  Geen fix; raakt ons gebruik niet (DOEL-1).\n' +
      'PYSEC-2026-12\t2026-10-03\tTweede reden, lang genoeg.\nCVE-2026-12345 2026-10-04 Derde reden voldoende lang'
    )();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ARGS:-r requirements\.txt --ignore-vuln GHSA-abcd-1234-efgh --ignore-vuln PYSEC-2026-12 --ignore-vuln CVE-2026-12345$/m);
    assert.match(r.stdout, /Uitzondering: GHSA-abcd-1234-efgh \(sinds 2026-10-02\) — Geen fix; raakt ons gebruik niet \(DOEL-1\)\./);
  });

  it('een bevinding van pip-audit (exit 1) laat het script falen — blokkerend', () => {
    const r = run('')({ FAKE_EXIT: '1' });
    assert.equal(r.status, 1);
  });

  const bad: [string, string, RegExp][] = [
    ['zonder motivatie', 'GHSA-abcd-1234-efgh 2026-10-02\n', /motivatie/],
    ['te korte motivatie', 'GHSA-abcd-1234-efgh 2026-10-02 kort\n', /motivatie/],
    ['zonder datum', 'GHSA-abcd-1234-efgh Geen fix beschikbaar voor deze\n', /datum/],
    ['ongeldig id', 'iets-anders 2026-10-02 Motivatie die lang genoeg is\n', /ongeldig kwetsbaarheid-id/],
    ['optie-injectie als id', '--ignore-vuln 2026-10-02 Motivatie die lang genoeg is\n', /ongeldig kwetsbaarheid-id/],
    ['shell-tekens in id', 'GHSA-abcd-1234-efgh;id 2026-10-02 Motivatie die lang genoeg is\n', /ongeldig kwetsbaarheid-id/],
  ];
  for (const [name, content, re] of bad) {
    it(`ongeldige regel wordt geweigerd, pip-audit draait niet: ${name}`, () => {
      const r = run(content)();
      assert.equal(r.status, 2);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stdout, /ARGS:/);
    });
  }

  it('shell-tekens in de motivatie worden niet uitgevoerd', () => {
    const marker = path.join(tmpdir(), `pipaudit-pwned-${process.pid}`);
    const r = run(`GHSA-abcd-1234-efgh 2026-10-02 reden $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}\n`)();
    assert.equal(r.status, 0, r.stderr);
    assert.throws(() => readFileSync(marker));
  });

  it('script is syntactisch geldig (bash -n)', () => {
    execFileSync('bash', ['-n', path.join(ROOT, 'scripts', 'pip-audit.sh')]);
  });
});
