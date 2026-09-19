import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, createSysadminUser, login, cleanupByPrefix, unique,
} from './helpers.js';
import { pool } from '../src/db.js';

// DOEL-27 (analyse M4, OWASP A01/A04): een tenant-admin kon open_access_role
// op 'admin' zetten — daarmee krijgt elk account met een login (en via de
// open registratie feitelijk iedereen) beheerdersrechten in de tenant.

const PREFIX = unique('openaccess');

describe('open_access_role: rechten van een tenant-admin (DOEL-27)', () => {
  let sysToken = '';
  let tenantId = 0;
  let adminToken = '';

  async function setRole(token: string, body: Record<string, unknown>) {
    return req('PUT', `/api/tenants/${tenantId}`, { token, body });
  }
  async function currentRole(): Promise<string | null> {
    return (await pool.query('select open_access_role from tenants where id = $1', [tenantId])).rows[0].open_access_role;
  }

  before(async () => {
    await startTestServer();
    const sysEmail = `${PREFIX}-sys@test.local`;
    await createSysadminUser(sysEmail, 'geheim1234');
    sysToken = await login(sysEmail, 'geheim1234');
    const t = await req('POST', '/api/tenants', { token: sysToken, body: { slug: `${PREFIX}-t`, name: 'Open access test' } });
    tenantId = t.body.id;
    const adminEmail = `${PREFIX}-tadmin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    adminToken = await login(adminEmail, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it("een tenant-admin kan open toegang NIET op 'editor' of 'admin' zetten (403, niets gewijzigd)", async () => {
    for (const role of ['admin', 'editor']) {
      const res = await setRole(adminToken, { openAccessRole: role, confirmOpenAccess: true });
      assert.equal(res.status, 403, role);
      assert.equal(res.body.reason, 'open_access_sysadmin_only');
    }
    assert.equal(await currentRole(), null);
  });

  it("'bezoeker' zonder expliciete bevestiging: 400 confirmation_required; een niet-strikte waarde telt niet als bevestiging", async () => {
    for (const confirm of [undefined, false, 'true', 1, 'yes']) {
      const res = await setRole(adminToken, { openAccessRole: 'bezoeker', ...(confirm === undefined ? {} : { confirmOpenAccess: confirm }) });
      assert.equal(res.status, 400, String(confirm));
      assert.equal(res.body.reason, 'confirmation_required');
    }
    assert.equal(await currentRole(), null);
  });

  it("'bezoeker' met confirmOpenAccess: true mag wel en komt in de auditlog", async () => {
    const res = await setRole(adminToken, { openAccessRole: 'bezoeker', confirmOpenAccess: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.open_access_role, 'bezoeker');
    const audit = await pool.query(
      `select detail from audit_log where event_type = 'tenant_settings_changed' and tenant_id = $1 order by id desc limit 1`,
      [tenantId]
    );
    assert.equal(audit.rows[0].detail.changes.open_access_role.to, 'bezoeker');
  });

  it('een tenant-admin mag open toegang altijd uitzetten of verlagen', async () => {
    await setRole(sysToken, { openAccessRole: 'admin' });
    assert.equal((await setRole(adminToken, { openAccessRole: 'editor' })).status, 200);
    assert.equal(await currentRole(), 'editor');
    assert.equal((await setRole(adminToken, { openAccessRole: 'bezoeker' })).status, 200);
    assert.equal((await setRole(adminToken, { openAccessRole: null })).status, 200);
    assert.equal(await currentRole(), null);
  });

  it('dezelfde waarde terugsturen (instellingenformulier stuurt alle velden mee) blijft toegestaan, ook als een sysadmin hem op admin zette', async () => {
    assert.equal((await setRole(sysToken, { openAccessRole: 'admin' })).status, 200);
    const res = await setRole(adminToken, { openAccessRole: 'admin', wipeOnEmpty: false, sessionTimeoutMinutes: 40 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.open_access_role, 'admin');
    assert.equal(res.body.session_timeout_minutes, 40);
    await setRole(sysToken, { openAccessRole: null });
  });

  it('een sysadmin blijft onbeperkt (admin/editor/bezoeker/null zonder bevestiging)', async () => {
    for (const role of ['admin', 'editor', 'bezoeker', null]) {
      const res = await setRole(sysToken, { openAccessRole: role });
      assert.equal(res.status, 200, String(role));
      assert.equal(await currentRole(), role);
    }
  });

  it('een ongeldige waarde blijft een 400, en zonder openAccessRole in de body verandert er niets aan de beperking', async () => {
    assert.equal((await setRole(adminToken, { openAccessRole: 'superadmin' })).status, 400);
    assert.equal((await setRole(adminToken, { wipeOnEmpty: false })).status, 200);
    assert.equal(await currentRole(), null);
  });

  it('een lid (geen admin) van de tenant kan de instelling sowieso niet wijzigen', async () => {
    const editorEmail = `${PREFIX}-editor@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysToken, body: { email: editorEmail, password: 'wachtwoord123', role: 'editor' },
    });
    const editorToken = await login(editorEmail, 'wachtwoord123');
    const res = await setRole(editorToken, { openAccessRole: 'bezoeker', confirmOpenAccess: true });
    assert.equal(res.status, 403);
    assert.equal(await currentRole(), null);
  });
});
