// Regressietests voor de bulkacties op een selectie van elementen:
// DOEL-81 (POST .../elements/bulk-update) en DOEL-82 (POST
// .../elements/bulk-delete) — zie api/src/routes/elements.ts. Inclusief de
// OWASP Top 10-tests uit de tickets: A01 (rollen, andere tenant, read_only,
// module, IDOR via codes van een andere boom), A03 (injectie in codes en
// waarden), A04 (limieten, onbekende velden, alles-of-niets) en A09 (geen
// audit bij bewerken; wél bij verwijderen, zonder vrije tekst).
// Verlopen licentie en beëindigde tenant lopen via dezelfde middleware
// (requireWritableDoelenboom) en zijn daar getest. Alleen neutrale voorbeelden.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('bulk');

const DEFS = [
  { id: 'C1', label: 'Fase', kind: 'choice', subjectTypes: ['Capability', 'Project'], options: ['Laag', 'Midden', 'Hoog'] },
  { id: 'T1', label: 'Referentie', kind: 'text', subjectTypes: ['Capability'] },
];

describe('bulkacties op elementen (DOEL-81 bewerken, DOEL-82 verwijderen)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const base = (id = doelenboomId) => `/api/doelenbomen/${id}`;
  const bulkUpdate = (body: unknown, token: string | undefined = editorToken, id: number | string = doelenboomId) =>
    req('POST', `/api/doelenbomen/${id}/elements/bulk-update`, { token, body: body as Record<string, unknown> });
  const bulkDelete = (body: unknown, token: string | undefined = adminToken, id: number | string = doelenboomId) =>
    req('POST', `/api/doelenbomen/${id}/elements/bulk-delete`, { token, body: body as Record<string, unknown> });
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });
  const addElement = (code: string, type: string, extra: Record<string, unknown> = {}, id = doelenboomId, token = adminToken) =>
    req('POST', `${base(id)}/elements`, { token, body: { code, type, name: `Element ${code}`, ...extra } });
  const elements = async (id = doelenboomId) =>
    (await pool.query(
      'select code, type, name, description, kpi, taakveld, subtaakveld from elements where doelenboom_id = $1 order by code', [id]
    )).rows as Array<Record<string, string>>;
  const element = async (code: string, id = doelenboomId) => (await elements(id)).find((e) => e.code === code);
  const snapshot = async (id = doelenboomId) => JSON.stringify({
    elements: await elements(id),
    tags: (await pool.query(
      `select e.code, t.code as tag, et.toelichting from element_tags et join elements e on e.id = et.element_id
       join tags t on t.id = et.tag_id where e.doelenboom_id = $1 order by 1, 2`, [id])).rows,
    orgs: (await pool.query(
      `select e.code, o.code as org, r.relatietype, r.status from ob_org_relations r join elements e on e.id = r.element_id
       join org_units o on o.id = r.org_unit_id where e.doelenboom_id = $1 order by 1, 2`, [id])).rows,
    values: (await pool.query(
      `select e.code, v.attribute_id, v.value_text from element_attribute_values v join elements e on e.id = v.element_id
       where v.doelenboom_id = $1 order by 1, 2`, [id])).rows,
    edges: (await pool.query('select count(*)::int as n from edges where doelenboom_id = $1', [id])).rows[0].n,
  });
  const tagsOf = async (code: string) =>
    (await pool.query(
      `select t.code, et.toelichting from element_tags et join elements e on e.id = et.element_id join tags t on t.id = et.tag_id
       where e.doelenboom_id = $1 and e.code = $2 order by 1`, [doelenboomId, code])).rows;
  const orgsOf = async (code: string) =>
    (await pool.query(
      `select o.code, r.relatietype, r.status from ob_org_relations r join elements e on e.id = r.element_id
       join org_units o on o.id = r.org_unit_id where e.doelenboom_id = $1 and e.code = $2 order by 1`, [doelenboomId, code])).rows;
  const valuesOf = async (code: string) =>
    (await pool.query(
      `select v.attribute_id, v.value_text, v.updated_by from element_attribute_values v join elements e on e.id = v.element_id
       where v.doelenboom_id = $1 and e.code = $2 order by 1`, [doelenboomId, code])).rows;
  const auditRows = async (eventType?: string) =>
    (await pool.query(
      `select event_type, user_id, detail from audit_log
       where doelenboom_id = $1 and event_type <> 'doelenboom_view' and ($2::text is null or event_type = $2) order by id`,
      [doelenboomId, eventType ?? null])).rows;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    const other = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`);
    otherDoelenboomId = other.doelenboomId;
    otherAdminToken = other.adminToken;
    assert.equal((await setModule(tenantId, true)).status, 200);

    // Een nieuwe boom kan voorbeeldelementen meekrijgen; die doen hier niet mee.
    await pool.query('delete from elements where doelenboom_id = any($1::bigint[])', [[doelenboomId, otherDoelenboomId]]);
    for (const code of ['P1', 'P2', 'P3']) {
      assert.equal((await addElement(code, 'Project', { description: `Omschrijving ${code}`, kpi: `KPI ${code}`, taakveld: 'Oud' })).status, 201);
    }
    for (const code of ['C1', 'C2']) assert.equal((await addElement(code, 'Capability')).status, 201);
    assert.equal((await addElement('OTX', 'Project', {}, otherDoelenboomId, otherAdminToken)).status, 201);
    for (const [code, name] of [['TA', 'Tag A'], ['TB', 'Tag B']]) {
      assert.equal((await req('POST', `${base()}/tags`, { token: adminToken, body: { code, name } })).status, 201);
    }
    for (const [code, name] of [['OA', 'Org A'], ['OB', 'Org B']]) {
      assert.equal((await req('POST', `${base()}/org-units`, { token: adminToken, body: { code, name } })).status, 201);
    }
    assert.equal((await req('POST', `${base(otherDoelenboomId)}/tags`, { token: otherAdminToken, body: { code: 'OT', name: 'Andere tag' } })).status, 201);
    assert.equal((await req('PUT', `${base()}/attributes`, { token: adminToken, body: { attributes: DEFS } })).status, 200);
    for (const [source, target] of [['P1', 'C1'], ['P2', 'C1'], ['P3', 'C2']]) {
      assert.equal((await req('POST', `${base()}/edges`, { token: adminToken, body: { source, target } })).status, 201);
    }
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // ---------------- DOEL-81: bulk-bewerken ----------------

  it('editor zet taakveld en sub-taakveld op de selectie; de rest van de boom en de overige velden blijven gelijk', async () => {
    const r = await bulkUpdate({ codes: ['P1', 'P2'], set: { taakveld: ' Nieuw taakveld ', subtaakveld: 'Sub' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { updated: 2 });
    for (const code of ['P1', 'P2']) {
      const e = await element(code);
      assert.equal(e!.taakveld, 'Nieuw taakveld');
      assert.equal(e!.subtaakveld, 'Sub');
      assert.equal(e!.name, `Element ${code}`);
      assert.equal(e!.description, `Omschrijving ${code}`);
      assert.equal(e!.kpi, `KPI ${code}`);
      assert.equal(e!.type, 'Project');
    }
    assert.equal((await element('P3'))!.taakveld, 'Oud');
    assert.equal((await element('C1'))!.taakveld, '');
  });

  it('een lege tekst maakt het veld leeg; een weggelaten veld blijft ongewijzigd', async () => {
    assert.equal((await bulkUpdate({ codes: ['P1'], set: { subtaakveld: '' } })).status, 200);
    const e = await element('P1');
    assert.equal(e!.subtaakveld, '');
    assert.equal(e!.taakveld, 'Nieuw taakveld');
  });

  it('A04: code, naam, omschrijving, KPI en andere velden in de body worden genegeerd (geen mass assignment)', async () => {
    const r = await bulkUpdate({
      codes: ['P1', 'P2'],
      set: { taakveld: 'T', code: 'GEKAAPT', name: 'Gekaapt', description: 'x', kpi: 'x', sort_order: 999, doelenboom_id: otherDoelenboomId, id: 1 },
      doelenboomId: otherDoelenboomId, name: 'Gekaapt',
    });
    assert.equal(r.status, 200);
    const codes = (await elements()).map((e) => e.code);
    assert.deepEqual(codes, ['C1', 'C2', 'P1', 'P2', 'P3']);
    assert.equal((await element('P1'))!.name, 'Element P1');
    assert.equal((await element('P1'))!.kpi, 'KPI P1');
    assert.equal((await elements(otherDoelenboomId)).length, 1);
  });

  it('tags toevoegen en verwijderen; een bestaande koppeling blijft zoals hij was', async () => {
    assert.equal((await req('POST', `${base()}/elements/P1/tags`, { token: adminToken, body: { tagCode: 'TA', toelichting: 'eigen toelichting' } })).status, 201);
    assert.equal((await bulkUpdate({ codes: ['P1', 'P2', 'C1'], tags: { add: ['TA', 'TB'] } })).status, 200);
    assert.deepEqual(await tagsOf('P1'), [{ code: 'TA', toelichting: 'eigen toelichting' }, { code: 'TB', toelichting: '' }]);
    assert.deepEqual((await tagsOf('P2')).map((t) => t.code), ['TA', 'TB']);
    assert.deepEqual((await tagsOf('C1')).map((t) => t.code), ['TA', 'TB']);
    assert.deepEqual(await tagsOf('P3'), []);

    // Verwijderen bij een selectie waarin niet elk element de tag heeft.
    assert.equal((await bulkUpdate({ codes: ['P2', 'P3'], tags: { remove: ['TB'] } })).status, 200);
    assert.deepEqual((await tagsOf('P2')).map((t) => t.code), ['TA']);
    assert.deepEqual((await tagsOf('P1')).map((t) => t.code), ['TA', 'TB']);
  });

  it('organisatieonderdelen toevoegen (Betrokken/Concept) en verwijderen; een bestaande koppeling houdt zijn relatietype', async () => {
    assert.equal((await req('POST', `${base()}/elements/P1/org-units`, {
      token: adminToken, body: { orgCode: 'OA', relatietype: 'Primair', status: 'Gevalideerd' },
    })).status, 201);
    assert.equal((await bulkUpdate({ codes: ['P1', 'P2'], orgUnits: { add: ['OA'] } })).status, 200);
    assert.deepEqual(await orgsOf('P1'), [{ code: 'OA', relatietype: 'Primair', status: 'Gevalideerd' }]);
    assert.deepEqual(await orgsOf('P2'), [{ code: 'OA', relatietype: 'Betrokken', status: 'Concept' }]);
    assert.equal((await bulkUpdate({ codes: ['P1', 'P2', 'P3'], orgUnits: { remove: ['OA'], add: ['OB'] } })).status, 200);
    for (const code of ['P1', 'P2', 'P3']) assert.deepEqual((await orgsOf(code)).map((o) => o.code), ['OB']);
  });

  it('kenmerken: een kenmerk dat voor alle types in de selectie geldt wordt gezet; door-wie zet de server', async () => {
    const r = await bulkUpdate({ codes: ['P1', 'C1', 'C2'], attributes: { C1: 'Hoog' }, updated_by: 1 });
    assert.equal(r.status, 200);
    const editorId = Number((await pool.query('select id from users where email = $1', [`${PREFIX}-editor@test.local`])).rows[0].id);
    for (const code of ['P1', 'C1', 'C2']) {
      const rows = await valuesOf(code);
      assert.deepEqual(rows.map((v) => [v.attribute_id, v.value_text]), [['C1', 'Hoog']]);
      assert.equal(Number(rows[0].updated_by), editorId);
    }
    // null wist; een niet genoemd kenmerk blijft staan.
    assert.equal((await bulkUpdate({ codes: ['C1', 'C2'], attributes: { T1: 'REF-1' } })).status, 200);
    assert.equal((await bulkUpdate({ codes: ['C1'], attributes: { C1: null } })).status, 200);
    assert.deepEqual((await valuesOf('C1')).map((v) => v.attribute_id), ['T1']);
    assert.deepEqual((await valuesOf('C2')).map((v) => v.attribute_id), ['C1', 'T1']);
  });

  it('A04: een kenmerk dat niet voor elk type in de selectie geldt, een ongeldige of onbekende waarde: 400 en niets gewijzigd', async () => {
    const before = await snapshot();
    const mixed = await bulkUpdate({ codes: ['P2', 'C2'], set: { taakveld: 'mag niet blijven staan' }, attributes: { T1: 'REF-2' } });
    assert.equal(mixed.status, 400);
    assert.match(mixed.body.error, /geldt niet voor elementen van dit type/);
    assert.equal((await bulkUpdate({ codes: ['C1'], attributes: { C1: 'Bestaat niet' } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['C1'], attributes: { ONBEKEND: 'x' } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['C1'], attributes: ['C1'] })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['C1'], attributes: 'C1' })).status, 400);
    assert.equal(await snapshot(), before);
  });

  it('type wijzigen: elementen verhuizen; een onbekend type wijzigt niets; kenmerken worden aan het nieuwe type getoetst', async () => {
    const before = await snapshot();
    const bad = await bulkUpdate({ codes: ['P3'], set: { type: 'Bestaat niet', taakveld: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal((await bulkUpdate({ codes: ['P3'], set: { type: '   ' } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P3'], set: { type: 5 } })).status, 400);
    assert.equal(await snapshot(), before);

    // T1 geldt alleen voor Capability: samen met de typewijziging mag het wél.
    const ok = await bulkUpdate({ codes: ['P3'], set: { type: 'Capability' }, attributes: { T1: 'REF-3' } });
    assert.equal(ok.status, 200);
    assert.equal((await element('P3'))!.type, 'Capability');
    assert.deepEqual((await valuesOf('P3')).map((v) => [v.attribute_id, v.value_text]), [['T1', 'REF-3']]);
    // Terug naar Project: T1 blijft bewaard maar wordt niet meer geleverd (zelfde gedrag als bij één element).
    assert.equal((await bulkUpdate({ codes: ['P3'], set: { type: 'Project' } })).status, 200);
    const tree = (await req('GET', `${base()}/tree`, { token: adminToken })).body;
    assert.equal(tree.attributeValues.P3?.T1, undefined);
    assert.equal((await valuesOf('P3')).length, 1);
    // Samen met een typewijziging naar Project mag T1 dus niet gezet worden.
    assert.equal((await bulkUpdate({ codes: ['C2'], set: { type: 'Project' }, attributes: { T1: 'x' } })).status, 400);
    assert.equal((await element('C2'))!.type, 'Capability');
  });

  it('A01: bezoeker, andere tenant, niet-gekoppelde sysadmin en geen login mogen niet bulk-bewerken', async () => {
    const before = await snapshot();
    const body = { codes: ['P1', 'P2'], set: { taakveld: 'Mag niet' } };
    assert.equal((await bulkUpdate(body, bezoekerToken)).status, 403);
    assert.equal((await bulkUpdate(body, otherAdminToken)).status, 403);
    assert.equal((await bulkUpdate(body, sysadminToken)).status, 403);
    assert.equal((await req('POST', `${base()}/elements/bulk-update`, { body })).status, 401);
    assert.equal(await snapshot(), before);
    assert.equal((await bulkUpdate(body, adminToken)).status, 200);
  });

  it('A01 (IDOR): een code van een andere boom maakt het hele verzoek ongeldig; een tag van een andere boom ook', async () => {
    const before = await snapshot();
    const otherBefore = await snapshot(otherDoelenboomId);
    const r = await bulkUpdate({ codes: ['P1', 'OTX'], set: { taakveld: 'Lek' } });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /niets gewijzigd/);
    const t = await bulkUpdate({ codes: ['P1'], set: { taakveld: 'Lek' }, tags: { add: ['OT'] } });
    assert.equal(t.status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], orgUnits: { remove: ['BESTAAT-NIET'] } })).status, 400);
    // Het boom-id van een andere tenant: geen toegang.
    assert.equal((await bulkUpdate({ codes: ['OTX'], set: { taakveld: 'Lek' } }, editorToken, otherDoelenboomId)).status, 403);
    // De admin van de andere boom kan met zijn eigen boom-id niet bij onze elementen.
    assert.equal((await bulkUpdate({ codes: ['P1'], set: { taakveld: 'Lek' } }, otherAdminToken, otherDoelenboomId)).status, 404);
    assert.equal(await snapshot(), before);
    assert.equal(await snapshot(otherDoelenboomId), otherBefore);
  });

  it('A01: read_only-boom: niet bulk-bewerken en niet bulk-verwijderen', async () => {
    const before = await snapshot();
    await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await bulkUpdate({ codes: ['P1'], set: { taakveld: 'x' } }, adminToken)).status, 403);
      assert.equal((await bulkDelete({ codes: ['P1'] })).status, 403);
    } finally {
      await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
    assert.equal(await snapshot(), before);
  });

  it('A01: zonder de module Controleregels geen kenmerken via bulk (403), de overige velden wel', async () => {
    assert.equal((await setModule(tenantId, false)).status, 200);
    try {
      const before = await snapshot();
      const r = await bulkUpdate({ codes: ['C1'], set: { taakveld: 'x' }, attributes: { T1: 'zonder module' } });
      assert.equal(r.status, 403);
      assert.equal(await snapshot(), before);
      assert.equal((await bulkUpdate({ codes: ['C1'], set: { taakveld: 'Zonder module' } })).status, 200);
    } finally {
      assert.equal((await setModule(tenantId, true)).status, 200);
    }
  });

  it('A03: SQL/HTML-achtige codes geven 404 (geen 500); zulke waarden worden letterlijk opgeslagen', async () => {
    const before = await snapshot();
    for (const code of ["P1' or '1'='1", 'P1"; drop table elements; --', '%', '../P1', '<script>alert(1)</script>']) {
      const r = await bulkUpdate({ codes: [code], set: { taakveld: 'x' } });
      assert.equal(r.status, 404, `code ${code}`);
      assert.equal((await bulkDelete({ codes: [code] })).status, 404, `code ${code}`);
    }
    assert.equal(await snapshot(), before);
    const payload = `<img src=x onerror=alert(1)>'; update elements set name = 'x'; --`;
    assert.equal((await bulkUpdate({ codes: ['C2'], set: { taakveld: payload } })).status, 200);
    assert.equal((await element('C2'))!.taakveld, payload);
    assert.equal((await element('C1'))!.name, 'Element C1');
  });

  it('A04: lege, te grote of ongeldige selectie, geen wijziging, te lange tekst en tegenstrijdige tags worden geweigerd', async () => {
    const before = await snapshot();
    const set = { taakveld: 'x' };
    assert.equal((await bulkUpdate({ set })).status, 400);
    assert.equal((await bulkUpdate({ codes: [], set })).status, 400);
    assert.equal((await bulkUpdate({ codes: 'P1', set })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1', 5], set })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1', ''], set })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1', 'x'.repeat(201)], set })).status, 400);
    assert.equal((await bulkUpdate({ codes: Array.from({ length: 201 }, (_, i) => `X${i}`), set })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'] })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], set: {}, tags: { add: [], remove: [] }, attributes: {} })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], set: { taakveld: 'x'.repeat(501) } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], set: { taakveld: 5 } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], tags: { add: ['TA'], remove: ['TA'] } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], tags: ['TA'] })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], tags: { add: 'TA' } })).status, 400);
    assert.equal((await bulkUpdate({ codes: ['P1'], tags: { add: Array.from({ length: 101 }, (_, i) => `T${i}`) } })).status, 400);
    assert.equal(await snapshot(), before);
    // Dubbele codes tellen één keer; precies 200 codes mag (hier: onbekend, dus 404 in plaats van 400).
    assert.deepEqual((await bulkUpdate({ codes: ['P1', 'P1', ' P1 '], set })).body, { updated: 1 });
    assert.equal((await bulkUpdate({ codes: Array.from({ length: 200 }, (_, i) => `X${i}`), set })).status, 404);
  });

  it('A04: alles of niets — een geldige veldwijziging samen met een onbekende tag wijzigt niets', async () => {
    const before = await snapshot();
    const r = await bulkUpdate({
      codes: ['P1', 'P2', 'C1'], set: { taakveld: 'Half', type: 'Capability' },
      tags: { add: ['TA', 'BESTAAT-NIET'] }, orgUnits: { add: ['OA'] }, attributes: { C1: 'Laag' },
    });
    assert.equal(r.status, 400);
    assert.equal(await snapshot(), before);
  });

  it('A01: niet-bestaand of niet-numeriek boom-id geeft 404, geen 500', async () => {
    for (const id of [999999999, 'abc', '1 or 1=1']) {
      assert.equal((await bulkUpdate({ codes: ['P1'], set: { taakveld: 'x' } }, adminToken, encodeURIComponent(String(id)))).status, 404);
      assert.equal((await bulkDelete({ codes: ['P1'] }, adminToken, encodeURIComponent(String(id)))).status, 404);
    }
  });

  it('A09: bulk-bewerken schrijft geen audit-event (zelfde lijn als bewerken van één element)', async () => {
    assert.deepEqual((await auditRows()).filter((r) => r.event_type !== 'attribute_definitions_updated'), []);
  });

  // ---------------- DOEL-82: bulk-verwijderen ----------------

  it('A01: editor, bezoeker, andere tenant, niet-gekoppelde sysadmin en geen login mogen niet bulk-verwijderen', async () => {
    const before = await snapshot();
    const body = { codes: ['P1', 'P2'] };
    assert.equal((await bulkDelete(body, editorToken)).status, 403);
    assert.equal((await bulkDelete(body, bezoekerToken)).status, 403);
    assert.equal((await bulkDelete(body, otherAdminToken)).status, 403);
    assert.equal((await bulkDelete(body, sysadminToken)).status, 403);
    assert.equal((await req('POST', `${base()}/elements/bulk-delete`, { body })).status, 401);
    assert.equal(await snapshot(), before);
    assert.deepEqual(await auditRows('elements_bulk_deleted'), []);
    // Eén voor één verwijderen blijft voor een editor mogelijk (ongewijzigd gedrag).
    assert.equal((await addElement('WEG1', 'Project')).status, 201);
    assert.equal((await req('DELETE', `${base()}/elements/WEG1`, { token: editorToken })).status, 204);
  });

  it('A01 (IDOR) en A04: onbekende code of code van een andere boom: 404 en niets verwijderd; ongeldige selectie: 400', async () => {
    const before = await snapshot();
    const otherBefore = await snapshot(otherDoelenboomId);
    const r = await bulkDelete({ codes: ['P1', 'P2', 'OTX'] });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /niets verwijderd/);
    assert.equal((await bulkDelete({ codes: ['P1', 'BESTAAT-NIET'] })).status, 404);
    assert.equal((await bulkDelete({ codes: ['P1'] }, otherAdminToken, otherDoelenboomId)).status, 404);
    assert.equal((await bulkDelete({})).status, 400);
    assert.equal((await bulkDelete({ codes: [] })).status, 400);
    assert.equal((await bulkDelete({ codes: 'P1' })).status, 400);
    assert.equal((await bulkDelete({ codes: [null] })).status, 400);
    assert.equal((await bulkDelete({ codes: Array.from({ length: 201 }, (_, i) => `X${i}`) })).status, 400);
    assert.equal(await snapshot(), before);
    assert.equal(await snapshot(otherDoelenboomId), otherBefore);
    assert.deepEqual(await auditRows('elements_bulk_deleted'), []);
  });

  it('admin verwijdert de selectie in één keer; relaties, koppelingen en kenmerkwaarden gaan mee, de rest blijft', async () => {
    assert.ok((await tagsOf('P1')).length > 0);
    assert.ok((await valuesOf('P1')).length > 0);
    const c2Before = { tags: await tagsOf('C2'), values: (await valuesOf('C2')).map((v) => v.attribute_id), el: await element('C2') };
    const r = await bulkDelete({ codes: ['P2', 'P1', 'P1', 'C1'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { deleted: 3 });
    assert.deepEqual((await elements()).map((e) => e.code), ['C2', 'P3']);
    // Alleen P3 -> C2 bestaat nog.
    const edges = (await pool.query(
      `select s.code as source, t.code as target from edges e join elements s on s.id = e.source_element_id
       join elements t on t.id = e.target_element_id where e.doelenboom_id = $1`, [doelenboomId])).rows;
    assert.deepEqual(edges, [{ source: 'P3', target: 'C2' }]);
    for (const table of ['element_tags', 'ob_org_relations', 'element_attribute_values']) {
      const orphans = await pool.query(`select count(*)::int as n from ${table} x where not exists (select 1 from elements e where e.id = x.element_id)`);
      assert.equal(orphans.rows[0].n, 0, table);
    }
    assert.deepEqual(await tagsOf('C2'), c2Before.tags);
    assert.deepEqual((await valuesOf('C2')).map((v) => v.attribute_id), c2Before.values);
    assert.deepEqual(await element('C2'), c2Before.el);
    // De tags en organisatieonderdelen zelf (de stamlijsten) blijven bestaan.
    assert.equal(Number((await pool.query('select count(*) from tags where doelenboom_id = $1', [doelenboomId])).rows[0].count), 2);
    assert.equal(Number((await pool.query('select count(*) from org_units where doelenboom_id = $1', [doelenboomId])).rows[0].count), 2);
    assert.equal((await elements(otherDoelenboomId)).length, 1);
  });

  it('A09: precies één audit-event per bulkverwijdering, met aantal en codes en zonder namen of vrije tekst', async () => {
    const rows = await auditRows('elements_bulk_deleted');
    assert.equal(rows.length, 1);
    const adminId = Number((await pool.query('select id from users where email = $1', [`${PREFIX}-admin@test.local`])).rows[0].id);
    assert.equal(Number(rows[0].user_id), adminId);
    assert.deepEqual(rows[0].detail, { count: 3, codes: ['C1', 'P1', 'P2'] });
    const text = JSON.stringify(rows[0].detail);
    assert.doesNotMatch(text, /Element |Omschrijving|KPI|taakveld/i);
    const tenantRow = await pool.query(`select tenant_id from audit_log where event_type = 'elements_bulk_deleted' and doelenboom_id = $1`, [doelenboomId]);
    assert.equal(Number(tenantRow.rows[0].tenant_id), Number(tenantId));
  });
});
