import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';
import { pool } from '../src/db.js';

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
  let gebruikerToken: string;

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
    ({ doelenboomId, tenantId, adminToken, gebruikerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));

    // Dit testbestand dateert van vóór het licentiemodel (module-gating, zie
    // license.ts/rbac.ts requireModule) — een verse tenant start met geen
    // enkele module actief, dus zonder dit zou het aanmaken van de producten/
    // projectstatus hieronder stilzwijgend niets doen (de write-routes
    // blokkeren dat al server-side) én zou GET .../tree straks een lege
    // products/projectStatus teruggeven voor zowel de bron- als de
    // geïmporteerde doelenboom (zelfde tenant, dus één keer activeren volstaat
    // voor beide). Zie hetzelfde patroon in products.test.ts/projectStatus.test.ts.
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
      token: sysadminToken, body: { active: true },
    });

    // Een nieuwe doelenboom wordt automatisch gezaaid met één voorbeeldelement
    // per standaardkolom, verbonden in kolomvolgorde (zie exampleTree.ts) —
    // die "verticale" voorbeeldketen (bv. Sub-benefit->Programmabaat) overleeft
    // een 'oud'-formaat-rondgang niet (zie toelichting hieronder), dus zou de
    // full-roundtrip-vergelijking verderop laten mislukken. Verwijder de
    // voorbeeldelementen daarom eerst, zodat alleen de hieronder bewust
    // gekozen, wél-rondgangbestendige fixture overblijft.
    const seeded = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    for (const el of seeded.body.elements as { code: string }[]) {
      await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/${el.code}`, { token: adminToken });
    }

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
    const deliverable1 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Deliverable 1', type: 'deliverable', pctGereed: 40, verwachteDatum: '2026-09-01' },
    });
    const deliverable2 = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Deliverable 2', type: 'deliverable', pctGereed: 0 },
    });
    // Een productafhankelijkheid, om te controleren dat ook die (nieuw: zie
    // exporter.py/parser.py Producten-tab "Hangt af van") een volledige
    // export->import->publiceer-rondgang overleeft — vóór die kolom bestond,
    // ging deze afhankelijkheid bij zo'n rondgang verloren (het bugrapport
    // waar deze fix een antwoord op is).
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products/dependencies`, {
      token: adminToken, body: { predecessorId: deliverable1.body.id, successorId: deliverable2.body.id, lagAmount: 2, lagEenheid: 'w' },
    });
    await req('PUT', `/api/doelenbomen/${doelenboomId}/elements/P1/project-status`, {
      token: adminToken, body: { projectstatus: 'Actief', rag: 'Groen' },
    });

    // Twee activiteiten + een afhankelijkheid ertussen, om te controleren dat
    // ook die (nieuw: zie exporter.py/parser.py Activiteiten-tab) een volledige
    // export->import->publiceer-rondgang overleven — vóór die tab bestond,
    // waren activiteiten helemaal niet onderdeel van deze export/import.
    const taakA = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Taak A', startDate: '2026-08-01', endDate: '2026-08-10' },
    });
    const taakB = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities`, {
      token: adminToken, body: { name: 'Taak B', startDate: '2026-08-11', endDate: '2026-08-14', isMilestone: false },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/activities/dependencies`, {
      token: adminToken, body: { predecessorId: taakA.body.id, successorId: taakB.body.id, type: 'FS', lagDays: 2 },
    });
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // Regressietest voor een incident: excel_imports.status stond alleen
  // 'warnings' (meervoud) toe in de check-constraint, terwijl excel-service
  // altijd 'warning' (enkelvoud) teruggeeft (app/parser.py/project_workbook.py)
  // — élke upload van een bestand met waarschuwingen (bijna elk "echt"
  // bestand) crashte daardoor op deze insert, en omdat die niet in een
  // try/catch zat (nu wel, zie routes/imports.ts), trok dat de hele
  // Node-container mee onderuit voor alle tenants tegelijk. Toetst rechtstreeks
  // tegen de db (i.p.v. via een volledige, warning-opleverende Excel-rondgang
  // te forceren) omdat de constraint zélf het kapotte onderdeel was — zie
  // db/migrations/0024_fix_excel_imports_status_check.sql.
  it('excel_imports.status accepteert "warning" (enkelvoud) — precies wat excel-service teruggeeft', async () => {
    const r = await pool.query(
      `insert into excel_imports (doelenboom_id, uploaded_by, filename, status, report_json, parsed_json)
       values ($1, $2, $3, 'warning', '{}'::jsonb, '{}'::jsonb)
       returning id, status`,
      [doelenboomId, null, 'regressie-warning.xlsx']
    );
    assert.equal(r.rows[0].status, 'warning');
    await pool.query('delete from excel_imports where id = $1', [r.rows[0].id]);
  });

  // Bulk Excel-import blijft admin-only, ook al mag de rol 'gebruiker' inmiddels
  // losse boom-inhoud (elementen/relaties/...) rechtstreeks bewerken — een
  // import vervangt de hele doelenboom in één keer, dat is bewust een zwaardere
  // actie. Deze check zit in de rbac-middleware, vóór de excel-service wordt
  // aangeroepen, dus onafhankelijk van excelServiceReachable.
  it('Excel-import (upload) is admin-only, ook voor de rol "gebruiker"', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'x.xlsx');
    const res = await fetch(`${getBaseUrl()}/api/doelenbomen/${doelenboomId}/imports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gebruikerToken}` },
      body: form,
    });
    assert.equal(res.status, 403);
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
        // Regressietest voor de CORS-exposedHeaders-fix in app.ts: zonder die
        // regel kan een browser (tree.html draait op een andere origin dan de
        // API) deze header wel ontvangen maar niet via JS uitlezen, en valt de
        // downloadnaam altijd terug op de kale fallback — Node's fetch (hier
        // in de test) is daar niet gevoelig voor, vandaar deze expliciete check.
        assert.match(
          res.headers.get('access-control-expose-headers') ?? '',
          /Content-Disposition/i
        );
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

    assert.equal(importedTree.body.productDependencies['P1']?.length, originalTree.body.productDependencies['P1']?.length);
    const importedProdByName = Object.fromEntries(
      (importedTree.body.products['P1'] as Array<{ id: number; name: string }>).map((p) => [p.name, p])
    );
    const importedProdDep = (
      importedTree.body.productDependencies['P1'] as Array<{ predecessorId: number; successorId: number; type: string; lagAmount: number; lagEenheid: string }>
    )[0];
    assert.equal(importedProdDep.predecessorId, importedProdByName['Deliverable 1'].id);
    assert.equal(importedProdDep.successorId, importedProdByName['Deliverable 2'].id);
    assert.equal(importedProdDep.type, 'FS');
    assert.equal(importedProdDep.lagAmount, 2);
    assert.equal(importedProdDep.lagEenheid, 'w');

    assert.equal(importedTree.body.activities['P1']?.length, originalTree.body.activities['P1']?.length);
    const importedActByName = Object.fromEntries(
      (importedTree.body.activities['P1'] as Array<{ name: string; startDate: string; endDate: string; isMilestone: boolean }>).map(
        (a) => [a.name, a]
      )
    );
    assert.equal(importedActByName['Taak A'].startDate, '2026-08-01');
    assert.equal(importedActByName['Taak B'].endDate, '2026-08-14');

    assert.equal(importedTree.body.dependencies['P1']?.length, originalTree.body.dependencies['P1']?.length);
    const importedDep = (importedTree.body.dependencies['P1'] as Array<{ predecessorId: number; successorId: number; type: string; lagDays: number }>)[0];
    const importedTaakAId = importedActByName['Taak A'].id;
    const importedTaakBId = importedActByName['Taak B'].id;
    assert.equal(importedDep.predecessorId, importedTaakAId);
    assert.equal(importedDep.successorId, importedTaakBId);
    assert.equal(importedDep.type, 'FS');
    assert.equal(importedDep.lagDays, 2);
  });
});
