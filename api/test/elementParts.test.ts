// Regressietests voor samengestelde elementen (DOEL-140): een geheel met
// deelelementen in dezelfde kolom, één niveau diep, een deel hoort bij
// hooguit één geheel. Zie api/src/elementParts.ts en
// db/migrations/0054_element_parts.sql.
//
// OWASP Top 10 (zie het ontwerp, sectie "Security en OWASP Top 10"):
//   A01 rollen, andere tenant/boom (geen IDOR via codes), read_only, geen login
//   A03 vrije tekst als parameter, nooit in SQL-tekst; namen ongewijzigd opgeslagen
//   A04 regels: zelfde kolom, één niveau, één geheel, niet naar zichzelf
//       (API én databasetrigger), alles-of-niets
//   A05 foutmeldingen zonder interne details
//   A09 auditregels met alleen codes
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('delen');

describe('samengestelde elementen (DOEL-140)', () => {
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const base = (id: number | string = doelenboomId) => `/api/doelenbomen/${id}`;
  const col = { subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, relationLabelToNext: null };
  const COLUMNS = [
    { ...col, typeName: 'Capability', title: 'Capability', isProjectRole: false, aliases: [{ typeName: 'Voorziening', color: null }] },
    { ...col, typeName: 'Project', title: 'Project', isProjectRole: true },
  ];
  const add = (code: string, type = 'Capability', token = adminToken, id: number | string = doelenboomId, extra: Record<string, unknown> = {}) =>
    req('POST', `${base(id)}/elements`, { token, body: { code, type, name: `Element ${code}`, ...extra } });
  const compose = (body: unknown, token: string | undefined = editorToken, id: number | string = doelenboomId) =>
    req('POST', `${base(id)}/elements/compose`, { token, body });
  const put = (code: string, body: Record<string, unknown>, token = editorToken) =>
    req('PUT', `${base()}/elements/${encodeURIComponent(code)}`, { token, body: { type: 'Capability', name: `Element ${code}`, ...body } });
  const partOf = async (id: number | string = doelenboomId) => {
    const tree = (await req('GET', `${base(id)}/tree`, { token: adminToken })).body;
    return Object.fromEntries((tree.elements as Array<{ code: string; part_of: string | null }>).map((e) => [e.code, e.part_of]));
  };
  const linkCount = async (id: number | string = doelenboomId) =>
    Number((await pool.query('select count(*) from element_parts where doelenboom_id = $1', [id])).rows[0].count);
  const codesIn = async (id: number | string = doelenboomId) =>
    (await pool.query('select code from elements where doelenboom_id = $1 order by code', [id])).rows.map((r) => r.code as string);
  const reset = async () => {
    await pool.query('delete from elements where doelenboom_id = $1', [doelenboomId]);
    for (const code of ['C1', 'C2', 'C3', 'C4']) assert.equal((await add(code)).status, 201, code);
    assert.equal((await add('V1', 'Voorziening')).status, 201);
    assert.equal((await add('P1', 'Project')).status, 201);
  };
  const audit = async (eventType: string) =>
    (await pool.query(
      'select detail from audit_log where event_type = $1 and doelenboom_id = $2 order by id desc limit 1',
      [eventType, doelenboomId]
    )).rows[0]?.detail;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    const other = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`);
    otherDoelenboomId = other.doelenboomId;
    otherAdminToken = other.adminToken;
    for (const [id, token] of [[doelenboomId, adminToken], [otherDoelenboomId, otherAdminToken]] as const) {
      await pool.query('delete from elements where doelenboom_id = $1', [id]);
      const r = await req('PUT', `${base(id)}/column-config`, { token, body: { columns: COLUMNS } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await pool.query('delete from elements where doelenboom_id = $1', [otherDoelenboomId]);
    assert.equal((await add('X1', 'Capability', otherAdminToken, otherDoelenboomId)).status, 201);
    assert.equal(tenantId > 0, true);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('samenvoegen bij een bestaand geheel: delen krijgen part_of, ook met een alias-type; auditregel met alleen codes', async () => {
    await reset();
    const r = await compose({ whole: 'C1', parts: ['C2', 'V1'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const links = await partOf();
    assert.equal(links.C2, 'C1');
    assert.equal(links.V1, 'C1');
    assert.equal(links.C1, null);
    assert.deepEqual(await audit('element_parts_composed'), { whole: 'C1', parts: ['C2', 'V1'], newWhole: false });
  });

  it('samenvoegen tot een nieuw geheel maakt dat element aan op de plek van het eerste deel', async () => {
    await reset();
    const r = await compose({ newWhole: { code: 'C0', type: 'Capability', name: 'Klantenservice' }, parts: ['C3', 'C4'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tree = (await req('GET', `${base()}/tree`, { token: adminToken })).body;
    const order = (tree.elements as Array<{ code: string }>).map((e) => e.code);
    assert.ok(order.indexOf('C0') < order.indexOf('C3'), 'nieuw geheel staat vóór zijn eerste deel');
    assert.deepEqual([(await partOf()).C3, (await partOf()).C4], ['C0', 'C0']);
    // Bestaande code als nieuw geheel: 409, niets gewijzigd.
    const before = await linkCount();
    assert.equal((await compose({ newWhole: { code: 'C1', type: 'Capability', name: 'x' }, parts: ['C2'] })).status, 409);
    assert.equal(await linkCount(), before);
  });

  it('A04: regels — andere kolom, nesting (beide kanten), tweede geheel, zichzelf; alles of niets', async () => {
    await reset();
    // Andere kolom
    let r = await compose({ whole: 'C1', parts: ['C2', 'P1'] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /andere kolom/);
    assert.equal(await linkCount(), 0, 'alles of niets: ook C2 is niet gekoppeld');
    // Zichzelf
    r = await compose({ whole: 'C1', parts: ['C1'] });
    assert.equal(r.status, 400);
    // Geldig, dan nesting proberen
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] })).status, 200);
    r = await compose({ whole: 'C2', parts: ['C3'] });
    assert.equal(r.status, 400, 'een deel kan geen geheel worden');
    assert.match(r.body.error, /één niveau/);
    r = await compose({ whole: 'C3', parts: ['C1'] });
    assert.equal(r.status, 400, 'een geheel kan geen deel worden');
    assert.match(r.body.error, /één niveau/);
    // Tweede geheel voor hetzelfde deel
    r = await compose({ whole: 'C3', parts: ['C2'] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /al deel van C1/);
    // Nogmaals bij hetzelfde geheel: idempotent
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] })).status, 200);
    assert.equal(await linkCount(), 1);
    // Ongeldige body
    assert.equal((await compose({ parts: ['C2'] })).status, 400);
    assert.equal((await compose({ whole: 'C1', newWhole: { code: 'N', type: 'Capability', name: 'n' }, parts: ['C2'] })).status, 400);
    assert.equal((await compose({ whole: 'C1', parts: [] })).status, 400);
    assert.equal((await compose({ whole: 'C1', parts: 'C2' })).status, 400);
    assert.equal((await compose({ whole: 'C1', parts: Array.from({ length: 201 }, (_, i) => `Z${i}`) })).status, 400);
  });

  it('A04: de databasetrigger weigert ook bij een directe insert (andere boom, nesting)', async () => {
    await reset();
    const id = async (boom: number, code: string) =>
      (await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [boom, code])).rows[0].id;
    const c1 = await id(doelenboomId, 'C1');
    const c2 = await id(doelenboomId, 'C2');
    const c3 = await id(doelenboomId, 'C3');
    const x1 = await id(otherDoelenboomId, 'X1');
    await assert.rejects(
      pool.query('insert into element_parts (doelenboom_id, whole_element_id, part_element_id) values ($1,$2,$3)', [doelenboomId, c1, x1]),
      /dezelfde doelenboom/
    );
    await pool.query('insert into element_parts (doelenboom_id, whole_element_id, part_element_id) values ($1,$2,$3)', [doelenboomId, c1, c2]);
    await assert.rejects(
      pool.query('insert into element_parts (doelenboom_id, whole_element_id, part_element_id) values ($1,$2,$3)', [doelenboomId, c2, c3]),
      /één niveau/
    );
    await assert.rejects(
      pool.query('insert into element_parts (doelenboom_id, whole_element_id, part_element_id) values ($1,$2,$3)', [doelenboomId, c3, c1]),
      /één niveau/
    );
    await assert.rejects(
      pool.query('insert into element_parts (doelenboom_id, whole_element_id, part_element_id) values ($1,$2,$2)', [doelenboomId, c3]),
      /check/
    );
  });

  it('A01: bezoeker, andere tenant, geen login en read_only mogen niet samenvoegen; codes uit een andere boom zijn onvindbaar', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] }, bezoekerToken)).status, 403);
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] }, otherAdminToken)).status, 403);
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] }, '')).status, 401);
    // Code uit een andere boom als deel: onbekend in deze boom.
    assert.equal((await compose({ whole: 'C1', parts: ['X1'] })).status, 404);
    assert.equal((await compose({ whole: 'X1', parts: ['C1'] })).status, 404);
    await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await compose({ whole: 'C1', parts: ['C2'] }, adminToken)).status, 403);
      assert.equal((await req('POST', `${base()}/elements/C1/detach-parts`, { token: adminToken })).status, 403);
    } finally {
      await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
    assert.equal(await linkCount(), 0);
  });

  it('"Onderdeel van" bij bewerken en aanmaken; null maakt los', async () => {
    await reset();
    let r = await put('C2', { partOf: 'C1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.part_of, 'C1');
    r = await add('C5', 'Capability', editorToken, doelenboomId, { partOf: 'C1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await partOf()).C5, 'C1');
    // Geen partOf meegegeven: koppeling blijft staan.
    assert.equal((await put('C2', { description: 'gewijzigd' })).body.part_of, 'C1');
    // Ongeldig geheel: andere kolom of onbekend; niets aangemaakt.
    assert.equal((await add('C6', 'Capability', editorToken, doelenboomId, { partOf: 'P1' })).status, 400);
    assert.equal((await add('C7', 'Capability', editorToken, doelenboomId, { partOf: 'ONBEKEND' })).status, 400);
    assert.ok(!(await codesIn()).includes('C6') && !(await codesIn()).includes('C7'));
    assert.equal((await put('C2', { partOf: 42 })).status, 400);
    // Losmaken
    r = await put('C2', { partOf: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.part_of, null);
    assert.equal((await partOf()).C5, 'C1');
  });

  it('typewissel naar een andere kolom maakt los (één element en bulk); naar een alias in dezelfde kolom niet', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'C3', 'V1'] })).status, 200);
    // Alias in dezelfde kolom: koppeling blijft.
    let r = await put('C2', { type: 'Voorziening' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.detached, []);
    assert.equal((await partOf()).C2, 'C1');
    // Andere kolom: los, met auditregel.
    r = await put('C3', { type: 'Project' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.detached, [{ whole: 'C1', part: 'C3' }]);
    assert.equal((await partOf()).C3, null);
    assert.deepEqual(await audit('element_parts_detached'), { whole: 'C1', parts: ['C3'] });
    // Bulk: het geheel naar een andere kolom → alle delen los.
    r = await req('POST', `${base()}/elements/bulk-update`, { token: editorToken, body: { codes: ['C1'], set: { type: 'Project' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.detached.length, 2, 'detached alleen in het antwoord als er iets is losgemaakt');
    assert.equal(await linkCount(), 0);
  });

  it('geheel verwijderen: standaard delen losmaken, op verzoek mee verwijderen (alleen admin); ongeldige keuze 400', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'C3'] })).status, 200);
    assert.equal((await req('DELETE', `${base()}/elements/C1?parts=alles`, { token: adminToken })).status, 400);
    // Editor mag de delen niet mee verwijderen.
    assert.equal((await req('DELETE', `${base()}/elements/C1?parts=delete`, { token: editorToken })).status, 403);
    assert.ok((await codesIn()).includes('C1'));
    // Standaard: losmaken.
    assert.equal((await req('DELETE', `${base()}/elements/C1`, { token: editorToken })).status, 204);
    assert.deepEqual((await codesIn()).filter((c) => c.startsWith('C')), ['C2', 'C3', 'C4']);
    assert.equal(await linkCount(), 0);
    assert.deepEqual(await audit('element_whole_deleted'), { whole: 'C1', parts: ['C2', 'C3'], partsAction: 'detach' });
    // Mee verwijderen door een admin.
    assert.equal((await compose({ whole: 'C4', parts: ['C2', 'C3'] })).status, 200);
    assert.equal((await req('DELETE', `${base()}/elements/C4?parts=delete`, { token: adminToken })).status, 204);
    assert.deepEqual((await codesIn()).filter((c) => c.startsWith('C')), []);
    // Een deel verwijderen laat het geheel staan.
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] })).status, 200);
    assert.equal((await req('DELETE', `${base()}/elements/C2`, { token: editorToken })).status, 204);
    assert.ok((await codesIn()).includes('C1'));
  });

  it('bulk-verwijderen met parts=delete neemt niet-geselecteerde delen mee; standaard blijven ze staan', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'C3'] })).status, 200);
    let r = await req('POST', `${base()}/elements/bulk-delete`, { token: adminToken, body: { codes: ['C1', 'C4'], parts: 'iets' } });
    assert.equal(r.status, 400);
    r = await req('POST', `${base()}/elements/bulk-delete`, { token: adminToken, body: { codes: ['C1', 'C4'], parts: 'delete' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, 4);
    assert.deepEqual((await codesIn()).filter((c) => c.startsWith('C')), []);
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2'] })).status, 200);
    r = await req('POST', `${base()}/elements/bulk-delete`, { token: adminToken, body: { codes: ['C1'] } });
    assert.equal(r.body.deleted, 1);
    assert.ok((await codesIn()).includes('C2'));
  });

  it('verplaatsen: een deel binnen zijn kader, een los element tussen de losse elementen van zijn groep', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'C3'] })).status, 200);
    const move = (code: string, body: unknown) => req('POST', `${base()}/elements/${code}/move`, { token: editorToken, body });
    const order = async () => ((await req('GET', `${base()}/tree`, { token: adminToken })).body.elements as Array<{ code: string }>).map((e) => e.code);
    // Deel na een element buiten het kader: geweigerd.
    let r = await move('C2', { after: 'C4' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /eigen samengestelde element/);
    // Los element na een deel: geweigerd.
    r = await move('C4', { after: 'C2' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /deelelement/);
    // Deel omhoog/omlaag binnen het kader.
    r = await move('C3', { direction: 'up' });
    assert.deepEqual(r.body, { moved: true, position: 1, of: 2 });
    const o = await order();
    assert.ok(o.indexOf('C3') < o.indexOf('C2'));
    // Het geheel stapt over de delen heen naar een plek tussen de losse elementen.
    r = await move('C1', { after: 'C4' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { moved: true, position: 2, of: 2 });
  });

  it('alle delen losmaken; auditregel; onbekend element 404', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'V1'] })).status, 200);
    const r = await req('POST', `${base()}/elements/C1/detach-parts`, { token: editorToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { detached: 2, parts: ['C2', 'V1'] });
    assert.equal(await linkCount(), 0);
    assert.deepEqual(await audit('element_parts_detached'), { whole: 'C1', parts: ['C2', 'V1'] });
    assert.equal((await req('POST', `${base()}/elements/ONBEKEND/detach-parts`, { token: editorToken })).status, 404);
    assert.equal((await req('POST', `${base()}/elements/C1/detach-parts`, { token: bezoekerToken })).status, 403);
  });

  it('A03/A05: injectie-achtige codes zijn gewone tekst; foutmeldingen zonder interne details', async () => {
    await reset();
    const evil = "C1'; drop table element_parts; --";
    let r = await compose({ whole: evil, parts: ['C2'] });
    assert.equal(r.status, 404);
    r = await put('C2', { partOf: evil });
    assert.equal(r.status, 400);
    assert.doesNotMatch(JSON.stringify(r.body), /element_parts:|stack|at \/|pg_|select /i);
    assert.equal((await pool.query("select to_regclass('element_parts') as t")).rows[0].t, 'element_parts');
    // Een naam met HTML wordt ongewijzigd opgeslagen (escapen gebeurt bij het tonen).
    r = await compose({ newWhole: { code: 'H1', type: 'Capability', name: '<img src=x onerror=alert(1)>' }, parts: ['C3'] });
    assert.equal(r.status, 201);
    const tree = (await req('GET', `${base()}/tree`, { token: adminToken })).body;
    assert.equal((tree.elements as Array<{ code: string; name: string }>).find((e) => e.code === 'H1')!.name, '<img src=x onerror=alert(1)>');
  });

  it('dupliceren neemt de koppelingen mee', async () => {
    await reset();
    assert.equal((await compose({ whole: 'C1', parts: ['C2', 'V1'] })).status, 200);
    const email = `${PREFIX}-dup@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const sys = await login(email, 'wachtwoord123');
    const r = await req('POST', `${base()}/duplicate`, { token: sys, body: { slug: `${PREFIX}-kopie`, name: 'Kopie' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const copyId = r.body.id as number;
    const rows = (await pool.query(
      `select w.code as whole, p.code as part from element_parts ep
       join elements w on w.id = ep.whole_element_id join elements p on p.id = ep.part_element_id
       where ep.doelenboom_id = $1 order by p.code`,
      [copyId]
    )).rows;
    assert.deepEqual(rows, [{ whole: 'C1', part: 'C2' }, { whole: 'C1', part: 'V1' }]);
  });
});
