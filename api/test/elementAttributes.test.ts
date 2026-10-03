// Regressietests voor DOEL-75 (epic DOEL-61, "Module Controleregels"):
// datamodel, validatie en beheer van kenmerkdefinities per kolomconfiguratie
// (doelenboom, tenant-default, sjabloon) — zie api/src/elementAttributes.ts en
// api/src/routes/elementAttributes.ts. Inclusief de OWASP Top 10-regressietests
// uit het ticket: A01 (autorisatie/IDOR, read_only, module), A03 (injectie/
// XSS-payloads worden als platte tekst opgeslagen en teruggegeven), A04
// (onverwachte jsonb-structuur, limieten, te grote body) en A09 (audit-event
// zonder vrije tekst). Alleen neutrale voorbeeldkenmerken.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';

const PREFIX = unique('kenmerken');

function attr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'K01',
    label: 'Laatst beoordeeld',
    kind: 'date',
    subjectTypes: ['Capability'],
    required: false,
    explanation: '',
    options: [],
    ...overrides,
  };
}

describe('kenmerkdefinities (DOEL-75)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherTenantId: number;
  let otherAdminToken: string;
  let otherDoelenboomId: number;

  const url = (id = doelenboomId) => `/api/doelenbomen/${id}/attributes`;
  const put = (attributes: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', url(id), { token, body: { attributes } });
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });
  const stored = async (id = doelenboomId) =>
    (await pool.query(`select attributes from column_configs where doelenboom_id = $1`, [id])).rows[0].attributes;
  const auditCount = async () =>
    Number((await pool.query(
      `select count(*) from audit_log where event_type = 'attribute_definitions_updated' and doelenboom_id = $1`, [doelenboomId]
    )).rows[0].count);

  async function columnsOf(id: number) {
    const r = await req('GET', `/api/doelenbomen/${id}/column-config`, { token: adminToken });
    assert.equal(r.status, 200);
    return r.body.columns as any[];
  }
  const putColumns = (columns: unknown, id = doelenboomId) =>
    req('PUT', `/api/doelenbomen/${id}/column-config`, { token: adminToken, body: { columns } });

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, editorToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    ({ tenantId: otherTenantId, doelenboomId: otherDoelenboomId, adminToken: otherAdminToken } =
      await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`));
    assert.equal((await setModule(tenantId, true)).status, 200);
    await setModule(otherTenantId, true);
  });

  after(async () => {
    await pool.query(`delete from doelenboom_templates where name like $1`, [`${PREFIX}%`]);
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Datamodel -------------------------------------------------------------

  it('bestaande/nieuwe boom heeft attributes = [] en GET levert context voor de editor', async () => {
    const res = await req('GET', url(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.attributes, []);
    assert.equal(res.body.moduleActive, true);
    assert.ok(res.body.validTypeNames.includes('Capability'));
    assert.deepEqual(res.body.invalidAttributeIds, []);
    assert.deepEqual(await stored(), []);
  });

  // --- Opslaan / teruglezen, alle vijf soorten ---------------------------------

  it('alle vijf soorten zijn op te slaan en terug te lezen (genormaliseerd)', async () => {
    const attributes = [
      attr({ id: 'K01', label: '  Laatst beoordeeld  ', required: true }),
      { id: 'K02', label: 'Referentie', kind: 'text', subjectTypes: ['Capability', 'Project', 'Capability'] },
      { id: 'K03', label: 'Aantal locaties', kind: 'number', subjectTypes: ['Project'], explanation: ' Uitleg ' },
      { id: 'K_04-x', label: 'Fase', kind: 'choice', subjectTypes: ['Project'], options: [' Start ', 'Uitvoering', 'Afgerond'] },
      { id: 'K05', label: 'Extern getoetst', kind: 'boolean', subjectTypes: ['Capability'], options: null, explanation: null },
    ];
    const res = await put(attributes);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.invalidAttributeIds, []);
    const get = await req('GET', url(), { token: bezoekerToken });
    assert.equal(get.status, 200);
    const byId = Object.fromEntries(get.body.attributes.map((a: any) => [a.id, a]));
    assert.equal(byId.K01.label, 'Laatst beoordeeld');
    assert.equal(byId.K01.required, true);
    assert.deepEqual(byId.K02.subjectTypes, ['Capability', 'Project'], 'dubbel type ontdubbeld');
    assert.equal(byId.K02.required, false);
    assert.equal(byId.K03.explanation, 'Uitleg');
    assert.deepEqual(byId['K_04-x'].options, ['Start', 'Uitvoering', 'Afgerond']);
    assert.deepEqual(byId.K05.options, []);
    for (const a of get.body.attributes) {
      assert.deepEqual(Object.keys(a).sort(), ['explanation', 'id', 'kind', 'label', 'options', 'required', 'subjectTypes']);
    }
    assert.deepEqual((await stored()).map((a: any) => a.id), ['K01', 'K02', 'K03', 'K_04-x', 'K05']);
  });

  it('teruggelezen definities zijn ongewijzigd opnieuw op te slaan (round-trip editor)', async () => {
    const get = await req('GET', url(), { token: adminToken });
    assert.equal(get.body.attributes.length, 5);
    const res = await put(get.body.attributes);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const again = await req('GET', url(), { token: adminToken });
    assert.deepEqual(again.body.attributes, get.body.attributes);
  });

  it('label, verplicht, uitleg, typen en keuzelijst zijn te wijzigen; de soort ligt vast', async () => {
    const current = (await req('GET', url(), { token: adminToken })).body.attributes as any[];
    const edited = current.map((a) =>
      a.id === 'K_04-x' ? { ...a, label: 'Projectfase', required: true, subjectTypes: ['Project', 'Capability'], options: ['Start', 'Afgerond', 'Vervallen'] } : a);
    const ok = await put(edited);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const before = await stored();
    const changedKind = await put(edited.map((a) => (a.id === 'K02' ? { ...a, kind: 'number' } : a)));
    assert.equal(changedKind.status, 400);
    assert.match(changedKind.body.error, /K02.*soort van een bestaand kenmerk ligt vast/);
    assert.deepEqual(await stored(), before, 'geweigerde wijziging slaat niets op');

    // Verwijderen en daarna hetzelfde id met een andere soort aanmaken mag
    // (twee bewuste stappen; in DOEL-76 vervallen bij de eerste de waarden).
    assert.equal((await put(edited.filter((a) => a.id !== 'K02'))).status, 200);
    const recreated = await put([...edited.filter((a) => a.id !== 'K02'), { id: 'K02', label: 'Referentie', kind: 'number', subjectTypes: ['Project'] }]);
    assert.equal(recreated.status, 200, JSON.stringify(recreated.body));
  });

  it('aliassen gelden als geldig type; kenmerken en controleregels beïnvloeden elkaar niet', async () => {
    const alias = `${PREFIX}-Alias`;
    const cols = await columnsOf(doelenboomId);
    cols[0].aliases = [{ typeName: alias, color: null }];
    assert.equal((await putColumns(cols)).status, 200);
    const rules = [{ id: 'R01', kind: 'required_field', subjectTypes: ['Capability'], field: 'description', label: 'Omschrijving ingevuld' }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken, body: { rules } })).status, 200);

    assert.equal((await put([attr({ id: 'AL1', subjectTypes: [alias] })])).status, 200);
    const r = await req('GET', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken });
    assert.deepEqual(r.body.rules.map((x: any) => x.id), ['R01'], 'regels blijven staan bij opslaan van kenmerken');

    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken, body: { rules: [] } })).status, 200);
    assert.deepEqual((await stored()).map((a: any) => a.id), ['AL1'], 'kenmerken blijven staan bij opslaan van regels');

    assert.equal((await put([])).status, 200);
    cols[0].aliases = [];
    assert.equal((await putColumns(cols)).status, 200);
  });

  // --- OWASP A04: validatie, limieten, onverwachte structuur --------------------

  it('A04: ongeldige definities worden geweigerd en slaan niets op', async () => {
    assert.equal((await put([attr({ id: 'BASIS' })])).status, 200);
    const before = await stored();
    const many = Array.from({ length: 31 }, (_, i) => attr({ id: `M${i}`, label: `Kenmerk ${i}` }));
    const cases: Array<[string, unknown, RegExp]> = [
      ['geen lijst', { id: 'K01' }, /als lijst/],
      ['element is geen object', ['K01'], /moet een object zijn/],
      ['element is een array', [[attr()]], /moet een object zijn/],
      ['meer dan 30 kenmerken', many, /Maximaal 30 kenmerken/],
      ['id ontbreekt', [attr({ id: undefined })], /id is verplicht/],
      ['id met spatie', [attr({ id: 'K 01' })], /id is verplicht/],
      ['id te lang', [attr({ id: 'K'.repeat(31) })], /id is verplicht/],
      ['id is geen tekst', [attr({ id: 7 })], /id is verplicht/],
      ['dubbel id', [attr(), attr({ label: 'Ander label' })], /komt meer dan één keer voor/],
      ['dubbel label (hoofdletterongevoelig)', [attr(), attr({ id: 'K02', label: 'LAATST BEOORDEELD' })], /label wordt al gebruikt/],
      ['onbekende soort', [attr({ kind: 'status' })], /onbekende soort/],
      ['soort is geen tekst', [attr({ kind: ['date'] })], /onbekende soort/],
      ['leeg label', [attr({ label: '   ' })], /label is verplicht/],
      ['label is geen tekst', [attr({ label: { a: 1 } })], /label is verplicht/],
      ['label te lang', [attr({ label: 'x'.repeat(61) })], /label mag maximaal 60/],
      ['uitleg te lang', [attr({ explanation: 'x'.repeat(301) })], /uitleg mag maximaal 300/],
      ['uitleg is geen tekst', [attr({ explanation: 5 })], /uitleg moet tekst zijn/],
      ['required is geen boolean', [attr({ required: 'ja' })], /required moet true of false/],
      ['geen elementtypen', [attr({ subjectTypes: [] })], /minstens één elementtype/],
      ['subjectTypes is geen lijst', [attr({ subjectTypes: 'Capability' })], /subjectTypes moet een lijst/],
      ['subjectTypes met niet-tekst', [attr({ subjectTypes: [1] })], /alleen niet-lege teksten/],
      ['onbekend elementtype', [attr({ subjectTypes: ['Bestaat niet'] })], /onbekend\(e\) elementtype/],
      ['onbekend veld', [attr({ value: 'x', enabled: true })], /2 onbekend\(e\) veld\(en\)/],
      ['keuzelijst zonder waarden', [attr({ kind: 'choice', options: [] })], /minstens één waarde/],
      ['keuzelijst met 51 waarden', [attr({ kind: 'choice', options: Array.from({ length: 51 }, (_, i) => `w${i}`) })], /maximaal 50 waarden/],
      ['keuzelijstwaarde te lang', [attr({ kind: 'choice', options: ['x'.repeat(61)] })], /langer dan 60 tekens/],
      ['dubbele keuzelijstwaarde', [attr({ kind: 'choice', options: ['A', ' A '] })], /meer dan één keer/],
      ['lege keuzelijstwaarde', [attr({ kind: 'choice', options: ['A', ' '] })], /alleen niet-lege teksten/],
      ['keuzelijst is geen lijst', [attr({ kind: 'choice', options: 'A' })], /keuzelijst moet een lijst/],
      ['keuzelijst bij een datum', [attr({ options: ['A'] })], /niet van toepassing op soort date/],
    ];
    for (const [name, body, pattern] of cases) {
      const res = await put(body);
      assert.equal(res.status, 400, `${name}: status ${res.status} ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, pattern, name);
    }
    assert.deepEqual(await stored(), before);
    // Precies op de grens mag wel.
    const edge = await put([
      attr({ id: 'K'.repeat(30), label: 'x'.repeat(60), explanation: 'y'.repeat(300) }),
      attr({ id: 'GRENS', label: 'Grens', kind: 'choice', options: Array.from({ length: 50 }, (_, i) => `${i}`.padStart(60, 'z')) }),
    ]);
    assert.equal(edge.status, 200, JSON.stringify(edge.body));
    assert.equal((await put(many.slice(0, 30))).status, 200);
    assert.equal((await put([])).status, 200);
  });

  it('A04: foutmelding kaatst onbekende veldnamen en ongeldige id\'s niet terug', async () => {
    const res = await put([{ ...attr({ id: '<img src=x>' }), '<script>veld</script>': 1 }]);
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.body.error, /<img|<script/);
  });

  it('A04: ontbrekende body/attributes-sleutel geeft 400', async () => {
    assert.equal((await req('PUT', url(), { token: adminToken, body: {} })).status, 400);
    assert.equal((await req('PUT', url(), { token: adminToken, body: { rules: [] } })).status, 400);
  });

  it('A04: te grote body geeft 413 zonder interne details', async () => {
    const res = await put([attr({ explanation: 'x'.repeat(200_000) })]);
    assert.equal(res.status, 413);
    assert.doesNotMatch(JSON.stringify(res.body), /PayloadTooLarge|stack|at /);
  });

  it('A04: kapotte JSON geeft 400', async () => {
    const res = await fetch(`${getBaseUrl()}${url()}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: '{"attributes": [',
    });
    assert.equal(res.status, 400);
  });

  // --- Kolomwijziging die een kenmerk verweest ---------------------------------

  it('kolomwijziging die een kenmerk laat verwijzen naar een niet-bestaand type wordt geweigerd (409 met id\'s)', async () => {
    const alias = `${PREFIX}-Weg`;
    const cols = await columnsOf(doelenboomId);
    cols[1].aliases = [{ typeName: alias, color: null }];
    assert.equal((await putColumns(cols)).status, 200);
    assert.equal((await put([attr({ id: 'KW1', subjectTypes: [alias] }), attr({ id: 'KW2', label: 'Tweede' })])).status, 200);

    const without = await columnsOf(doelenboomId);
    without[1].aliases = [];
    const res = await putColumns(without);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /kenmerk\(en\) KW1 /);
    assert.doesNotMatch(res.body.error, /KW2/);
    // Niets stil gewijzigd.
    assert.deepEqual((await columnsOf(doelenboomId))[1].aliases.map((a: any) => a.typeName), [alias]);
    assert.deepEqual((await stored()).map((a: any) => a.id), ['KW1', 'KW2']);

    assert.equal((await put([attr({ id: 'KW2', label: 'Tweede' })])).status, 200);
    assert.equal((await putColumns(without)).status, 200);
  });

  it('zonder actieve module: kolomwijziging gaat door, definities onzichtbaar maar bewaard, na heractivering gemarkeerd', async () => {
    const alias = `${PREFIX}-Slaap`;
    const cols = await columnsOf(doelenboomId);
    cols[2].aliases = [{ typeName: alias, color: null }];
    assert.equal((await putColumns(cols)).status, 200);
    assert.equal((await put([attr({ id: 'KS1', subjectTypes: [alias] })])).status, 200);

    await setModule(tenantId, false);
    try {
      const without = await columnsOf(doelenboomId);
      without[2].aliases = [];
      const res = await putColumns(without);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const get = await req('GET', url(), { token: adminToken });
      assert.equal(get.status, 200);
      assert.equal(get.body.moduleActive, false);
      assert.deepEqual(get.body.attributes, [], 'zonder module worden geen definities geleverd');
      assert.deepEqual((await stored()).map((a: any) => a.id), ['KS1'], 'definitie niet stil verwijderd');
    } finally {
      await setModule(tenantId, true);
    }
    const again = await req('GET', url(), { token: adminToken });
    assert.deepEqual(again.body.attributes.map((a: any) => a.id), ['KS1']);
    assert.deepEqual(again.body.invalidAttributeIds, ['KS1']);
    const stale = await put(again.body.attributes);
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /onbekend\(e\) elementtype/);
    assert.equal((await put([])).status, 200);
  });

  // --- Tenant-default, nieuwe boom, dupliceren ---------------------------------

  it('tenant-default: alleen sysadmin; definities gaan mee naar een nieuwe boom en bij dupliceren', async () => {
    const tdUrl = `/api/tenants/${tenantId}/attributes`;
    assert.equal((await req('GET', tdUrl, { token: adminToken })).status, 403);
    assert.equal((await req('PUT', tdUrl, { token: adminToken, body: { attributes: [] } })).status, 403);

    const ok = await req('PUT', tdUrl, { token: sysadminToken, body: { attributes: [attr({ id: 'TD1' })] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await req('PUT', tdUrl, { token: sysadminToken, body: { attributes: [attr({ subjectTypes: ['Bestaat niet'] })] } })).status, 400);
    assert.equal((await req('PUT', tdUrl, { token: sysadminToken, body: { attributes: [attr({ id: 'TD1', kind: 'text' })] } })).status, 400, 'soort ligt ook hier vast');
    const get = await req('GET', tdUrl, { token: sysadminToken });
    assert.deepEqual(get.body.attributes.map((a: any) => a.id), ['TD1']);
    assert.equal((await req('GET', `/api/tenants/999999999/attributes`, { token: sysadminToken })).status, 404);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken, body: { slug: 'met-kenmerken', name: 'Met kenmerken' } });
    assert.equal(boom.status, 201);
    assert.deepEqual((await req('GET', url(boom.body.id), { token: adminToken })).body.attributes.map((a: any) => a.id), ['TD1']);

    // Onafhankelijke kopie.
    assert.equal((await put([attr({ id: 'EIGEN' })], adminToken, boom.body.id)).status, 200);
    assert.deepEqual((await req('GET', tdUrl, { token: sysadminToken })).body.attributes.map((a: any) => a.id), ['TD1']);

    const dup = await req('POST', `/api/doelenbomen/${boom.body.id}/duplicate`, {
      token: sysadminToken, body: { slug: 'met-kenmerken-kopie', name: 'Kopie' },
    });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.deepEqual((await req('GET', url(dup.body.id), { token: adminToken })).body.attributes.map((a: any) => a.id), ['EIGEN']);
  });

  it('tenant-default: kolomwijziging die een kenmerk verweest wordt geweigerd', async () => {
    const cols = (await req('GET', `/api/tenants/${tenantId}/column-config`, { token: sysadminToken })).body.columns;
    const renamed = cols.map((c: any) => (c.typeName === 'Capability' ? { ...c, typeName: 'Vermogen' } : c));
    const res = await req('PUT', `/api/tenants/${tenantId}/column-config`, { token: sysadminToken, body: { columns: renamed } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /kenmerk\(en\) TD1/);
  });

  // --- Sjablonen -----------------------------------------------------------------

  it('sjabloon: definities gaan mee bij opslaan en toepassen; geldigheid tegen sjabloonkolommen', async () => {
    assert.equal((await put([attr({ id: 'SJ1' }), attr({ id: 'SJ2', label: 'Fase', kind: 'choice', subjectTypes: ['Project'], options: ['A', 'B'] })])).status, 200);
    const saved = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: `${PREFIX}-sjabloon`, scope: 'tenant' },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const templateId = saved.body.id;
    const tUrl = `/api/doelenboom-templates/${templateId}/attributes`;

    const tr = await req('GET', tUrl, { token: adminToken });
    assert.equal(tr.status, 200);
    assert.deepEqual(tr.body.attributes.map((a: any) => a.id), ['SJ1', 'SJ2']);
    assert.deepEqual(tr.body.invalidAttributeIds, []);

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kenmerk-sjabloon', name: 'Uit sjabloon', templateId },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    const applied = await req('GET', url(boom.body.id), { token: adminToken });
    assert.deepEqual(applied.body.attributes, tr.body.attributes);

    assert.equal((await req('PUT', tUrl, { token: adminToken, body: { attributes: [attr({ subjectTypes: ['Bestaat niet'] })] } })).status, 400);
    assert.equal((await req('PUT', tUrl, { token: adminToken, body: { attributes: [attr({ id: 'SJ1', kind: 'text' })] } })).status, 400);
    assert.equal((await req('PUT', tUrl, { token: adminToken, body: {} })).status, 400);
    const okT = await req('PUT', tUrl, { token: adminToken, body: { attributes: [attr({ id: 'SJ9', subjectTypes: ['Operationele benefit'] })] } });
    assert.equal(okT.status, 200, JSON.stringify(okT.body));

    // "Inhoud vervangen vanuit een boom" neemt de definities van die boom over.
    assert.equal((await put([attr({ id: 'VERV' })])).status, 200);
    const refresh = await req('POST', `/api/doelenboom-templates/${templateId}/refresh-from-doelenboom`, { token: adminToken, body: { doelenboomId } });
    assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
    assert.deepEqual((await req('GET', tUrl, { token: adminToken })).body.attributes.map((a: any) => a.id), ['VERV']);

    // Sjabloonkolom hernoemen die een kenmerk verweest -> geweigerd.
    const tcols = (await req('GET', `/api/doelenboom-templates/${templateId}/column-config`, { token: adminToken })).body.columns;
    const renamed = tcols.map((c: any) => (c.typeName === 'Capability' ? { ...c, typeName: 'Vermogen' } : c));
    const colRes = await req('PUT', `/api/doelenboom-templates/${templateId}/column-config`, { token: adminToken, body: { columns: renamed } });
    assert.equal(colRes.status, 409);
    assert.match(colRes.body.error, /VERV|voorbeeldelement/);

    // Andere tenant mag dit sjabloon niet beheren (IDOR).
    assert.equal((await req('GET', tUrl, { token: otherAdminToken })).status, 403);
    assert.equal((await req('PUT', tUrl, { token: otherAdminToken, body: { attributes: [] } })).status, 403);
    assert.equal((await req('GET', `/api/doelenboom-templates/999999999/attributes`, { token: adminToken })).status, 404);

    // Inconsistent sjabloon (bv. handmatig in de database) -> toepassen geweigerd, geen halve boom.
    await pool.query(`update doelenboom_templates set attributes_snapshot = $1 where id = $2`, [
      JSON.stringify([attr({ id: 'KAPOT', subjectTypes: ['Bestaat niet'] })]), templateId,
    ]);
    const broken = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kapot-kenmerk', name: 'Kapot', templateId },
    });
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /kenmerken van dit sjabloon/);
    const none = await pool.query(`select 1 from doelenbomen where tenant_id = $1 and slug = 'kapot-kenmerk'`, [tenantId]);
    assert.equal(none.rowCount, 0);
  });

  it('oud sjabloon zonder definities (attributes_snapshot-default) blijft werken', async () => {
    const tmpl = await pool.query(
      `insert into doelenboom_templates (tenant_id, name, description, columns_snapshot, elements_snapshot, edges_snapshot)
       select $1, $2, '', columns_snapshot, elements_snapshot, edges_snapshot from doelenboom_templates
       where tenant_id is null and name = 'Batenboom' returning id, attributes_snapshot`,
      [tenantId, `${PREFIX}-oud`]
    );
    assert.deepEqual(tmpl.rows[0].attributes_snapshot, []);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'kenmerk-oud', name: 'Uit oud', templateId: tmpl.rows[0].id },
    });
    assert.equal(boom.status, 201, JSON.stringify(boom.body));
    assert.deepEqual((await req('GET', url(boom.body.id), { token: adminToken })).body.attributes, []);
  });

  // --- OWASP A01: autorisatie / IDOR -------------------------------------------

  it('A01: editor en bezoeker mogen lezen maar niet wijzigen', async () => {
    assert.equal((await req('GET', url(), { token: editorToken })).status, 200);
    assert.equal((await req('GET', url(), { token: bezoekerToken })).status, 200);
    assert.equal((await put([attr()], editorToken)).status, 403);
    assert.equal((await put([attr()], bezoekerToken)).status, 403);
  });

  it('A01: gebruiker van een andere tenant kan niet lezen of wijzigen (IDOR)', async () => {
    const before = await stored();
    const get = await req('GET', url(), { token: otherAdminToken });
    assert.ok([403, 404].includes(get.status), `GET gaf ${get.status}`);
    assert.equal(get.body.attributes, undefined);
    const res = await put([attr({ id: 'IDOR' })], otherAdminToken);
    assert.ok([403, 404].includes(res.status), `PUT gaf ${res.status}`);
    assert.deepEqual(await stored(), before);
    assert.ok([403, 404].includes((await put([], adminToken, otherDoelenboomId)).status));
    assert.equal((await req('GET', `/api/tenants/${otherTenantId}/attributes`, { token: adminToken })).status, 403);
    assert.equal((await req('PUT', `/api/tenants/${otherTenantId}/attributes`, { token: adminToken, body: { attributes: [] } })).status, 403);
  });

  it('A01: niet-gekoppelde sysadmin mag de kenmerken van een boom niet lezen of wijzigen', async () => {
    assert.ok([403, 404].includes((await put([], sysadminToken)).status));
    assert.ok([403, 404].includes((await req('GET', url(), { token: sysadminToken })).status));
  });

  it('A01: niet-bestaand of niet-numeriek boom-id geeft 404, geen 500', async () => {
    assert.equal((await req('PUT', `/api/doelenbomen/999999999/attributes`, { token: adminToken, body: { attributes: [] } })).status, 404);
    assert.equal((await req('PUT', `/api/doelenbomen/abc/attributes`, { token: adminToken, body: { attributes: [] } })).status, 404);
    assert.equal((await req('GET', `/api/doelenbomen/abc/attributes`, { token: adminToken })).status, 404);
  });

  it('A01: read_only-boom kan niet gewijzigd worden', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await put([attr({ id: 'RO' })])).status, 403);
    } finally {
      await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
  });

  it('A01: zonder actieve module geen wijzigingen (403) en geen definities in de respons', async () => {
    assert.equal((await put([attr({ id: 'MOD1' })])).status, 200);
    await setModule(tenantId, false);
    try {
      const res = await put([attr({ id: 'NOMOD' })]);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /controleregels/);
      for (const token of [adminToken, editorToken, bezoekerToken]) {
        const get = await req('GET', url(), { token });
        assert.equal(get.status, 200);
        assert.equal(get.body.moduleActive, false);
        assert.deepEqual(get.body.attributes, []);
        assert.doesNotMatch(JSON.stringify(get.body), /MOD1/);
      }
      assert.deepEqual((await stored()).map((a: any) => a.id), ['MOD1'], 'bewaard, niet gewist');
    } finally {
      await setModule(tenantId, true);
    }
  });

  it('A01: zonder login 401', async () => {
    assert.equal((await req('GET', url())).status, 401);
    assert.equal((await req('PUT', url(), { body: { attributes: [] } })).status, 401);
    assert.equal((await req('GET', `/api/tenants/${tenantId}/attributes`)).status, 401);
    assert.equal((await req('GET', `/api/doelenboom-templates/1/attributes`)).status, 401);
  });

  // --- OWASP A03 -------------------------------------------------------------------

  it('A03: HTML/script in label, uitleg en keuzelijstwaarden wordt letterlijk als tekst opgeslagen en als JSON teruggegeven', async () => {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const expl = `"'><svg onload=alert(3)> & ${xss}`;
    const res = await put([attr({ id: 'XSS', label: xss, kind: 'choice', explanation: expl, options: [xss, '"><b>x</b>'] })]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const raw = await rawReq('GET', url(), { token: adminToken });
    assert.match(raw.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    const body = await raw.json();
    assert.equal(body.attributes[0].label, xss);
    assert.equal(body.attributes[0].explanation, expl);
    assert.deepEqual(body.attributes[0].options, [xss, '"><b>x</b>']);
  });

  it('A03: SQL-achtige invoer wordt als gewone tekst behandeld of geweigerd', async () => {
    const res = await put([attr({ subjectTypes: [`Capability'); drop table column_configs; --`] })]);
    assert.equal(res.status, 400);
    const label = `x'); drop table column_configs; --`;
    assert.equal((await put([attr({ id: 'SQL', label })])).status, 200);
    assert.equal((await stored())[0].label, label);
    assert.ok(Number((await pool.query('select count(*) from column_configs')).rows[0].count) > 0);
  });

  // --- OWASP A09: audit-log ----------------------------------------------------------

  it('A09: wijzigen schrijft attribute_definitions_updated met id\'s, zonder vrije tekst', async () => {
    const secret = `${PREFIX} geheim`;
    const res = await put([
      attr({ id: 'AUD1', label: `${secret} label`, kind: 'choice', explanation: `${secret} uitleg`, options: [`${secret} waarde`] }),
      attr({ id: 'AUD2', label: 'Tweede' }),
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const log = await pool.query(
      `select user_id, tenant_id, detail from audit_log
       where event_type = 'attribute_definitions_updated' and doelenboom_id = $1 order by id desc limit 1`,
      [doelenboomId]
    );
    assert.equal(log.rowCount, 1);
    assert.equal(String(log.rows[0].tenant_id), String(tenantId));
    assert.ok(log.rows[0].user_id);
    assert.deepEqual(log.rows[0].detail, { scope: 'doelenboom', attributeCount: 2, attributeIds: ['AUD1', 'AUD2'] });
    assert.doesNotMatch(JSON.stringify(log.rows[0].detail), /geheim|Tweede/);

    // Ook voor tenant-default en sjabloon, eveneens zonder vrije tekst.
    for (const scope of ['tenant_default', 'template']) {
      const rows = await pool.query(
        `select detail from audit_log where event_type = 'attribute_definitions_updated' and tenant_id = $1 and detail->>'scope' = $2`,
        [tenantId, scope]
      );
      assert.ok(rows.rowCount! >= 1, scope);
      for (const row of rows.rows) {
        const allowed = scope === 'template' ? ['attributeCount', 'attributeIds', 'scope', 'templateId'] : ['attributeCount', 'attributeIds', 'scope'];
        assert.deepEqual(Object.keys(row.detail).sort(), allowed);
      }
    }
  });

  it('A09: een geweigerde wijziging schrijft geen audit-event', async () => {
    const before = await auditCount();
    await put([attr({ id: 'X X' })]);
    await put([attr()], editorToken);
    await put([attr()], otherAdminToken);
    assert.equal(await auditCount(), before);
  });
});
