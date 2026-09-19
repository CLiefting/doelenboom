// Regressietest voor DOEL-30: de beveiligingsheaders van de statische frontend.
//
// Toetst de ECHTE configuratiebestanden (nginx.conf, security-headers.conf,
// Dockerfile.prod, ../docker-compose.prod.yml) met alleen Node's ingebouwde
// testrunner. De feitelijke headers zijn daarnaast handmatig geverifieerd met
// een echte nginx + Chromium (geen CSP-schendingen bij inloggen, boomweergave
// in de iframe en de HTML-export).
//
// Uitvoeren: node --test web/test/security-headers.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const nginx = read('nginx.conf');
const snippet = read('security-headers.conf');
const dockerfile = read('Dockerfile.prod');
const compose = read('../docker-compose.prod.yml');

// Haalt het blok van een location uit nginx.conf (geen geneste blokken aanwezig).
function locationBlock(header) {
  const start = nginx.indexOf(header);
  assert.ok(start >= 0, `${header} niet gevonden in nginx.conf`);
  return nginx.slice(start, nginx.indexOf('}', start));
}

describe('nginx.conf: beveiligingsheaders (DOEL-30)', () => {
  const INCLUDE = 'include /etc/nginx/snippets/security-headers.conf;';

  it('de headers worden in elke statische location opgenomen (nginx erft add_header niet van server-niveau)', () => {
    assert.ok(locationBlock('location = /tree.html').includes(INCLUDE), '/tree.html mist de include');
    assert.ok(locationBlock('location / {').includes(INCLUDE), 'location / mist de include');
  });

  it('/api/ krijgt ze bewust niet (de API zet zelf helmet-headers; anders dubbele headers)', () => {
    assert.ok(!locationBlock('location /api/').includes('security-headers'));
  });

  it('/tree.html houdt zijn Cache-Control: no-cache', () => {
    assert.match(locationBlock('location = /tree.html'), /add_header Cache-Control "no-cache";/);
  });

  it('de Dockerfile kopieert het snippet naar het pad waar nginx.conf naar verwijst', () => {
    // Optionele --chmod-vlag (DOEL-31b): COPY neemt anders de rechten van de werkmap over.
    assert.match(dockerfile, /COPY (--chmod=\S+ )?security-headers\.conf \/etc\/nginx\/snippets\/security-headers\.conf/);
    assert.match(dockerfile, /COPY --chmod=0?644 security-headers\.conf /);
  });
});

describe('security-headers.conf (DOEL-30)', () => {
  const header = (name) => {
    const m = snippet.match(new RegExp(`^add_header ${name} "([^"]*)" always;`, 'm'));
    assert.ok(m, `add_header ${name} ... always; ontbreekt`);
    return m[1];
  };

  it('Referrer-Policy en Permissions-Policy staan erin', () => {
    assert.equal(header('Referrer-Policy'), 'same-origin');
    const pp = header('Permissions-Policy');
    for (const f of ['camera', 'microphone', 'geolocation', 'payment']) assert.ok(pp.includes(`${f}=()`), f);
  });

  it('de CSP beperkt uitgaande verbindingen, framing, <base>, formulieren en plugins', () => {
    const csp = header('Content-Security-Policy');
    const d = Object.fromEntries(csp.split(';').map((p) => p.trim().split(/\s+(.*)/s).slice(0, 2)));
    assert.equal(d['default-src'], "'self'");
    assert.equal(d['connect-src'], "'self'");
    assert.equal(d['frame-ancestors'], "'self'");
    assert.equal(d['frame-src'], "'self'");
    assert.equal(d['base-uri'], "'self'");
    assert.equal(d['form-action'], "'self'");
    assert.equal(d['object-src'], "'none'");
  });

  it('de CSP laat geen externe scriptbronnen, http(s):-wildcards of eval toe', () => {
    const csp = header('Content-Security-Policy');
    assert.ok(!/https?:/.test(csp), 'externe origin in CSP');
    assert.ok(!/\*/.test(csp), 'wildcard in CSP');
    assert.ok(!csp.includes('unsafe-eval'), 'unsafe-eval in CSP');
  });
});

describe('docker-compose.prod.yml: Traefik-headers (DOEL-30)', () => {
  it('zet Referrer-Policy en Permissions-Policy in de doelenboom-headers-middleware', () => {
    assert.match(compose, /doelenboom-headers\.headers\.referrerPolicy=same-origin/);
    assert.match(compose, /doelenboom-headers\.headers\.customresponseheaders\.Permissions-Policy=camera=\(\)/);
  });

  it('behoudt HSTS, nosniff en SAMEORIGIN (tree.html draait in een same-origin iframe)', () => {
    assert.match(compose, /headers\.stsSeconds=31536000/);
    assert.match(compose, /headers\.contentTypeNosniff=true/);
    assert.match(compose, /headers\.customFrameOptionsValue=SAMEORIGIN/);
  });
});
