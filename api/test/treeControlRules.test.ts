// Regressietests voor DOEL-63 (epic DOEL-61, "Module Controleregels"):
// de boomrespons (GET /api/doelenbomen/:id/tree) levert de actieve,
// geldige controleregels mee zodat tree.html de controleweergave kan
// tonen. De evaluatie zelf gebeurt client-side (web/test/
// tree-html-control-rules.test.mjs). OWASP: A01 (alleen met module, alleen
// eigen tenant, bezoeker mag lezen), A03 (regelteksten komen ongewijzigd als
// JSON-tekst mee; escaping gebeurt in de weergave), A04 (verweesde regels
// worden niet meegeleverd), A09 (lezen schrijft geen audit-event).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('treectrl');

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

describe('controleregels in de boomrespons (DOEL-63)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let bezoekerToken: string;
  let otherAdminToken: string;

  const treeUrl = (id = doelenboomId) => `/api/doelenbomen/${id}/tree`;
  const putRules = (rules: unknown) =>
    req('PUT', `/api/doelenbomen/${doelenboomId}/control-rules`, { token: adminToken, body: { rules } });
  const setModule = (active: boolean) =>
    req('PUT', `/api/tenants/${tenantId}/license/modules/controleregels`, { token: sysadminToken, body: { active } });

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, bezoekerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    ({ adminToken: otherAdminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-b`));
    assert.equal((await setModule(true)).status, 200);
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('zonder regels: controlRules = []', async () => {
    const res = await req('GET', treeUrl(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.controlRules, []);
  });

  it('met module: opgeslagen regels komen mee in de boomrespons (ook uitgeschakelde, voor de client)', async () => {
    const put = await putRules([
      rule(),
      { id: 'R02', kind: 'required_field', subjectTypes: ['Capability'], field: 'kpi', label: 'KPI ingevuld', enabled: false },
    ]);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const res = await req('GET', treeUrl(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.controlRules.map((r: any) => r.id), ['R01', 'R02']);
    const r1 = res.body.controlRules[0];
    assert.equal(r1.kind, 'requires_outgoing');
    assert.deepEqual(r1.subjectTypes, ['Capability']);
    assert.deepEqual(r1.targetTypes, ['Operationele benefit']);
    assert.equal(res.body.controlRules[1].enabled, false);
  });

  it('A01: bezoeker krijgt de regels mee (alleen-lezen weergave)', async () => {
    const res = await req('GET', treeUrl(), { token: bezoekerToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.controlRules.map((r: any) => r.id), ['R01', 'R02']);
  });

  it('A01: zonder actieve module levert de boom geen regels mee', async () => {
    await setModule(false);
    try {
      const res = await req('GET', treeUrl(), { token: adminToken });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.controlRules, []);
    } finally {
      await setModule(true);
    }
    const back = await req('GET', treeUrl(), { token: adminToken });
    assert.equal(back.body.controlRules.length, 2);
  });

  it('A01: gebruiker van een andere tenant krijgt de boom (en dus de regels) niet', async () => {
    const res = await req('GET', treeUrl(), { token: otherAdminToken });
    assert.ok([403, 404].includes(res.status), String(res.status));
    assert.equal(res.body?.controlRules, undefined);
  });

  it('A04: regel die naar een niet-bestaand type verwijst wordt niet meegeleverd', async () => {
    const alias = `${PREFIX}-Weg`;
    const cfg = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken });
    const cols = cfg.body.columns as any[];
    cols[2].aliases = [{ typeName: alias, color: null }];
    assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: cols } })).status, 200);
    assert.equal((await putRules([rule(), rule({ id: 'RW', subjectTypes: [alias] })])).status, 200);

    // Zonder module mag de kolomwijziging door (DOEL-62); daarna verweest RW.
    await setModule(false);
    try {
      const without = (await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken })).body.columns as any[];
      without[2].aliases = [];
      assert.equal((await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken, body: { columns: without } })).status, 200);
    } finally {
      await setModule(true);
    }
    const res = await req('GET', treeUrl(), { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.controlRules.map((r: any) => r.id), ['R01'], 'verweesde regel RW niet in de weergave');
    assert.equal((await putRules([rule()])).status, 200);
  });

  it('A03: HTML in label/uitleg komt letterlijk als tekst mee (escaping gebeurt in de weergave)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    assert.equal((await putRules([rule({ label: payload, explanation: `"><script>alert(2)</script>` })])).status, 200);
    const res = await req('GET', treeUrl(), { token: adminToken });
    assert.equal(res.body.controlRules[0].label, payload);
    assert.equal(res.body.controlRules[0].explanation, `"><script>alert(2)</script>`);
  });

  it('A09: de boom lezen schrijft geen control_rules-audit-event', async () => {
    const q = `select count(*) from audit_log where event_type = 'control_rules_updated' and doelenboom_id = $1`;
    const before = await pool.query(q, [doelenboomId]);
    await req('GET', treeUrl(), { token: adminToken });
    await req('GET', treeUrl(), { token: bezoekerToken });
    const afterRow = await pool.query(q, [doelenboomId]);
    assert.equal(afterRow.rows[0].count, before.rows[0].count);
  });
});
