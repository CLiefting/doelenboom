// Regressietests voor DOEL-64 (epic DOEL-61, "Module Controleregels"):
// gemotiveerde afwijking per (element, regel) — zie
// api/src/controlRuleDeviations.ts en routes/controlRuleDeviations.ts.
// OWASP Top 10: A01 (rollen, andere tenant, read_only, module, IDOR via
// element van een andere boom, door-wie alleen door de server), A03 (HTML/
// SQL-achtige tekst wordt letterlijk opgeslagen en als JSON teruggegeven),
// A04 (lengtegrenzen in API én database, regel-id-patroon, onbekende regel,
// bodylimiet) en A09 (audit-events zonder motivatietekst). Plus de cascades
// (element weg, boom leeg/weg, regel verwijderd) en behoud bij Excel-import.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { restoreDeviations, snapshotDeviations } from '../src/controlRuleDeviations.js';
import {
  startTestServer, stopTestServer, closePool, req, getBaseUrl, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('ctrldev');

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'R01', kind: 'requires_outgoing', subjectTypes: ['Capability'], targetTypes: ['Operationele benefit'],
    label: 'Capability heeft een benefit als ouder', explanation: '', enabled: true, ...overrides,
  };
}

describe('gemotiveerde afwijkingen van controleregels (DOEL-64)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let editorToken: string;
  let bezoekerToken: string;
  let otherDoelenboomId: number;
  let otherAdminToken: string;

  const devUrl = (code: string, ruleId: string, id = doelenboomId) =>
    `/api/doelenbomen/${id}/elements/${encodeURIComponent(code)}/control-rule-deviations/${encodeURIComponent(ruleId)}`;
  const listUrl = (id = doelenboomId) => `/api/doelenbomen/${id}/control-rule-deviations`;
  const put = (code: string, ruleId: string, body: unknown, token = adminToken, id = doelenboomId) =>
    req('PUT', devUrl(code, ruleId, id), { token, body });
  const del = (code: string, ruleId: string, token = adminToken, id = doelenboomId) =>
    req('DELETE', devUrl(code, ruleId, id), { token });
  const putRules = (rules: unknown) =>
    req('PUT', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken, body: { rules } });
  const setModule = (tid: number, active: boolean) =>
    req('PUT', `/api/tenants/${tid}/license/modules/controleregels`, { token: sysadminToken, body: { active } });
  const addElement = (code: string, id = doelenboomId, token = adminToken) =>
    req('POST', `/api/doelenbomen/${id}/elements`, { token, body: { code, type: 'Capability', name: `Element ${code}` } });
  const dbRows = (id = doelenboomId) =>
    pool.query(
      `select e.code, d.rule_id, d.motivatie, d.created_by, d.updated_by from control_rule_deviations d
       join elements e on e.id = d.element_id where d.doelenboom_id = $1 order by e.code, d.rule_id`,
      [id]
    );
  const auditRows = (type: string) =>
    pool.query(`select user_id, tenant_id, detail from audit_log where event_type = $1 and doelenboom_id = $2 order by id`, [type, doelenboomId]);

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
    for (const code of ['CD1', 'CD2', 'CD3']) assert.equal((await addElement(code)).status, 201);
    assert.equal((await addElement('CDX', otherDoelenboomId, otherAdminToken)).status, 201);
    assert.equal((await putRules([rule(), rule({ id: 'R02', label: 'Tweede regel' }), rule({ id: 'R03', label: 'Derde', enabled: false })])).status, 200);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // --- Basis: zetten, wijzigen, intrekken per (element, regel) ----------------

  it('lege lijst zolang er niets gemotiveerd is', async () => {
    const res = await req('GET', listUrl(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.deviations, []);
  });

  it('admin zet een afwijking; door-wie/wanneer door de server; komt mee in lijst en boomrespons', async () => {
    const res = await put('CD1', 'R01', { motivatie: '  Afgedekt door een andere capability, zie besluit 12.  ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.elementCode, 'CD1');
    assert.equal(res.body.ruleId, 'R01');
    assert.equal(res.body.motivatie, 'Afgedekt door een andere capability, zie besluit 12.', 'getrimd');
    assert.equal(res.body.updatedByEmail, `${PREFIX}-admin@test.local`);
    assert.ok(!Number.isNaN(Date.parse(res.body.updatedAt)));

    const list = await req('GET', listUrl(), { token: adminToken });
    assert.equal(list.body.deviations.length, 1);
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.deepEqual(tree.body.controlRuleDeviations.map((d: any) => [d.elementCode, d.ruleId]), [['CD1', 'R01']]);
  });

  it('editor (gebruiker) mag ook zetten en wijzigen; een tweede regel op hetzelfde element staat los', async () => {
    const second = await put('CD1', 'R02', { motivatie: 'Tweede motivatie' }, editorToken);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const upd = await put('CD1', 'R01', { motivatie: 'Aangepast door editor' }, editorToken);
    assert.equal(upd.status, 200);
    const rows = await dbRows();
    assert.deepEqual(rows.rows.map((r) => [r.code, r.rule_id, r.motivatie]), [
      ['CD1', 'R01', 'Aangepast door editor'],
      ['CD1', 'R02', 'Tweede motivatie'],
    ]);
    // created_by blijft de oorspronkelijke maker, updated_by wordt de editor.
    assert.notEqual(rows.rows[0].created_by, rows.rows[0].updated_by);
  });

  it('intrekken verwijdert alleen die (element, regel); nogmaals intrekken geeft 404', async () => {
    assert.equal((await del('CD1', 'R02', editorToken)).status, 204);
    assert.equal((await del('CD1', 'R02')).status, 404);
    assert.deepEqual((await dbRows()).rows.map((r) => r.rule_id), ['R01']);
  });

  it('afwijking op een uitgeschakelde regel kan (regel bestaat), en blijft staan', async () => {
    assert.equal((await put('CD2', 'R03', { motivatie: 'Bij uitgeschakelde regel' })).status, 200);
    assert.equal((await del('CD2', 'R03')).status, 204);
  });

  // --- A01 Broken Access Control ---------------------------------------------

  it('A01: bezoeker mag lezen (zonder e-mailadres van de bijwerker) maar niet zetten/intrekken', async () => {
    const list = await req('GET', listUrl(), { token: bezoekerToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.deviations.length, 1);
    assert.equal('updatedByEmail' in list.body.deviations[0], false);
    assert.ok(list.body.deviations[0].updatedAt);
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: bezoekerToken });
    assert.equal('updatedByEmail' in tree.body.controlRuleDeviations[0], false);

    assert.equal((await put('CD2', 'R01', { motivatie: 'x' }, bezoekerToken)).status, 403);
    assert.equal((await del('CD1', 'R01', bezoekerToken)).status, 403);
    assert.deepEqual((await dbRows()).rows.map((r) => [r.code, r.rule_id]), [['CD1', 'R01']]);
  });

  it('A01: gebruiker van een andere tenant kan niet lezen, zetten of intrekken', async () => {
    for (const res of [
      await req('GET', listUrl(), { token: otherAdminToken }),
      await put('CD1', 'R01', { motivatie: 'x' }, otherAdminToken),
      await del('CD1', 'R01', otherAdminToken),
    ]) {
      assert.ok([403, 404].includes(res.status), String(res.status));
    }
    assert.equal((await dbRows()).rows[0].motivatie, 'Aangepast door editor');
  });

  it('A01: niet-gekoppelde sysadmin komt er niet in; zonder login 401', async () => {
    assert.ok([403, 404].includes((await put('CD1', 'R01', { motivatie: 'x' }, sysadminToken)).status));
    assert.equal((await req('GET', listUrl())).status, 401);
    assert.equal((await req('PUT', devUrl('CD1', 'R01'), { body: { motivatie: 'x' } })).status, 401);
    assert.equal((await req('DELETE', devUrl('CD1', 'R01'))).status, 401);
  });

  it('A01 (IDOR): element van een andere boom onder het eigen boom-id geeft 404, ook omgekeerd', async () => {
    // CDX bestaat alleen in de boom van de andere tenant.
    assert.equal((await put('CDX', 'R01', { motivatie: 'x' })).status, 404);
    assert.equal((await del('CDX', 'R01')).status, 404);
    // De andere admin met zijn eigen boom-id maar ons element.
    const res = await put('CD1', 'R01', { motivatie: 'x' }, otherAdminToken, otherDoelenboomId);
    assert.ok([400, 404].includes(res.status), String(res.status));
    assert.equal((await dbRows(otherDoelenboomId)).rowCount, 0);
  });

  it('A01: verzonnen created_by/updated_by/tijdstippen/doelenboom in de body worden genegeerd', async () => {
    const res = await put('CD2', 'R01', {
      motivatie: 'Met extra velden',
      created_by: 1, updated_by: 1, createdBy: 1, updatedByEmail: 'ander@evil.test',
      updatedAt: '2000-01-01T00:00:00Z', doelenboom_id: otherDoelenboomId, element_id: 1, rule_id: 'R02',
    }, editorToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.updatedByEmail, `${PREFIX}-editor@test.local`);
    assert.ok(Date.parse(res.body.updatedAt) > Date.parse('2026-01-01'));
    const row = await pool.query(
      `select d.doelenboom_id, d.rule_id, u.email as created_email from control_rule_deviations d
       join elements e on e.id = d.element_id left join users u on u.id = d.created_by
       where d.doelenboom_id = $1 and e.code = 'CD2'`,
      [doelenboomId]
    );
    assert.equal(row.rows[0].rule_id, 'R01');
    assert.equal(row.rows[0].created_email, `${PREFIX}-editor@test.local`);
    assert.equal((await del('CD2', 'R01')).status, 204);
  });

  it('A01: read_only-boom: niet zetten of intrekken, lezen blijft', async () => {
    await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: true } });
    try {
      assert.equal((await put('CD2', 'R01', { motivatie: 'x' })).status, 403);
      assert.equal((await del('CD1', 'R01')).status, 403);
      assert.equal((await req('GET', listUrl(), { token: adminToken })).status, 200);
    } finally {
      await req('PUT', `/api/doelenbomen/${doelenboomId}`, { token: adminToken, body: { name: 'Testboom', readOnly: false } });
    }
  });

  it('A01: zonder actieve module geen wijzigingen (403) en een lege lijst; data blijft bewaard', async () => {
    await setModule(tenantId, false);
    try {
      assert.equal((await put('CD2', 'R01', { motivatie: 'x' })).status, 403);
      assert.equal((await del('CD1', 'R01')).status, 403);
      const list = await req('GET', listUrl(), { token: adminToken });
      assert.deepEqual(list.body.deviations, []);
      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.deepEqual(tree.body.controlRuleDeviations, []);
    } finally {
      await setModule(tenantId, true);
    }
    assert.equal((await req('GET', listUrl(), { token: adminToken })).body.deviations.length, 1);
  });

  it('A01: niet-bestaand of niet-numeriek boom-id geeft 404, geen 500', async () => {
    assert.equal((await put('CD1', 'R01', { motivatie: 'x' }, adminToken, 99999999)).status, 404);
    const weird = await req('GET', '/api/doelenbomen/abc/control-rule-deviations', { token: adminToken });
    assert.ok([400, 404].includes(weird.status), String(weird.status));
  });

  // --- A03 Injection -----------------------------------------------------------

  it('A03: HTML/script/SQL-achtige motivatie wordt letterlijk opgeslagen en als JSON-tekst teruggegeven', async () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(2)>',
      'javascript:alert(3)',
      `'; drop table control_rule_deviations; --`,
    ];
    for (const p of payloads) {
      const res = await put('CD3', 'R01', { motivatie: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.body.motivatie, p);
    }
    const list = await req('GET', listUrl(), { token: adminToken });
    assert.equal(list.body.deviations.find((d: any) => d.elementCode === 'CD3').motivatie, payloads[3]);
    assert.equal((await pool.query(`select to_regclass('control_rule_deviations') as t`)).rows[0].t, 'control_rule_deviations');
    assert.equal((await del('CD3', 'R01')).status, 204);
  });

  it('A03: elementcode of regel-id met SQL/pad-tekens levert 400/404, geen 500', async () => {
    assert.equal((await put(`CD1' or '1'='1`, 'R01', { motivatie: 'x' })).status, 404);
    assert.equal((await put('CD1', `R01' or '1'='1`, { motivatie: 'x' })).status, 400);
    assert.equal((await put('CD1', 'R 01', { motivatie: 'x' })).status, 400);
    assert.equal((await del('CD1', '../R01')).status, 400);
  });

  // --- A04 Insecure Design -----------------------------------------------------

  it('A04: lengtegrens 1-500 in de API (na trimmen), verkeerd type en ontbrekende body', async () => {
    assert.equal((await put('CD2', 'R01', { motivatie: 'a'.repeat(500) })).status, 200);
    assert.equal((await put('CD2', 'R01', { motivatie: 'a'.repeat(501) })).status, 400);
    assert.equal((await put('CD2', 'R01', { motivatie: '' })).status, 400);
    assert.equal((await put('CD2', 'R01', { motivatie: '    ' })).status, 400);
    assert.equal((await put('CD2', 'R01', { motivatie: 123 })).status, 400);
    assert.equal((await put('CD2', 'R01', { motivatie: ['x'] })).status, 400);
    assert.equal((await put('CD2', 'R01', {})).status, 400);
    assert.equal((await req('PUT', devUrl('CD2', 'R01'), { token: adminToken })).status, 400);
    // De geweigerde pogingen hebben de geldige waarde niet overschreven.
    assert.equal((await dbRows()).rows.find((r) => r.code === 'CD2').motivatie.length, 500);
    assert.equal((await del('CD2', 'R01')).status, 204);
  });

  it('A04: de database dwingt lengte en regel-id-patroon ook zelf af', async () => {
    const el = await pool.query(`select id from elements where doelenboom_id = $1 and code = 'CD2'`, [doelenboomId]);
    const ins = (ruleId: string, motivatie: string) =>
      pool.query(
        'insert into control_rule_deviations (doelenboom_id, element_id, rule_id, motivatie) values ($1,$2,$3,$4)',
        [doelenboomId, el.rows[0].id, ruleId, motivatie]
      );
    await assert.rejects(ins('R01', ''), /check/i);
    await assert.rejects(ins('R01', 'a'.repeat(501)), /check/i);
    await assert.rejects(ins('R 01', 'ok'), /check/i);
    await ins('R02', 'ok');
    await assert.rejects(ins('R02', 'dubbel'), /unique|duplicate/i);
    await pool.query('delete from control_rule_deviations where element_id = $1', [el.rows[0].id]);
  });

  it('A04: niet-bestaande regel geeft 400', async () => {
    const res = await put('CD2', 'BESTAATNIET', { motivatie: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /bestaat niet/);
  });

  it('A04: te grote body geeft 413 zonder interne details; kapotte JSON geeft 400', async () => {
    const big = await put('CD2', 'R01', { motivatie: 'a'.repeat(300_000) });
    assert.equal(big.status, 413);
    assert.doesNotMatch(JSON.stringify(big.body ?? ''), /stack|node_modules/);
    const broken = await fetch(`${getBaseUrl()}${devUrl('CD2', 'R01')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: '{"motivatie": ',
    });
    assert.equal(broken.status, 400);
  });

  // --- A09 Logging ---------------------------------------------------------------

  it('A09: zetten en intrekken schrijven audit-events met elementcode en regel-id, zonder motivatietekst', async () => {
    const secret = `GEHEIM-${PREFIX}-motivatietekst`;
    const beforeSet = (await auditRows('control_rule_deviation_set')).rowCount!;
    const beforeRem = (await auditRows('control_rule_deviation_removed')).rowCount!;
    assert.equal((await put('CD3', 'R02', { motivatie: secret }, editorToken)).status, 200);
    assert.equal((await del('CD3', 'R02', editorToken)).status, 204);

    const set = await auditRows('control_rule_deviation_set');
    const rem = await auditRows('control_rule_deviation_removed');
    assert.equal(set.rowCount, beforeSet + 1);
    assert.equal(rem.rowCount, beforeRem + 1);
    const lastSet = set.rows[set.rows.length - 1];
    assert.deepEqual(lastSet.detail, { elementCode: 'CD3', ruleId: 'R02' });
    assert.equal(String(lastSet.tenant_id), String(tenantId));
    assert.ok(lastSet.user_id);
    assert.deepEqual(rem.rows[rem.rows.length - 1].detail, { elementCode: 'CD3', ruleId: 'R02' });

    const anywhere = await pool.query(`select count(*)::int as n from audit_log where detail::text like $1`, [`%${secret}%`]);
    assert.equal(anywhere.rows[0].n, 0, 'motivatietekst staat nergens in audit_log');
  });

  it('A09: geweigerde pogingen schrijven geen audit-event', async () => {
    const before = (await auditRows('control_rule_deviation_set')).rowCount;
    await put('CD3', 'R02', { motivatie: 'x' }, bezoekerToken);
    await put('CD3', 'BESTAATNIET', { motivatie: 'x' });
    await put('CD3', 'R02', { motivatie: '' });
    await put('NIETBESTAAND', 'R02', { motivatie: 'x' });
    assert.equal((await auditRows('control_rule_deviation_set')).rowCount, before);
  });

  // --- Regel verwijderd / cascades / import ---------------------------------------

  it('editor-context meldt het aantal afwijkingen per regel', async () => {
    assert.equal((await put('CD2', 'R02', { motivatie: 'm' })).status, 200);
    const ctx = await req('GET', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken });
    assert.deepEqual(ctx.body.deviationCounts, { R01: 1, R02: 1 });
  });

  it('regel verwijderen ruimt de afwijkingen van die regel direct op; uitschakelen niet; audit zonder tekst', async () => {
    // Uitschakelen van R02: afwijking blijft.
    assert.equal((await putRules([rule(), rule({ id: 'R02', label: 'Tweede regel', enabled: false }), rule({ id: 'R03', label: 'Derde', enabled: false })])).status, 200);
    assert.deepEqual((await dbRows()).rows.map((r) => [r.code, r.rule_id]), [['CD1', 'R01'], ['CD2', 'R02']]);
    // Verwijderen van R02: afwijking weg, R01 blijft.
    assert.equal((await putRules([rule(), rule({ id: 'R03', label: 'Derde', enabled: false })])).status, 200);
    assert.deepEqual((await dbRows()).rows.map((r) => [r.code, r.rule_id]), [['CD1', 'R01']]);
    const audit = await auditRows('control_rules_updated');
    const last = audit.rows[audit.rows.length - 1].detail;
    assert.equal(last.removedDeviations, 1);
    assert.doesNotMatch(JSON.stringify(last), /Tweede regel|Aangepast door editor/);
    // Een mislukte regel-PUT (ongeldige invoer) ruimt niets op.
    assert.equal((await putRules([rule({ id: 'X X' })])).status, 400);
    assert.equal((await dbRows()).rowCount, 1);
  });

  it('Excel-import (volledige vervanging van elementen): afwijkingen blijven behouden op elementcode', async () => {
    assert.equal((await put('CD3', 'R01', { motivatie: 'Blijft niet: element vervalt' })).status, 200);
    const stamp = `select d.created_at, d.updated_at, d.created_by from control_rule_deviations d
       join elements e on e.id = d.element_id where d.doelenboom_id = $1 and e.code = 'CD1'`;
    const before = await pool.query(stamp, [doelenboomId]);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const snap = await snapshotDeviations(client, doelenboomId);
      assert.equal(snap.length, 2);
      await client.query(`delete from elements where doelenboom_id = $1 and code in ('CD1','CD3')`, [doelenboomId]);
      // Na de vervanging bestaat alleen CD1 nog (nieuw database-id), CD3 niet meer.
      const re = await client.query(
        `insert into elements (doelenboom_id, code, type, name) values ($1, 'CD1', 'Capability', 'Element CD1') returning id`,
        [doelenboomId]
      );
      await restoreDeviations(client, doelenboomId, snap, new Map([['CD1', re.rows[0].id]]));
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    const rows = await dbRows();
    assert.deepEqual(rows.rows.map((r) => [r.code, r.rule_id, r.motivatie]), [['CD1', 'R01', 'Aangepast door editor']]);
    const after = await pool.query(stamp, [doelenboomId]);
    assert.deepEqual(after.rows[0], before.rows[0], 'door wie/wanneer ongewijzigd');
  });

  it('cascade: element verwijderen via de API haalt zijn afwijkingen weg', async () => {
    assert.equal((await put('CD2', 'R01', { motivatie: 'Gaat mee weg' })).status, 200);
    const d = await req('DELETE', `/api/doelenbomen/${doelenboomId}/elements/CD2`, { token: adminToken });
    assert.ok([200, 204].includes(d.status), String(d.status));
    assert.deepEqual((await dbRows()).rows.map((r) => r.code), ['CD1']);
  });

  it('afwijkingen gaan niet mee in sjablonen (geen kolom ervoor in doelenboom_templates)', async () => {
    const cols = await pool.query(
      `select column_name from information_schema.columns where table_name = 'doelenboom_templates'`
    );
    assert.ok(cols.rowCount! > 0);
    assert.ok(!cols.rows.some((c) => /deviation|afwijking|motivatie/i.test(c.column_name)));
  });

  it('cascade: boom leegmaken (wipe: delete from elements) en boom verwijderen laten geen afwijkingen achter', async () => {
    assert.equal((await dbRows()).rowCount, 1);
    // Zelfde statement als wipeDoelenboomData() in tenantWipe.ts (wipe_on_empty/tenant-wipe).
    await pool.query('delete from elements where doelenboom_id = $1', [doelenboomId]);
    assert.equal((await pool.query('select 1 from control_rule_deviations where doelenboom_id = $1', [doelenboomId])).rowCount, 0);

    assert.equal((await addElement('CD9')).status, 201);
    assert.equal((await put('CD9', 'R01', { motivatie: 'Voor boom-delete' })).status, 200);
    await pool.query('delete from doelenbomen where id = $1', [doelenboomId]);
    assert.equal((await pool.query('select 1 from control_rule_deviations where doelenboom_id = $1', [doelenboomId])).rowCount, 0);
  });
});
