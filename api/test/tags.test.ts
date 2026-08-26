import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('tags');

describe('tags CRUD + koppelen aan elementen', () => {
  let doelenboomId: number;
  let adminToken: string;
  let gebruikerToken: string;
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    ({ doelenboomId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('POST zonder code genereert automatisch T1, T2, ...', async () => {
    const t1 = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { name: 'Eerste tag' } });
    assert.equal(t1.status, 201);
    assert.equal(t1.body.code, 'T1');

    const t2 = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { name: 'Tweede tag' } });
    assert.equal(t2.body.code, 'T2');

    const missingName = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: {} });
    assert.equal(missingName.status, 400);

    const gebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: gebruikerToken, body: { name: 'x' } });
    assert.equal(gebruiker.status, 403);
  });

  it('PUT wijzigt een tag, DELETE verwijdert hem, dubbele code geeft 409', async () => {
    await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { code: 'TX', name: 'X' } });
    await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { code: 'TY', name: 'Y' } });

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/tags/TX`, {
      token: adminToken, body: { name: 'X gewijzigd', categorie: 'Cat' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'X gewijzigd');

    const dupCode = await req('PUT', `/api/doelenbomen/${doelenboomId}/tags/TX`, {
      token: adminToken, body: { code: 'TY', name: 'Botst met TY' },
    });
    assert.equal(dupCode.status, 409);

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/tags/TX`, { token: adminToken });
    assert.equal(del.status, 204);
    const notFound = await req('DELETE', `/api/doelenbomen/${doelenboomId}/tags/TX`, { token: adminToken });
    assert.equal(notFound.status, 404);
  });

  it('koppelen/ontkoppelen van een tag aan een element', async () => {
    const tag = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { name: 'Koppel-tag' } });
    const tagCode = tag.body.code;

    const missingTagCode = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: adminToken, body: {},
    });
    assert.equal(missingTagCode.status, 400);

    const unknownElement = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/tags`, {
      token: adminToken, body: { tagCode },
    });
    assert.equal(unknownElement.status, 404);

    const linked = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: adminToken, body: { tagCode, toelichting: 'Waarom' },
    });
    assert.equal(linked.status, 201);

    const dupLink = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: adminToken, body: { tagCode },
    });
    assert.equal(dupLink.status, 409);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.ok(tree.body.elementTags['P1'].includes(tagCode));

    const unlinked = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/tags/${tagCode}`, { token: adminToken });
    assert.equal(unlinked.status, 204);
    const unlinkedAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/tags/${tagCode}`, { token: adminToken });
    assert.equal(unlinkedAgain.status, 404);
  });

  it('gebruiker mag een tag aan een element koppelen/ontkoppelen, bezoeker niet — de catalogus zelf blijft admin-only', async () => {
    const tag = await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, { token: adminToken, body: { name: 'Gebruiker-koppel-tag' } });
    const tagCode = tag.body.code;

    const bezoekerLink = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: bezoekerToken, body: { tagCode },
    });
    assert.equal(bezoekerLink.status, 403);

    const gebruikerLink = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: gebruikerToken, body: { tagCode },
    });
    assert.equal(gebruikerLink.status, 201);

    const gebruikerUnlink = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/tags/${tagCode}`, {
      token: gebruikerToken,
    });
    assert.equal(gebruikerUnlink.status, 204);
  });
});
