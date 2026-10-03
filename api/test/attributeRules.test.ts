// Regressietests voor DOEL-77 (epic DOEL-61, "Module Controleregels"):
// controleregels op kenmerken — het regeltype attribute_condition
// (api/src/controlRules.ts), de ingebouwde regel req-<kenmerk-id> voor een
// verplicht kenmerk (motiveren via routes/controlRuleDeviations.ts) en de
// samenhang tussen kenmerkdefinities en regels. Inclusief de OWASP Top
// 10-regressietests uit het ticket: A01 (rollen/module/IDOR), A03 (waarden als
// platte tekst), A04 (eis past niet bij soort, ontbrekende/ongeldige waarde,
// kenmerk in gebruik) en A09 (audit zonder regelwaarden of labels). De
// evaluatie zelf zit client-side: web/test/tree-html-attribute-rules.test.mjs.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('kenmregels');

const DEFS = [
  { id: 'T1', label: 'Referentie', kind: 'text', subjectTypes: ['Capability'] },
  { id: 'N1', label: 'Aantal locaties', kind: 'number', subjectTypes: ['Capability'] },
  { id: 'D1', label: 'Laatst beoordeeld', kind: 'date', subjectTypes: ['Capability', 'Project'], required: true },
  { id: 'C1', label: 'Fase', kind: 'choice', subjectTypes: ['Capability'], options: ['Laag', 'Midden', 'Hoog'] },
  { id: 'B1', label: 'Extern getoetst', kind: 'boolean', subjectTypes: ['Capability'], required: true },
];

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'A01', kind: 'attribute_condition', subjectTypes: ['Capability'], attributeId: 'D1',
    operator: 'date_max_days_old', value: 180, label: 'Beoordeling is actueel', ...overrides,
  };
}

describe('controleregels op kenmerken (DOEL-77)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const putRules = (rules: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', `/api/doelenbomen/${id}/control-rules`, { token, body: { rules } });
  const getRules = async (token = adminToken) => (await req('GET', `/api/doelenbomen/${doelenboomId}/control-rules`, { token })).body;
  const putDefs = (attributes: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', `/api/doelenbomen/${id}/attributes`, { token, body: { attributes } });
  const getDefs = async () => (await req('GET', `/api/doelenbomen/${doelenboomId}/attributes`, { token: adminToken })).body;
  const tree = async (token = adminToken) => (await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token })).body;
  const devUrl = (code: string, ruleId: string, id = doelenboomId) =>
    `/api/doelenbomen/${id}/elements/${encodeURIComponent(code)}/control-rule-deviations/${encodeURIComponent(ruleId)}`;
  const putDev = (code: string, ruleId: string, token = adminToken, id = doelenboomId) =>
    req('PUT', devUrl(code, ruleId, id), { token, body: { motivatie: `Motivatie ${code} ${ruleId}` } });
  const devKeys = async () =>
    (await pool.query(
      `select e.code, d.rule_id from control_rule_deviations d join elements e on e.id = d.element_id
       where d.doelenboom_id = $1 order by e.code, d.rule_id`, [doelenboomId]
    )).rows.map((r) => `${r.code}.${r.rule_id}`).sort();
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });
  const addElement = (code: string, type = 'Capability', id = doelenboomId, token = adminToken) =>
    req('POST', `/api/doelenbomen/${id}/elements`, { token, body: { code, type, name: `Element ${code}` } });
  const storedRules = async () => (await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId])).rows[0].rules;

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
    for (const code of ['CAP1', 'CAP2']) assert.equal((await addElement(code)).status, 201);
    assert.equal((await addElement('PRJ1', 'Project')).status, 201);
    assert.equal((await addElement('MIS1', 'Missie')).status, 201);
    assert.equal((await addElement('OTX', 'Capability', otherDoelenboomId, otherAdminToken)).status, 201);
    assert.equal((await putDefs(DEFS)).status, 200);
    assert.equal((await putDefs(DEFS, otherAdminToken, otherDoelenboomId)).status, 200);
  });

  after(async () => {
    await pool.query(`delete from doelenboom_templates where name like $1`, [`${PREFIX}%`]);
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Regeltype attribute_condition ------------------------------------------

  it('elke eis is op te slaan bij de passende soort; genormaliseerd teruggelezen en opnieuw op te slaan', async () => {
    const rules = [
      rule({ id: 'T-c', attributeId: 'T1', operator: 'text_contains', value: '  ref  ' }),
      rule({ id: 'T-nc', attributeId: 'T1', operator: 'text_not_contains', value: 'x' }),
      rule({ id: 'T-eq', attributeId: 'T1', operator: 'text_equals', value: 'x' }),
      rule({ id: 'T-sw', attributeId: 'T1', operator: 'text_starts_with', value: 'x' }),
      ...['num_eq', 'num_ne', 'num_lt', 'num_lte', 'num_gt', 'num_gte'].map((operator) => rule({ id: `N-${operator}`, attributeId: 'N1', operator, value: 2.5 })),
      rule({ id: 'N-tussen', attributeId: 'N1', operator: 'num_between', value: 0, value2: 10 }),
      ...['date_before', 'date_on_or_before', 'date_after', 'date_on_or_after'].map((operator) => rule({ id: `D-${operator}`, operator, value: '2026-12-31' })),
      ...['date_max_days_old', 'date_min_days_old', 'date_max_days_ahead'].map((operator) => rule({ id: `D-${operator}`, operator, value: 0 })),
      rule({ id: 'D-nip', operator: 'date_not_in_past', value: undefined }),
      rule({ id: 'C-een', attributeId: 'C1', operator: 'choice_one_of', value: ['Midden', ' Hoog '] }),
      rule({ id: 'C-geen', attributeId: 'C1', operator: 'choice_none_of', value: ['Laag'] }),
      rule({ id: 'B-ja', attributeId: 'B1', operator: 'bool_true', value: null }),
      rule({ id: 'B-nee', attributeId: 'B1', operator: 'bool_false', value: undefined, enabled: false }),
      ...['T1', 'N1', 'D1', 'C1', 'B1'].map((attributeId) => rule({ id: `leeg-${attributeId}`, attributeId, operator: 'is_empty', value: undefined })),
    ];
    const res = await putRules(rules);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const got = await getRules(bezoekerToken);
    const byId = Object.fromEntries(got.rules.map((r: any) => [r.id, r]));
    assert.equal(got.rules.length, rules.length);
    assert.equal(byId['T-c'].value, 'ref');
    assert.deepEqual([byId['N-tussen'].value, byId['N-tussen'].value2], [0, 10]);
    assert.deepEqual(byId['C-een'].value, ['Midden', 'Hoog']);
    assert.equal(byId['D-nip'].value, null);
    assert.equal(byId['B-nee'].enabled, false);
    for (const r of got.rules) {
      assert.deepEqual([r.targetTypes, r.weight, r.min, r.max, r.tagCategory, r.field], [[], 'any', null, null, null, null], r.id);
    }
    assert.deepEqual(got.invalidRuleIds, []);
    assert.deepEqual(got.attributes.map((a: any) => a.id), ['T1', 'N1', 'D1', 'C1', 'B1'], 'definities voor de editor');
    const again = await putRules(got.rules);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual((await getRules()).rules, got.rules);
    // De boomrespons levert de regels mee voor de evaluatie in tree.html.
    assert.equal((await tree()).controlRules.length, rules.length);
  });

  it('bestaande regeltypen blijven werken naast kenmerkregels; kenmerk-velden zijn daar niet toegestaan', async () => {
    const structure = { id: 'S01', kind: 'required_field', subjectTypes: ['Capability'], field: 'description', label: 'Omschrijving' };
    assert.equal((await putRules([structure, rule()])).status, 200);
    for (const extra of [{ attributeId: 'D1' }, { operator: 'is_empty' }, { value: 1 }, { value2: 1 }]) {
      const res = await putRules([{ ...structure, ...extra }]);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(res.body.error, /is niet van toepassing op regeltype required_field/);
    }
    for (const extra of [{ targetTypes: ['Project'] }, { min: 1 }, { max: 2 }, { tagCategory: 'x' }, { field: 'kpi' }, { weight: 'primair' }]) {
      const res = await putRules([rule(extra)]);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(res.body.error, /is niet van toepassing op regeltype attribute_condition/);
    }
  });

  it('een kenmerk geldt per type: de regel mag alleen typen bevatten waarvoor het kenmerk geldt (alias volgt basistype)', async () => {
    assert.equal((await putRules([rule({ subjectTypes: ['Capability', 'Project'] })])).status, 200, 'D1 geldt voor beide');
    const res = await putRules([rule({ attributeId: 'N1', operator: 'num_gt', value: 0, subjectTypes: ['Capability', 'Project'] })]);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /kenmerk N1 geldt niet voor alle elementtypen van deze regel/);

    const cols = (await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken })).body.columns as any[];
    const alias = `${PREFIX}-Variant`;
    cols.find((c) => c.typeName === 'Capability').aliases = [{ typeName: alias, color: null }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
    assert.equal((await putRules([rule({ attributeId: 'N1', operator: 'num_gt', value: 0, subjectTypes: [alias] })])).status, 200);
    cols.find((c) => c.typeName === 'Capability').aliases = [];
    assert.equal((await putRules([rule()])).status, 200);
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
  });

  // --- OWASP A04 -------------------------------------------------------------------

  it('A04: eis past niet bij de soort, onbekend kenmerk/eis, ontbrekende of ongeldige waarde → 400, niets opgeslagen', async () => {
    assert.equal((await putRules([rule()])).status, 200);
    const before = await storedRules();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['kenmerk ontbreekt', { attributeId: undefined }, /kies een bestaand kenmerk/],
      ['onbekend kenmerk', { attributeId: 'BESTAAT-NIET' }, /kies een bestaand kenmerk/],
      ['kenmerk-id met vreemde tekens', { attributeId: `D1'; drop table elements; --` }, /kies een bestaand kenmerk/],
      ['kenmerk-id is geen tekst', { attributeId: 5 }, /kies een bestaand kenmerk/],
      ['eis ontbreekt', { operator: undefined }, /onbekende eis/],
      ['onbekende eis', { operator: 'date_is_weekend' }, /onbekende eis/],
      ['eis uit het prototype', { operator: 'constructor' }, /onbekende eis/],
      ['eis is geen tekst', { operator: ['is_empty'] }, /onbekende eis/],
      ['tekst-eis op een datum', { operator: 'text_contains', value: 'x' }, /past niet bij de soort \(date\) van kenmerk D1/],
      ['datum-eis op een getal', { attributeId: 'N1', operator: 'date_before', value: '2026-01-01' }, /past niet bij de soort \(number\)/],
      ['getal-eis op tekst', { attributeId: 'T1', operator: 'num_gt', value: 1 }, /past niet bij de soort \(text\)/],
      ['keuze-eis op ja/nee', { attributeId: 'B1', operator: 'choice_one_of', value: ['Laag'] }, /past niet bij de soort \(boolean\)/],
      ['ja/nee-eis op een keuzelijst', { attributeId: 'C1', operator: 'bool_true', value: undefined }, /past niet bij de soort \(choice\)/],
      ['dagen ontbreekt', { value: undefined }, /aantal dagen moet een geheel getal van 0 t\/m 36500/],
      ['dagen negatief', { value: -1 }, /aantal dagen moet een geheel getal/],
      ['dagen met decimalen', { value: 1.5 }, /aantal dagen moet een geheel getal/],
      ['dagen te groot', { value: 36501 }, /aantal dagen moet een geheel getal/],
      ['dagen als tekst', { value: '180' }, /aantal dagen moet een geheel getal/],
      ['datum bestaat niet', { operator: 'date_before', value: '2026-02-30' }, /bestaande datum/],
      ['datum verkeerd formaat', { operator: 'date_after', value: '31-12-2026' }, /bestaande datum/],
      ['datum ontbreekt', { operator: 'date_on_or_before', value: undefined }, /bestaande datum/],
      ['waarde bij "niet in het verleden"', { operator: 'date_not_in_past', value: 5 }, /een waarde is niet van toepassing/],
      ['waarde bij "is leeg"', { operator: 'is_empty', value: 'x' }, /een waarde is niet van toepassing/],
      ['tweede waarde bij een enkelvoudige eis', { value2: 5 }, /een tweede waarde is niet van toepassing/],
      ['tekst leeg', { attributeId: 'T1', operator: 'text_contains', value: '   ' }, /vul de tekst in/],
      ['tekst te lang', { attributeId: 'T1', operator: 'text_equals', value: 'x'.repeat(201) }, /maximaal 200 tekens/],
      ['tekst is een getal', { attributeId: 'T1', operator: 'text_equals', value: 5 }, /vul de tekst in/],
      ['getal als tekst', { attributeId: 'N1', operator: 'num_gt', value: '5' }, /vul een getal in/],
      ['getal te groot', { attributeId: 'N1', operator: 'num_lt', value: 1e15 }, /vul een getal in/],
      ['tussen zonder bovengrens', { attributeId: 'N1', operator: 'num_between', value: 1 }, /onder- en bovengrens/],
      ['tussen met omgekeerde grenzen', { attributeId: 'N1', operator: 'num_between', value: 5, value2: 1 }, /ondergrens mag niet groter/],
      ['keuze zonder waarden', { attributeId: 'C1', operator: 'choice_one_of', value: [] }, /één of meer waarden uit de keuzelijst/],
      ['keuze buiten de lijst', { attributeId: 'C1', operator: 'choice_one_of', value: ['Extreem'] }, /één of meer waarden uit de keuzelijst/],
      ['keuze dubbel', { attributeId: 'C1', operator: 'choice_none_of', value: ['Laag', 'Laag'] }, /één of meer waarden uit de keuzelijst/],
      ['keuze als tekst', { attributeId: 'C1', operator: 'choice_one_of', value: 'Laag' }, /één of meer waarden uit de keuzelijst/],
      ['keuze met niet-tekst', { attributeId: 'C1', operator: 'choice_one_of', value: [1] }, /één of meer waarden uit de keuzelijst/],
      ['onbekend veld', { waarde: 1 }, /1 onbekend\(e\) veld\(en\)/],
    ];
    for (const [name, overrides, pattern] of cases) {
      const res = await putRules([rule(overrides)]);
      assert.equal(res.status, 400, `${name}: status ${res.status} ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, pattern, name);
      assert.doesNotMatch(res.body.error, /drop table|BESTAAT-NIET|date_is_weekend|Extreem/, `${name}: invoer niet teruggekaatst`);
    }
    assert.deepEqual(await storedRules(), before);
    // Grenswaarden die wél mogen.
    assert.equal((await putRules([rule({ value: 0 }), rule({ id: 'A02', value: 36500 }), rule({ id: 'A03', attributeId: 'T1', operator: 'text_equals', value: 'x'.repeat(200) })])).status, 200);
  });

  it('A04: het voorvoegsel "req-" is gereserveerd voor verplichte kenmerken', async () => {
    for (const id of ['req-D1', 'REQ-x', 'req-']) {
      const res = await putRules([rule({ id })]);
      assert.equal(res.status, 400, id);
      assert.match(res.body.error, /mag niet met "req-" beginnen/);
    }
    assert.equal((await putRules([rule({ id: 'request' }), rule({ id: 'xreq-1' })])).status, 200, 'alleen het voorvoegsel met streepje');
  });

  it('A04: een kenmerk dat in een regel wordt gebruikt kan niet weg; eerst de regel aanpassen (409 met regel-id\'s)', async () => {
    assert.equal((await putRules([
      rule({ id: 'GEBRUIK-D1' }),
      rule({ id: 'GEBRUIK-C1', attributeId: 'C1', operator: 'choice_one_of', value: ['Hoog'] }),
      rule({ id: 'LOS', attributeId: 'T1', operator: 'is_empty', value: undefined }),
    ])).status, 200);
    const defsBefore = (await getDefs()).attributes;

    const removed = await putDefs(DEFS.filter((d) => d.id !== 'D1'));
    assert.equal(removed.status, 409);
    assert.match(removed.body.error, /controleregel\(s\) GEBRUIK-D1 /);
    assert.doesNotMatch(removed.body.error, /LOS|GEBRUIK-C1/);

    const optionGone = await putDefs(DEFS.map((d) => (d.id === 'C1' ? { ...d, options: ['Laag', 'Midden'] } : d)));
    assert.equal(optionGone.status, 409);
    assert.match(optionGone.body.error, /GEBRUIK-C1/);

    const typeGone = await putDefs(DEFS.map((d) => (d.id === 'D1' ? { ...d, subjectTypes: ['Project'] } : d)));
    assert.equal(typeGone.status, 409);
    assert.match(typeGone.body.error, /GEBRUIK-D1/);

    assert.deepEqual((await getDefs()).attributes, defsBefore, 'niets stil gewijzigd');
    // Wijzigingen die de regels niet raken mogen wel: label, extra keuzelijstwaarde, niet-gebruikte waarde weg.
    const ok = await putDefs(DEFS.map((d) => (d.id === 'C1' ? { ...d, label: 'Projectfase', options: ['Midden', 'Hoog', 'Extra'] } : d)));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Na aanpassen van de regel kan het kenmerk weg.
    assert.equal((await putRules([rule({ id: 'LOS', attributeId: 'T1', operator: 'is_empty', value: undefined })])).status, 200);
    assert.equal((await putDefs(DEFS.filter((d) => d.id !== 'D1'))).status, 200);
    assert.equal((await putDefs(DEFS)).status, 200);
  });

  // --- Verplichte kenmerken: ingebouwde regel req-<kenmerk-id> ----------------------

  it('verplicht kenmerk is te motiveren via req-<id>, door admin en editor; komt mee in de boomrespons', async () => {
    assert.equal((await putRules([])).status, 200);
    const res = await putDev('CAP1', 'req-D1');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ruleId, 'req-D1');
    assert.equal((await putDev('CAP1', 'req-B1', editorToken)).status, 200);
    assert.equal((await putDev('PRJ1', 'req-D1', editorToken)).status, 200, 'D1 geldt ook voor Project');
    const t = await tree(bezoekerToken);
    assert.deepEqual(t.controlRules, []);
    assert.deepEqual(t.controlRuleDeviations.map((d: any) => `${d.elementCode}.${d.ruleId}`).sort(), ['CAP1.req-B1', 'CAP1.req-D1', 'PRJ1.req-D1']);
    assert.ok(t.controlRuleDeviations.every((d: any) => d.updatedByEmail === undefined), 'bezoeker ziet geen e-mailadres');
    assert.equal((await req('DELETE', devUrl('PRJ1', 'req-D1'), { token: editorToken })).status, 204);
  });

  it('A04: req-<id> alleen voor een bestaand, verplicht kenmerk dat voor het type van het element geldt', async () => {
    const before = await devKeys();
    assert.equal((await putDev('CAP1', 'req-T1')).status, 400, 'T1 is niet verplicht');
    assert.equal((await putDev('CAP1', 'req-ONBEKEND')).status, 400);
    assert.equal((await putDev('PRJ1', 'req-B1')).status, 400, 'B1 geldt niet voor Project');
    assert.equal((await putDev('MIS1', 'req-D1')).status, 400, 'D1 geldt niet voor Missie');
    assert.equal((await putDev('CAP1', 'req-')).status, 400);
    assert.deepEqual(await devKeys(), before);
  });

  it('A01: motiveren van een verplicht kenmerk volgt de bestaande rechten', async () => {
    const before = await devKeys();
    assert.equal((await putDev('CAP2', 'req-D1', bezoekerToken)).status, 403);
    assert.ok([403, 404].includes((await putDev('CAP2', 'req-D1', otherAdminToken)).status));
    assert.ok([403, 404].includes((await putDev('CAP2', 'req-D1', sysadminToken)).status));
    assert.equal((await req('PUT', devUrl('CAP2', 'req-D1'), { body: { motivatie: 'x' } })).status, 401);
    assert.equal((await putDev('OTX', 'req-D1')).status, 404, 'element van een andere boom');
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await putDev('CAP2', 'req-D1')).status, 403);
    } finally {
      await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
    await setModule(tenantId, false);
    try {
      assert.equal((await putDev('CAP2', 'req-D1')).status, 403);
      assert.deepEqual((await tree()).controlRuleDeviations, []);
    } finally {
      await setModule(tenantId, true);
    }
    assert.deepEqual(await devKeys(), before);
  });

  it('regels opslaan laat de afwijkingen op verplichte kenmerken staan (en ruimt die van verwijderde regels wel op)', async () => {
    assert.equal((await putRules([rule({ id: 'TIJDELIJK' })])).status, 200);
    assert.equal((await putDev('CAP1', 'TIJDELIJK')).status, 200);
    assert.deepEqual(await devKeys(), ['CAP1.TIJDELIJK', 'CAP1.req-B1', 'CAP1.req-D1']);
    assert.equal((await putRules([])).status, 200);
    assert.deepEqual(await devKeys(), ['CAP1.req-B1', 'CAP1.req-D1']);
  });

  it('"verplicht" uitzetten of het kenmerk verwijderen ruimt de afwijkingen op; de editor krijgt vooraf het aantal', async () => {
    assert.deepEqual((await getDefs()).requiredDeviationCounts, { D1: 1, B1: 1 });
    // Een geweigerde wijziging ruimt niets op.
    assert.equal((await putDefs([...DEFS, { id: 'X X', label: 'fout', kind: 'text', subjectTypes: ['Capability'] }])).status, 400);
    assert.deepEqual(await devKeys(), ['CAP1.req-B1', 'CAP1.req-D1']);

    const off = await putDefs(DEFS.map((d) => (d.id === 'D1' ? { ...d, required: false } : d)));
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepEqual(await devKeys(), ['CAP1.req-B1']);
    assert.equal((await putDev('CAP1', 'req-D1')).status, 400, 'niet meer verplicht, dus niet meer te motiveren');
    const log = await pool.query(
      `select detail from audit_log where event_type = 'attribute_definitions_updated' and doelenboom_id = $1 order by id desc limit 1`,
      [doelenboomId]
    );
    assert.equal(log.rows[0].detail.removedDeviations, 1);

    assert.equal((await putDefs(DEFS.filter((d) => d.id !== 'B1').map((d) => (d.id === 'D1' ? { ...d, required: false } : d)))).status, 200);
    assert.deepEqual(await devKeys(), []);
    assert.deepEqual((await getDefs()).requiredDeviationCounts, {});
    assert.equal((await putDefs(DEFS)).status, 200);
  });

  // --- OWASP A01 / A03 / A09 -----------------------------------------------------------

  it('A01: kenmerkregels wijzigen alleen als admin met actieve module; andere tenant en sysadmin niet', async () => {
    assert.equal((await putRules([rule()])).status, 200);
    const before = await storedRules();
    assert.equal((await putRules([rule({ id: 'E' })], editorToken)).status, 403);
    assert.equal((await putRules([rule({ id: 'B' })], bezoekerToken)).status, 403);
    assert.ok([403, 404].includes((await putRules([rule({ id: 'O' })], otherAdminToken)).status));
    assert.ok([403, 404].includes((await putRules([rule({ id: 'S' })], sysadminToken)).status));
    await setModule(tenantId, false);
    try {
      assert.equal((await putRules([rule({ id: 'M' })])).status, 403);
      const got = await getRules();
      assert.equal(got.moduleActive, false);
      assert.deepEqual(got.attributes, [], 'zonder module geen kenmerkdefinities in de regels-context');
      assert.deepEqual((await tree()).controlRules, []);
    } finally {
      await setModule(tenantId, true);
    }
    assert.deepEqual(await storedRules(), before);
    // Een regel met een kenmerk-id van een andere boom bestaat hier gewoon niet.
    assert.equal((await putDefs([...DEFS, { id: 'ALLEEN-B', label: 'Alleen B', kind: 'text', subjectTypes: ['Capability'] }], otherAdminToken, otherDoelenboomId)).status, 200);
    assert.equal((await putRules([rule({ attributeId: 'ALLEEN-B', operator: 'is_empty', value: undefined })])).status, 400);
  });

  it('A03: HTML/script/SQL in de vergelijkingswaarde en het label wordt letterlijk als tekst opgeslagen', async () => {
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)> "'); drop table column_configs; --`;
    const res = await putRules([rule({ id: 'XSS', attributeId: 'T1', operator: 'text_contains', value: xss, label: xss })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const got = (await tree()).controlRules[0];
    assert.equal(got.value, xss);
    assert.equal(got.label, xss);
    assert.ok(Number((await pool.query('select count(*) from column_configs')).rows[0].count) > 0);
  });

  it('A09: audit-events bevatten geen regelwaarden, labels of motivaties', async () => {
    const secret = `${PREFIX} geheim`;
    assert.equal((await putRules([
      rule({ id: 'AUD1', attributeId: 'T1', operator: 'text_equals', value: `${secret} waarde`, label: `${secret} label` }),
      rule({ id: 'AUD2', attributeId: 'C1', operator: 'choice_one_of', value: ['Hoog'] }),
    ])).status, 200);
    assert.equal((await req('PUT', devUrl('CAP2', 'req-D1'), { token: adminToken, body: { motivatie: `${secret} motivatie` } })).status, 200);
    const rules = await pool.query(
      `select detail from audit_log where event_type = 'control_rules_updated' and doelenboom_id = $1 order by id desc limit 1`, [doelenboomId]
    );
    assert.deepEqual(rules.rows[0].detail, { scope: 'doelenboom', ruleCount: 2, ruleIds: ['AUD1', 'AUD2'] });
    const dev = await pool.query(
      `select detail from audit_log where event_type = 'control_rule_deviation_set' and doelenboom_id = $1 order by id desc limit 1`, [doelenboomId]
    );
    assert.deepEqual(dev.rows[0].detail, { elementCode: 'CAP2', ruleId: 'req-D1' });
    const leaked = await pool.query(`select 1 from audit_log where detail::text like $1`, [`%${secret}%`]);
    assert.equal(leaked.rowCount, 0);
    assert.equal((await req('DELETE', devUrl('CAP2', 'req-D1'), { token: adminToken })).status, 204);
  });

  // --- Boomrespons, tenant-default, sjabloon -------------------------------------------

  it('de boomrespons laat een kenmerkregel weg waarvan het kenmerk ontbreekt; de editor markeert hem', async () => {
    assert.equal((await putRules([rule({ id: 'HEEL' }), rule({ id: 'KAPOT', attributeId: 'T1', operator: 'is_empty', value: undefined })])).status, 200);
    // Rechtstreeks in de database (bv. een oude back-up): T1 verdwijnt zonder dat de regel is aangepast.
    const original = (await pool.query(`select attributes from column_configs where doelenboom_id = $1`, [doelenboomId])).rows[0].attributes;
    await pool.query(`update column_configs set attributes = $1 where doelenboom_id = $2`, [
      JSON.stringify(original.filter((a: any) => a.id !== 'T1')), doelenboomId,
    ]);
    try {
      assert.deepEqual((await tree()).controlRules.map((r: any) => r.id), ['HEEL']);
      assert.deepEqual((await getRules()).invalidRuleIds, ['KAPOT']);
      const stale = await putRules((await getRules()).rules);
      assert.equal(stale.status, 400);
      assert.match(stale.body.error, /KAPOT.*kies een bestaand kenmerk/);
    } finally {
      await pool.query(`update column_configs set attributes = $1 where doelenboom_id = $2`, [JSON.stringify(original), doelenboomId]);
    }
    assert.equal((await putRules([])).status, 200);
  });

  it('tenant-default: kenmerkregels gevalideerd tegen de standaardkenmerken; gaan samen mee naar een nieuwe boom', async () => {
    const base = `/api/tenants/${tenantId}`;
    assert.equal((await req('PUT', `${base}/control-rules`, { token: sysadminToken, body: { rules: [rule()] } })).status, 400, 'nog geen kenmerken');
    assert.equal((await req('PUT', `${base}/attributes`, { token: sysadminToken, body: { attributes: DEFS } })).status, 200);
    const ok = await req('PUT', `${base}/control-rules`, { token: sysadminToken, body: { rules: [rule({ id: 'TD1' })] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const got = await req('GET', `${base}/control-rules`, { token: sysadminToken });
    assert.equal(got.body.attributes.length, 5);
    const removed = await req('PUT', `${base}/attributes`, { token: sysadminToken, body: { attributes: DEFS.filter((d) => d.id !== 'D1') } });
    assert.equal(removed.status, 409);
    assert.match(removed.body.error, /TD1/);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken, body: { slug: 'met-kenmerkregel', name: 'Met kenmerkregel' } });
    assert.equal(boom.status, 201);
    const t = (await req('GET', `/api/doelenbomen/${boom.body.id}/tree`, { token: adminToken })).body;
    assert.deepEqual(t.controlRules.map((r: any) => [r.id, r.attributeId, r.operator, r.value]), [['TD1', 'D1', 'date_max_days_old', 180]]);
    assert.equal(t.attributes.length, 5);
  });

  it('sjabloon: kenmerkregels gaan mee met de definities; bewerken gevalideerd; kapot sjabloon wordt niet toegepast', async () => {
    assert.equal((await putRules([rule({ id: 'SJ1' }), rule({ id: 'SJ2', attributeId: 'C1', operator: 'choice_none_of', value: ['Laag'] })])).status, 200);
    const saved = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: `${PREFIX}-sjabloon`, scope: 'tenant' },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const t = `/api/doelenboom-templates/${saved.body.id}`;
    const tr = await req('GET', `${t}/control-rules`, { token: adminToken });
    assert.deepEqual(tr.body.rules.map((r: any) => r.id), ['SJ1', 'SJ2']);
    assert.equal(tr.body.attributes.length, 5);
    assert.deepEqual(tr.body.invalidRuleIds, []);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kenmerkregel-sjabloon', name: 'Uit sjabloon', templateId: saved.body.id },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    assert.deepEqual((await req('GET', `/api/doelenbomen/${boom.body.id}/tree`, { token: adminToken })).body.controlRules.map((r: any) => r.id), ['SJ1', 'SJ2']);

    assert.equal((await req('PUT', `${t}/control-rules`, { token: adminToken, body: { rules: [rule({ operator: 'text_contains', value: 'x' })] } })).status, 400);
    const removed = await req('PUT', `${t}/attributes`, { token: adminToken, body: { attributes: DEFS.filter((d) => d.id !== 'C1') } });
    assert.equal(removed.status, 409);
    assert.match(removed.body.error, /SJ2/);
    assert.equal((await req('PUT', `${t}/control-rules`, { token: adminToken, body: { rules: [rule({ id: 'SJ1' })] } })).status, 200);
    assert.equal((await req('PUT', `${t}/attributes`, { token: adminToken, body: { attributes: DEFS.filter((d) => d.id !== 'C1') } })).status, 200);

    // Inconsistent sjabloon (handmatig in de database): regel zonder kenmerk -> toepassen geweigerd, geen halve boom.
    await pool.query(`update doelenboom_templates set attributes_snapshot = '[]' where id = $1`, [saved.body.id]);
    const broken = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kapotte-kenmerkregel', name: 'Kapot', templateId: saved.body.id },
    });
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /controleregels van dit sjabloon/);
    assert.equal((await pool.query(`select 1 from doelenbomen where tenant_id = $1 and slug = 'kapotte-kenmerkregel'`, [tenantId])).rowCount, 0);
  });

  it('bestaande regels van vóór DOEL-77 (zonder de nieuwe velden) blijven leesbaar en opnieuw op te slaan', async () => {
    const old = [{
      id: 'OUD', kind: 'required_field', subjectTypes: ['Capability'], targetTypes: [], weight: 'any', min: null, max: null,
      tagCategory: null, field: 'kpi', label: 'KPI ingevuld', explanation: '', enabled: true,
    }];
    await pool.query(`update column_configs set rules = $1 where doelenboom_id = $2`, [JSON.stringify(old), doelenboomId]);
    const got = await getRules();
    assert.deepEqual(got.rules, old);
    assert.deepEqual(got.invalidRuleIds, []);
    assert.deepEqual((await tree()).controlRules.map((r: any) => r.id), ['OUD']);
    const res = await putRules(got.rules);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.rules[0].attributeId, res.body.rules[0].operator, res.body.rules[0].value, res.body.rules[0].value2], [null, null, null, null]);
  });
});
