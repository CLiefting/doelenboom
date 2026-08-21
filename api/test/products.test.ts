import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('products');

// "Planning items" (producten/deliverables/mijlpalen) — zie api/src/routes/products.ts.
describe('products (planning items) CRUD', () => {
  let doelenboomId: number;
  let adminToken: string;
  let gebruikerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    ({ doelenboomId, adminToken, gebruikerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('validatie: naam verplicht, type moet deliverable/mijlpaal zijn, pctGereed 0-100', async () => {
    const missingName = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: '' },
    });
    assert.equal(missingName.status, 400);

    const badType = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'X', type: 'onzin' },
    });
    assert.equal(badType.status, 400);

    const badPct = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'X', pctGereed: 150 },
    });
    assert.equal(badPct.status, 400);

    const unknownElement = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/products`, {
      token: adminToken, body: { name: 'X' },
    });
    assert.equal(unknownElement.status, 404);

    const gebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: gebruikerToken, body: { name: 'X' },
    });
    assert.equal(gebruiker.status, 403);
  });

  it('type default is deliverable; mijlpaal expliciet meegeven werkt', async () => {
    const deliverable = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Deliverable zonder expliciet type' },
    });
    assert.equal(deliverable.status, 201);
    assert.equal(deliverable.body.type, 'deliverable');

    const mijlpaal = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Mijlpaal', type: 'mijlpaal', verwachteDatum: '2026-12-01' },
    });
    assert.equal(mijlpaal.status, 201);
    assert.equal(mijlpaal.body.type, 'mijlpaal');
    assert.equal(mijlpaal.body.verwachteDatum, '2026-12-01');
  });

  it('PUT werkt bij, DELETE verwijdert', async () => {
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Te wijzigen' },
    });
    const productId = created.body.id;

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${productId}`, {
      token: adminToken, body: { name: 'Gewijzigd', pctGereed: 50, werkelijkeDatum: '2026-01-15' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Gewijzigd');
    assert.equal(updated.body.pctGereed, 50);

    const wrongElement = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/products/999999999`, {
      token: adminToken, body: { name: 'x' },
    });
    assert.equal(wrongElement.status, 404);

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${productId}`, { token: adminToken });
    assert.equal(del.status, 204);
    const delAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${productId}`, { token: adminToken });
    assert.equal(delAgain.status, 404);
  });

  it('producten verschijnen onder de juiste elementcode in GET tree', async () => {
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, { token: adminToken, body: { name: 'In de boom' } });
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.ok(tree.body.products['P1'].some((p: any) => p.name === 'In de boom'));
  });
});
