import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('appsettings');

// GET/PUT /api/app-settings (zie api/src/routes/appSettings.ts) — de
// sysadmin-only, app-brede instellingen voor de inlog-blokkade
// (maxFailedLoginAttempts/loginLockoutMinutes, zie auth.ts POST /login).
// De blokkade-logica zelf wordt getest in auth.test.ts; hier alleen de
// beheerroute (autorisatie, validatie, effectief opslaan).
describe('app-settings', () => {
  let sysadminToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-admin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
  });

  after(async () => {
    // Reset naar de standaardwaarden, anders lekt een gewijzigde instelling
    // (bv. loginLockoutMinutes = 1 hieronder) door naar andere testbestanden
    // die in dezelfde testrun/database draaien (bv. auth.test.ts).
    await pool.query(
      'update app_settings set max_failed_login_attempts = 5, login_lockout_minutes = 15, idle_timeout_minutes = 15 where id = 1'
    );
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/app-settings is niet toegankelijk zonder token', async () => {
    const res = await req('GET', '/api/app-settings');
    assert.equal(res.status, 401);
  });

  it('GET /api/app-settings is sysadmin-only (tenant-admin krijgt 403)', async () => {
    const { adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t1`);
    const res = await req('GET', '/api/app-settings', { token: adminToken });
    assert.equal(res.status, 403);
  });

  it('GET /api/app-settings geeft de standaardwaarden terug (5 pogingen / 15 minuten)', async () => {
    const res = await req('GET', '/api/app-settings', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.maxFailedLoginAttempts, 5);
    assert.equal(res.body.loginLockoutMinutes, 15);
  });

  it('PUT /api/app-settings valideert de invoer', async () => {
    const geenVelden = await req('PUT', '/api/app-settings', { token: sysadminToken, body: {} });
    assert.equal(geenVelden.status, 400);

    const nul = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { maxFailedLoginAttempts: 0 },
    });
    assert.equal(nul.status, 400);

    const nietGeheel = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { loginLockoutMinutes: 2.5 },
    });
    assert.equal(nietGeheel.status, 400);

    const negatief = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { maxFailedLoginAttempts: -1 },
    });
    assert.equal(negatief.status, 400);
  });

  it('PUT /api/app-settings wijzigt één of beide velden, en is sysadmin-only', async () => {
    const { adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t2`);
    const asTenantAdmin = await req('PUT', '/api/app-settings', {
      token: adminToken, body: { maxFailedLoginAttempts: 3 },
    });
    assert.equal(asTenantAdmin.status, 403);

    const onlyOne = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { maxFailedLoginAttempts: 3 },
    });
    assert.equal(onlyOne.status, 200);
    assert.equal(onlyOne.body.maxFailedLoginAttempts, 3);
    // Alleen loginLockoutMinutes meesturen: blijft ongewijzigd op 15.
    assert.equal(onlyOne.body.loginLockoutMinutes, 15);

    const both = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { maxFailedLoginAttempts: 4, loginLockoutMinutes: 20 },
    });
    assert.equal(both.status, 200);
    assert.equal(both.body.maxFailedLoginAttempts, 4);
    assert.equal(both.body.loginLockoutMinutes, 20);

    const check = await req('GET', '/api/app-settings', { token: sysadminToken });
    assert.equal(check.body.maxFailedLoginAttempts, 4);
    assert.equal(check.body.loginLockoutMinutes, 20);
  });

  // DOEL-97: de inactiviteitstermijn voor automatisch uitloggen is instelbaar
  // (standaard 15 minuten, grenzen 5 t/m 480). Het effect op requireAuth zelf
  // staat in auth.test.ts.
  it('GET /api/app-settings geeft ook de inactiviteitstermijn terug (standaard 15 minuten)', async () => {
    const res = await req('GET', '/api/app-settings', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.idleTimeoutMinutes, 15);
  });

  it('PUT /api/app-settings zet de inactiviteitstermijn binnen de grenzen (5 t/m 480)', async () => {
    for (const ongeldig of [4, 481, 0, -15, 30.5, '60', null, true]) {
      const res = await req('PUT', '/api/app-settings', { token: sysadminToken, body: { idleTimeoutMinutes: ongeldig } });
      assert.equal(res.status, 400, `waarde ${JSON.stringify(ongeldig)} had geweigerd moeten worden`);
    }
    // Een SQL-fragment als waarde wordt geweigerd en komt nooit in een query (OWASP A03).
    const injectie = await req('PUT', '/api/app-settings', {
      token: sysadminToken, body: { idleTimeoutMinutes: "15 minutes'; drop table users; --" },
    });
    assert.equal(injectie.status, 400);
    const users = await pool.query('select count(*)::int as n from users');
    assert.ok(users.rows[0].n > 0);

    for (const geldig of [5, 60, 480]) {
      const res = await req('PUT', '/api/app-settings', { token: sysadminToken, body: { idleTimeoutMinutes: geldig } });
      assert.equal(res.status, 200);
      assert.equal(res.body.idleTimeoutMinutes, geldig);
    }
    const check = await req('GET', '/api/app-settings', { token: sysadminToken });
    assert.equal(check.body.idleTimeoutMinutes, 480);
    // De andere instellingen blijven ongemoeid.
    assert.equal(typeof check.body.maxFailedLoginAttempts, 'number');
    await req('PUT', '/api/app-settings', { token: sysadminToken, body: { idleTimeoutMinutes: 15 } });
  });

  it('alleen een sysadmin mag de inactiviteitstermijn wijzigen (OWASP A01), en de wijziging staat in het auditlog (A09)', async () => {
    const { adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t3`);
    const asTenantAdmin = await req('PUT', '/api/app-settings', { token: adminToken, body: { idleTimeoutMinutes: 480 } });
    assert.equal(asTenantAdmin.status, 403);
    const zonderToken = await req('PUT', '/api/app-settings', { body: { idleTimeoutMinutes: 480 } });
    assert.equal(zonderToken.status, 401);
    const check = await req('GET', '/api/app-settings', { token: sysadminToken });
    assert.equal(check.body.idleTimeoutMinutes, 15);

    const before = await pool.query(`select count(*)::int as n from audit_log where event_type = 'app_settings_updated'`);
    const ok = await req('PUT', '/api/app-settings', { token: sysadminToken, body: { idleTimeoutMinutes: 45 } });
    assert.equal(ok.status, 200);
    const rows = await pool.query(
      `select detail from audit_log where event_type = 'app_settings_updated' order by id desc limit 1`
    );
    const after = await pool.query(`select count(*)::int as n from audit_log where event_type = 'app_settings_updated'`);
    assert.equal(after.rows[0].n, before.rows[0].n + 1);
    assert.deepEqual(rows.rows[0].detail.changes.idleTimeoutMinutes, { from: 15, to: 45 });
    await req('PUT', '/api/app-settings', { token: sysadminToken, body: { idleTimeoutMinutes: 15 } });
  });
});
