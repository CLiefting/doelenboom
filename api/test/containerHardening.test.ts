import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DOEL-31 (analyse M-niveau, OWASP A05): container- en deploy-hardening.
// Statische controles op de echte Dockerfiles/compose-bestanden (er draait in
// de testomgeving geen Docker), plus een echte run van het back-upscript met
// een nagebootste `docker`.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8');
const stripComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

// Het gedeelte van een Dockerfile na de laatste FROM (= de runtime-image).
function finalStage(dockerfile: string): string {
  const code = stripComments(dockerfile);
  return code.slice(code.lastIndexOf('\nFROM ') + 1);
}

describe('Dockerfiles: niet als root, met HEALTHCHECK (DOEL-31)', () => {
  it('api (prod): USER node, HEALTHCHECK, geen npm als PID 1', () => {
    const stage = finalStage(read('api/Dockerfile.prod'));
    assert.match(stage, /^USER node$/m);
    assert.match(stage, /^HEALTHCHECK /m);
    assert.match(stage, /\/api\/health/);
    assert.match(stage, /^CMD \["node", "dist\/index\.js"\]$/m);
    assert.ok(stage.indexOf('USER node') > stage.indexOf('npm ci'), 'npm ci moet vóór USER node draaien');
  });

  it('excel-service: eigen gebruiker (USER), HEALTHCHECK op /health', () => {
    const stage = finalStage(read('excel-service/Dockerfile'));
    assert.match(stage, /^RUN useradd /m);
    assert.match(stage, /^USER excel$/m);
    assert.match(stage, /^HEALTHCHECK [\s\S]*\/health/m);
    assert.ok(stage.indexOf('USER excel') > stage.indexOf('COPY app'), 'USER hoort ná het kopiëren van de app');
  });

  it('web (prod): nginx-unprivileged op 8080, nginx.conf en Traefik wijzen daarnaar', () => {
    const stage = finalStage(read('web/Dockerfile.prod'));
    assert.match(stage, /^FROM nginxinc\/nginx-unprivileged/);
    assert.match(stage, /^EXPOSE 8080$/m);
    assert.match(stage, /^HEALTHCHECK [\s\S]*8080/m);
    assert.match(read('web/nginx.conf'), /^\s*listen 8080;/m);
    assert.match(read('docker-compose.prod.yml'), /loadbalancer\.server\.port=8080\b/);
    assert.ok(!/loadbalancer\.server\.port=80\b/.test(read('docker-compose.prod.yml')));
  });
});

describe('docker-compose.prod.yml: resourcegrenzen en privileges (DOEL-31)', () => {
  const compose = stripComments(read('docker-compose.prod.yml'));
  const service = (name: string) => {
    const m = compose.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)+)`, 'm'));
    assert.ok(m, `service ${name} niet gevonden`);
    return m[1];
  };

  for (const name of ['db', 'api', 'web', 'excel-service']) {
    it(`${name}: mem_limit en cpus ingesteld`, () => {
      const s = service(name);
      assert.match(s, /^    mem_limit: \d+[mg]$/m);
      assert.match(s, /^    cpus: [\d.]+$/m);
    });
  }

  for (const name of ['api', 'web', 'excel-service']) {
    it(`${name}: no-new-privileges en alle capabilities weg`, () => {
      const s = service(name);
      assert.match(s, /no-new-privileges:true/);
      assert.match(s, /cap_drop:\n\s+- ALL/);
    });
  }
});

describe('excel-service/requirements.txt (DOEL-31)', () => {
  it('pint defusedxml (openpyxl gebruikt het alleen als het geïnstalleerd is)', () => {
    assert.match(stripComments(read('excel-service/requirements.txt')), /^defusedxml==\d/m);
  });
});

describe('deploy/backup-database.sh: bestandsrechten (DOEL-31)', () => {
  it('maakt de dump 0600 en de map 0700, ook als de map eerder ruimer was; herstelt oudere dumps', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    try {
      // Nagebootste projectmap: <tmp>/deploy/backup-database.sh (het script leidt REPO_DIR af van zijn eigen pad).
      mkdirSync(path.join(tmp, 'deploy'));
      cpSync(path.join(repo, 'deploy', 'backup-database.sh'), path.join(tmp, 'deploy', 'backup-database.sh'));
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "-- nagebootste pg_dump"\n');
      chmodSync(path.join(bin, 'docker'), 0o755);

      // Een bestaande map met te ruime rechten en een oude dump.
      const dir = path.join(tmp, 'backups', 'database');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      const old = path.join(dir, 'doelenboom-20200101-000000.sql.gz');
      writeFileSync(old, 'oud');
      chmodSync(old, 0o644);

      // Zelfde umask als een gewone (ruime) cron-omgeving: 022.
      const r = spawnSync('bash', ['-c', 'umask 022; bash deploy/backup-database.sh'], {
        cwd: tmp, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);

      const mode = (p: string) => statSync(p).mode & 0o777;
      assert.equal(mode(dir), 0o700, 'backupmap');
      assert.equal(mode(old), 0o600, 'oude dump');
      const fresh = readdirSync(dir).filter((f) => f !== path.basename(old));
      assert.equal(fresh.length, 1, 'er moet één nieuwe dump zijn');
      assert.equal(mode(path.join(dir, fresh[0])), 0o600, 'nieuwe dump');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('image-leesrechten: niet afhankelijk van de rechten in de werkmap (DOEL-31b)', () => {
  it('excel-service: /app wordt leesbaar gemaakt na COPY en vóór USER excel', () => {
    const stage = finalStage(read('excel-service/Dockerfile'));
    const chmod = stage.search(/^RUN chmod -R a\+rX \/app\b/m);
    assert.ok(chmod >= 0, 'RUN chmod -R a+rX /app ontbreekt: bronbestanden met modus 600 zijn dan niet leesbaar voor uid 10001');
    assert.ok(chmod > stage.indexOf('COPY app'), 'chmod moet ná COPY app draaien');
    assert.ok(chmod < stage.indexOf('USER excel'), 'chmod moet vóór USER excel draaien (daarna mag het niet meer)');
  });

  it('web (prod): nginx-configuratie wordt met expliciete leesrechten gekopieerd', () => {
    const stage = finalStage(read('web/Dockerfile.prod'));
    // DOEL-31d: symbolisch. Een octale modus als 0644 zet ook de nieuw aangemaakte MAP op 644 (geen x-bit),
    // waardoor nginx (uid 101) /etc/nginx/snippets niet meer kan openen en niet start.
    assert.match(stage, /^COPY --chmod=u=rwX,go=rX nginx\.conf /m);
    assert.match(stage, /^COPY --chmod=u=rwX,go=rX security-headers\.conf /m);
    assert.ok(!/^COPY --chmod=0?[0-7]{3} /m.test(stage), 'geen octale --chmod op COPY: maakt mappen ontoegankelijk');
    // DOEL-41: ook de gebouwde dist (o.a. tree.html) krijgt vaste leesrechten; anders geeft nginx een 403 bij modus 600.
    assert.match(stage, /^COPY --from=build --chmod=u=rwX,go=rX \/app\/dist /m);
  });
});
