import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('orgunits');

describe('org-units CRUD + koppelen aan elementen', () => {
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
      token: adminToken, body: { code: 'OB1', type: 'Operationele benefit', name: 'OB 1' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('POST zonder code genereert automatisch O1, O2, ...; gebruiker mag niet', async () => {
    const gebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, { token: gebruikerToken, body: { name: 'x' } });
    assert.equal(gebruiker.status, 403);

    const o1 = await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, { token: adminToken, body: { name: 'Eerste OE' } });
    assert.equal(o1.status, 201);
    assert.equal(o1.body.code, 'O1');
  });

  it('PUT wijzigt, DELETE verwijdert, dubbele code geeft 409', async () => {
    await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, { token: adminToken, body: { code: 'OX', name: 'X' } });
    await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, { token: adminToken, body: { code: 'OY', name: 'Y' } });

    const dupCode = await req('PUT', `/api/doelenbomen/${doelenboomId}/org-units/OX`, {
      token: adminToken, body: { code: 'OY', name: 'Botst' },
    });
    assert.equal(dupCode.status, 409);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/org-units/OX`, {
      token: adminToken, body: { name: 'X gewijzigd' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'X gewijzigd');

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/org-units/OX`, { token: adminToken });
    assert.equal(del.status, 204);
  });

  it('koppelen/wijzigen/ontkoppelen van een org-unit-relatie op een element', async () => {
    const org = await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, { token: adminToken, body: { name: 'Koppel-OE' } });
    const orgCode = org.body.code;

    const missingOrgCode = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/OB1/org-units`, {
      token: adminToken, body: {},
    });
    assert.equal(missingOrgCode.status, 400);

    const linked = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/OB1/org-units`, {
      token: adminToken, body: { orgCode, relatietype: 'Primair', status: 'Concept', toelichting: 'Waarom' },
    });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.relatietype, 'Primair');

    const dupLink = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/OB1/org-units`, {
      token: adminToken, body: { orgCode },
    });
    assert.equal(dupLink.status, 409);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/OB1/org-units/${orgCode}`, {
      token: adminToken, body: { relatietype: 'Gevalideerd is geen relatietype', status: 'Gevalideerd' },
    });
    assert.equal(updated.status, 200);
    // Onbekend relatietype valt terug op 'Betrokken' (zie readRelationBody in orgUnits.ts).
    assert.equal(updated.body.relatietype, 'Betrokken');
    assert.equal(updated.body.status, 'Gevalideerd');

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    const rel = tree.body.obOrg['OB1'].find((r: any) => r.org === orgCode);
    assert.equal(rel.status, 'Gevalideerd');

    const unlinked = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/OB1/org-units/${orgCode}`, { token: adminToken });
    assert.equal(unlinked.status, 204);
  });
});
