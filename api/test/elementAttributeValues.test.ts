// Regressietests voor DOEL-76 (epic DOEL-61, "Module Controleregels"):
// kenmerkwaarden per element invullen en meeleveren in de boom — zie
// api/src/elementAttributeValues.ts, de PUT-route in
// api/src/routes/elementAttributes.ts en routes/tree.ts. Inclusief de OWASP
// Top 10-regressietests uit het ticket: A01 (rollen, andere tenant, IDOR via
// elementcode, read_only, module, door-wie alleen door de server), A03
// (waarden als platte tekst), A04 (soort/lengte/datum in API én database,
// bodylimiet), A09 (geen waarden in audit_log), plus cascades, opruimen bij
// definitiewijziging en behoud bij Excel-import. Alleen neutrale voorbeelden.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { restoreAttributeValues, snapshotAttributeValues } from '../src/elementAttributeValues.js';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';

const PREFIX = unique('kenmwaarden');

const DEFS = [
  { id: 'T1', label: 'Referentie', kind: 'text', subjectTypes: ['Capability'] },
  { id: 'N1', label: 'Aantal locaties', kind: 'number', subjectTypes: ['Capability'] },
  { id: 'D1', label: 'Laatst beoordeeld', kind: 'date', subjectTypes: ['Capability'], required: true },
  { id: 'C1', label: 'Fase', kind: 'choice', subjectTypes: ['Capability', 'Project'], options: ['Laag', 'Midden', 'Hoog'] },
  { id: 'B1', label: 'Extern getoetst', kind: 'boolean', subjectTypes: ['Capability'] },
  { id: 'P1', label: 'Projectcode', kind: 'text', subjectTypes: ['Project'] },
];

describe('kenmerkwaarden per element (DOEL-76)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const url = (code: string, id = doelenboomId) => `/api/doelenbomen/${id}/elements/${encodeURIComponent(code)}/attributes`;
  const put = (code: string, values: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', url(code, id), { token, body: { values } });
  const putDefs = (attributes: unknown, id = doelenboomId, token = adminToken) =>
    req('PUT', `/api/doelenbomen/${id}/attributes`, { token, body: { attributes } });
  const tree = async (token = adminToken, id = doelenboomId) => (await req('GET', `/api/doelenbomen/${id}/tree`, { token })).body;
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });
  const addElement = (code: string, type = 'Capability', id = doelenboomId, token = adminToken) =>
    req('POST', `/api/doelenbomen/${id}/elements`, { token, body: { code, type, name: `Element ${code}` } });
  const dbRows = async (id = doelenboomId) =>
    (await pool.query(
      `select e.code, v.attribute_id, v.value_text, v.value_number::text as value_number,
              to_char(v.value_date, 'YYYY-MM-DD') as value_date, v.value_bool, v.updated_by
       from element_attribute_values v join elements e on e.id = v.element_id
       where v.doelenboom_id = $1 order by e.code, v.attribute_id`,
      [id]
    )).rows;
  const keys = async () => (await dbRows()).map((r) => `${r.code}.${r.attribute_id}`);
  const auditCount = async () =>
    Number((await pool.query('select count(*) from audit_log where doelenboom_id = $1 and event_type <> $2', [doelenboomId, 'doelenboom_view'])).rows[0].count);

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
    await setModule(other.tenantId, true);
    for (const code of ['CAP1', 'CAP2', 'CAP3']) assert.equal((await addElement(code)).status, 201);
    assert.equal((await addElement('PRJ1', 'Project')).status, 201);
    assert.equal((await addElement('OTX', 'Capability', otherDoelenboomId, otherAdminToken)).status, 201);
    assert.equal((await putDefs(DEFS)).status, 200);
    assert.equal((await putDefs(DEFS, otherDoelenboomId, otherAdminToken)).status, 200);
  });

  after(async () => {
    await pool.query(`delete from doelenboom_templates where name like $1`, [`${PREFIX}%`]);
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Basis: invullen, wijzigen, wissen per soort ----------------------------

  it('nieuwe boom: definities in de boomrespons, nog geen waarden', async () => {
    const t = await tree();
    assert.deepEqual(t.attributes.map((a: any) => a.id), ['T1', 'N1', 'D1', 'C1', 'B1', 'P1']);
    assert.deepEqual(t.attributeValues, {});
  });

  it('admin vult alle vijf soorten in; teruggelezen in respons, boom en database; door-wie door de server', async () => {
    const res = await put('CAP1', { T1: '  REF-001  ', N1: 12.5, D1: '2026-03-31', C1: 'Midden', B1: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const expected = { T1: 'REF-001', N1: 12.5, D1: '2026-03-31', C1: 'Midden', B1: false };
    assert.deepEqual(res.body, { elementCode: 'CAP1', values: expected });
    assert.deepEqual((await tree()).attributeValues, { CAP1: expected });
    const rows = await dbRows();
    assert.deepEqual(rows.map((r) => [r.attribute_id, r.value_text, r.value_number, r.value_date, r.value_bool]), [
      ['B1', null, null, null, false],
      ['C1', 'Midden', null, null, null],
      ['D1', null, null, '2026-03-31', null],
      ['N1', null, '12.5', null, null],
      ['T1', 'REF-001', null, null, null],
    ]);
    const admin = await pool.query('select id from users where email = $1', [`${PREFIX}-admin@test.local`]);
    assert.ok(rows.every((r) => String(r.updated_by) === String(admin.rows[0].id)));
  });

  it('editor mag wijzigen; niet genoemde kenmerken blijven staan; null en lege tekst wissen; 0 en nee zijn waarden', async () => {
    const res = await put('CAP1', { N1: 0, T1: null, C1: '   ' }, editorToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.values, { N1: 0, D1: '2026-03-31', B1: false });
    assert.deepEqual(await keys(), ['CAP1.B1', 'CAP1.D1', 'CAP1.N1']);
    // Nogmaals wissen van iets dat al leeg is, is geen fout.
    assert.equal((await put('CAP1', { T1: null })).status, 200);
    // Getallen: negatief, decimalen, groot — exact terug.
    for (const n of [-3, 0.000001, 123456789.123456, 999999999999999]) {
      const r = await put('CAP1', { N1: n });
      assert.equal(r.status, 200, `${n}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.values.N1, n);
      assert.equal((await tree()).attributeValues.CAP1.N1, n);
    }
    assert.equal((await put('CAP1', { D1: '2024-02-29', B1: true })).status, 200);
    assert.deepEqual((await tree()).attributeValues.CAP1, { N1: 999999999999999, D1: '2024-02-29', B1: true });
  });

  it('een kenmerk geldt per type; een alias volgt zijn basistype', async () => {
    assert.equal((await put('PRJ1', { C1: 'Hoog', P1: 'P-7' })).status, 200);
    const wrong = await put('PRJ1', { T1: 'x' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /T1: geldt niet voor elementen van dit type/);
    assert.equal((await put('CAP1', { P1: 'x' })).status, 400);

    const cols = (await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken })).body.columns as any[];
    const alias = `${PREFIX}-Variant`;
    cols.find((c) => c.typeName === 'Capability').aliases = [{ typeName: alias, color: null }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
    assert.equal((await addElement('ALI1', alias)).status, 201);
    const res = await put('ALI1', { T1: 'via alias' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await tree()).attributeValues.ALI1.T1, 'via alias');
  });

  // --- OWASP A01 -------------------------------------------------------------------

  it('A01: bezoeker ziet de waarden maar mag niet invullen; de boom bevat geen door-wie-gegevens', async () => {
    const before = await dbRows();
    const res = await put('CAP1', { T1: 'bezoeker' }, bezoekerToken);
    assert.equal(res.status, 403);
    assert.deepEqual(await dbRows(), before);
    const t = await tree(bezoekerToken);
    assert.equal(t.attributeValues.CAP1.D1, '2024-02-29');
    assert.equal(t.attributes.length, 6);
    assert.doesNotMatch(JSON.stringify(t.attributeValues), /@|updated/i);
    assert.doesNotMatch(JSON.stringify((await tree()).attributeValues), /@|updated/i);
  });

  it('A01: gebruiker van een andere tenant, niet-gekoppelde sysadmin en geen login komen er niet in', async () => {
    const before = await dbRows();
    assert.ok([403, 404].includes((await put('CAP1', { T1: 'x' }, otherAdminToken)).status));
    assert.ok([403, 404].includes((await put('CAP1', { T1: 'x' }, sysadminToken)).status));
    assert.equal((await req('PUT', url('CAP1'), { body: { values: { T1: 'x' } } })).status, 401);
    assert.deepEqual(await dbRows(), before);
  });

  it('A01 (IDOR): element van een andere boom onder het eigen boom-id geeft 404, ook omgekeerd', async () => {
    const res = await put('OTX', { T1: 'x' });
    assert.equal(res.status, 404);
    assert.equal((await put('CAP1', { T1: 'x' }, otherAdminToken, otherDoelenboomId)).status, 404);
    assert.deepEqual(await dbRows(otherDoelenboomId), []);
    assert.equal((await put('BESTAAT-NIET', { T1: 'x' })).status, 404);
  });

  it('A01: verzonnen updated_by/doelenboom/element in de body worden genegeerd', async () => {
    const res = await req('PUT', url('CAP2'), {
      token: editorToken,
      body: { values: { T1: 'echt' }, updated_by: 1, updatedBy: 'x@y.z', doelenboom_id: otherDoelenboomId, element_id: 1, elementCode: 'OTX' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const editor = await pool.query('select id from users where email = $1', [`${PREFIX}-editor@test.local`]);
    const row = (await dbRows()).find((r) => r.code === 'CAP2' && r.attribute_id === 'T1');
    assert.equal(String(row.updated_by), String(editor.rows[0].id));
    assert.deepEqual(await dbRows(otherDoelenboomId), []);
  });

  it('A01: read_only-boom: niet invullen, lezen blijft', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await put('CAP1', { T1: 'ro' })).status, 403);
      assert.equal((await put('CAP1', { T1: 'ro' }, editorToken)).status, 403);
      assert.equal((await tree()).attributeValues.CAP2.T1, 'echt');
    } finally {
      await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
  });

  it('A01: zonder actieve module geen wijzigingen (403) en niets in de boomrespons; data blijft bewaard', async () => {
    const before = await dbRows();
    await setModule(tenantId, false);
    try {
      const res = await put('CAP1', { T1: 'nomod' });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /controleregels/);
      for (const token of [adminToken, bezoekerToken]) {
        const t = await tree(token);
        assert.deepEqual(t.attributes, []);
        assert.deepEqual(t.attributeValues, {});
      }
      assert.deepEqual(await dbRows(), before);
    } finally {
      await setModule(tenantId, true);
    }
    assert.equal((await tree()).attributeValues.CAP2.T1, 'echt');
  });

  it('A01: niet-bestaand of niet-numeriek boom-id geeft 404, geen 500', async () => {
    assert.equal((await put('CAP1', {}, adminToken, 999999999)).status, 404);
    assert.equal((await req('PUT', `/api/doelenbomen/abc/elements/CAP1/attributes`, { token: adminToken, body: { values: {} } })).status, 404);
  });

  // --- OWASP A03 -------------------------------------------------------------------

  it('A03: HTML/script/SQL-achtige waarden worden letterlijk opgeslagen en als JSON-tekst teruggegeven', async () => {
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)> "'); drop table element_attribute_values; --`;
    const res = await put('CAP2', { T1: xss });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const raw = await rawReq('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.match(raw.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await raw.json()).attributeValues.CAP2.T1, xss);
    assert.ok((await dbRows()).length > 0, 'tabel bestaat nog');
    assert.equal((await put('CAP2', { T1: 'echt' })).status, 200);
  });

  it('A03: elementcode of kenmerk-id met SQL/pad-tekens levert 400/404, geen 500', async () => {
    assert.equal((await put(`CAP1' or '1'='1`, { T1: 'x' })).status, 404);
    assert.equal((await put('../CAP1', { T1: 'x' })).status, 404);
    const res = await put('CAP1', { [`T1'; drop table elements; --`]: 'x', '<img src=x>': 'y' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /2 onbekend\(e\) kenmerk\(en\)/);
    assert.doesNotMatch(res.body.error, /drop table|<img/);
  });

  // --- OWASP A04 -------------------------------------------------------------------

  it('A04: verkeerde soort, lengte, datum, getal en onbekende kenmerken worden geweigerd en slaan niets op', async () => {
    const before = await dbRows();
    const cases: Array<[string, unknown, RegExp]> = [
      ['geen object', ['T1'], /als object/],
      ['values ontbreekt', undefined, /als object/],
      ['values is tekst', 'T1=x', /als object/],
      ['meer dan 30 sleutels', Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`X${i}`, 'x'])), /Te veel kenmerken/],
      ['onbekend kenmerk', { ONBEKEND: 'x' }, /1 onbekend\(e\) kenmerk\(en\)/],
      ['tekst te lang', { T1: 'x'.repeat(201) }, /T1: de tekst mag maximaal 200 tekens/],
      ['tekst is een getal', { T1: 5 }, /T1: de waarde moet tekst zijn/],
      ['tekst is een object', { T1: { a: 1 } }, /T1: de waarde moet tekst zijn/],
      ['getal als tekst', { N1: '5' }, /N1: de waarde moet een getal zijn/],
      ['getal is boolean', { N1: true }, /N1: de waarde moet een getal zijn/],
      ['getal te groot', { N1: 1e15 }, /N1: een getal mag maximaal 15 cijfers/],
      ['getal met 7 decimalen', { N1: 0.1234567 }, /N1: een getal mag maximaal 15 cijfers/],
      ['getal met 18 cijfers', { N1: 123456789012.123456 }, /N1: een getal mag maximaal 15 cijfers/],
      ['datum bestaat niet', { D1: '2026-02-30' }, /D1: de waarde moet een bestaande datum zijn/],
      ['datum verkeerd formaat', { D1: '31-03-2026' }, /D1: de waarde moet een bestaande datum zijn/],
      ['datum zonder voorloopnullen', { D1: '2026-3-1' }, /D1: de waarde moet een bestaande datum zijn/],
      ['datum met tijd', { D1: '2026-03-31T00:00:00Z' }, /D1: de waarde moet een bestaande datum zijn/],
      ['datum vóór het jaar 1000', { D1: '0999-01-01' }, /D1: de waarde moet een bestaande datum zijn/],
      ['datum is een getal', { D1: 20260331 }, /D1: de waarde moet een bestaande datum zijn/],
      ['keuze buiten de lijst', { C1: 'Extreem' }, /C1: deze waarde staat niet in de keuzelijst/],
      ['keuze andere hoofdletters', { C1: 'laag' }, /C1: deze waarde staat niet in de keuzelijst/],
      ['keuze is een lijst', { C1: ['Laag'] }, /C1: kies een waarde uit de keuzelijst/],
      ['ja/nee als tekst', { B1: 'ja' }, /B1: de waarde moet ja of nee zijn/],
      ['ja/nee als getal', { B1: 1 }, /B1: de waarde moet ja of nee zijn/],
      ['één goed, één fout: niets opgeslagen', { T1: 'goed', N1: 'fout' }, /N1: de waarde moet een getal zijn/],
    ];
    for (const [name, values, pattern] of cases) {
      const res = await put('CAP1', values);
      assert.equal(res.status, 400, `${name}: status ${res.status} ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, pattern, name);
    }
    assert.deepEqual(await dbRows(), before);
    assert.equal((await req('PUT', url('CAP1'), { token: adminToken, body: {} })).status, 400);
    // Precies op de grens mag wel; de teller in de UI rekent in dezelfde eenheid.
    const edge = await put('CAP3', { T1: 'x'.repeat(200) });
    assert.equal(edge.status, 200, JSON.stringify(edge.body));
    assert.equal((await put('CAP3', { T1: null })).status, 200);
  });

  it('A04: de database dwingt lengte, id-patroon en "precies één waarde" ook zelf af', async () => {
    const el = (await pool.query(`select id from elements where doelenboom_id = $1 and code = 'CAP3'`, [doelenboomId])).rows[0].id;
    const ins = (cols: string, vals: string, params: unknown[] = []) =>
      pool.query(`insert into element_attribute_values (doelenboom_id, element_id, attribute_id, ${cols}) values ($1, $2, ${vals})`, [doelenboomId, el, ...params]);
    await assert.rejects(ins('value_text', `'T1', $3`, ['x'.repeat(201)]), /check/i);
    await assert.rejects(ins('value_text', `'T1', ''`), /check/i);
    await assert.rejects(ins('value_text', `'T 1', 'x'`), /check/i);
    await assert.rejects(ins('value_text, value_number', `'T1', 'x', 1`), /check/i);
    await assert.rejects(pool.query(`insert into element_attribute_values (doelenboom_id, element_id, attribute_id) values ($1, $2, 'T1')`, [doelenboomId, el]), /check/i);
    await assert.rejects(ins('value_number', `'N1', 1e15`), /check/i);
    await ins('value_text', `'T1', 'x'`);
    await assert.rejects(ins('value_text', `'T1', 'y'`), /unique|duplicate/i);
    await pool.query(`delete from element_attribute_values where element_id = $1`, [el]);
  });

  it('A04: te grote body geeft 413 zonder interne details; kapotte JSON geeft 400', async () => {
    const big = await put('CAP1', { T1: 'x'.repeat(200_000) });
    assert.equal(big.status, 413);
    assert.doesNotMatch(JSON.stringify(big.body), /PayloadTooLarge|stack|at /);
    const res = await fetch(`${getBaseUrl()}${url('CAP1')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: '{"values": {',
    });
    assert.equal(res.status, 400);
  });

  // --- OWASP A09 -------------------------------------------------------------------

  it('A09: invullen, wijzigen en wissen schrijven geen audit-event en geen waarden in audit_log', async () => {
    const before = await auditCount();
    const secret = `${PREFIX} geheime waarde`;
    assert.equal((await put('CAP3', { T1: secret, C1: 'Hoog' })).status, 200);
    assert.equal((await put('CAP3', { T1: `${secret} 2` })).status, 200);
    assert.equal((await put('CAP3', { T1: null, C1: null })).status, 200);
    await put('CAP3', { T1: 5 });
    assert.equal(await auditCount(), before);
    const leaked = await pool.query(`select 1 from audit_log where detail::text like $1`, [`%${secret}%`]);
    assert.equal(leaked.rowCount, 0);
  });

  // --- Definities wijzigen: aantallen en opruimen ----------------------------------

  it('editor-context meldt het aantal ingevulde waarden per kenmerk en per keuzelijstwaarde', async () => {
    assert.equal((await put('CAP2', { C1: 'Laag' })).status, 200);
    assert.equal((await put('CAP3', { C1: 'Hoog', T1: 'derde' })).status, 200);
    const get = await req('GET', `/api/doelenbomen/${doelenboomId}/attributes`, { token: adminToken });
    assert.equal(get.status, 200);
    // CAP1: N1, D1, B1 — CAP2: T1, C1 — CAP3: C1, T1 — PRJ1: C1, P1 — ALI1: T1
    assert.deepEqual(get.body.valueCounts, {
      T1: { total: 3, byOption: {} },
      N1: { total: 1, byOption: {} },
      D1: { total: 1, byOption: {} },
      B1: { total: 1, byOption: {} },
      C1: { total: 3, byOption: { Laag: 1, Hoog: 2 } },
      P1: { total: 1, byOption: {} },
    });
    // Geen vrije tekstwaarden van elementen in de aantallen.
    assert.doesNotMatch(JSON.stringify(get.body.valueCounts), /echt|derde|via alias|P-7/);
  });

  it('keuzelijstwaarde verwijderen wist alleen de waarden die hem gebruiken; audit met alleen een aantal', async () => {
    const defs = DEFS.map((d) => (d.id === 'C1' ? { ...d, options: ['Laag', 'Midden'] } : d));
    const res = await putDefs(defs);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const t = await tree();
    assert.equal(t.attributeValues.CAP2.C1, 'Laag');
    assert.equal(t.attributeValues.CAP3.C1, undefined);
    assert.equal(t.attributeValues.PRJ1.C1, undefined);
    assert.equal(t.attributeValues.PRJ1.P1, 'P-7', 'andere kenmerken van hetzelfde element blijven');
    const log = await pool.query(
      `select detail from audit_log where event_type = 'attribute_definitions_updated' and doelenboom_id = $1 order by id desc limit 1`,
      [doelenboomId]
    );
    assert.equal(log.rows[0].detail.removedValues, 2);
    assert.deepEqual(Object.keys(log.rows[0].detail).sort(), ['attributeCount', 'attributeIds', 'removedValues', 'scope']);
  });

  it('kenmerk verwijderen wist zijn waarden direct; een geweigerde wijziging wist niets', async () => {
    const before = await keys();
    assert.ok(before.includes('CAP2.T1') && before.includes('CAP3.T1') && before.includes('ALI1.T1'));
    const defs = DEFS.map((d) => (d.id === 'C1' ? { ...d, options: ['Laag', 'Midden'] } : d));
    const bad = await putDefs([...defs.filter((d) => d.id !== 'T1'), { id: 'X X', label: 'fout', kind: 'text', subjectTypes: ['Capability'] }]);
    assert.equal(bad.status, 400);
    assert.deepEqual(await keys(), before);

    assert.equal((await putDefs(defs.filter((d) => d.id !== 'T1'))).status, 200);
    assert.deepEqual(await keys(), before.filter((k) => !k.endsWith('.T1')));
    assert.equal((await put('CAP2', { T1: 'x' })).status, 400, 'verwijderd kenmerk is niet meer in te vullen');
    // Hetzelfde id opnieuw aanmaken (ook met een andere soort) begint leeg.
    const recreated = [...defs.filter((d) => d.id !== 'T1'), { id: 'T1', label: 'Referentie', kind: 'number', subjectTypes: ['Capability'] }];
    assert.equal((await putDefs(recreated)).status, 200);
    assert.equal((await tree()).attributeValues.CAP2.T1, undefined);
  });

  it('kenmerk geldt niet meer voor een type: waarde wordt niet meer geleverd maar blijft bewaard', async () => {
    const current = (await req('GET', `/api/doelenbomen/${doelenboomId}/attributes`, { token: adminToken })).body.attributes as any[];
    assert.equal((await tree()).attributeValues.PRJ1.P1, 'P-7');
    assert.equal((await putDefs(current.map((d) => (d.id === 'P1' ? { ...d, subjectTypes: ['Capability'] } : d)))).status, 200);
    assert.equal((await tree()).attributeValues.PRJ1, undefined);
    assert.ok((await keys()).includes('PRJ1.P1'));
    assert.equal((await putDefs(current)).status, 200);
    assert.equal((await tree()).attributeValues.PRJ1.P1, 'P-7');
  });

  // --- Excel-import, dupliceren, sjabloon, cascades ----------------------------------

  it('Excel-import (volledige vervanging van elementen): waarden blijven behouden op elementcode', async () => {
    const stamp = `select v.updated_at, v.updated_by from element_attribute_values v
       join elements e on e.id = v.element_id where v.doelenboom_id = $1 and e.code = 'CAP1' order by v.attribute_id`;
    const before = await pool.query(stamp, [doelenboomId]);
    const valuesBefore = (await tree()).attributeValues.CAP1;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const snap = await snapshotAttributeValues(client, doelenboomId);
      assert.ok(snap.length >= 4);
      await client.query(`delete from elements where doelenboom_id = $1 and code in ('CAP1','CAP3')`, [doelenboomId]);
      // Na de vervanging bestaat CAP1 weer (nieuw database-id), CAP3 niet meer.
      const re = await client.query(
        `insert into elements (doelenboom_id, code, type, name) values ($1, 'CAP1', 'Capability', 'Element CAP1') returning id`,
        [doelenboomId]
      );
      const ids = new Map<string, number>([['CAP1', re.rows[0].id]]);
      for (const r of (await client.query(`select id, code from elements where doelenboom_id = $1`, [doelenboomId])).rows) ids.set(r.code, r.id);
      await restoreAttributeValues(client, doelenboomId, snap, ids);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    const t = await tree();
    assert.deepEqual(t.attributeValues.CAP1, valuesBefore);
    assert.equal(t.attributeValues.CAP3, undefined);
    assert.ok(!(await keys()).some((k) => k.startsWith('CAP3.')));
    assert.deepEqual((await pool.query(stamp, [doelenboomId])).rows, before.rows, 'door wie/wanneer ongewijzigd');
  });

  it('de import-route legt de waarden vast en zet ze terug (naast de afwijkingen)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/routes/imports.ts', import.meta.url), 'utf8');
    const snapAt = src.indexOf('snapshotAttributeValues(client, doelenboomId)');
    const deleteAt = src.indexOf(`delete from elements where doelenboom_id = $1`);
    const restoreAt = src.indexOf('restoreAttributeValues(client, doelenboomId, attributeValueSnapshot, elementIdByCode)');
    assert.ok(snapAt > 0 && deleteAt > snapAt && restoreAt > deleteAt, 'vastleggen vóór en terugzetten ná de vervanging');
  });

  it('de Excel-export stuurt geen kenmerken of waarden naar de excel-service (buiten scope, DOEL-66)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['../src/routes/exports.ts', '../src/scripts/exportAllDoelenbomen.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.match(src, /attributes: undefined, attributeValues: undefined/, file);
    }
  });

  it('waarden gaan niet mee bij dupliceren en niet in sjablonen; de definities wel', async () => {
    const dup = await req('POST', `/api/doelenbomen/${doelenboomId}/duplicate`, {
      token: sysadminToken, body: { slug: 'waarden-kopie', name: 'Kopie' },
    });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    const t = await tree(adminToken, dup.body.id);
    assert.ok(t.elements.length > 0, 'elementen zijn gekopieerd');
    assert.equal(t.attributes.length, 6);
    assert.deepEqual(t.attributeValues, {});
    assert.deepEqual(await dbRows(dup.body.id), []);

    const saved = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: `${PREFIX}-sjabloon`, scope: 'tenant' },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const row = await pool.query('select * from doelenboom_templates where id = $1', [saved.body.id]);
    assert.doesNotMatch(JSON.stringify(row.rows[0]), /REF-001|2024-02-29|P-7|"echt"/);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'waarden-sjabloon', name: 'Uit sjabloon', templateId: saved.body.id },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    const fromTemplate = await tree(adminToken, boom.body.id);
    assert.equal(fromTemplate.attributes.length, 6);
    assert.deepEqual(fromTemplate.attributeValues, {});
  });

  it('cascade: element verwijderen via de API haalt zijn waarden weg', async () => {
    assert.ok((await keys()).some((k) => k.startsWith('CAP2.')));
    const d = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/CAP2`, { token: adminToken });
    assert.ok([200, 204].includes(d.status), String(d.status));
    assert.ok(!(await keys()).some((k) => k.startsWith('CAP2.')));
  });

  it('cascade: boom leegmaken (wipe: delete from elements) en boom verwijderen laten geen waarden achter', async () => {
    assert.ok((await dbRows()).length > 0);
    // Zelfde statement als wipeDoelenboomData() in tenantWipe.ts (wipe_on_empty/tenant-wipe).
    await pool.query('delete from elements where doelenboom_id = $1', [doelenboomId]);
    assert.deepEqual(await dbRows(), []);

    assert.equal((await addElement('CAP9')).status, 201);
    assert.equal((await put('CAP9', { B1: true })).status, 200);
    await pool.query('delete from doelenbomen where id = $1', [doelenboomId]);
    assert.equal((await pool.query('select 1 from element_attribute_values where doelenboom_id = $1', [doelenboomId])).rowCount, 0);
  });
});
