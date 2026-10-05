// Regressietests voor de PowerPoint-export van een hele doelenboom (DOEL-88):
// POST /api/doelenbomen/:id/export-pptx — zie api/src/routes/exports.ts en
// excel-service/app/tree_pptx.py. Inclusief de OWASP Top 10-tests uit het
// ticket: A01 (rollen, andere tenant, sysadmin zonder lidmaatschap, geen lek
// van een andere boom), A03 (injectie en verkeerde types in de keuzes), A04
// (grens op het aantal slides, alleen bestaande kolommen) en A09 (auditlog bij
// een geslaagde export, niets bij een geweigerde).
// De tests die een echte presentatie nodig hebben slaan over als de
// excel-service niet bereikbaar is (zelfde patroon als importsExports.test.ts);
// de validatie- en rechtentests draaien altijd. Alleen neutrale voorbeelden.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { pool } from '../src/db.js';
import { parsePptxOptions, PPTX_MAX_SLIDES } from '../src/routes/exports.js';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('pptx');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
let excelServiceReachable = false;

// Minimale zip-lezer (centrale directory + inflate) om de tekst van de slides
// te kunnen controleren zonder extra dependency.
function readSlides(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'geen geldig zip-bestand');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const slides: Array<{ n: number; xml: string }> = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (match) {
      const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      slides.push({ n: Number(match[1]), xml: (method === 0 ? raw : inflateRawSync(raw)).toString('utf8') });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return slides.sort((a, b) => a.n - b.n).map((s) => s.xml);
}

describe('PowerPoint-export van een doelenboom (DOEL-88)', () => {
  let sysadminToken: string;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const exportPptx = (body: unknown, token: string | undefined = bezoekerToken, id: number | string = doelenboomId) =>
    rawReq('POST', `/api/doelenbomen/${id}/export-pptx`, { token, body: body as Record<string, unknown> });
  const addElement = (code: string, type: string, extra: Record<string, unknown> = {}, id = doelenboomId, token = adminToken) =>
    req('POST', `/api/doelenbomen/${id}/elements`, { token, body: { code, type, name: `Element ${code}`, ...extra } });
  const addEdge = (source: string, target: string, extra: Record<string, unknown> = {}) =>
    req('POST', `/api/doelenbomen/${doelenboomId}/edges`, { token: adminToken, body: { source, target, ...extra } });
  const exportAudit = async (id = doelenboomId) =>
    (await pool.query(
      `select user_id, tenant_id, detail from audit_log
       where doelenboom_id = $1 and event_type = 'doelenboom_exported' order by id`, [id])).rows;

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
    sysadminToken = await login(email, 'wachtwoord123');
    ({ doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    const other = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`);
    otherDoelenboomId = other.doelenboomId;
    otherAdminToken = other.adminToken;

    // Een nieuwe boom kan voorbeeldelementen meekrijgen; die doen hier niet mee.
    await pool.query('delete from elements where doelenboom_id = any($1::bigint[])', [[doelenboomId, otherDoelenboomId]]);
    assert.equal((await addElement('P1', 'Project', { name: 'Voorbeeldproject' })).status, 201);
    assert.equal((await addElement('C1', 'Capability', { name: 'Voorbeeldcapability' })).status, 201);
    assert.equal((await addElement('B1', 'Operationele benefit', { name: 'Voorbeeldbenefit', description: 'Omschrijving van B1', kpi: 'KPI van B1' })).status, 201);
    assert.equal((await addElement('B2', 'Operationele benefit', { name: 'Tweede benefit' })).status, 201);
    assert.equal((await addEdge('P1', 'C1', { toelichting: 'VERTROUWELIJKE-TOELICHTING' })).status, 201);
    assert.equal((await addEdge('C1', 'B1')).status, 201);
    assert.equal((await addElement('X1', 'Project', { name: 'ANDERE-BOOM-GEHEIM' }, otherDoelenboomId, otherAdminToken)).status, 201);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // ---- keuzes valideren (pure functie) ----

  it('parsePptxOptions: standaardwaarden, kolomvolgorde en ontdubbelen', () => {
    const cols = ['A', 'B', 'C'];
    assert.deepEqual(parsePptxOptions({}, cols), { options: { visibleColumns: cols, slideColumns: [], perRow: 4 } });
    assert.deepEqual(parsePptxOptions(undefined, cols), { options: { visibleColumns: cols, slideColumns: [], perRow: 4 } });
    assert.deepEqual(
      parsePptxOptions({ visibleColumns: ['C', 'A', 'C'], slideColumns: ['C', 'A'], perRow: 2 }, cols),
      { options: { visibleColumns: ['A', 'C'], slideColumns: ['A', 'C'], perRow: 2 } }
    );
  });

  it('parsePptxOptions: weigert onbekende kolommen, verkeerde types en een gekozen maar verborgen kolom', () => {
    const cols = ['A', 'B'];
    const bad: unknown[] = [
      { visibleColumns: 'A' }, { visibleColumns: [] }, { visibleColumns: ['Z'] }, { visibleColumns: [1] },
      { visibleColumns: [['A']] }, { visibleColumns: ['A', 'B', 'A'] }, { slideColumns: {} }, { slideColumns: ['Z'] },
      { slideColumns: [null] }, { visibleColumns: ['A'], slideColumns: ['B'] },
      { perRow: 1 }, { perRow: 7 }, { perRow: 2.5 }, { perRow: '4' }, { perRow: null }, { perRow: [4] }, { perRow: NaN },
    ];
    for (const body of bad) {
      const result = parsePptxOptions(body, cols);
      assert.ok('error' in result, `had geweigerd moeten worden: ${JSON.stringify(body)}`);
    }
  });

  // ---- A01: toegang ----

  it('A01: zonder token 401', async () => {
    // Rechtstreeks (niet via exportPptx): die vult bij 'undefined' het standaardtoken in.
    assert.equal((await rawReq('POST', `/api/doelenbomen/${doelenboomId}/export-pptx`, { body: {} })).status, 401);
    assert.equal((await rawReq('POST', `/api/doelenbomen/${doelenboomId}/export-pptx`, { token: 'geen.geldig.token', body: {} })).status, 401);
  });

  it('A01: lid van een andere tenant krijgt 403 en er wordt niets gelogd', async () => {
    assert.equal((await exportPptx({}, otherAdminToken)).status, 403);
    assert.deepEqual(await exportAudit(), []);
  });

  it('A01: sysadmin zonder eigen lidmaatschap krijgt 403 (geen inhoudelijke toegang)', async () => {
    assert.equal((await exportPptx({}, sysadminToken)).status, 403);
    assert.deepEqual(await exportAudit(), []);
  });

  it('A01: niet-bestaande of niet-numerieke boom geeft geen 200 en geen 500', async () => {
    for (const id of ['99999999', 'abc', "1' or '1'='1", '1;drop table elements']) {
      const res = await exportPptx({}, adminToken, encodeURIComponent(id));
      assert.ok([400, 403, 404].includes(res.status), `status ${res.status} voor id ${id}`);
    }
  });

  it('A01: bezoeker, editor en admin mogen exporteren', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    for (const token of [bezoekerToken, editorToken, adminToken]) {
      assert.equal((await exportPptx({}, token)).status, 200);
    }
    await pool.query(`delete from audit_log where doelenboom_id = $1 and event_type = 'doelenboom_exported'`, [doelenboomId]);
  });

  // ---- A03: invoer ----

  it('A03: injectie en onbekende namen in de kolomkeuze geven 400, geen 500', async () => {
    const payloads = [
      "Project'; drop table elements; --", '<script>alert(1)</script>', '../../etc/passwd', '{{7*7}}', '${jndi:ldap://x}',
      'Project\u0000', ' Project', 'project',
    ];
    for (const p of payloads) {
      for (const body of [{ slideColumns: [p] }, { visibleColumns: [p] }]) {
        const res = await exportPptx(body, adminToken);
        assert.equal(res.status, 400, `payload ${JSON.stringify(body)}`);
        const text = await res.text();
        assert.ok(!text.includes('drop table') && !text.includes('<script>'), 'foutmelding herhaalt de invoer niet');
      }
    }
    assert.deepEqual(await exportAudit(), []);
    assert.equal((await pool.query('select count(*)::int as n from elements where doelenboom_id = $1', [doelenboomId])).rows[0].n, 4);
  });

  it('A03: verkeerde types en waarden buiten bereik geven 400', async () => {
    const bodies: unknown[] = [
      { visibleColumns: 'Project' }, { visibleColumns: [] }, { slideColumns: 'Project' }, { slideColumns: [{ $ne: null }] },
      { perRow: 1 }, { perRow: 7 }, { perRow: 3.5 }, { perRow: '4' }, { perRow: { $gt: 0 } },
      { visibleColumns: ['Project'], slideColumns: ['Capability'] },
      { slideColumns: Array.from({ length: 5000 }, () => 'Project') },
    ];
    for (const body of bodies) {
      const res = await exportPptx(body, adminToken);
      assert.equal(res.status, 400, `body ${JSON.stringify(body).slice(0, 80)}`);
      assert.match((await res.json() as { error: string }).error, /\S/);
    }
    assert.deepEqual(await exportAudit(), []);
  });

  // ---- werking ----

  it('geeft een .pptx terug met de juiste naam, slides en inhoud', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const res = await exportPptx({ slideColumns: ['Operationele benefit'], perRow: 4 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), PPTX_MEDIA_TYPE);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="Doelenboom_[A-Za-z0-9_]+_Testboom_\d{6}\.pptx"$/);
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /Content-Disposition/i);
    const slides = readSlides(Buffer.from(await res.arrayBuffer()));
    // snoer + tussenslide + B1 + B2
    assert.equal(slides.length, 4);
    assert.match(slides[0], /1\. Project/);
    assert.match(slides[0], /per element uitgewerkt/);
    const b1 = slides.find((s) => s.includes('B1 — Voorbeeldbenefit'));
    assert.ok(b1, 'slide voor B1');
    assert.match(b1, /Omschrijving van B1/);
    assert.match(b1, /KPI van B1/);
    assert.match(b1, /C1 — Voorbeeldcapability/);
    assert.match(b1, /element P1/); // hele pad: ook het project onder de capability
  });

  it('A01/A04: toelichting bij relaties en gegevens van een andere boom komen niet in het bestand', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const res = await exportPptx({ slideColumns: ['Project', 'Capability', 'Operationele benefit'] });
    assert.equal(res.status, 200);
    const all = readSlides(Buffer.from(await res.arrayBuffer())).join('\n');
    assert.ok(!all.includes('VERTROUWELIJKE-TOELICHTING'));
    assert.ok(!all.includes('ANDERE-BOOM-GEHEIM'));
    assert.ok(!all.includes('@test.local'), 'geen e-mailadressen in de presentatie');
  });

  it('verborgen kolom komt nergens voor en de relatie wordt doorgetrokken', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const columns = (await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken })).body.columns as Array<{ typeName: string }>;
    const visibleColumns = columns.map((c) => c.typeName).filter((n) => n !== 'Capability');
    const res = await exportPptx({ visibleColumns, slideColumns: ['Operationele benefit'] });
    assert.equal(res.status, 200);
    const slides = readSlides(Buffer.from(await res.arrayBuffer()));
    const all = slides.join('\n');
    assert.ok(!all.includes('Capability') && !all.includes('Voorbeeldcapability'));
    const b1 = slides.find((s) => s.includes('B1 — Voorbeeldbenefit'));
    assert.ok(b1 && b1.includes('P1 — Voorbeeldproject'), 'project hangt nu direct onder de benefit');
  });

  // ---- A09: auditlog ----

  it('A09: een geslaagde export staat in het auditlog met formaat en gekozen kolommen, zonder inhoud', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    await pool.query(`delete from audit_log where doelenboom_id = $1 and event_type = 'doelenboom_exported'`, [doelenboomId]);
    assert.equal((await exportPptx({ slideColumns: ['Project'] }, editorToken)).status, 200);
    const rows = await exportAudit();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].detail, { kind: 'doelenboom-pptx', format: 'pptx', slideColumns: ['Project'], slides: 3 });
    assert.ok(rows[0].user_id && rows[0].tenant_id);
    assert.ok(!JSON.stringify(rows[0].detail).includes('Voorbeeld'));
  });

  // ---- A04: grens op het aantal slides ----

  it('A04: meer dan het maximum aantal slides geeft 422 met uitleg en geen auditregel', async () => {
    await pool.query(`delete from audit_log where doelenboom_id = $1 and event_type = 'doelenboom_exported'`, [doelenboomId]);
    await pool.query(
      `insert into elements (doelenboom_id, code, type, name)
       select $1, 'Q' || g, 'Capability', 'Veel ' || g from generate_series(1, $2::int) g`,
      [doelenboomId, PPTX_MAX_SLIDES]
    );
    const res = await exportPptx({ slideColumns: ['Capability'] }, adminToken);
    assert.equal(res.status, 422);
    const body = await res.json() as { error: string };
    assert.match(body.error, new RegExp(`maximum is ${PPTX_MAX_SLIDES}`));
    assert.deepEqual(await exportAudit(), []);
  });

  it('A04: dezelfde grote boom mag wel zonder die kolom uit te werken', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const res = await exportPptx({ slideColumns: ['Project'] }, adminToken);
    assert.equal(res.status, 200);
    assert.equal(readSlides(Buffer.from(await res.arrayBuffer())).length, 3);
  });
});
