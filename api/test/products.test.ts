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
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    let tenantId: number;
    ({ tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    // Producten horen bij de "Projecten"-module (zie license.ts/routes/products.ts
    // requireModule) — dit testbestand dateert van vóór het licentiemodel en test
    // puur de CRUD-mechaniek zelf, dus activeren we de module hier expliciet i.p.v.
    // elke test daarmee te belasten.
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

    const bezoeker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: bezoekerToken, body: { name: 'X' },
    });
    assert.equal(bezoeker.status, 403);
  });

  it('gebruiker mag producten aanmaken/wijzigen/verwijderen (losse boom-inhoud)', async () => {
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: gebruikerToken, body: { name: 'Door gebruiker' },
    });
    assert.equal(created.status, 201);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${created.body.id}`, {
      token: gebruikerToken, body: { name: 'Door gebruiker gewijzigd', pctGereed: 25 },
    });
    assert.equal(updated.status, 200);

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${created.body.id}`, {
      token: gebruikerToken,
    });
    assert.equal(del.status, 204);
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

  // Duur/eenheid, business value, deadline — extra velden naast de
  // oorspronkelijke set hierboven (zie api/src/routes/products.ts).
  it('duur/duurEenheid/businessValue/deadline: valideert en bewaart correct, defaults kloppen', async () => {
    const missingDefaults = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Zonder extra velden' },
    });
    assert.equal(missingDefaults.status, 201);
    assert.equal(missingDefaults.body.duur, null);
    assert.equal(missingDefaults.body.duurEenheid, 'd');
    assert.equal(missingDefaults.body.businessValue, null);
    assert.equal(missingDefaults.body.deadline, null);

    const filled = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken,
      body: { name: 'Met extra velden', duur: 3, duurEenheid: 'w', businessValue: 12.5, deadline: '2026-10-01' },
    });
    assert.equal(filled.status, 201);
    assert.equal(filled.body.duur, 3);
    assert.equal(filled.body.duurEenheid, 'w');
    assert.equal(Number(filled.body.businessValue), 12.5);
    assert.equal(filled.body.deadline, '2026-10-01');

    const badDuur = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'X', duur: -1 },
    });
    assert.equal(badDuur.status, 400);

    const badEenheid = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'X', duurEenheid: 'onzin' },
    });
    assert.equal(badEenheid.status, 400);

    const badBv = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'X', businessValue: 'geen getal' },
    });
    assert.equal(badBv.status, 400);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${filled.body.id}`, {
      token: adminToken, body: { name: 'Met extra velden', duur: 5, duurEenheid: 'm', businessValue: -2, deadline: '2027-01-01' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.duur, 5);
    assert.equal(updated.body.duurEenheid, 'm');
    assert.equal(Number(updated.body.businessValue), -2);
    assert.equal(updated.body.deadline, '2027-01-01');
  });

  // Vervolg-interview met Charles (31 augustus 2026, n.a.v. project "Sweepen"):
  // een deliverable-wijziging moet ook meetellen voor de 'verouderd'-markering
  // van het PROJECT (project_status.updatedAt) en in dezelfde historie-lijst
  // verschijnen als projectstatus-wijzigingen (zie GET .../elements/:code/history,
  // routes/projectStatus.ts, en de gedeelde helpers in api/src/projectHistory.ts).
  it('een product-wijziging bumpt project_status.updatedAt en komt in de gecombineerde historie terecht', async () => {
    const before = new Date();
    const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: gebruikerToken, body: { name: 'Historie-deliverable' },
    });
    assert.equal(created.status, 201);
    const productId = created.body.id;

    const treeAfterCreate = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.ok(treeAfterCreate.body.projectStatus['P1'].updatedAt, 'aanmaken van een deliverable zet project_status.updatedAt');
    assert.ok(new Date(treeAfterCreate.body.projectStatus['P1'].updatedAt).getTime() >= before.getTime() - 1000);
    assert.equal(treeAfterCreate.body.projectStatus['P1'].updatedByEmail, `${PREFIX}-gebruiker@test.local`);

    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${productId}`, {
      token: adminToken, body: { name: 'Historie-deliverable', pctGereed: 40 },
    });
    await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/products/${productId}`, { token: adminToken });

    const history = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P1/history`, { token: adminToken });
    assert.equal(history.status, 200);
    const [delRow, updateRow, createRow] = history.body;

    assert.equal(delRow.kind, 'product');
    assert.equal(delRow.action, 'delete');
    assert.equal(delRow.label, 'Historie-deliverable');
    assert.equal(delRow.changes.name.from, 'Historie-deliverable');
    assert.equal(delRow.changes.name.to, null);

    assert.equal(updateRow.kind, 'product');
    assert.equal(updateRow.action, 'update');
    assert.equal(updateRow.changes.pctGereed.from, 0);
    assert.equal(updateRow.changes.pctGereed.to, 40);
    assert.ok(!('name' in updateRow.changes), 'ongewijzigde naam blijft onvermeld');

    assert.equal(createRow.kind, 'product');
    assert.equal(createRow.action, 'create');
    assert.equal(createRow.label, 'Historie-deliverable');
    assert.equal(createRow.changes.name.from, null);
    assert.equal(createRow.changes.name.to, 'Historie-deliverable');
  });

  // Afhankelijkheden tussen planning items (product_dependencies) — simpeler
  // dan activities/dependencies (geen type/lagDays, zie api/src/routes/
  // products.ts). Eigen element (P2) + eigen products, geneste describe net
  // als activities/dependencies in activities.test.ts (zelfde
  // server/doelenboom/tokens als de CRUD-tests hierboven, geen eigen
  // startTestServer/stopTestServer).
  describe('products/dependencies', () => {
    let deliverableA: number;
    let deliverableB: number;
    let mijlpaalC: number;

    before(async () => {
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P2', type: 'Project', name: 'Project 2' },
      });
      const a = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable A' },
      });
      const b = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable B' },
      });
      const c = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Mijlpaal C', type: 'mijlpaal' },
      });
      deliverableA = a.body.id;
      deliverableB = b.body.id;
      mijlpaalC = c.body.id;
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P3', type: 'Project', name: 'Project 3' },
      });
    });

    it('validatie: predecessorId/successorId verplicht, niet aan elkaar gelijk', async () => {
      const missing = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: {},
      });
      assert.equal(missing.status, 400);

      const zelfde = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: deliverableA },
      });
      assert.equal(zelfde.status, 400);
    });

    it('bezoeker mag geen afhankelijkheid aanmaken', async () => {
      const res = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: bezoekerToken, body: { predecessorId: deliverableA, successorId: deliverableB },
      });
      assert.equal(res.status, 403);
    });

    it('onbekend element geeft 404', async () => {
      const res = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: deliverableB },
      });
      assert.equal(res.status, 404);
    });

    it('beide planning items moeten bij dit project-element horen (cross-project en onbestaand geweigerd)', async () => {
      const opP3 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P3/products`, {
        token: adminToken, body: { name: 'Deliverable op P3' },
      });
      const crossProject = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: opP3.body.id },
      });
      assert.equal(crossProject.status, 404);

      const onbestaand = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: 999999999 },
      });
      assert.equal(onbestaand.status, 404);
    });

    it('maakt een afhankelijkheid aan, toont die in GET tree, en weigert een duplicaat', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: mijlpaalC },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.predecessorId, deliverableA);
      assert.equal(created.body.successorId, mijlpaalC);
      // Zonder type/lagAmount/lagEenheid meegegeven: default type 'FS',
      // vertraging 0 dagen (zie PRODUCT_DEPENDENCY_TYPES in products.ts).
      assert.equal(created.body.type, 'FS');
      assert.equal(created.body.lagAmount, 0);
      assert.equal(created.body.lagEenheid, 'd');

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.ok(tree.body.productDependencies['P2'].some((d: any) => d.id === created.body.id));

      const dup = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: mijlpaalC },
      });
      assert.equal(dup.status, 409);
    });

    it('vertraging: bewaart lagAmount/lagEenheid (weken/maanden), ook negatief', async () => {
      const d = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable met vertraging' },
      });
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken,
        body: { predecessorId: deliverableB, successorId: d.body.id, lagAmount: 2, lagEenheid: 'w' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.lagAmount, 2);
      assert.equal(created.body.lagEenheid, 'w');

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      const row = tree.body.productDependencies['P2'].find((x: any) => x.id === created.body.id);
      assert.equal(row.lagAmount, 2);
      assert.equal(row.lagEenheid, 'w');

      // Negatief mag ook (vroeger/overlap, zelfde als bij activiteiten).
      const d2 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable met negatieve vertraging' },
      });
      const negatief = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken,
        body: { predecessorId: deliverableB, successorId: d2.body.id, lagAmount: -1, lagEenheid: 'm' },
      });
      assert.equal(negatief.status, 201);
      assert.equal(negatief.body.lagAmount, -1);
      assert.equal(negatief.body.lagEenheid, 'm');
    });

    it('vertraging: valideert lagAmount (geheel getal) en lagEenheid (d/w/m)', async () => {
      const d = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable voor validatie' },
      });
      const nietGeheel = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken,
        body: { predecessorId: deliverableB, successorId: d.body.id, lagAmount: 1.5 },
      });
      assert.equal(nietGeheel.status, 400);

      const onbekendeEenheid = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken,
        body: { predecessorId: deliverableB, successorId: d.body.id, lagAmount: 1, lagEenheid: 'y' },
      });
      assert.equal(onbekendeEenheid.status, 400);
    });

    it('DELETE verwijdert een afhankelijkheid', async () => {
      const created = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableB, successorId: mijlpaalC },
      });
      assert.equal(created.status, 201);

      const del = await req(
        'DELETE',
        `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies/${created.body.id}`,
        { token: adminToken }
      );
      assert.equal(del.status, 204);
      const delAgain = await req(
        'DELETE',
        `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies/${created.body.id}`,
        { token: adminToken }
      );
      assert.equal(delAgain.status, 404);
    });

    it('een afhankelijkheid verdwijnt automatisch als een betrokken planning item verwijderd wordt (cascade)', async () => {
      const d = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
        token: adminToken, body: { name: 'Deliverable D' },
      });
      const dep = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products/dependencies`, {
        token: adminToken, body: { predecessorId: deliverableA, successorId: d.body.id },
      });
      assert.equal(dep.status, 201);

      await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2/products/${d.body.id}`, { token: adminToken });

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.ok(!(tree.body.productDependencies['P2'] || []).some((x: any) => x.id === dep.body.id));
    });
  });
});
