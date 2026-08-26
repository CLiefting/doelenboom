import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('activities');

// Activiteiten-planning (start-/einddatum, kunnen er meerdere zijn per
// project) — zie api/src/routes/activities.ts. Anders dan products.test.ts
// (products.ts) heeft een activiteit altijd een start- én einddatum
// (geen los, optioneel moment).
describe('activities (activiteiten-planning) CRUD', () => {
  let doelenboomId: number;
  let adminToken: string;
  let gebruikerToken: string;
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    let tenantId: number;
    ({ tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    // Activiteiten horen, net als products, bij de "Projecten"-module (zie
    // license.ts/routes/activities.ts requireModule).
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
      token: sysadminToken, body: { active: true },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('validatie: naam/start-/einddatum verplicht, einddatum mag niet vóór startdatum liggen', async () => {
    const missingName = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: '', startDate: '2026-09-01', endDate: '2026-09-10' },
    });
    assert.equal(missingName.status, 400);

    const missingDates = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Zonder datums' },
    });
    assert.equal(missingDates.status, 400);

    const endBeforeStart = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Verkeerde volgorde', startDate: '2026-09-10', endDate: '2026-09-01' },
    });
    assert.equal(endBeforeStart.status, 400);

    const unknownElement = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/activities`, {
      token: adminToken, body: { name: 'X', startDate: '2026-09-01', endDate: '2026-09-10' },
    });
    assert.equal(unknownElement.status, 404);

    const bezoeker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: bezoekerToken, body: { name: 'X', startDate: '2026-09-01', endDate: '2026-09-10' },
    });
    assert.equal(bezoeker.status, 403);
  });

  it('gebruiker mag activiteiten aanmaken/wijzigen/verwijderen (losse boom-inhoud)', async () => {
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: gebruikerToken, body: { name: 'Door gebruiker', startDate: '2026-09-01', endDate: '2026-09-15' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.startDate, '2026-09-01');
    assert.equal(created.body.endDate, '2026-09-15');

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
      token: gebruikerToken,
      body: { name: 'Door gebruiker gewijzigd', startDate: '2026-09-02', endDate: '2026-09-20', omschrijving: 'bijgewerkt' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Door gebruiker gewijzigd');
    assert.equal(updated.body.omschrijving, 'bijgewerkt');

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
      token: gebruikerToken,
    });
    assert.equal(del.status, 204);
    const delAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
      token: gebruikerToken,
    });
    assert.equal(delAgain.status, 404);
  });

  it('start- en einddatum op dezelfde dag is toegestaan (eendaagse activiteit)', async () => {
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Eendaags', startDate: '2026-10-01', endDate: '2026-10-01' },
    });
    assert.equal(created.status, 201);
  });

  it('PUT met onbekend id geeft 404', async () => {
    const wrongElement = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/999999999`, {
      token: adminToken, body: { name: 'x', startDate: '2026-09-01', endDate: '2026-09-05' },
    });
    assert.equal(wrongElement.status, 404);
  });

  it('activiteiten verschijnen onder de juiste elementcode in GET tree', async () => {
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'In de boom', startDate: '2026-11-01', endDate: '2026-11-05' },
    });
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.ok(tree.body.activities['P1'].some((a: any) => a.name === 'In de boom'));
  });
});
