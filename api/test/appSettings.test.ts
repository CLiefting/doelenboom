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
      'update app_settings set max_failed_login_attempts = 5, login_lockout_minutes = 15 where id = 1'
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
});
