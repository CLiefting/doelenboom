// Regressietests voor DOEL-62 (epic DOEL-61, "Module Controleregels"):
// datamodel, validatie en beheer van controleregels per kolomconfiguratie
// (doelenboom, tenant-default, sjabloon) — zie api/src/controlRules.ts en
// api/src/routes/controlRules.ts. Inclusief de OWASP Top 10-regressietests
// uit het ticket: A01 (autorisatie/IDOR, read_only, module), A03 (injectie/
// XSS-payloads worden als platte tekst opgeslagen en teruggegeven), A04
// (onverwachte jsonb-structuur, limieten, te grote body) en A09 (audit-event
// zonder vrije tekst).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('ctrlrules');

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'R01',
    kind: 'requires_outgoing',
    subjectTypes: ['Capability'],
    targetTypes: ['Operationele benefit'],
    label: 'Capability heeft een benefit als ouder',
    explanation: '',
    enabled: true,
    ...overrides,
  };
}

describe('controleregels (DOEL-62)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherTenantId: number;
  let otherAdminToken: string;
  let otherDoelenboomId: number;

  const rulesUrl = () => `/api/doelenbomen/${doelenboomId}/control-rules`;
  const putRules = (rules: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', `/api/doelenbomen/${id}/control-rules`, { token, body: { rules } });
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });

  async function columnsOf(id: number) {
    const r = await req('GET', `/api/doelenbomen/${id}/column-config`, { token: adminToken });
    assert.equal(r.status, 200);
    return r.body.columns as any[];
  }

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    ({ tenantId: otherTenantId, doelenboomId: otherDoelenboomId, adminToken: otherAdminToken } =
      await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`));
    const mod = await setModule(tenantId, true);
    assert.equal(mod.status, 200);
    await setModule(otherTenantId, true);
  });

  after(async () => {
    await pool.query(`delete from doelenboom_templates where name like $1`, [`${PREFIX}%`]);
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Datamodel / migratie ------------------------------------------------

  it('module "controleregels" bestaat in de catalogus, zonder opslagrij', async () => {
    const m = await pool.query(`select id from modules where key = 'controleregels'`);
    assert.equal(m.rowCount, 1);
    const s = await pool.query('select 1 from module_surcharges where module_id = $1', [m.rows[0].id]);
    assert.equal(s.rowCount, 0);
  });

  it('bestaande/nieuwe boom heeft rules = [] en GET levert context voor de editor', async () => {
    const res = await req('GET', rulesUrl(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rules, []);
    assert.equal(res.body.moduleActive, true);
    assert.ok(res.body.validTypeNames.includes('Capability'));
    assert.deepEqual(res.body.invalidRuleIds, []);
    const db = await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId]);
    assert.deepEqual(db.rows[0].rules, []);
  });

  // --- Opslaan / teruglezen, alle vijf regeltypen ----------------------------

  it('alle vijf regeltypen zijn op te slaan en terug te lezen (genormaliseerd)', async () => {
    const rules = [
      rule({ id: 'R01', label: '  Capability -> benefit  ', weight: 'primair', min: 1, max: 3 }),
      rule({ id: 'R02', kind: 'requires_incoming', subjectTypes: ['Capability'], targetTypes: ['Project'], label: 'Capability heeft een project als kind' }),
      { id: 'R03', kind: 'primary_parent_count', subjectTypes: ['Sub-benefit'], min: 1, max: 1, label: 'Precies 1 primaire ouder', enabled: false },
      { id: 'R04', kind: 'requires_tag_category', subjectTypes: ['Project'], tagCategory: ' Thema ', label: 'Project heeft een thema-tag' },
      { id: 'R_05-x', kind: 'required_field', subjectTypes: ['Strategisch doel'], field: 'kpi', label: 'Doel heeft een KPI', explanation: 'Uitleg' },
    ];
    const put = await putRules(rules);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await req('GET', rulesUrl(), { token: bezoekerToken });
    assert.equal(get.status, 200);
    const byId = Object.fromEntries(get.body.rules.map((r: any) => [r.id, r]));
    assert.equal(byId.R01.label, 'Capability -> benefit');
    assert.equal(byId.R01.weight, 'primair');
    assert.equal(byId.R01.max, 3);
    assert.equal(byId.R02.weight, 'any');
    assert.equal(byId.R02.min, 1);
    assert.equal(byId.R02.max, null);
    assert.deepEqual(byId.R03.targetTypes, []);
    assert.equal(byId.R03.enabled, false);
    assert.equal(byId.R04.tagCategory, 'Thema');
    assert.equal(byId['R_05-x'].field, 'kpi');
    assert.equal(byId['R_05-x'].min, null);
    assert.equal(byId.R04.max, null);
    assert.deepEqual(Object.keys(byId.R01).sort(), [
      'attributeId', 'enabled', 'explanation', 'field', 'id', 'kind', 'label', 'max', 'min', 'operator', 'subjectTypes',
      'tagCategory', 'targetTypes', 'value', 'value2', 'weight',
    ]);
  });

  it('teruggelezen regels zijn ongewijzigd opnieuw op te slaan (round-trip editor)', async () => {
    const get = await req('GET', rulesUrl(), { token: adminToken });
    assert.equal(get.body.rules.length, 5);
    const put = await putRules(get.body.rules);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const again = await req('GET', rulesUrl(), { token: adminToken });
    assert.deepEqual(again.body.rules, get.body.rules);
  });

  it('aliassen gelden als geldig type in een regel', async () => {
    const cols = await columnsOf(doelenboomId);
    cols[0].aliases = [{ typeName: `${PREFIX}-Alias`, color: null }];
    const putCols = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } });
    assert.equal(putCols.status, 200, JSON.stringify(putCols.body));
    const put = await putRules([rule({ id: 'RA', subjectTypes: [`${PREFIX}-Alias`], targetTypes: ['Capability'] })]);
    assert.equal(put.status, 200, JSON.stringify(put.body));
  });

  // --- Validatie ---------------------------------------------------------------

  const invalidCases: Array<[string, unknown, RegExp]> = [
    ['geen lijst', { id: 'R01' }, /als lijst/],
    ['meer dan 50 regels', Array.from({ length: 51 }, (_, i) => rule({ id: `R${i}` })), /Maximaal 50/],
    ['dubbele id', [rule({ id: 'R1' }), rule({ id: 'R1' })], /meer dan één keer/],
    ['id met ongeldige tekens', [rule({ id: 'R 1' })], /id is verplicht/],
    ['id te lang', [rule({ id: 'R'.repeat(41) })], /id is verplicht/],
    ['onbekend regeltype (statusregel)', [rule({ kind: 'control_effective' })], /onbekend regeltype/],
    ['onbekend veld', [rule({ status: 'werkt niet' })], /onbekend\(e\) veld/],
    ['__proto__-sleutel', [JSON.parse('{"id":"R1","kind":"required_field","subjectTypes":["Missie"],"field":"kpi","label":"x","__proto__":{"isAdmin":true}}')], /onbekend\(e\) veld/],
    ['label leeg', [rule({ label: '   ' })], /label is verplicht/],
    ['label te lang', [rule({ label: 'x'.repeat(121) })], /maximaal 120/],
    ['uitleg te lang', [rule({ explanation: 'x'.repeat(501) })], /maximaal 500/],
    ['uitleg geen tekst', [rule({ explanation: { a: 1 } })], /uitleg moet tekst/],
    ['onbekend type', [rule({ subjectTypes: ['Bestaat niet'] })], /onbekend\(e\) elementtype/],
    ['onbekend doeltype', [rule({ targetTypes: ['Bestaat niet'] })], /onbekend\(e\) elementtype/],
    ['geen subjectTypes', [rule({ subjectTypes: [] })], /minstens één elementtype/],
    ['subjectTypes geen lijst', [rule({ subjectTypes: 'Capability' })], /lijst van typenamen/],
    ['subjectTypes met object', [rule({ subjectTypes: [{ $ne: 1 }] })], /niet-lege typenamen/],
    ['typenaam te lang', [rule({ subjectTypes: ['x'.repeat(201)] })], /langer dan 200/],
    ['relatieregel zonder doeltype', [rule({ targetTypes: [] })], /doeltype/],
    ['weight ongeldig', [rule({ weight: 'ondersteunend' })], /weight moet/],
    ['min > max', [rule({ min: 3, max: 1 })], /min \(3\) mag niet groter/],
    ['min negatief', [rule({ min: -1 })], /geheel getal/],
    ['min geen geheel getal', [rule({ min: 1.5 })], /geheel getal/],
    ['min als tekst', [rule({ min: '1' })], /geheel getal/],
    ['enabled geen boolean', [rule({ enabled: 'ja' })], /enabled moet/],
    ['regel is geen object', ['R01'], /moet een object/],
    ['regel is null', [null], /moet een object/],
    ['targetTypes bij primary_parent_count', [{ id: 'R1', kind: 'primary_parent_count', subjectTypes: ['Missie'], targetTypes: ['Capability'], label: 'x' }], /niet van toepassing/],
    ['tagregel zonder categorie', [{ id: 'R1', kind: 'requires_tag_category', subjectTypes: ['Missie'], label: 'x' }], /tagCategory is verplicht/],
    ['tagregel met max', [{ id: 'R1', kind: 'requires_tag_category', subjectTypes: ['Missie'], tagCategory: 'T', max: 2, label: 'x' }], /max is niet van toepassing/],
    ['veldregel zonder veld', [{ id: 'R1', kind: 'required_field', subjectTypes: ['Missie'], label: 'x' }], /kies het verplichte veld/],
    ['veldregel met niet-whitelisted veld', [{ id: 'R1', kind: 'required_field', subjectTypes: ['Missie'], field: 'password_hash', label: 'x' }], /veld moet een van/],
    ['field bij relatieregel', [rule({ field: 'kpi' })], /field is niet van toepassing/],
  ];

  for (const [name, input, expected] of invalidCases) {
    it(`weigert ongeldige invoer: ${name}`, async () => {
      const before = await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId]);
      const res = await putRules(input);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, expected);
      const afterRow = await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId]);
      assert.deepEqual(afterRow.rows[0].rules, before.rows[0].rules, 'niets opgeslagen');
    });
  }

  it('ontbrekende body/rules-sleutel geeft 400', async () => {
    const res = await req('PUT', rulesUrl(), { token: adminToken, body: {} });
    assert.equal(res.status, 400);
  });

  // --- Kolomwijziging die een regel verweest ---------------------------------

  it('kolomwijziging die een regel laat verwijzen naar een niet-bestaand type wordt geweigerd (409 met regel-id\'s)', async () => {
    const alias = `${PREFIX}-Weg`;
    const cols = await columnsOf(doelenboomId);
    cols[1].aliases = [{ typeName: alias, color: null }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
    assert.equal((await putRules([rule({ id: 'RW1', subjectTypes: [alias] }), rule({ id: 'RW2', targetTypes: [alias] }), rule({ id: 'RW3' })])).status, 200);

    const without = await columnsOf(doelenboomId);
    without[1].aliases = [];
    const res = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: without } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /RW1, RW2/);
    assert.doesNotMatch(res.body.error, /RW3/);
    // Niets stil gewijzigd: alias en regels staan er nog.
    const cfg = await columnsOf(doelenboomId);
    assert.deepEqual(cfg[1].aliases.map((a: any) => a.typeName), [alias]);
    const rules = await req('GET', rulesUrl(), { token: adminToken });
    assert.deepEqual(rules.body.rules.map((r: any) => r.id), ['RW1', 'RW2', 'RW3']);

    // Na aanpassen van de regels gaat de kolomwijziging wel door.
    assert.equal((await putRules([rule({ id: 'RW3' })])).status, 200);
    const ok = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: without } });
    assert.equal(ok.status, 200);
  });

  it('zonder actieve module gaat de kolomwijziging door; regel blijft bewaard en wordt als ongeldig gemarkeerd', async () => {
    const alias = `${PREFIX}-Slaap`;
    const cols = await columnsOf(doelenboomId);
    cols[2].aliases = [{ typeName: alias, color: null }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
    assert.equal((await putRules([rule({ id: 'RS1', subjectTypes: [alias] })])).status, 200);

    await setModule(tenantId, false);
    try {
      const without = await columnsOf(doelenboomId);
      without[2].aliases = [];
      const res = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: without } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const get = await req('GET', rulesUrl(), { token: adminToken });
      assert.equal(get.body.moduleActive, false);
      assert.deepEqual(get.body.rules.map((r: any) => r.id), ['RS1'], 'regel niet stil verwijderd');
      assert.deepEqual(get.body.invalidRuleIds, ['RS1']);
    } finally {
      await setModule(tenantId, true);
    }
    // Na heractivering: dezelfde regel opnieuw opslaan kan pas na herstel.
    const again = await req('GET', rulesUrl(), { token: adminToken });
    const stale = await putRules(again.body.rules);
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /onbekend\(e\) elementtype/);
    assert.equal((await putRules([])).status, 200);
  });

  // --- Tenant-default, nieuwe boom, dupliceren ---------------------------------

  it('tenant-default: alleen sysadmin; regels gaan mee naar een nieuwe boom en bij dupliceren', async () => {
    assert.equal((await req('GET', `/api/tenants/${tenantId}/control-rules`, { token: adminToken })).status, 403);
    assert.equal((await req('PUT', `/api/tenants/${tenantId}/control-rules`, { token: adminToken, body: { rules: [] } })).status, 403);

    const put = await req('PUT', `/api/tenants/${tenantId}/control-rules`, {
      token: sysadminToken, body: { rules: [rule({ id: 'TD1' })] },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const bad = await req('PUT', `/api/tenants/${tenantId}/control-rules`, {
      token: sysadminToken, body: { rules: [rule({ subjectTypes: ['Bestaat niet'] })] },
    });
    assert.equal(bad.status, 400);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken, body: { slug: 'met-regels', name: 'Met regels' } });
    assert.equal(boom.status, 201);
    const rulesNew = await req('GET', `/api/doelenbomen/${boom.body.id}/control-rules`, { token: adminToken });
    assert.deepEqual(rulesNew.body.rules.map((r: any) => r.id), ['TD1']);

    // Onafhankelijke kopie: wijzigen in de nieuwe boom raakt de tenant-default niet.
    assert.equal((await putRules([rule({ id: 'EIGEN' })], adminToken, boom.body.id)).status, 200);
    const td = await req('GET', `/api/tenants/${tenantId}/control-rules`, { token: sysadminToken });
    assert.deepEqual(td.body.rules.map((r: any) => r.id), ['TD1']);

    // Dupliceren is een sysadmin-route (routes/doelenbomen.ts).
    const dup = await req('POST', `/api/doelenbomen/${boom.body.id}/duplicate`, {
      token: sysadminToken, body: { slug: 'met-regels-kopie', name: 'Kopie' },
    });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    const dupRules = await req('GET', `/api/doelenbomen/${dup.body.id}/control-rules`, { token: adminToken });
    assert.deepEqual(dupRules.body.rules.map((r: any) => r.id), ['EIGEN']);
  });

  it('tenant-default: kolomwijziging die een regel verweest wordt geweigerd', async () => {
    const cols = (await req('GET', `/api/tenants/${tenantId}/column-config`, { token: sysadminToken })).body.columns;
    const renamed = cols.map((c: any) => (c.typeName === 'Capability' ? { ...c, typeName: 'Vermogen' } : c));
    const res = await req('PUT', `/api/tenants/${tenantId}/column-config`, { token: sysadminToken, body: { columns: renamed } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /TD1/);
  });

  // --- Sjablonen -----------------------------------------------------------------

  it('sjabloon: regels gaan mee bij opslaan en toepassen; geldigheid tegen sjabloonkolommen', async () => {
    assert.equal((await putRules([rule({ id: 'SJ1' }), rule({ id: 'SJ2', kind: 'required_field', subjectTypes: ['Missie'], targetTypes: undefined, field: 'description' })])).status, 200);
    const saved = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: `${PREFIX}-sjabloon`, scope: 'tenant' },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const templateId = saved.body.id;

    const tr = await req('GET', `/api/doelenboom-templates/${templateId}/control-rules`, { token: adminToken });
    assert.equal(tr.status, 200);
    assert.deepEqual(tr.body.rules.map((r: any) => r.id), ['SJ1', 'SJ2']);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'uit-sjabloon', name: 'Uit sjabloon', templateId },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    const applied = await req('GET', `/api/doelenbomen/${boom.body.id}/control-rules`, { token: adminToken });
    assert.deepEqual(applied.body.rules.map((r: any) => r.id), ['SJ1', 'SJ2']);

    // Sjabloonregels bewerken: gevalideerd tegen de sjabloonkolommen.
    const badT = await req('PUT', `/api/doelenboom-templates/${templateId}/control-rules`, {
      token: adminToken, body: { rules: [rule({ subjectTypes: ['Bestaat niet'] })] },
    });
    assert.equal(badT.status, 400);
    const okT = await req('PUT', `/api/doelenboom-templates/${templateId}/control-rules`, {
      token: adminToken, body: { rules: [rule({ id: 'SJ9' })] },
    });
    assert.equal(okT.status, 200);

    // Sjabloonkolom hernoemen die een regel verweest -> geweigerd met id.
    const tcols = (await req('GET', `/api/doelenboom-templates/${templateId}/column-config`, { token: adminToken })).body.columns;
    const renamed = tcols.map((c: any) => (c.typeName === 'Operationele benefit' ? { ...c, typeName: 'Effect' } : c));
    const colRes = await req('PUT', `/api/doelenboom-templates/${templateId}/column-config`, { token: adminToken, body: { columns: renamed } });
    assert.equal(colRes.status, 409);
    assert.match(colRes.body.error, /SJ9|voorbeeldelement/);

    // Andere tenant mag dit sjabloon niet beheren (IDOR).
    assert.equal((await req('GET', `/api/doelenboom-templates/${templateId}/control-rules`, { token: otherAdminToken })).status, 403);
    assert.equal((await req('PUT', `/api/doelenboom-templates/${templateId}/control-rules`, { token: otherAdminToken, body: { rules: [] } })).status, 403);

    // Inconsistent sjabloon (bv. handmatig in de database) -> toepassen geweigerd, geen halve boom.
    await pool.query(`update doelenboom_templates set rules_snapshot = $1 where id = $2`, [
      JSON.stringify([rule({ id: 'KAPOT', subjectTypes: ['Bestaat niet'] })]), templateId,
    ]);
    const broken = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kapot', name: 'Kapot', templateId },
    });
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /controleregels van dit sjabloon/);
    const none = await pool.query(`select 1 from doelenbomen where tenant_id = $1 and slug = 'kapot'`, [tenantId]);
    assert.equal(none.rowCount, 0);
  });

  it('oud sjabloon zonder regels (rules_snapshot-default) blijft werken', async () => {
    const tmpl = await pool.query(
      `insert into doelenboom_templates (tenant_id, name, description, columns_snapshot, elements_snapshot, edges_snapshot)
       select $1, $2, '', columns_snapshot, elements_snapshot, edges_snapshot from doelenboom_templates
       where tenant_id is null and name = 'Batenboom' returning id, rules_snapshot`,
      [tenantId, `${PREFIX}-oud`]
    );
    assert.deepEqual(tmpl.rows[0].rules_snapshot, []);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'uit-oud', name: 'Uit oud', templateId: tmpl.rows[0].id },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    const r = await req('GET', `/api/doelenbomen/${boom.body.id}/control-rules`, { token: adminToken });
    assert.deepEqual(r.body.rules, []);
  });

  // --- OWASP A01: autorisatie / IDOR -------------------------------------------

  it('A01: editor en bezoeker mogen lezen maar niet wijzigen', async () => {
    assert.equal((await req('GET', rulesUrl(), { token: editorToken })).status, 200);
    assert.equal((await putRules([rule()], editorToken)).status, 403);
    assert.equal((await putRules([rule()], bezoekerToken)).status, 403);
  });

  it('A01: gebruiker van een andere tenant kan niet lezen of wijzigen (IDOR)', async () => {
    const before = await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId]);
    const get = await req('GET', rulesUrl(), { token: otherAdminToken });
    assert.ok([403, 404].includes(get.status), `GET gaf ${get.status}`);
    assert.equal(get.body.rules, undefined);
    const put = await putRules([rule({ id: 'IDOR' })], otherAdminToken);
    assert.ok([403, 404].includes(put.status), `PUT gaf ${put.status}`);
    const afterRow = await pool.query(`select rules from column_configs where doelenboom_id = $1`, [doelenboomId]);
    assert.deepEqual(afterRow.rows[0].rules, before.rows[0].rules);
    // En omgekeerd: eigen admin kan niet bij de boom van de andere tenant.
    assert.ok([403, 404].includes((await putRules([], adminToken, otherDoelenboomId)).status));
    // Tenant-default van een andere tenant: alleen sysadmin.
    assert.equal((await req('GET', `/api/tenants/${otherTenantId}/control-rules`, { token: adminToken })).status, 403);
  });

  it('A01: niet-gekoppelde sysadmin mag de regels van een boom niet wijzigen of lezen', async () => {
    assert.ok([403, 404].includes((await putRules([], sysadminToken)).status));
    assert.ok([403, 404].includes((await req('GET', rulesUrl(), { token: sysadminToken })).status));
  });

  it('A01: niet-bestaand of niet-numeriek boom-id geeft 404, geen 500', async () => {
    assert.equal((await req('PUT', `/api/doelenbomen/999999999/control-rules`, { token: adminToken, body: { rules: [] } })).status, 404);
    assert.equal((await req('PUT', `/api/doelenbomen/abc/control-rules`, { token: adminToken, body: { rules: [] } })).status, 404);
    assert.equal((await req('GET', `/api/doelenbomen/abc/control-rules`, { token: adminToken })).status, 404);
  });

  it('A01: read_only-boom kan niet gewijzigd worden', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      const res = await putRules([rule({ id: 'RO' })]);
      assert.equal(res.status, 403);
    } finally {
      await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
  });

  it('A01: zonder actieve module geen wijzigingen (403), lezen blijft mogelijk', async () => {
    await setModule(tenantId, false);
    try {
      const res = await putRules([rule({ id: 'NOMOD' })]);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /controleregels/);
      const get = await req('GET', rulesUrl(), { token: adminToken });
      assert.equal(get.status, 200);
      assert.equal(get.body.moduleActive, false);
    } finally {
      await setModule(tenantId, true);
    }
  });

  it('A01: zonder login 401', async () => {
    assert.equal((await req('GET', rulesUrl())).status, 401);
    assert.equal((await req('PUT', rulesUrl(), { body: { rules: [] } })).status, 401);
  });

  // --- OWASP A03 / A04 -----------------------------------------------------------

  it('A03: HTML/script in label en uitleg wordt letterlijk als tekst opgeslagen en als JSON teruggegeven', async () => {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const res = await putRules([rule({ id: 'XSS', label: xss, explanation: `"'><svg onload=alert(3)> & ${xss}` })]);
    assert.equal(res.status, 200);
    const raw = await rawReq('GET', rulesUrl(), { token: adminToken });
    assert.match(raw.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    const body = await raw.json();
    assert.equal(body.rules[0].label, xss);
    assert.equal(body.rules[0].explanation, `"'><svg onload=alert(3)> & ${xss}`);
  });

  it('A03: SQL-achtige typenaam wordt gewoon als onbekend type geweigerd', async () => {
    const res = await putRules([rule({ subjectTypes: [`Capability'); drop table column_configs; --`] })]);
    assert.equal(res.status, 400);
    const still = await pool.query('select count(*) from column_configs');
    assert.ok(Number(still.rows[0].count) > 0);
  });

  it('A04: te grote body geeft 413 zonder interne details', async () => {
    const big = [rule({ explanation: 'x'.repeat(200_000) })];
    const res = await req('PUT', rulesUrl(), { token: adminToken, body: { rules: big } });
    assert.equal(res.status, 413);
    assert.doesNotMatch(JSON.stringify(res.body), /PayloadTooLarge|stack|at /);
  });

  it('A04: kapotte JSON geeft 400', async () => {
    const res = await fetch(`${(await import('./helpers.js')).getBaseUrl()}${rulesUrl()}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: '{"rules": [',
    });
    assert.equal(res.status, 400);
  });

  // --- OWASP A09: audit-log ----------------------------------------------------------

  it('A09: wijzigen schrijft control_rules_updated met id\'s, zonder regelteksten', async () => {
    const secretLabel = `${PREFIX} geheim label`;
    const secretExpl = `${PREFIX} geheime uitleg`;
    const res = await putRules([rule({ id: 'AUD1', label: secretLabel, explanation: secretExpl }), rule({ id: 'AUD2' })]);
    assert.equal(res.status, 200);
    const log = await pool.query(
      `select user_id, tenant_id, detail from audit_log
       where event_type = 'control_rules_updated' and doelenboom_id = $1 order by id desc limit 1`,
      [doelenboomId]
    );
    assert.equal(log.rowCount, 1);
    assert.equal(Number(log.rows[0].tenant_id), Number(tenantId));
    assert.ok(log.rows[0].user_id);
    assert.equal(log.rows[0].detail.scope, 'doelenboom');
    assert.equal(log.rows[0].detail.ruleCount, 2);
    assert.deepEqual(log.rows[0].detail.ruleIds, ['AUD1', 'AUD2']);
    const asText = JSON.stringify(log.rows[0].detail);
    assert.doesNotMatch(asText, /geheim/);

    // Ook voor tenant-default en sjabloon.
    const td = await pool.query(
      `select detail from audit_log where event_type = 'control_rules_updated' and tenant_id = $1 and detail->>'scope' = 'tenant_default'`,
      [tenantId]
    );
    assert.ok(td.rowCount! >= 1);
    const tp = await pool.query(
      `select detail from audit_log where event_type = 'control_rules_updated' and detail->>'scope' = 'template' and tenant_id = $1`,
      [tenantId]
    );
    assert.ok(tp.rowCount! >= 1);
  });

  it('A09: een geweigerde wijziging schrijft geen audit-event', async () => {
    const before = await pool.query(`select count(*) from audit_log where event_type = 'control_rules_updated' and doelenboom_id = $1`, [doelenboomId]);
    await putRules([rule({ id: 'X X' })]);
    await putRules([rule()], editorToken);
    const afterRow = await pool.query(`select count(*) from audit_log where event_type = 'control_rules_updated' and doelenboom_id = $1`, [doelenboomId]);
    assert.equal(afterRow.rows[0].count, before.rows[0].count);
  });
});
