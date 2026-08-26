import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';

const PREFIX = unique('activities');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';

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

  // mppUid — zie computeMppImportPlan (tree.html): bij een herimport van
  // hetzelfde MS Project-plan moeten eerder geïmporteerde activiteiten
  // herkend (bijgewerkt) worden i.p.v. dubbel aangemaakt, en een gewone
  // handmatige bewerking mag die koppeling niet stilzwijgend wissen.
  describe('mppUid (koppeling met een geïmporteerde MS Project-taak)', () => {
    it('wordt opgeslagen bij aanmaken en verschijnt in GET tree', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Uit MS Project', startDate: '2026-09-01', endDate: '2026-09-05', mppUid: 'task-42' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.mppUid, 'task-42');

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      const inTree = tree.body.activities['P1'].find((a: any) => a.id === created.body.id);
      assert.equal(inTree.mppUid, 'task-42');
    });

    it('een gewone PUT zonder mppUid in de body laat een bestaand mppUid ongemoeid', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Blijft gekoppeld', startDate: '2026-09-01', endDate: '2026-09-05', mppUid: 'task-99' },
      });
      // Zoals het bewerk-formulier in tree.html: geen mppUid meegeven.
      const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
        token: adminToken,
        body: { name: 'Blijft gekoppeld (bewerkt)', startDate: '2026-09-02', endDate: '2026-09-06', omschrijving: 'net bewerkt' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.name, 'Blijft gekoppeld (bewerkt)');
      assert.equal(updated.body.mppUid, 'task-99');
    });

    it('een PUT met mppUid zet die waarde (gebruikt door de import-sync bij "wijzigen")', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken, body: { name: 'Handmatig', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      assert.equal(created.body.mppUid, null);

      const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
        token: adminToken,
        body: { name: 'Handmatig', startDate: '2026-09-01', endDate: '2026-09-05', mppUid: 'task-7' },
      });
      assert.equal(updated.body.mppUid, 'task-7');
    });
  });

  // isMilestone — zie activityGanttHtml (tree.html): bepaalt of de Gantt een
  // ruit-icoon toont i.p.v. een balkje. Anders dan mppUid wordt dit veld door
  // ALLE aanroepers (formulier én import) altijd meegestuurd, dus geen
  // coalesce-gedrag: een PUT zonder isMilestone zet 'm gewoon op false.
  describe('isMilestone', () => {
    it('standaard false; kan gezet worden bij aanmaken', async () => {
      const zonder = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken, body: { name: 'Gewone activiteit', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      assert.equal(zonder.body.isMilestone, false);

      const mijlpaal = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Mijlpaal', startDate: '2026-09-10', endDate: '2026-09-10', isMilestone: true },
      });
      assert.equal(mijlpaal.body.isMilestone, true);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      const inTree = tree.body.activities['P1'].find((a: any) => a.id === mijlpaal.body.id);
      assert.equal(inTree.isMilestone, true);
    });

    it('een PUT zonder isMilestone in de body zet het terug op false (geen coalesce, i.t.t. mppUid)', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Was mijlpaal', startDate: '2026-09-01', endDate: '2026-09-01', isMilestone: true },
      });
      assert.equal(created.body.isMilestone, true);

      const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
        token: adminToken,
        body: { name: 'Was mijlpaal', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      assert.equal(updated.body.isMilestone, false);
    });
  });

  // DELETE .../activities (zonder :activityId) — wist in één keer ALLE
  // activiteiten van een project-element, gebruikt door de "Alles wissen"-knop
  // in tree.html (deleteAllActivities, na bevestiging via showConfirm). Eigen
  // element (P2) om niet te knoeien met de P1-activiteiten die andere tests
  // hierboven aanmaken/verwachten.
  describe('DELETE .../activities (alles wissen)', () => {
    before(async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P2', type: 'Project', name: 'Project 2' },
      });
    });

    it('bezoeker mag niet alles wissen', async () => {
      const res = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
        token: bezoekerToken,
      });
      assert.equal(res.status, 403);
    });

    it('onbekend element geeft 404', async () => {
      const res = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/activities`, {
        token: adminToken,
      });
      assert.equal(res.status, 404);
    });

    it('verwijdert alle activiteiten van het element en geeft het aantal terug; andere elementen blijven ongemoeid', async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
        token: adminToken, body: { name: 'A', startDate: '2026-09-01', endDate: '2026-09-02' },
      });
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
        token: adminToken, body: { name: 'B', startDate: '2026-09-03', endDate: '2026-09-04' },
      });
      const p1Before = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken, body: { name: 'Blijft staan op P1', startDate: '2026-09-01', endDate: '2026-09-02' },
      });

      const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
        token: adminToken,
      });
      assert.equal(del.status, 200);
      assert.equal(del.body.deletedCount, 2);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.equal(tree.body.activities['P2'], undefined);
      assert.ok(tree.body.activities['P1'].some((a: any) => a.id === p1Before.body.id));

      const delAgain = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
        token: adminToken,
      });
      assert.equal(delAgain.status, 200);
      assert.equal(delAgain.body.deletedCount, 0);
    });
  });

  // POST .../activities/import-mpp — zet een geüpload .mpp-bestand om naar MS
  // Project XML via excel-service en geeft die XML terug (schrijft zelf niets
  // naar activities, zie de toelichting bovenaan activities.ts). De permissie-/
  // validatiechecks (geen bestand, onbekend element, bezoeker) gebeuren vóórdat
  // excel-service aangeroepen wordt, dus die zijn onafhankelijk testbaar; de
  // "echte" conversie heeft een bereikbare excel-service nodig — zelfde
  // skip-patroon als importsExports.test.ts.
  describe('.mpp-import (via excel-service)', () => {
    let excelServiceReachable = false;

    before(async () => {
      try {
        const res = await fetch(`${EXCEL_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
        excelServiceReachable = res.ok;
      } catch {
        excelServiceReachable = false;
      }
    });

    it('geen bestand meegestuurd geeft 400', async () => {
      const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/activities/import-mpp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 400);
    });

    it('onbekend element geeft 404', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'x.mpp');
      const res = await fetch(
        `${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/activities/import-mpp`,
        { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form }
      );
      assert.equal(res.status, 404);
    });

    it('bezoeker mag niet importeren', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'x.mpp');
      const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/activities/import-mpp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bezoekerToken}` },
        body: form,
      });
      assert.equal(res.status, 403);
    });

    it('onleesbaar .mpp-bestand geeft 400 (via excel-service doorgegeven)', async (t) => {
      if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
      const form = new FormData();
      form.append('file', new Blob([new TextEncoder().encode('dit is geen geldig mpp-bestand')]), 'x.mpp');
      const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/activities/import-mpp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: form,
      });
      assert.equal(res.status, 400);
    });
  });
});
