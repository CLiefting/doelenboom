// Regressietests voor de programma-PowerPoint (DOEL-112):
// POST /api/doelenbomen/:id/program-pptx en de opgeslagen selecties
// (/api/doelenbomen/:id/program-selections) -- zie api/src/routes/programPptx.ts
// en excel-service/app/program_pptx.py. Inclusief de OWASP Top 10-tests uit het
// ticket: A01 (rollen, module, andere tenant, IDOR op projectcodes en op
// selecties van een ander), A03 (injectie en verkeerde types), A04 (grenzen op
// aantal projecten, venster, naamlengte en aantal selecties) en A09 (auditlog
// bij een geslaagde export, niets bij een geweigerde).
// Tests die een echte presentatie nodig hebben slaan over als de excel-service
// niet bereikbaar is; de validatie- en rechtentests draaien altijd.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { pool } from '../src/db.js';
import {
  goalColumnsOf, parseProjectCodes, parseReferenceDate, parseSelectionName, parseWindowMonths,
  PROGRAM_MAX_PROJECTS, SELECTIONS_PER_USER_MAX,
} from '../src/routes/programPptx.js';
import type { ColumnDef } from '../src/columnConfig.js';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('prog');
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000';
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
let excelServiceReachable = false;

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

const col = (position: number, typeName: string, isProjectRole = false): ColumnDef => ({
  position, typeName, title: typeName, subtitle: '', color: '#000000', isNarrow: false, nodeFontSize: null,
  isProjectRole, relationLabelToNext: null, aliases: [],
} as unknown as ColumnDef);

describe('Programma-PowerPoint (DOEL-112) — pure validatie', () => {
  it('parseProjectCodes: ontdubbelt en volgt de boomvolgorde', () => {
    assert.deepEqual(parseProjectCodes(['P2', 'P1', 'P2'], ['P1', 'P2', 'P3']), { codes: ['P1', 'P2'] });
  });

  it('parseProjectCodes: weigert lege lijst, onbekende codes, verkeerde types en te veel projecten', () => {
    const known = Array.from({ length: 60 }, (_, i) => `P${i}`);
    const bad: unknown[] = [
      undefined, null, 'P1', {}, [], ['Z9'], [1], [null], [['P1']], [{ $ne: null }],
      known.slice(0, PROGRAM_MAX_PROJECTS + 1), Array.from({ length: 5000 }, () => 'P1'),
    ];
    for (const v of bad) assert.ok('error' in parseProjectCodes(v, known), JSON.stringify(v)?.slice(0, 60));
    const ok = parseProjectCodes(known.slice(0, PROGRAM_MAX_PROJECTS), known);
    assert.ok('codes' in ok && ok.codes.length === PROGRAM_MAX_PROJECTS);
  });

  it('parseWindowMonths en parseReferenceDate', () => {
    assert.deepEqual(parseWindowMonths(undefined), { months: 3 });
    assert.deepEqual(parseWindowMonths(12), { months: 12 });
    for (const v of [0, 13, 2.5, '3', null, true, NaN, [3]]) assert.ok('error' in parseWindowMonths(v), String(v));
    assert.deepEqual(parseReferenceDate(undefined), { date: null });
    assert.deepEqual(parseReferenceDate('2026-10-13'), { date: '2026-10-13' });
    for (const v of ['2026-02-30', '13-10-2026', '2026-1-1', '1999-12-31', '2026-10-13T00:00', 20261013, {}]) {
      assert.ok('error' in parseReferenceDate(v), String(v));
    }
  });

  it('parseSelectionName: trimt, verwijdert besturingstekens en begrenst de lengte', () => {
    assert.deepEqual(parseSelectionName('  Stuurgroep\u0000 OVpay '), { name: 'Stuurgroep OVpay' });
    for (const v of [undefined, '', '   ', '\u0007', 5, 'x'.repeat(81)]) assert.ok('error' in parseSelectionName(v));
  });

  it('goalColumnsOf: kolom boven het project en de één-na-bovenste kolom', () => {
    const cols = [col(0, 'Project', true), col(1, 'Capability'), col(2, 'Benefit'), col(3, 'Doel'), col(4, 'Missie')];
    const g = goalColumnsOf(cols);
    assert.equal(g.direct?.typeName, 'Capability');
    assert.equal(g.top?.typeName, 'Doel');
    // Te weinig kolommen: geen aparte doelkolom.
    assert.equal(goalColumnsOf([col(0, 'Project', true), col(1, 'Capability'), col(2, 'Missie')]).top, null);
    assert.deepEqual(goalColumnsOf([col(0, 'A'), col(1, 'B')]), { direct: null, top: null });
  });
});

describe('Programma-PowerPoint (DOEL-112) — routes', () => {
  let doelenboomId: number;
  let tenantId: number;
  let sysadminToken: string;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const exportProg = (body: unknown, token: string | undefined = bezoekerToken, id: number | string = doelenboomId) =>
    rawReq('POST', `/api/doelenbomen/${id}/program-pptx`, { token, body: body as Record<string, unknown> });
  const sel = (method: string, path: string, token: string, body?: unknown, id: number | string = doelenboomId) =>
    req(method, `/api/doelenbomen/${id}/program-selections${path}`, { token, body: body as Record<string, unknown> });
  const addElement = (code: string, type: string, name: string, id = doelenboomId, token = adminToken) =>
    req('POST', `/api/doelenbomen/${id}/elements`, { token, body: { code, type, name } });
  const exportAudit = async () =>
    (await pool.query(
      `select detail from audit_log where doelenboom_id = $1 and event_type = 'doelenboom_exported' order by id`,
      [doelenboomId])).rows;

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
    ({ doelenboomId, tenantId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    const other = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`);
    otherDoelenboomId = other.doelenboomId;
    otherAdminToken = other.adminToken;
    for (const t of [tenantId, other.tenantId]) {
      await req('PUT', `/api/tenants/${t}/license/modules/projecten`, { token: sysadminToken, body: { active: true } });
    }

    await pool.query('delete from elements where doelenboom_id = any($1::bigint[])', [[doelenboomId, otherDoelenboomId]]);
    for (const [code, type, name] of [
      ['P1', 'Project', 'Zeta-project'], ['P2', 'Project', 'Alfa-project'], ['P3', 'Project', 'Midden-project'],
      ['C1', 'Capability', 'Voorbeeldcapability'], ['D1', 'Strategisch doel', 'Voorbeelddoel'],
    ]) assert.equal((await addElement(code, type, name)).status, 201);
    for (const [s, t] of [['P1', 'C1'], ['P2', 'C1']]) {
      assert.equal((await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, { token: adminToken, body: { source: s, target: t } })).status, 201);
    }
    // C1 -> D1 via een tussenliggende benefit, om de keten te testen.
    assert.equal((await addElement('B1', 'Operationele benefit', 'Voorbeeldbenefit')).status, 201);
    for (const [s, t] of [['C1', 'B1'], ['B1', 'D1']]) {
      assert.equal((await req('POST', `/api/doelenbomen/${doelenboomId}/edges`, { token: adminToken, body: { source: s, target: t } })).status, 201);
    }
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
      token: adminToken, body: { name: 'TE-LAAT-DELIVERABLE', type: 'deliverable', verwachteDatum: '2026-01-15' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/products`, {
      token: adminToken, body: { name: 'BINNEN-VENSTER', type: 'deliverable', verwachteDatum: '2026-11-01' },
    });
    await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P2/activities`, {
      token: adminToken, body: { name: 'FASE-REALISATIE', startDate: '2026-09-01', endDate: '2026-12-31', isSummary: true },
    });
    assert.equal((await addElement('X1', 'Project', 'ANDERE-BOOM-GEHEIM', otherDoelenboomId, otherAdminToken)).status, 201);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // ---- A01: rechten ----

  it('A01: zonder token 401, andere tenant geen toegang, sysadmin zonder lidmaatschap geen toegang', async () => {
    // Let op: exportProg(…, undefined) zou de standaardwaarde (bezoeker) pakken.
    const anon = await rawReq('POST', `/api/doelenbomen/${doelenboomId}/program-pptx`, { body: { projects: ['P1'] } });
    assert.equal(anon.status, 401);
    assert.equal((await req('GET', `/api/doelenbomen/${doelenboomId}/program-selections`)).status, 401);
    assert.ok([403, 404].includes((await exportProg({ projects: ['P1'] }, otherAdminToken)).status));
    assert.ok([403, 404].includes((await exportProg({ projects: ['P1'] }, sysadminToken)).status));
    assert.ok([403, 404].includes((await sel('GET', '', otherAdminToken)).status));
    assert.deepEqual(await exportAudit(), []);
  });

  it('A01/IDOR: een project uit een andere boom, een niet-project of een onbekende code geeft 400 zonder lek', async () => {
    for (const projects of [['X1'], ['P1', 'X1'], ['C1'], ['p1'], [' P1'], ['P1\u0000']]) {
      const res = await exportProg({ projects }, adminToken);
      assert.equal(res.status, 400, JSON.stringify(projects));
      const text = await res.text();
      assert.ok(!text.includes('ANDERE-BOOM-GEHEIM') && !text.includes('X1'));
    }
    // Andersom: een project van deze boom via de andere boom.
    assert.equal((await exportProg({ projects: ['P1'] }, otherAdminToken, otherDoelenboomId)).status, 400);
  });

  it('A01: zonder module "projecten" geen export en geen selecties', async () => {
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, { token: sysadminToken, body: { active: false } });
    try {
      assert.equal((await exportProg({ projects: ['P1'] })).status, 403);
      assert.equal((await sel('GET', '', bezoekerToken)).status, 403);
    } finally {
      await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, { token: sysadminToken, body: { active: true } });
    }
  });

  // ---- A03/A04: invoer ----

  it('A03/A04: injectie, verkeerde types en grenswaarden geven 400, geen 500', async () => {
    const bodies: unknown[] = [
      {}, { projects: 'P1' }, { projects: [] }, { projects: ["P1'; drop table elements; --"] },
      { projects: ['<script>alert(1)</script>'] }, { projects: [{ $ne: null }] },
      { projects: Array.from({ length: 5000 }, () => 'P1') },
      { projects: ['P1'], windowMonths: 0 }, { projects: ['P1'], windowMonths: 13 }, { projects: ['P1'], windowMonths: '3' },
      { projects: ['P1'], referenceDate: '2026-02-30' }, { projects: ['P1'], referenceDate: "2026-01-01' or 1=1" },
      { projects: ['P1'], referenceDate: { $gt: '' } },
    ];
    for (const body of bodies) {
      const res = await exportProg(body, adminToken);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      const text = await res.text();
      assert.ok(!text.includes('drop table') && !text.includes('<script>'), 'foutmelding herhaalt de invoer niet');
    }
    assert.deepEqual(await exportAudit(), []);
    assert.equal((await pool.query('select count(*)::int as n from elements where doelenboom_id = $1', [doelenboomId])).rows[0].n, 6);
  });

  // ---- de presentatie zelf ----

  it('bezoeker exporteert: alfabetische voortgangsslides, te laat bovenaan, fasen en doelen; auditlog', async (t) => {
    if (!excelServiceReachable) return t.skip('excel-service niet bereikbaar — zie EXCEL_SERVICE_URL');
    const res = await exportProg({ projects: ['P1', 'P2'], referenceDate: '2026-10-13', windowMonths: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), PPTX_MEDIA_TYPE);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="Programma_.*\.pptx"/);
    const slides = readSlides(Buffer.from(await res.arrayBuffer()));
    assert.equal(slides.length, 7); // tijdlijn, tijdlijn alle projecten, alle projecten, deliverables, doelen, 2x voortgang
    assert.match(slides[0], /Tijdlijnen/);
    assert.match(slides[0], /FASE-REALISATIE/);
    assert.match(slides[1], /Tijdlijnen — alle projecten/);
    assert.ok(slides[1].includes('Alfa-project') && slides[1].includes('Zeta-project'));
    assert.match(slides[2], /Alle projecten/);
    assert.ok(slides[2].includes('Alfa-project') && slides[2].includes('Zeta-project'));
    assert.ok(slides[3].indexOf('TE-LAAT-DELIVERABLE') < slides[3].indexOf('BINNEN-VENSTER'));
    assert.match(slides[4], /Voorbeeldcapability/);
    assert.match(slides[4], /Voorbeelddoel/);
    assert.ok(slides[5].includes('Alfa-project') && slides[6].includes('Zeta-project'));
    // Voortgangsslide (optie 3): genummerde deliverable in de lijst.
    assert.match(slides[6], /TE-LAAT-DELIVERABLE/);
    const all = slides.join('\n');
    assert.ok(!all.includes('Midden-project'), 'niet gekozen project staat er niet in');
    assert.ok(!all.includes('ANDERE-BOOM-GEHEIM'));
    const audit = await exportAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.kind, 'programma-pptx');
    assert.deepEqual(audit[0].detail.projects, ['P1', 'P2']);
  });

  // ---- opgeslagen selecties ----

  it('selecties: aanmaken, ophalen, wijzigen en verwijderen door de eigenaar', async () => {
    const created = await sel('POST', '', bezoekerToken, { name: ' Stuurgroep ', projects: ['P2', 'P1'], windowMonths: 6 });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Stuurgroep');
    assert.deepEqual(created.body.projectCodes, ['P1', 'P2']);
    assert.equal(created.body.windowMonths, 6);
    const id = created.body.id;

    assert.equal((await sel('POST', '', bezoekerToken, { name: 'Stuurgroep', projects: ['P1'] })).status, 409);

    const list = await sel('GET', '', bezoekerToken);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((s: { name: string }) => s.name), ['Stuurgroep']);

    const upd = await sel('PUT', `/${id}`, bezoekerToken, { name: 'Stuurgroep OVpay', projects: ['P3'] });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.name, 'Stuurgroep OVpay');
    assert.deepEqual(upd.body.projectCodes, ['P3']);
    assert.equal(upd.body.windowMonths, 6);

    assert.equal((await sel('DELETE', `/${id}`, bezoekerToken)).status, 204);
    assert.deepEqual((await sel('GET', '', bezoekerToken)).body, []);
  });

  it('A01/IDOR: een selectie is alleen van de eigenaar en alleen in zijn eigen boom', async () => {
    const created = await sel('POST', '', adminToken, { name: 'Van de admin', projects: ['P1'] });
    assert.equal(created.status, 201);
    const id = created.body.id;
    // Andere gebruiker in dezelfde tenant ziet hem niet en kan hem niet wijzigen of verwijderen.
    assert.deepEqual((await sel('GET', '', editorToken)).body, []);
    assert.equal((await sel('PUT', `/${id}`, editorToken, { name: 'gekaapt' })).status, 404);
    assert.equal((await sel('DELETE', `/${id}`, editorToken)).status, 404);
    // Andere tenant via de eigen boom met dit id: 404, niet te raden of hij bestaat.
    assert.equal((await sel('PUT', `/${id}`, otherAdminToken, { name: 'gekaapt' }, otherDoelenboomId)).status, 404);
    assert.equal((await sel('DELETE', `/${id}`, otherAdminToken, undefined, otherDoelenboomId)).status, 404);
    const row = (await pool.query('select name from program_selections where id = $1', [id])).rows[0];
    assert.equal(row.name, 'Van de admin');
    // Ongeldige id's netjes 404.
    for (const bad of ['abc', '0', '-1', '1.5', '99999999999999999999']) {
      assert.equal((await sel('DELETE', `/${bad}`, adminToken)).status, 404, bad);
    }
    await sel('DELETE', `/${id}`, adminToken);
  });

  it('A03/A04: selecties weigeren ongeldige namen, projecten uit een andere boom en te veel selecties', async () => {
    const bad: unknown[] = [
      { projects: ['P1'] }, { name: '', projects: ['P1'] }, { name: 'x'.repeat(81), projects: ['P1'] },
      { name: 'ok', projects: ['X1'] }, { name: 'ok', projects: [] }, { name: 'ok', projects: 'P1' },
      { name: 'ok', projects: ['P1'], windowMonths: 99 }, { name: { $ne: null }, projects: ['P1'] },
    ];
    for (const body of bad) {
      const res = await sel('POST', '', editorToken, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    for (let i = 0; i < SELECTIONS_PER_USER_MAX; i++) {
      assert.equal((await sel('POST', '', editorToken, { name: `Set ${i}`, projects: ['P1'] })).status, 201);
    }
    assert.equal((await sel('POST', '', editorToken, { name: 'Eén te veel', projects: ['P1'] })).status, 409);
    await pool.query('delete from program_selections where doelenboom_id = $1', [doelenboomId]);
  });

  it('XSS: een selectienaam met HTML wordt als platte tekst bewaard en als JSON teruggegeven', async () => {
    const res = await sel('POST', '', adminToken, { name: '<img src=x onerror=alert(1)>', projects: ['P1'] });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, '<img src=x onerror=alert(1)>');
    const raw = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/program-selections`, { token: adminToken });
    assert.match(raw.headers.get('content-type') ?? '', /application\/json/);
    await pool.query('delete from program_selections where doelenboom_id = $1', [doelenboomId]);
  });
});
