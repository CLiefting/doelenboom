import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('elements');

describe('elements CRUD', () => {
  let sysadminToken: string;
  let sysadminEmail: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let gebruikerToken: string;
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    sysadminEmail = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('bezoeker (alleen-lezen) mag geen element aanmaken; gebruiker wel', async () => {
    const bezoeker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: bezoekerToken, body: { code: 'X1', type: 'Project', name: 'Mag niet' },
    });
    assert.equal(bezoeker.status, 403);

    const gebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: gebruikerToken, body: { code: 'X2', type: 'Project', name: 'Mag wel' },
    });
    assert.equal(gebruiker.status, 201);
    assert.equal(gebruiker.body.code, 'X2');
  });

  it('admin kan een element aanmaken; validatie op type/naam/code', async () => {
    const missingName = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'X1', type: 'Project', name: '' },
    });
    assert.equal(missingName.status, 400);

    const badType = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'X1', type: 'Onbekend type', name: 'Test' },
    });
    assert.equal(badType.status, 400);

    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1', kpi: 'KPI', taakveld: 'IT' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, 'P1');
    assert.equal(created.body.kpi, 'KPI');

    const dupCode = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Nog een keer' },
    });
    assert.equal(dupCode.status, 409);
  });

  it('PUT hernoemt/wijzigt een element; DELETE verwijdert het', async () => {
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P2', type: 'Project', name: 'Project 2' },
    });

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P2`, {
      token: adminToken, body: { code: 'P2b', type: 'Project', name: 'Project 2 hernoemd' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.code, 'P2b');
    assert.equal(updated.body.name, 'Project 2 hernoemd');

    const notFound = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/DOESNIETBESTAAN`, {
      token: adminToken, body: { type: 'Project', name: 'x' },
    });
    assert.equal(notFound.status, 404);

    const bezoekerDelete = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2b`, { token: bezoekerToken });
    assert.equal(bezoekerDelete.status, 403);

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2b`, { token: adminToken });
    assert.equal(del.status, 204);

    const delAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2b`, { token: adminToken });
    assert.equal(delAgain.status, 404);
  });

  it('sysadmin mag NIET schrijven zonder zelf gekoppeld te zijn (privacy) — na koppeling als gebruiker wel', async () => {
    const blocked = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: sysadminToken, body: { code: 'P3', type: 'Project', name: 'Door ongekoppelde sysadmin' },
    });
    assert.equal(blocked.status, 403);

    // Zelfde privacy-check op lezen: ook GET .../tree is dicht zonder koppeling.
    const blockedRead = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(blockedRead.status, 403);

    // Koppel sysadmin alsnog als gebruiker aan deze tenant (ledenbeheer blijft
    // sysadmin-only toegankelijk, zie rbac.ts) — dan werkt schrijven gewoon,
    // precies zoals voor elke andere gebruiker met die rol.
    const link = await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: sysadminEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    assert.equal(link.status, 201);
    // De JWT bevat geen tenant-rollen (die worden live opgezocht, zie
    // auth.ts) — dus geen nieuwe login nodig, hetzelfde sysadminToken volstaat.
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: sysadminToken, body: { code: 'P3', type: 'Project', name: 'Door gekoppelde sysadmin' },
    });
    assert.equal(created.status, 201);

    // Weer ontkoppelen zodat latere tests in dit bestand (die ongekoppelde
    // sysadmin-toegang verwachten te weigeren) niet per ongeluk slagen.
    await req('DELETE', `/api/tenants/${tenantId}/members/${link.body.userId}`, { token: sysadminToken });
  });

  it('read-only doelenboom blokkeert schrijven, ook voor de tenant-admin', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    const blocked = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P4', type: 'Project', name: 'Mag niet, read-only' },
    });
    assert.equal(blocked.status, 403);
    // Weer terugzetten voor eventuele volgende tests in dit bestand.
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
  });
});
