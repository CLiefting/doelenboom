import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('edges');

describe('edges (relaties tussen elementen)', () => {
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
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'C1', type: 'Capability', name: 'Capability 1' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('validatie: bron/doel verplicht, mogen niet gelijk zijn, moeten bestaan', async () => {
    const missing = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, { token: adminToken, body: { source: 'P1' } });
    assert.equal(missing.status, 400);

    const selfLoop = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'P1', target: 'P1' },
    });
    assert.equal(selfLoop.status, 400);

    const unknownSource = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'ONBEKEND', target: 'C1' },
    });
    assert.equal(unknownSource.status, 404);

    const gebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: gebruikerToken, body: { source: 'P1', target: 'C1' },
    });
    assert.equal(gebruiker.status, 403);
  });

  it('aanmaken, dubbele relatie geeft 409, PUT wijzigt weight/toelichting, DELETE verwijdert', async () => {
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'P1', target: 'C1', weight: 'primair', toelichting: 'Waarom' },
    });
    assert.equal(created.status, 201);

    const dup = await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'P1', target: 'C1' },
    });
    assert.equal(dup.status, 409);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/edges/P1/C1`, {
      token: adminToken, body: { weight: 'ondersteunend', toelichting: 'Aangepast' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.weight, 'ondersteunend');

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    const edge = tree.body.edges.find((e: any) => e.source === 'P1' && e.target === 'C1');
    assert.equal(edge.weight, 'ondersteunend');

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/edges/P1/C1`, { token: adminToken });
    assert.equal(del.status, 204);
    const delAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/edges/P1/C1`, { token: adminToken });
    assert.equal(delAgain.status, 404);
  });
});
