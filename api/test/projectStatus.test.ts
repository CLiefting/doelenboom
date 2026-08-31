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
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    let tenantId: number;
    ({ tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    // Projectstatus hoort bij de "Projecten"-module (zie license.ts/
    // routes/projectStatus.ts requireModule) — dit testbestand dateert van
    // vóór het licentiemodel en test puur de CRUD-mechaniek zelf, dus
    // activeren we de module hier expliciet i.p.v. elke test daarmee te belasten.
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
      token: sysadminToken, body: { active: true },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P2', type: 'Project', name: 'Project 2' },
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

    const bezoeker = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: bezoekerToken, body: { projectstatus: 'Actief' },
    });
    assert.equal(bezoeker.status, 403);
  });

  it('gebruiker mag projectstatus zetten en wissen (losse boom-inhoud)', async () => {
    const set = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: gebruikerToken, body: { projectstatus: 'Actief', rag: 'Groen' },
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.projectstatus, 'Actief');

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, { token: gebruikerToken });
    assert.equal(del.status, 204);
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

  it('PUT zet automatisch updatedAt/updatedByEmail ("laatst bijgewerkt door wie, wanneer")', async () => {
    const before = new Date();
    const res = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: gebruikerToken, body: { projectstatus: 'Actief' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.updatedAt, 'updatedAt moet gezet zijn');
    assert.ok(new Date(res.body.updatedAt).getTime() >= before.getTime() - 1000);
    assert.equal(res.body.updatedByEmail, `${PREFIX}-gebruiker@test.local`);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.ok(tree.body.projectStatus['P1'].updatedAt);
    assert.equal(tree.body.projectStatus['P1'].updatedByEmail, `${PREFIX}-gebruiker@test.local`);
  });

  it('een bezoeker ziet updatedAt wel, updatedByEmail niet (privacy, zie routes/tree.ts)', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief' },
    });
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: bezoekerToken });
    assert.ok(tree.body.projectStatus['P1'].updatedAt, 'wanneer mag bezoeker wel zien');
    assert.equal(tree.body.projectStatus['P1'].updatedByEmail, undefined, 'wie mag bezoeker niet zien');
    assert.ok(tree.body.doelenboom.staleAfterDays, 'drempel is geen gevoelige data, mag altijd mee');
  });

  it('POST .../project-status/touch zet alleen updatedAt/updatedByEmail bij, wijzigt verder niets', async () => {
    const first = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'On-hold', rag: 'Oranje', toelichting: 'nog bezig' },
    });
    assert.equal(first.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const touch = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status/touch`, {
      token: gebruikerToken,
    });
    assert.equal(touch.status, 200);
    assert.equal(touch.body.projectstatus, 'On-hold');
    assert.equal(touch.body.rag, 'Oranje');
    assert.equal(touch.body.toelichting, 'nog bezig');
    assert.ok(new Date(touch.body.updatedAt).getTime() > new Date(first.body.updatedAt).getTime());
    assert.equal(touch.body.updatedByEmail, `${PREFIX}-gebruiker@test.local`);
  });

  it('touch is ook een upsert (project zonder project_status-rij) en bezoeker/geen-module krijgen 403', async () => {
    await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, { token: adminToken });
    const touch = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status/touch`, {
      token: adminToken,
    });
    assert.equal(touch.status, 200);
    assert.equal(touch.body.projectstatus, '');
    assert.ok(touch.body.updatedAt);

    const bezoeker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status/touch`, {
      token: bezoekerToken,
    });
    assert.equal(bezoeker.status, 403);
  });

  it('GET .../project-status/history: before/after per veld, nieuwste eerst, touch apart gelabeld', async () => {
    // P2 is nog nooit aangeraakt -> eerste PUT heeft prev=null (nog geen rij).
    const first = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief', rag: 'Groen', toelichting: 'Start' },
    });
    assert.equal(first.status, 200);

    const second = await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status`, {
      token: gebruikerToken, body: { projectstatus: 'On-hold', rag: 'Oranje', toelichting: 'Start' },
    });
    assert.equal(second.status, 200);

    const touch = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status/touch`, {
      token: gebruikerToken,
    });
    assert.equal(touch.status, 200);

    const del = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status`, { token: adminToken });
    assert.equal(del.status, 204);

    const history = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status/history`, {
      token: adminToken,
    });
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 4, 'PUT + PUT + touch + DELETE = 4 historie-rijen');

    // Nieuwste eerst: DELETE (index 0) ... eerste PUT (index 3).
    const [delRow, touchRow, secondRow, firstRow] = history.body;

    assert.equal(delRow.isTouch, false);
    assert.equal(delRow.prevProjectstatus, 'On-hold', 'DELETE: prev = wat er stond vóór het wissen');
    assert.equal(delRow.newProjectstatus, null, 'DELETE: new = null (gewist)');
    assert.equal(delRow.changedByEmail, `${PREFIX}-admin@test.local`);

    assert.equal(touchRow.isTouch, true);
    assert.equal(touchRow.prevProjectstatus, 'On-hold');
    assert.equal(touchRow.newProjectstatus, 'On-hold', 'touch: prev === new, inhoudelijk niets gewijzigd');
    assert.equal(touchRow.changedByEmail, `${PREFIX}-gebruiker@test.local`);

    assert.equal(secondRow.isTouch, false);
    assert.equal(secondRow.prevProjectstatus, 'Actief');
    assert.equal(secondRow.newProjectstatus, 'On-hold');
    assert.equal(secondRow.prevRag, 'Groen');
    assert.equal(secondRow.newRag, 'Oranje');

    assert.equal(firstRow.isTouch, false);
    assert.equal(firstRow.prevProjectstatus, null, 'eerste keer: nog geen rij, dus prev = null (niet leeg)');
    assert.equal(firstRow.newProjectstatus, 'Actief');
  });

  it('een bezoeker ziet de historie wel, maar changedByEmail niet (zelfde privacy als GET .../tree)', async () => {
    const asAdmin = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status/history`, {
      token: adminToken,
    });
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.length > 0);
    assert.ok(asAdmin.body[0].changedByEmail, 'admin ziet wie');

    const asBezoeker = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/P2/project-status/history`, {
      token: bezoekerToken,
    });
    assert.equal(asBezoeker.status, 200);
    assert.equal(asBezoeker.body.length, asAdmin.body.length);
    assert.equal(asBezoeker.body[0].changedByEmail, undefined, 'bezoeker ziet wie niet');
    assert.ok(asBezoeker.body[0].changedAt, 'bezoeker ziet wanneer wel');
    assert.ok('newProjectstatus' in asBezoeker.body[0], 'bezoeker ziet wat er gewijzigd is wel');
  });

  it('GET .../project-status/history: onbekend element geeft 404', async () => {
    const res = await req('GET', `/api/doelenbomen/${doelenboomId}/elements/GEENBESTAAND/project-status/history`, {
      token: adminToken,
    });
    assert.equal(res.status, 404);
  });
});
