import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('projstat');

describe('project-status (PUT upsert + DELETE)', () => {
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

  it('validatie: onbekende projectstatus/rag geven 400; onbekend element geeft 404', async () => {
    const badStatus = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Onzin' },
    });
    assert.equal(badStatus.status, 400);

    const badRag = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { rag: 'Blauw' },
    });
    assert.equal(badRag.status, 400);

    const unknownElement = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief' },
    });
    assert.equal(unknownElement.status, 404);

    const gebruiker = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: gebruikerToken, body: { projectstatus: 'Actief' },
    });
    assert.equal(gebruiker.status, 403);
  });

  it('PUT is een upsert: eerste keer aanmaken, tweede keer bijwerken', async () => {
    const first = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken,
      body: { projectstatus: 'Actief', rag: 'Groen', toelichting: 'Op schema', clusterPpt: 'Cluster A' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.projectstatus, 'Actief');
    assert.equal(first.body.rag, 'Groen');

    const second = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'On-hold', rag: 'Oranje', gerapporteerdOp: '2026-03-01' },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.projectstatus, 'On-hold');
    assert.equal(second.body.rag, 'Oranje');
    assert.equal(second.body.gerapporteerdOp, '2026-03-01');

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(tree.body.projectStatus['P1'].projectstatus, 'On-hold');
  });

  it('DELETE wist de status terug naar "nog niet gerapporteerd"', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Gereed' },
    });
    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, { token: adminToken });
    assert.equal(del.status, 204);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(tree.body.projectStatus['P1'], undefined);
  });
});
