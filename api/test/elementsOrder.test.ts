// Regressietests voor de volgorde van elementen binnen een kolom — zie
// "Volgorde van elementen" onderaan api/src/routes/elements.ts:
//   DOEL-84  nieuw element komt op codevolgorde in zijn kolom (POST .../elements)
//   DOEL-85  kolom in één keer sorteren (POST .../elements/sort-column, alleen admin)
//   DOEL-86  element handmatig verplaatsen (POST .../elements/:code/move)
// Inclusief de OWASP Top 10-tests uit de tickets: A01 (rollen, andere tenant,
// read_only, doelelement uit een andere kolom of boom), A03 (vaste lijsten,
// injectie) en A04 (atomair, gelijktijdige acties, andere kolommen blijven
// ongemoeid). Alleen neutrale voorbeelden.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { compareElementCodes, insertIndexByCode } from '../src/routes/elements.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('volgorde');

describe('volgorde van elementen (DOEL-84 invoegen, DOEL-85 kolom sorteren, DOEL-86 verplaatsen)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const base = (id: number | string = doelenboomId) => `/api/doelenbomen/${id}`;
  const add = (code: string, type = 'Capability', token = adminToken, id: number | string = doelenboomId, extra: Record<string, unknown> = {}) =>
    req('POST', `${base(id)}/elements`, { token, body: { code, type, name: `Element ${code}`, ...extra } });
  const addAll = async (codes: string[], type = 'Capability') => {
    for (const code of codes) assert.equal((await add(code, type)).status, 201, code);
  };
  const edge = (source: string, target: string, weight?: string) =>
    req('POST', `${base()}/edges`, { token: adminToken, body: { source, target, weight } });
  const sortColumn = (body: unknown, token: string | undefined = adminToken, id: number | string = doelenboomId) =>
    req('POST', `${base(id)}/elements/sort-column`, { token, body });
  const move = (code: string, body: unknown, token: string | undefined = editorToken, id: number | string = doelenboomId) =>
    req('POST', `${base(id)}/elements/${encodeURIComponent(code)}/move`, { token, body });
  // De volgorde zoals de boom hem levert (routes/tree.ts), per type.
  const order = async (types: string[] = ['Capability'], id: number | string = doelenboomId, token = adminToken) => {
    const tree = (await req('GET', `${base(id)}/tree`, { token })).body;
    return (tree.elements as Array<{ code: string; type: string }>).filter((e) => types.includes(e.type)).map((e) => e.code);
  };
  const sortOrders = async (id: number | string = doelenboomId) =>
    (await pool.query('select sort_order from elements where doelenboom_id = $1 order by sort_order', [id])).rows.map((r) => Number(r.sort_order));
  const wipe = (id: number | string = doelenboomId) => pool.query('delete from elements where doelenboom_id = $1', [id]);
  const assertContiguous = async (id: number | string = doelenboomId) => {
    const orders = await sortOrders(id);
    assert.deepEqual(orders, orders.map((_, i) => i + 1));
  };

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    const other = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`);
    otherDoelenboomId = other.doelenboomId;
    otherAdminToken = other.adminToken;
    await wipe();
    await wipe(otherDoelenboomId);
    assert.equal((await add('OTX', 'Capability', otherAdminToken, otherDoelenboomId)).status, 201);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // ---------------- hulpfuncties ----------------

  it('natuurlijke codevolgorde: cijfers als getal, ook achter een punt; vaste uitkomst bij gelijke codes', () => {
    const sorted = ['B10', 'B9', 'B3.10', 'B3.2', 'B3.9', 'A1', 'b2', 'B2', 'M1'].sort(compareElementCodes);
    assert.deepEqual(sorted, ['A1', 'B2', 'b2', 'B3.2', 'B3.9', 'B3.10', 'B9', 'B10', 'M1']);
    assert.equal(compareElementCodes('B2', 'B2'), 0);
    assert.notEqual(compareElementCodes('B2', 'b2'), 0);
  });

  it('insertIndexByCode: na de voorganger op code; zonder voorganger vóór de opvolger; lege kolom: achteraan', () => {
    const rows = (codes: string[]) => codes.map((code) => ({ code }));
    assert.equal(insertIndexByCode(rows(['B3.1', 'B3.2', 'B4.1']), 'B3.3'), 2);
    assert.equal(insertIndexByCode(rows(['B1', 'B9']), 'B10'), 2);
    assert.equal(insertIndexByCode(rows(['B2', 'B3']), 'B1'), 0);
    assert.equal(insertIndexByCode(rows([]), 'B1'), 0);
    // Kolom die niet op code staat: naast de buur op code.
    assert.equal(insertIndexByCode(rows(['C3', 'C1']), 'C2'), 2);
    assert.equal(insertIndexByCode(rows(['C3', 'C2']), 'C1'), 1);
  });

  // ---------------- DOEL-84: nieuw element op zijn plek ----------------

  it('DOEL-84: B3.3 komt na B3.2, B10 na B9, en een kleinste code komt vooraan', async () => {
    await wipe();
    await addAll(['B3.1', 'B3.2', 'B4.1']);
    assert.equal((await add('B3.3', 'Capability', editorToken)).status, 201);
    assert.deepEqual(await order(), ['B3.1', 'B3.2', 'B3.3', 'B4.1']);
    await addAll(['B9', 'B10', 'B3.10']);
    assert.deepEqual(await order(), ['B3.1', 'B3.2', 'B3.3', 'B3.10', 'B4.1', 'B9', 'B10']);
    await addAll(['A1']);
    assert.deepEqual(await order(), ['A1', 'B3.1', 'B3.2', 'B3.3', 'B3.10', 'B4.1', 'B9', 'B10']);
    await assertContiguous();
  });

  it('DOEL-84: andere kolommen blijven in hun eigen volgorde; het antwoord bevat de nieuwe sort_order', async () => {
    await wipe();
    await addAll(['P2', 'P1'], 'Project'); // P1 komt vóór P2 (op code)
    await addAll(['C1', 'C3']);
    await addAll(['M1'], 'Missie');
    const created = await add('C2');
    assert.equal(created.status, 201);
    assert.deepEqual(await order(), ['C1', 'C2', 'C3']);
    assert.deepEqual(await order(['Project']), ['P1', 'P2']);
    assert.deepEqual(await order(['Missie']), ['M1']);
    const stored = await pool.query('select sort_order from elements where doelenboom_id = $1 and code = $2', [doelenboomId, 'C2']);
    assert.equal(Number(created.body.sort_order), Number(stored.rows[0].sort_order));
    await assertContiguous();
  });

  it('DOEL-84: in een handmatig geordende kolom komt het element naast zijn buur op code', async () => {
    await wipe();
    await addAll(['C1', 'C3']);
    assert.equal((await move('C3', { after: null })).status, 200);
    assert.deepEqual(await order(), ['C3', 'C1']);
    await addAll(['C2']);
    assert.deepEqual(await order(), ['C3', 'C1', 'C2']);
  });

  it('DOEL-84: een alias-type hoort bij de kolom van zijn basistype', async () => {
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken, body: { slug: 'alias', name: 'Aliasboom' } });
    assert.equal(boom.status, 201);
    const id = boom.body.id as number;
    await wipe(id);
    const col = { subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, relationLabelToNext: null };
    const put = await req('PUT', `${base(id)}/column-config`, {
      token: adminToken,
      body: { columns: [
        { ...col, typeName: 'Project', title: 'Project', isProjectRole: true, aliases: [{ typeName: 'Project 1', color: null }] },
        { ...col, typeName: 'Capability', title: 'Capability', isProjectRole: false },
      ] },
    });
    assert.equal(put.status, 200);
    for (const [code, type] of [['P1', 'Project'], ['P3', 'Project 1'], ['C1', 'Capability']]) {
      assert.equal((await add(code, type, adminToken, id)).status, 201);
    }
    assert.equal((await add('P2', 'Project 1', adminToken, id)).status, 201);
    assert.deepEqual(await order(['Project', 'Project 1'], id), ['P1', 'P2', 'P3']);
    // Sorteren en verplaatsen rekenen de alias ook tot de kolom.
    assert.equal((await move('P3', { after: null }, editorToken, id)).status, 200);
    assert.deepEqual(await order(['Project', 'Project 1'], id), ['P3', 'P1', 'P2']);
    assert.deepEqual((await sortColumn({ column: 'Project', by: 'code' }, adminToken, id)).body, { sorted: 3, moved: 3 });
    assert.deepEqual(await order(['Project', 'Project 1'], id), ['P1', 'P2', 'P3']);
    // De aliasnaam zelf is geen kolom.
    assert.equal((await sortColumn({ column: 'Project 1', by: 'code' }, adminToken, id)).status, 400);
  });

  it('DOEL-84: een expliciete sortOrder wordt opgeslagen zoals hij is; een dubbele code geeft 409 en wijzigt niets', async () => {
    await wipe();
    await addAll(['C1', 'C2']);
    const explicit = await add('C9', 'Capability', adminToken, doelenboomId, { sortOrder: 500 });
    assert.equal(explicit.status, 201);
    assert.equal(Number(explicit.body.sort_order), 500);
    const beforeOrders = await sortOrders();
    assert.equal((await add('C1')).status, 409);
    assert.deepEqual(await sortOrders(), beforeOrders);
    assert.deepEqual(await order(), ['C1', 'C2', 'C9']);
  });

  it('DOEL-84 A04: gelijktijdig aanmaken geeft geen dubbele of ontbrekende plekken', async () => {
    await wipe();
    await addAll(['K1', 'K20']);
    const codes = Array.from({ length: 12 }, (_, i) => `K${i + 2}`);
    const results = await Promise.all(codes.map((code) => add(code)));
    assert.deepEqual(results.map((r) => r.status), codes.map(() => 201));
    assert.deepEqual(await order(), ['K1', ...codes, 'K20']);
    await assertContiguous();
  });

  it('DOEL-84 A01: bezoeker en andere tenant mogen geen element aanmaken; de volgorde blijft gelijk', async () => {
    const beforeOrder = await order();
    assert.equal((await add('K0', 'Capability', bezoekerToken)).status, 403);
    assert.equal((await add('K0', 'Capability', otherAdminToken)).status, 403);
    assert.deepEqual(await order(), beforeOrder);
    assert.deepEqual(await order(['Capability'], otherDoelenboomId, otherAdminToken), ['OTX']);
  });

  // ---------------- DOEL-86: handmatig verplaatsen ----------------

  it('DOEL-86: omhoog en omlaag, met de randen; andere kolommen blijven ongemoeid', async () => {
    await wipe();
    await addAll(['P1', 'P2'], 'Project');
    await addAll(['C1', 'C2', 'C3']);
    assert.deepEqual((await move('C3', { direction: 'up' })).body, { moved: true, position: 2, of: 3 });
    assert.deepEqual(await order(), ['C1', 'C3', 'C2']);
    assert.deepEqual((await move('C3', { direction: 'up' })).body, { moved: true, position: 1, of: 3 });
    assert.deepEqual((await move('C3', { direction: 'up' })).body, { moved: false, position: 1, of: 3 });
    assert.deepEqual(await order(), ['C3', 'C1', 'C2']);
    assert.deepEqual((await move('C2', { direction: 'down' })).body, { moved: false, position: 3, of: 3 });
    assert.deepEqual((await move('C3', { direction: 'down' }, adminToken)).body, { moved: true, position: 2, of: 3 });
    assert.deepEqual(await order(), ['C1', 'C3', 'C2']);
    assert.deepEqual(await order(['Project']), ['P1', 'P2']);
    await assertContiguous();
  });

  it('DOEL-86: plaatsen na een ander element en bovenaan', async () => {
    await wipe();
    await addAll(['C1', 'C2', 'C3', 'C4']);
    assert.deepEqual((await move('C1', { after: 'C3' })).body, { moved: true, position: 3, of: 4 });
    assert.deepEqual(await order(), ['C2', 'C3', 'C1', 'C4']);
    assert.deepEqual((await move('C4', { after: null })).body, { moved: true, position: 1, of: 4 });
    assert.deepEqual(await order(), ['C4', 'C2', 'C3', 'C1']);
    // Al op die plek: niets te doen.
    assert.deepEqual((await move('C2', { after: 'C4' })).body, { moved: false, position: 2, of: 4 });
    assert.deepEqual((await move('C4', { after: ' C1 ' })).body, { moved: true, position: 4, of: 4 });
    assert.deepEqual(await order(), ['C2', 'C3', 'C1', 'C4']);
  });

  it('DOEL-86 A01/A04: doelelement uit een andere kolom of boom, zichzelf, onbekend, en ongeldige opdrachten worden geweigerd zonder iets te wijzigen', async () => {
    await wipe();
    await addAll(['P1'], 'Project');
    await addAll(['C1', 'C2']);
    const beforeOrders = JSON.stringify([await order(), await order(['Project']), await sortOrders()]);
    assert.equal((await move('C1', { after: 'P1' })).status, 400);
    assert.equal((await move('C1', { after: 'C1' })).status, 400);
    assert.equal((await move('C1', { after: 'OTX' })).status, 404);
    assert.equal((await move('C1', { after: 'BESTAAT-NIET' })).status, 404);
    assert.equal((await move('BESTAAT-NIET', { direction: 'up' })).status, 404);
    assert.equal((await move('OTX', { direction: 'up' })).status, 404);
    assert.equal((await move('C2', {})).status, 400);
    assert.equal((await move('C2', { direction: 'up', after: null })).status, 400);
    assert.equal((await move('C2', { direction: 'links' })).status, 400);
    assert.equal((await move('C2', { direction: 1 })).status, 400);
    assert.equal((await move('C2', { after: 5 })).status, 400);
    assert.equal((await move('C2', { after: '' })).status, 400);
    assert.equal((await move('C2', { after: 'x'.repeat(201) })).status, 400);
    for (const code of ["C1' or '1'='1", 'C1"; drop table elements; --', '%']) {
      assert.equal((await move('C2', { after: code })).status, 404, code);
      assert.equal((await move(code, { direction: 'up' })).status, 404, code);
    }
    assert.equal(JSON.stringify([await order(), await order(['Project']), await sortOrders()]), beforeOrders);
  });

  it('DOEL-86 A01: bezoeker, andere tenant, niet-gekoppelde sysadmin, geen login en read_only mogen niet verplaatsen', async () => {
    const beforeOrder = await order();
    const body = { direction: 'down' };
    assert.equal((await move('C1', body, bezoekerToken)).status, 403);
    assert.equal((await move('C1', body, otherAdminToken)).status, 403);
    assert.equal((await move('C1', body, sysadminToken)).status, 403);
    assert.equal((await req('POST', `${base()}/elements/C1/move`, { body })).status, 401);
    // Met het eigen boom-id van een andere tenant komt die admin niet bij onze elementen.
    assert.equal((await move('C1', body, otherAdminToken, otherDoelenboomId)).status, 404);
    await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await move('C1', body, adminToken)).status, 403);
      assert.equal((await sortColumn({ column: 'Capability', by: 'code' })).status, 403);
    } finally {
      await req('PUT', base(), { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
    assert.deepEqual(await order(), beforeOrder);
  });

  // ---------------- DOEL-85: kolom sorteren ----------------

  it('DOEL-85: sorteren op code zet alleen die kolom recht en meldt hoeveel er verplaatst zijn', async () => {
    await wipe();
    await addAll(['P1', 'P2', 'P3'], 'Project');
    await addAll(['C1', 'C2', 'C10', 'C9']);
    await move('P3', { after: null });
    await move('C10', { after: null });
    await move('C1', { after: 'C9' });
    assert.deepEqual(await order(), ['C10', 'C2', 'C9', 'C1']);
    const r = await sortColumn({ column: 'Capability', by: 'code' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sorted: 4, moved: 2 });
    assert.deepEqual(await order(), ['C1', 'C2', 'C9', 'C10']);
    assert.deepEqual(await order(['Project']), ['P3', 'P1', 'P2']);
    assert.deepEqual((await sortColumn({ column: 'Capability', by: 'code' })).body, { sorted: 4, moved: 0 });
    assert.deepEqual((await sortColumn({ column: 'Missie', by: 'code' })).body, { sorted: 0, moved: 0 });
    await assertContiguous();
  });

  it('DOEL-85: sorteren op bovenliggend element — per ouder bij elkaar, primaire relatie gaat voor, zonder ouder achteraan', async () => {
    await wipe();
    await addAll(['C1', 'C2']);
    await addAll(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], 'Project');
    assert.equal((await edge('P1', 'C2')).status, 201);
    assert.equal((await edge('P2', 'C1')).status, 201);
    assert.equal((await edge('P3', 'C2')).status, 201);
    // P5: twee ouders; de primaire (C2) telt, ook al staat C1 eerder.
    assert.equal((await edge('P5', 'C1', 'ondersteunend')).status, 201);
    assert.equal((await edge('P5', 'C2', 'primair')).status, 201);
    // P6: twee gelijkwaardige ouders; de eerste in de boom (C1) telt.
    assert.equal((await edge('P6', 'C2')).status, 201);
    assert.equal((await edge('P6', 'C1')).status, 201);
    const r = await sortColumn({ column: 'Project', by: 'parent' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sorted, 6);
    assert.deepEqual(await order(['Project']), ['P2', 'P6', 'P1', 'P3', 'P5', 'P4']);
    assert.deepEqual(await order(), ['C1', 'C2']);
    // De ouders omdraaien en opnieuw sorteren: de kinderen volgen.
    assert.equal((await move('C2', { after: null })).status, 200);
    assert.equal((await sortColumn({ column: 'Project', by: 'parent' })).status, 200);
    assert.deepEqual(await order(['Project']), ['P1', 'P3', 'P5', 'P6', 'P2', 'P4']);
    await assertContiguous();
  });

  it('DOEL-85 A01: alleen admin — editor, bezoeker, andere tenant, niet-gekoppelde sysadmin en geen login krijgen geen toegang', async () => {
    await move('P4', { after: null });
    const beforeOrder = await order(['Project']);
    const body = { column: 'Project', by: 'code' };
    assert.equal((await sortColumn(body, editorToken)).status, 403);
    assert.equal((await sortColumn(body, bezoekerToken)).status, 403);
    assert.equal((await sortColumn(body, otherAdminToken)).status, 403);
    assert.equal((await sortColumn(body, sysadminToken)).status, 403);
    assert.equal((await req('POST', `${base()}/elements/sort-column`, { body })).status, 401);
    assert.deepEqual(await order(['Project']), beforeOrder);
    // De andere boom wordt niet geraakt door een sortering in onze boom.
    assert.equal((await sortColumn(body)).status, 200);
    assert.deepEqual(await order(['Capability'], otherDoelenboomId, otherAdminToken), ['OTX']);
  });

  it('DOEL-85 A03/A04: kolom en sorteerwijze komen uit een vaste lijst; al het andere wordt geweigerd', async () => {
    const beforeOrders = await sortOrders();
    assert.equal((await sortColumn({ column: 'Project', by: 'naam' })).status, 400);
    assert.equal((await sortColumn({ column: 'Project', by: 'code; drop table elements' })).status, 400);
    assert.equal((await sortColumn({ column: 'Project' })).status, 400);
    assert.equal((await sortColumn({ column: 'Project', by: ['code'] })).status, 400);
    assert.equal((await sortColumn({ by: 'code' })).status, 400);
    assert.equal((await sortColumn({ column: '', by: 'code' })).status, 400);
    assert.equal((await sortColumn({ column: 5, by: 'code' })).status, 400);
    assert.equal((await sortColumn({ column: 'Bestaat niet', by: 'code' })).status, 400);
    assert.equal((await sortColumn({ column: "Project' or '1'='1", by: 'code' })).status, 400);
    assert.equal((await sortColumn({})).status, 400);
    assert.deepEqual(await sortOrders(), beforeOrders);
    for (const id of [999999999, 'abc']) {
      assert.equal((await sortColumn({ column: 'Project', by: 'code' }, adminToken, id)).status, 404);
      assert.equal((await move('P1', { direction: 'up' }, adminToken, id)).status, 404);
    }
  });

  it('A09: sorteren en verplaatsen schrijven geen audit-event (zelfde lijn als bewerken van een element)', async () => {
    const rows = await pool.query(
      `select event_type from audit_log where doelenboom_id = $1 and event_type <> 'doelenboom_view'`, [doelenboomId]);
    assert.deepEqual(rows.rows, []);
  });
});
