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

  // wbs (coalesce, zoals mppUid) en isSummary (altijd meegestuurd, zoals
  // isMilestone) — zie activityGanttHtml (tree.html): fase-taken tonen een
  // dunnere balk met eindmarkeringen, en het WBS-nummer verschijnt tussen
  // haakjes vóór de taaknaam.
  describe('wbs / isSummary ("fase"-taken uit MS Project)', () => {
    it('wbs en isSummary worden opgeslagen bij aanmaken en verschijnen in GET tree', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: {
          name: 'Fase 2', startDate: '2026-09-01', endDate: '2026-09-30',
          wbs: '2', isSummary: true, mppUid: 'task-fase-2',
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.wbs, '2');
      assert.equal(created.body.isSummary, true);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      const inTree = tree.body.activities['P1'].find((a: any) => a.id === created.body.id);
      assert.equal(inTree.wbs, '2');
      assert.equal(inTree.isSummary, true);
    });

    it('een PUT zonder wbs laat een bestaand wbs ongemoeid (coalesce, zoals mppUid)', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Blijft WBS houden', startDate: '2026-09-01', endDate: '2026-09-05', wbs: '3.1' },
      });
      const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
        token: adminToken,
        body: { name: 'Blijft WBS houden (bewerkt)', startDate: '2026-09-02', endDate: '2026-09-06' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.wbs, '3.1');
    });

    it('een PUT zonder isSummary in de body zet het terug op false (geen coalesce, zoals isMilestone)', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
        token: adminToken,
        body: { name: 'Was fase', startDate: '2026-09-01', endDate: '2026-09-10', isSummary: true },
      });
      assert.equal(created.body.isSummary, true);

      const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/${created.body.id}`, {
        token: adminToken,
        body: { name: 'Was fase', startDate: '2026-09-01', endDate: '2026-09-10' },
      });
      assert.equal(updated.body.isSummary, false);
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

  // Afhankelijkheden tussen activiteiten (dependencies) — denk aan MS
  // Project: successor hangt af van predecessor volgens 'type' (FS = default).
  // Eigen element (P3) + eigen activiteiten om niet te knoeien met de
  // P1/P2-activiteiten van andere tests hierboven.
  describe('activities/dependencies', () => {
    let taakA: number;
    let taakB: number;
    let taakC: number;

    before(async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P3', type: 'Project', name: 'Project 3' },
      });
      const a = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities`, {
        token: adminToken, body: { name: 'Taak A', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      const b = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities`, {
        token: adminToken, body: { name: 'Taak B', startDate: '2026-09-06', endDate: '2026-09-10' },
      });
      const c = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities`, {
        token: adminToken, body: { name: 'Taak C (ander project)', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      taakA = a.body.id;
      taakB = b.body.id;
      taakC = c.body.id;
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P4', type: 'Project', name: 'Project 4' },
      });
    });

    it('validatie: predecessorId/successorId verplicht, niet aan elkaar gelijk, ongeldig type geweigerd', async () => {
      const missing = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: {},
      });
      assert.equal(missing.status, 400);

      const zelfde = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: taakA },
      });
      assert.equal(zelfde.status, 400);

      const ongeldigType = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: taakB, type: 'XX' },
      });
      assert.equal(ongeldigType.status, 400);
    });

    it('bezoeker mag geen afhankelijkheid aanmaken', async () => {
      const res = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: bezoekerToken, body: { predecessorId: taakA, successorId: taakB },
      });
      assert.equal(res.status, 403);
    });

    it('onbekend element geeft 404', async () => {
      const res = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: taakB },
      });
      assert.equal(res.status, 404);
    });

    it('beide activiteiten moeten bij dit project-element horen (cross-project en onbestaand geweigerd)', async () => {
      const opP4 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P4/activities`, {
        token: adminToken, body: { name: 'Taak op P4', startDate: '2026-09-01', endDate: '2026-09-05' },
      });
      // P3-taak als predecessor, een taak van een ANDER project (P4) als
      // successor — moet geweigerd worden, ook al bestaat die taak wel.
      const crossProject = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: opP4.body.id },
      });
      assert.equal(crossProject.status, 404);

      const onbestaand = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: 999999999 },
      });
      assert.equal(onbestaand.status, 404);
    });

    it('maakt een Finish-Start-afhankelijkheid aan (default type), toont die in GET tree, en weigert een duplicaat', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: taakB },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.predecessorId, taakA);
      assert.equal(created.body.successorId, taakB);
      assert.equal(created.body.type, 'FS');
      assert.equal(created.body.lagDays, 0);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.ok(tree.body.dependencies['P3'].some((d: any) => d.id === created.body.id));

      const dup = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: taakB },
      });
      assert.equal(dup.status, 409);
    });

    it('PUT wijzigt type/lagDays; DELETE verwijdert', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakB, successorId: taakC, type: 'SS', lagDays: 2 },
      });
      assert.equal(created.body.type, 'SS');
      assert.equal(created.body.lagDays, 2);

      const updated = await req(
        'PUT',
        `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies/${created.body.id}`,
        { token: adminToken, body: { type: 'FF', lagDays: -1 } }
      );
      assert.equal(updated.status, 200);
      assert.equal(updated.body.type, 'FF');
      assert.equal(updated.body.lagDays, -1);

      const del = await req(
        'DELETE',
        `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies/${created.body.id}`,
        { token: adminToken }
      );
      assert.equal(del.status, 204);
      const delAgain = await req(
        'DELETE',
        `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies/${created.body.id}`,
        { token: adminToken }
      );
      assert.equal(delAgain.status, 404);
    });

    it('een afhankelijkheid verdwijnt automatisch als een betrokken activiteit verwijderd wordt (cascade)', async () => {
      const d = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities`, {
        token: adminToken, body: { name: 'Taak D', startDate: '2026-09-11', endDate: '2026-09-15' },
      });
      const dep = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/dependencies`, {
        token: adminToken, body: { predecessorId: taakA, successorId: d.body.id },
      });
      assert.equal(dep.status, 201);

      await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P3/activities/${d.body.id}`, {
        token: adminToken,
      });

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.ok(!tree.body.dependencies['P3'].some((x: any) => x.id === dep.body.id));
    });
  });

  // Vervolg-interview met Charles (31 augustus 2026, n.a.v. project "Sweepen"):
  // een activiteiten-wijziging moet ook meetellen voor de 'verouderd'-markering
  // van het PROJECT (project_status.updatedAt) en in dezelfde historie-lijst
  // verschijnen als projectstatus-/deliverable-wijzigingen (zie GET
  // .../elements/:code/history). mppUid blijft buiten de gelogde changes
  // (interne boekhouding, geen gebruikersgerichte wijziging, zie omitMppUid in
  // routes/activities.ts) — anders zou elke MS Project-herimport een storende
  // technische regel in de tijdlijn zetten.
  describe('wijzigingshistorie (project_status.updatedAt-bump + GET .../history)', () => {
    before(async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P5', type: 'Project', name: 'Project 5' },
      });
    });

    it('aanmaken/wijzigen/verwijderen bumpt project_status.updatedAt en komt in de gecombineerde historie terecht', async () => {
      const before = new Date();
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P5/activities`, {
        token: gebruikerToken,
        body: { name: 'Historie-activiteit', startDate: '2026-09-01', endDate: '2026-09-05', mppUid: 'task-historie' },
      });
      assert.equal(created.status, 201);
      const activityId = created.body.id;

      const treeAfterCreate = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.ok(treeAfterCreate.body.projectStatus['P5'].updatedAt, 'aanmaken van een activiteit zet project_status.updatedAt');
      assert.ok(new Date(treeAfterCreate.body.projectStatus['P5'].updatedAt).getTime() >= before.getTime() - 1000);
      assert.equal(treeAfterCreate.body.projectStatus['P5'].updatedByEmail, `${PREFIX}-gebruiker@test.local`);

      await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P5/activities/${activityId}`, {
        token: adminToken,
        body: { name: 'Historie-activiteit', startDate: '2026-09-02', endDate: '2026-09-05' },
      });
      await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P5/activities/${activityId}`, { token: adminToken });

      const history = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P5/history`, { token: adminToken });
      assert.equal(history.status, 200);
      const [delRow, updateRow, createRow] = history.body;

      assert.equal(delRow.kind, 'activity');
      assert.equal(delRow.action, 'delete');
      assert.equal(delRow.label, 'Historie-activiteit');
      assert.equal(delRow.changes.startDate.from, '2026-09-02');
      assert.equal(delRow.changes.startDate.to, null);
      assert.ok(!('mppUid' in delRow.changes), 'mppUid is interne boekhouding, hoort niet in de historie');

      assert.equal(updateRow.kind, 'activity');
      assert.equal(updateRow.action, 'update');
      assert.equal(updateRow.changes.startDate.from, '2026-09-01');
      assert.equal(updateRow.changes.startDate.to, '2026-09-02');
      assert.ok(!('name' in updateRow.changes), 'ongewijzigde naam blijft onvermeld');
      assert.ok(!('mppUid' in updateRow.changes), 'mppUid (coalesce, ongewijzigd) hoort niet in de historie');

      assert.equal(createRow.kind, 'activity');
      assert.equal(createRow.action, 'create');
      assert.equal(createRow.label, 'Historie-activiteit');
      assert.equal(createRow.changes.name.from, null);
      assert.equal(createRow.changes.name.to, 'Historie-activiteit');
      assert.ok(!('mppUid' in createRow.changes), 'mppUid hoort ook bij aanmaken niet in de historie');
    });

    it('"Alles wissen" logt één history-rij per verwijderde activiteit', async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P5/activities`, {
        token: adminToken, body: { name: 'Bulk A', startDate: '2026-10-01', endDate: '2026-10-02' },
      });
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P5/activities`, {
        token: adminToken, body: { name: 'Bulk B', startDate: '2026-10-03', endDate: '2026-10-04' },
      });

      const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P5/activities`, { token: adminToken });
      assert.equal(del.status, 200);
      assert.equal(del.body.deletedCount, 2);

      const history = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P5/history`, { token: adminToken });
      const bulkDeleteRows = history.body.filter((r: any) => r.kind === 'activity' && r.action === 'delete' && r.label.startsWith('Bulk '));
      assert.equal(bulkDeleteRows.length, 2, 'één history-rij per verwijderde activiteit, niet één samengevatte rij');
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
