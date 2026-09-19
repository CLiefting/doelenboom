import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOEL-33 (analyse M10, OWASP A02/A05): scripts/check-secrets.sh meldt een repo
// met geheimen in een cloud-sync-map, en toont nooit een waarde.

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-secrets.sh');
const SECRET = 'S3cr3t-Smtp-Wachtwoord-XYZ';

function makeDir(root: string, sub: string, envText: string, opts: { mode: number; trackEnv?: boolean }) {
  const dir = path.join(root, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.env'), envText);
  chmodSync(path.join(dir, '.env'), opts.mode);
  writeFileSync(path.join(dir, '.gitignore'), opts.trackEnv ? 'node_modules\n' : '.env\n');
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  if (opts.trackEnv) git('add', '-f', '.env');
  git('commit', '-q', '-m', 'x');
  return dir;
}
const run = (dir: string) => spawnSync('bash', [script, dir], { encoding: 'utf8' });

describe('scripts/check-secrets.sh (DOEL-33)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
  const envText = (jwt: string, db: string) =>
    `JWT_SECRET=${jwt}\nPOSTGRES_PASSWORD=${db}\nSMTP_HOST=smtp.example\nSMTP_PASSWORD=${SECRET}\n`;

  it('meldt een gesynchroniseerde map, te ruime .env-rechten en een gezet SMTP-wachtwoord — zonder een waarde te tonen', () => {
    const dir = makeDir(tmp, 'OneDrive/src/a', envText('dev-secret-verander-mij', 'doelenboom'), { mode: 0o644 });
    const r = run(dir);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /WAARSCHUWING\s+De map staat in een gesynchroniseerde cloudmap/);
    assert.match(out, /WAARSCHUWING\s+\.env heeft rechten 644/);
    assert.match(out, /WAARSCHUWING\s+SMTP_PASSWORD is gezet in een \.env die in de cloud/);
    assert.match(out, /INFO\s+JWT_SECRET is leeg of een bekende dev-default/);
    assert.match(out, /INFO\s+POSTGRES_PASSWORD is leeg of een bekende default/);
    assert.ok(!out.includes(SECRET), 'het wachtwoord mag nooit in de uitvoer staan');
    assert.ok(!out.includes('dev-secret-verander-mij'), 'ook geen dev-default-waarde tonen');
  });

  it('een schone map buiten een sync-map met sterke geheimen en rechten 600 geeft geen waarschuwingen', () => {
    const dir = makeDir(tmp, 'werk/b', envText('x'.repeat(48), 'k9V2-x7Qp-Lm4z'), { mode: 0o600 });
    const r = run(dir);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /Resultaat: 0 fout\(en\), 0 waarschuwing\(en\)/);
  });

  it('een .env die in git is beland (niet genegeerd) is een FOUT met exitcode 1', () => {
    const dir = makeDir(tmp, 'werk/c', envText('x'.repeat(48), 'k9V2-x7Qp-Lm4z'), { mode: 0o600, trackEnv: true });
    const r = run(dir);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(out, /FOUT\s+Mogelijk geheime bestanden staan in git: .*\.env/);
    assert.match(out, /FOUT\s+\.env wordt NIET door git genegeerd/);
    assert.ok(!out.includes(SECRET));
  });

  it('de echte repo: .env.example is toegestaan en er zit niets geheims in git', () => {
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.ok(!/FOUT\s+Mogelijk geheime bestanden/.test(r.stdout), r.stdout);
    rmSync(tmp, { recursive: true, force: true });
  });
});
