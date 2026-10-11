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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(repo, 'scripts', 'release.sh'), 'utf8');
const code = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
const remote = (() => {
  const m = src.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE\n/);
  assert.ok(m, "remote deel (heredoc <<'REMOTE') niet gevonden in release.sh");
  return code(m[1]);
})();
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
