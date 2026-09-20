import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOEL-51: `doelenboom -zip` en `doelenboom -zip -d`. Echte zip, tijdelijke HOME en repo.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'scripts', 'doelenboom-cli.sh');
const hasZip = spawnSync('sh', ['-c', 'command -v zip && command -v unzip']).status === 0;

function put(root: string, rel: string, content = 'x') {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
}

function setup(where: 'DOELENBOOM_DIR' | 'default') {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cli-zip-'));
  const repoDir = where === 'default' ? path.join(home, 'src', 'doelenboom') : path.join(home, 'elders', 'doelenboom');
  put(repoDir, 'docker-compose.yml', 'services: {}\n');
  put(repoDir, 'api/src/index.ts');
  put(repoDir, 'api/package.json', '{}');
  put(repoDir, 'api/.env.example', 'A=');
  put(repoDir, 'api/.env', 'SMTP_PASSWORD=GEHEIM-api');
  put(repoDir, 'api/.env.local', 'SMTP_PASSWORD=GEHEIM-api-local');
  put(repoDir, 'api/node_modules/dep/index.js');
  put(repoDir, 'api/.DS_Store');
  put(repoDir, 'web/src/App.tsx');
  put(repoDir, 'web/public/tree.html');
  put(repoDir, 'web/.env', 'SECRET=GEHEIM-web');
  put(repoDir, 'web/node_modules/y/index.js');
  put(repoDir, 'README.md'); // buiten api/web: mag niet in de zips
  mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  put(home, 'Downloads/ander-bestand.txt', 'blijft');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (where === 'DOELENBOOM_DIR') env.DOELENBOOM_DIR = repoDir; else delete env.DOELENBOOM_DIR;
  const run = (args: string[]) => {
    const r = spawnSync('bash', [cli, ...args], { env, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const list = (zipName: string) => {
    const r = spawnSync('unzip', ['-Z1', path.join(home, 'Downloads', zipName)], { encoding: 'utf8' });
    return r.stdout.split('\n').filter((l) => l && !l.endsWith('/'));
  };
  return { home, repoDir, run, list, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('doelenboom-cli: -zip en -zip -d (DOEL-51)', { skip: !hasZip && 'zip/unzip niet beschikbaar' }, () => {
  it('-zip maakt db_backend.zip (api) en db_frontend.zip (web) zonder node_modules, .env en .DS_Store', () => {
    const t = setup('DOELENBOOM_DIR');
    try {
      const r = t.run(['-zip']);
      assert.equal(r.status, 0, r.err + r.out);
      assert.deepEqual(t.list('db_backend.zip').sort(), ['api/.env.example', 'api/package.json', 'api/src/index.ts']);
      assert.deepEqual(t.list('db_frontend.zip').sort(), ['web/public/tree.html', 'web/src/App.tsx']);
      assert.match(r.out, /db_backend\.zip {2}\(3 bestanden/);
      assert.match(r.out, /Klaar\./);
      assert.ok(!r.out.includes('GEHEIM'), 'geen inhoud in de uitvoer');
    } finally { t.cleanup(); }
  });

  it('een tweede -zip vervangt de zips (bestanden die inmiddels weg zijn blijven niet achter)', () => {
    const t = setup('DOELENBOOM_DIR');
    try {
      assert.equal(t.run(['-zip']).status, 0);
      rmSync(path.join(t.repoDir, 'api/src/index.ts'));
      put(t.repoDir, 'api/src/nieuw.ts');
      assert.equal(t.run(['-zip']).status, 0);
      const files = t.list('db_backend.zip');
      assert.ok(files.includes('api/src/nieuw.ts'), files.join(','));
      assert.ok(!files.includes('api/src/index.ts'), 'verwijderd bestand zit nog in de zip: ' + files.join(','));
    } finally { t.cleanup(); }
  });

  it('-zip -d (in beide volgordes) verwijdert alleen de twee zips en laat ander werk staan; ook als ze er niet zijn', () => {
    const t = setup('DOELENBOOM_DIR');
    try {
      assert.equal(t.run(['-zip']).status, 0);
      const r = t.run(['-zip', '-d']);
      assert.equal(r.status, 0, r.err + r.out);
      assert.ok(!existsSync(path.join(t.home, 'Downloads', 'db_backend.zip')));
      assert.ok(!existsSync(path.join(t.home, 'Downloads', 'db_frontend.zip')));
      assert.ok(existsSync(path.join(t.home, 'Downloads', 'ander-bestand.txt')), 'ander bestand is weg');
      assert.match(r.out, /verwijderd/);
      assert.equal(t.run(['-d', '-zip']).status, 0, 'opnieuw (geen zips meer) moet slagen');
    } finally { t.cleanup(); }
  });

  it('zonder DOELENBOOM_DIR gebruikt de CLI ~/src/doelenboom', () => {
    const t = setup('default');
    try {
      const r = t.run(['-zip']);
      assert.equal(r.status, 0, r.err + r.out);
      assert.ok(t.list('db_backend.zip').includes('api/src/index.ts'));
    } finally { t.cleanup(); }
  });

  it('-d zonder -zip, -zip met -local/-prod/-rebuild en een onbekende optie worden geweigerd', () => {
    const t = setup('DOELENBOOM_DIR');
    try {
      const d = t.run(['-d']);
      assert.equal(d.status, 1); assert.match(d.err, /-d hoort bij -zip/);
      const dl = t.run(['-local', '-stop', '-d']);
      assert.equal(dl.status, 1); assert.match(dl.err, /-d hoort bij -zip/);
      const l = t.run(['-zip', '-local']);
      assert.equal(l.status, 1); assert.match(l.err, /-zip werkt zonder -local of -prod/);
      const rb = t.run(['-zip', '-rebuild']);
      assert.equal(rb.status, 1); assert.match(rb.err, /hoort bij -restart/);
      const u = t.run(['-zap']);
      assert.equal(u.status, 1); assert.match(u.err, /Bekende opties:.*-zip \[-d\]/);
      assert.ok(!existsSync(path.join(t.home, 'Downloads', 'db_backend.zip')), 'geweigerde aanroep maakte toch een zip');
    } finally { t.cleanup(); }
  });
});
