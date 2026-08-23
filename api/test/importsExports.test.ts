import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';

const PREFIX = unique('impexp');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';

// Deze tests hebben een bereikbare excel-service nodig (zie EXCEL_SERVICE_URL) —
// die staat, anders dan db, niet standaard op een host-poort in docker-compose.yml
// (bewust: alleen de api-container praat er intern mee). Lokaal draai je 'm dus
// even los, bv. via `cd excel-service && uvicorn app.main:app --port 8000`
// (zie het testrapport/regressie-advies voor de precieze commando's). Als de
// service niet bereikbaar is, worden deze tests overgeslagen i.p.v. de hele
// suite te laten falen — de rest van de regressietests heeft 'm niet nodig.
let excelServiceReachable = false;

describe('imports/exports (Excel round-trip via excel-service)', () => {
  let doelenboomId: number;
  let tenantId: number;
  let adminToken: string;

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
    ({ doelenboomId, tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));

    // Alleen Capability->Operationele-benefit- en Project->Capability-edges
    // hebben een eigen tabblad in het "oud" Excel-formaat (zie exporter.py
    // _fill_oud) en overleven dus een export+import-rondgang; "verticale" edges
    // worden afgeleid uit elements.parent_text, een veld dat niet via de directe
    // element-CRUD-API te zetten is (alleen via Excel-import zelf) — dus die
    // horen hier niet in deze fixture thuis.
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'OB1', type: 'Operationele benefit', name: 'OB 1' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'C1', type: 'Capability', name: 'Capability 1' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'C1', target: 'OB1', weight: 'primair' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, {
      token: adminToken, body: { source: 'P1', target: 'C1', weight: 'ondersteunend' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Deliverable 1', type: 'deliverable', pctGereed: 40, verwachteDatum: '2026-09-01' },
    });
    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief', rag: 'Groen' },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  for (const format of ['oud', 'nieuw'] as const) {
    for (const mode of ['template', 'data'] as const) {
      it(`GET export?format=${format}&mode=${mode} geeft een .xlsx-bestand terug`, async (t) => {
        if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
        const res = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/export?format=${format}&mode=${mode}`, {
          token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(
          res.headers.get('content-type'),
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        const buf = await res.arrayBuffer();
        assert.ok(buf.byteLength > 0);

        // Bestandsnaam: Doelenboom_<Tenant>_<Doelenboomnaam>_<JJMMDD>.xlsx —
        // zie routes/exports.ts. setupWritableDoelenboom noemt de doelenboom
        // "Testboom" (spatie-vrij, dus na sanitatie ongewijzigd); de datum
        // wordt hier alleen op patroon gecontroleerd (niet op exacte waarde),
        // om deze test niet te laten breken bij een dag-overgang tijdens de run.
        const disposition = res.headers.get('content-disposition') ?? '';
        const match = disposition.match(/filename="([^"]+)"/);
        assert.ok(match, `verwacht een filename in Content-Disposition, kreeg: ${disposition}`);
        assert.match(match![1], /^Doelenboom_.+_Testboom_\d{6}\.xlsx$/);
      });
    }
  }

  it('volledige rondgang: exporteren (oud), importeren + publiceren in een nieuwe doelenboom levert dezelfde inhoud op', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');

    const exportRes = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/export?format=oud&mode=data`, { token: adminToken });
    assert.equal(exportRes.status, 200);
    const xlsxBuffer = await exportRes.arrayBuffer();

    const target = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'geimporteerd', name: 'Geïmporteerd' },
    });
    assert.equal(target.status, 201);
    const targetId = target.body.id;

    const form = new FormData();
    form.append('file', new Blob([xlsxBuffer]), 'export.xlsx');
    const uploadRes = await fetch(`${getBaseUrl()}/api/doelenbomen/${targetId}/imports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    const upload = await uploadRes.json();
    assert.equal(uploadRes.status, 201);
    assert.ok(upload.status === 'ok' || upload.status === 'warning', `onverwachte importstatus: ${upload.status}`);

    const publishRes = await fetch(`${getBaseUrl()}/api/imports/${upload.id}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const publish = await publishRes.json();
    assert.equal(publishRes.status, 200);
    assert.equal(publish.status, 'published');

    const originalTree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    const importedTree = await req('GET', `/api/doelenbomen/${targetId}/tree`, { token: adminToken });

    assert.equal(importedTree.body.elements.length, originalTree.body.elements.length);
    assert.equal(importedTree.body.edges.length, originalTree.body.edges.length);
    assert.equal(importedTree.body.products['P1']?.length, originalTree.body.products['P1']?.length);
    assert.equal(importedTree.body.products['P1'][0].type, 'deliverable');
    assert.equal(importedTree.body.projectStatus['P1'].projectstatus, 'Actief');
    assert.equal(importedTree.body.projectStatus['P1'].rag, 'Groen');
  });
});
