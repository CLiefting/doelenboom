import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, closePool, req } from './helpers.js';

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
});
