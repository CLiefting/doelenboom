// Regressietests voor DOEL-127: drie omgevingen, die elkaar niet in de weg
// zitten.
//   - ontwikkeling (docker-compose.yml): eigen tags doelenboom-dev-*, start
//     niet vanzelf mee met Docker Desktop, mails "[ONTWIKKELING]";
//   - acceptatie (docker-compose.acc.yml): productie-images, alleen 127.0.0.1,
//     geheimen verplicht via scripts/acceptatie.sh, mails "[ACCEPTATIE]";
//   - productie (docker-compose.yml + docker-compose.prod.yml): ongewijzigd,
//     dus doelenboom-*:latest, restart: unless-stopped, zonder mail-label.
// Aanleiding (25-10-2026): de dev-stack had restart: unless-stopped, startte
// mee met Docker Desktop, draaide nog een build van 18-10 en mailde "23 nieuwe
// kwetsbaarheden". Dev en release deelden bovendien dezelfde image-tags.
//
// Eerst broncontroles; daarna, als `docker compose` beschikbaar is (CI, je
// Mac), de echte samengevoegde configuratie via `docker compose config`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');
// Commentaarregels en lege regels weg, en commentaar achter een waarde.
const stripComments = (s: string) => s.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim() !== '').join('\n');
const dev = stripComments(read('docker-compose.yml'));
const prod = stripComments(read('docker-compose.prod.yml'));
const acc = stripComments(read('docker-compose.acc.yml'));
const SERVICES = ['excel-service', 'api', 'web'];

describe('DOEL-127: compose-bestanden per omgeving (broncontrole)', () => {
  it('ontwikkeling: nergens restart: unless-stopped, eigen doelenboom-dev-*-tags, label "ontwikkeling"', () => {
    assert.doesNotMatch(dev, /restart:\s*unless-stopped/);
    assert.equal((dev.match(/restart: "no"/g) || []).length, 4);
    for (const s of SERVICES) assert.match(dev, new RegExp(`image: doelenboom-dev-${s}:latest`));
    assert.doesNotMatch(dev, /image: doelenboom-(api|web|excel-service):latest/);
    assert.match(dev, /DOELENBOOM_OMGEVING: ontwikkeling/);
    assert.doesNotMatch(dev, /APP_BASE_URL/, 'de dev-stack hoort geen APP_BASE_URL te hebben (dan geen kwetsbaarhedenmail)');
  });

  it('productie legt image-namen, herstartbeleid en "productie" zelf vast (anders erft het van de dev-stack)', () => {
    for (const s of SERVICES) assert.match(prod, new RegExp(`\\n  ${s}:\\n    image: doelenboom-${s}:latest\\n    restart: unless-stopped\\n`));
    assert.match(prod, /\n  db:\n    restart: unless-stopped\n/);
    assert.match(prod, /DOELENBOOM_OMGEVING: productie/);
  });

  it('acceptatie: productie-Dockerfiles, eigen projectnaam en tags, alleen 127.0.0.1, geen automatische herstart', () => {
    assert.match(acc, /^name: doelenboom-acc$/m);
    assert.equal((acc.match(/dockerfile: Dockerfile\.prod/g) || []).length, 2, 'api en web');
    for (const s of SERVICES) assert.match(acc, new RegExp(`image: doelenboom-acc-${s}:latest`));
    assert.doesNotMatch(acc, /restart:\s*(unless-stopped|always|on-failure)/);
    assert.equal((acc.match(/restart: "no"/g) || []).length, 4);
    const ports = [...acc.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p));
    assert.deepEqual(ports, ['127.0.0.1:8088:8080'], 'alleen de web-container, alleen op 127.0.0.1');
    for (const v of ['NODE_ENV: production', 'APP_BASE_URL: http://localhost:8088', 'DOELENBOOM_OMGEVING: acceptatie', 'TRUST_PROXY_HOPS: "1"']) {
      assert.ok(acc.includes(v), `${v} ontbreekt`);
    }
    assert.doesNotMatch(acc, /code072-net|traefik/);
  });

  it('acceptatie (A02/A05): geen geheimen in het bestand; database- en JWT-geheim zijn verplicht van buiten', () => {
    assert.match(acc, /POSTGRES_PASSWORD: \$\{ACC_POSTGRES_PASSWORD:\?/);
    assert.match(acc, /JWT_SECRET: \$\{ACC_JWT_SECRET:\?/);
    assert.doesNotMatch(acc, /dev-secret|changeme|POSTGRES_PASSWORD: [^$]/);
    assert.match(read('.gitignore'), /^\/\.acceptatie\/$/m);
  });
});

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function composeConfig(files: string[], envFile?: string) {
  // Geen -p: de projectnaam uit het bestand zelf (acceptatie: name: doelenboom-acc) telt mee.
  const args = ['compose', ...files.flatMap((f) => ['-f', path.join(repo, f)])];
  if (envFile) args.push('--env-file', envFile);
  const r = spawnSync('docker', [...args, 'config', '--format', 'json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, SMTP_HOST: '' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { name?: string; services: Record<string, { image?: string; restart?: string; environment?: Record<string, string>; ports?: { host_ip?: string; published?: string }[] }> };
}

describe('DOEL-127: samengevoegde configuratie (docker compose config)', { skip: hasCompose ? false : 'docker compose niet beschikbaar' }, () => {
  it('productie (basis + prod): doelenboom-*:latest, restart: unless-stopped, label "productie"', () => {
    const c = composeConfig(['docker-compose.yml', 'docker-compose.prod.yml']);
    for (const s of SERVICES) {
      assert.equal(c.services[s].image, `doelenboom-${s}:latest`);
      assert.equal(c.services[s].restart, 'unless-stopped', s);
    }
    assert.equal(c.services.db.restart, 'unless-stopped');
    assert.equal(c.services.api.environment?.DOELENBOOM_OMGEVING, 'productie');
    assert.equal(c.services.api.environment?.APP_BASE_URL, 'https://doelenboom.code072.nl');
  });

  it('ontwikkeling: geen automatische herstart, eigen tags', () => {
    const c = composeConfig(['docker-compose.yml']);
    for (const s of [...SERVICES, 'db']) assert.equal(c.services[s].restart, 'no', s);
    for (const s of SERVICES) assert.equal(c.services[s].image, `doelenboom-dev-${s}:latest`);
  });

  it('acceptatie: met geheimen geldig, zonder geheimen geweigerd', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'acc-env-'));
    try {
      const envFile = path.join(tmp, 'acc.env');
      writeFileSync(envFile, 'ACC_POSTGRES_PASSWORD=testtesttesttest\nACC_JWT_SECRET=jwtjwtjwtjwtjwtjwtjwtjwtjwtjwtjwt\n');
      const c = composeConfig(['docker-compose.acc.yml'], envFile);
      assert.equal(c.name, 'doelenboom-acc');
      for (const s of [...SERVICES, 'db']) assert.equal(c.services[s].restart, 'no', s);
      assert.deepEqual(c.services.web.ports?.map((p) => `${p.host_ip}:${p.published}`), ['127.0.0.1:8088']);
      for (const s of ['api', 'db', 'excel-service']) assert.ok(!c.services[s].ports?.length, `${s} hoort geen poort te hebben`);
      const empty = path.join(tmp, 'leeg.env');
      writeFileSync(empty, '');
      const r = spawnSync('docker', ['compose', '-f', path.join(repo, 'docker-compose.acc.yml'), '--env-file', empty, 'config'], { cwd: repo, encoding: 'utf8' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /ACC_POSTGRES_PASSWORD|ACC_JWT_SECRET/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
