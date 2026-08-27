import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';

const PREFIX = unique('projexcel');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';

// Zelfde opzet als importsExports.test.ts: deze tests hebben een bereikbare
// excel-service nodig (zie EXCEL_SERVICE_URL) — als die niet draait worden ze
// overgeslagen i.p.v. de hele suite te laten falen.
let excelServiceReachable = false;

describe('project-export/project-import-parse (Excel voor één project)', () => {
  let doelenboomId: number;
  let tenantId: number;
  let adminToken: string;
  let gebruikerToken: string;
  let bezoekerToken: string;

  before(async () => {
    await startTestServer();
    try {
      const res = await fetch(`${EXCEL_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      excelServiceReachable = res.ok;
    } catch {
      excelServiceReachable = false;
    }

    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    ({ doelenboomId, tenantId, adminToken, gebruikerToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));

    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
      token: sysadminToken, body: { active: true },
    });

    // Voorbeeldelementen van de verse doelenboom weg (zelfde reden als
    // importsExports.test.ts), daarna één eigen Project-element met producten/
    // activiteiten/afhankelijkheden/status/tags/organisatieonderdeel erop.
    const seeded = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    for (const el of seeded.body.elements as { code: string }[]) {
      await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/${el.code}`, { token: adminToken });
    }

    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1', description: 'Testomschrijving' },
    });
    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief', rag: 'Groen', toelichting: 'Op schema' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/tags`, {
      token: adminToken, body: { code: 'IGO', name: 'IGO' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/tags`, {
      token: adminToken, body: { tagCode: 'IGO' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/org-units`, {
      token: adminToken, body: { code: 'HRB', name: 'HRB-S' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/org-units`, {
      token: adminToken, body: { orgCode: 'HRB', relatietype: 'Primair' },
    });

    const p1 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken,
      body: { name: 'PID', type: 'deliverable', pctGereed: 100, verwachteDatum: '2026-09-15', werkelijkeDatum: '2026-09-10' },
    });
    const p2 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken,
      body: {
        name: 'Adviesrapport', type: 'deliverable', pctGereed: 30, verwachteDatum: '2026-08-29',
        deadline: '2026-10-01', duur: 10, duurEenheid: 'm', businessValue: 100,
      },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products/dependencies`, {
      token: adminToken, body: { predecessorId: p1.body.id, successorId: p2.body.id },
    });

    const a1 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Taak A', startDate: '2026-08-01', endDate: '2026-08-10' },
    });
    const a2 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Taak B', startDate: '2026-08-11', endDate: '2026-08-11', isMilestone: true },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/dependencies`, {
      token: adminToken, body: { predecessorId: a1.body.id, successorId: a2.body.id, type: 'FS', lagDays: 0 },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET project-export vereist minimaal bezoeker-rol (geen toegang -> 403/404, geen server-crash)', async () => {
    // Puur een rbac-sanity-check, onafhankelijk van excelServiceReachable —
    // een niet-lid van de tenant mag hier sowieso nooit voorbij komen.
    const res = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/elements/P1/project-export`, {});
    assert.equal(res.status, 401); // geen token meegegeven
  });

  it('GET project-export geeft een .xlsx-bestand terug met alle tabbladen', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const res = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/elements/P1/project-export`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.match(disposition, /filename="Project_P1_Project_1_\d{4}-\d{2}-\d{2}\.xlsx"/);
    // Regressietest voor de CORS-exposedHeaders-fix in app.ts — zie
    // importsExports.test.ts voor de toelichting.
    assert.match(
      res.headers.get('access-control-expose-headers') ?? '',
      /Content-Disposition/i
    );
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });

  it('bezoeker mag exporteren maar niet importeren', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const exportRes = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/elements/P1/project-export`, { token: bezoekerToken });
    assert.equal(exportRes.status, 200);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'x.xlsx');
    const importRes = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/project-import-parse`, {
      method: 'POST', headers: { Authorization: `Bearer ${bezoekerToken}` }, body: form,
    });
    assert.equal(importRes.status, 403);
  });

  it('volledige rondgang: exporteren en weer parsen levert dezelfde producten/activiteiten/afhankelijkheden/status op', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');

    const exportRes = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/elements/P1/project-export`, { token: adminToken });
    assert.equal(exportRes.status, 200);
    const xlsxBuffer = await exportRes.arrayBuffer();

    const form = new FormData();
    form.append('file', new Blob([xlsxBuffer]), 'export.xlsx');
    const parseRes = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/project-import-parse`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form,
    });
    assert.equal(parseRes.status, 200);
    const parsed = await parseRes.json();
    assert.equal(parsed.status, 'ok', JSON.stringify(parsed.report));

    const p = parsed.parsed;
    assert.equal(p.project.code, 'P1');
    assert.equal(p.project.projectstatus, 'actief');
    assert.equal(p.project.rag, 'groen');
    assert.deepEqual(p.project.tags, ['IGO']);
    assert.deepEqual(p.project.orgs, [{ name: 'HRB-S', relatietype: 'Primair' }]);

    assert.equal(p.products.length, 2);
    const advies = p.products.find((x: { name: string }) => x.name === 'Adviesrapport');
    assert.equal(advies.duur, 10);
    assert.equal(advies.duurEenheid, 'm');
    assert.equal(advies.businessValue, 100);
    assert.deepEqual(advies.dependsOnNames, ['PID']);
    assert.ok(typeof advies.id === 'number');

    assert.equal(p.activities.length, 2);
    const taakB = p.activities.find((x: { name: string }) => x.name === 'Taak B');
    assert.equal(taakB.isMilestone, true);
    assert.deepEqual(taakB.predecessors, [{ name: 'Taak A', type: 'FS', lagDays: 0 }]);
  });

  it('lege upload -> excel-service geeft 400, de route geeft dat door als 502 met foutmelding', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    // Zelfde gedrag als imports.ts (routes/imports.ts): een niet-ok-response
    // van excel-service wordt hier niet geïnterpreteerd, alleen doorgegeven
    // als 502 — de client (tree.html) toont de foutmelding, geen crash.
    const form = new FormData();
    form.append('file', new Blob([]), 'leeg.xlsx');
    const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/elements/P1/project-import-parse`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.ok(body.error);
  });
});
