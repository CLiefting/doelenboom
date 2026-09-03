import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, closePool, req, getBaseUrl } from './helpers.js';

describe('overige endpoints (hello/health/version)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  it('GET /api/hello', async () => {
    const res = await req('GET', '/api/hello');
    assert.equal(res.status, 200);
    assert.match(res.body.message, /Hello, doelenboom/);
  });

  it('GET /api/health rapporteert een verbonden database', async () => {
    const res = await req('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.db, 'connected');
  });

  it('GET /api/version geeft "dev" terug zonder BUILD_VERSION-env-var', async () => {
    const res = await req('GET', '/api/version');
    assert.equal(res.status, 200);
    assert.equal(res.body.version, process.env.BUILD_VERSION || 'dev');
  });

  // Beveiligingsheaders (helmet, zie app.ts) — CISO-aandachtspunt. req() (via
  // helpers.ts) parset alleen de JSON-body, dus hier rechtstreeks fetch()
  // tegen getBaseUrl() om de response-headers zelf te kunnen inspecteren.
  it('elke response krijgt de helmet-beveiligingsheaders mee', async () => {
    const res = await fetch(`${getBaseUrl()}/api/hello`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // SAMEORIGIN, niet DENY: tree.html laadt zichzelf same-origin in een
    // iframe (zie TreePage.tsx) — DENY zou dat ook blokkeren.
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(res.headers.get('strict-transport-security'));
  });

  // CORS-allowlist (ALLOWED_ORIGINS, zie app.ts) — een toegestane origin
  // krijgt Access-Control-Allow-Origin terug, een onbekende niet (de browser
  // blokkeert de respons dan zelf aan de cliëntkant — zie het commentaar bij
  // ALLOWED_ORIGINS in app.ts voor waarom de server 'm hier bewust niet met
  // een foutstatus afwijst).
  it('CORS: alleen toegestane origins krijgen Access-Control-Allow-Origin terug', async () => {
    const toegestaan = await fetch(`${getBaseUrl()}/api/hello`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(toegestaan.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(toegestaan.status, 200);

    const onbekend = await fetch(`${getBaseUrl()}/api/hello`, {
      headers: { Origin: 'https://kwaadaardig.example' },
    });
    assert.equal(onbekend.headers.get('access-control-allow-origin'), null);
    // De server verwerkt het verzoek zelf gewoon (200) — CORS is een door de
    // browser afgedwongen policy, geen server-side autorisatiemechanisme; het
    // ontbreken van de header hierboven is wat een browser zou tegenhouden.
    assert.equal(onbekend.status, 200);

    // Geen Origin-header (zoals elk ander req()-verzoek in deze hele
    // testsuite, of een server-naar-server-aanroep) is geen cross-origin
    // browserverzoek en wordt gewoon toegestaan.
    const zonderOrigin = await fetch(`${getBaseUrl()}/api/hello`);
    assert.equal(zonderOrigin.status, 200);
  });
});
