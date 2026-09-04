import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createUser, createSysadminUser, login,
  cleanupByPrefix, getLastMfaCode, setMfaEmailFailure,
} from './helpers.js';
import { pool } from '../src/db.js';
import { MAX_ATTEMPTS, MAX_RESENDS, RESEND_COOLDOWN_SECONDS } from '../src/mfa.js';

const PREFIX = unique('mfa');

// Tweestapsverificatie — zie doelenboom_mfa_ontwerp.md in het project en
// api/src/mfa.ts/auth.ts. auth.test.ts test al de simpele gelukkige route
// (sysadmin-login -> mfaRequired -> verify -> token) — dit bestand test de
// randgevallen: foute code, te veel pogingen, hernieuwen (cooldown/limiet),
// verlopen/al-gebruikte challenges, de zelfbedieningsschakelaar en het
// sysadmin-herstelpad.
describe('mfa', () => {
  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  before(async () => {
    await startTestServer();
  });

  it('gewone gebruiker zonder mfaEnabled logt in zonder MFA-stap', async () => {
    const email = `${PREFIX}-plain@test.local`;
    await createUser(email, 'geheim1234');
    const { status, body } = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.mfaRequired, undefined);
  });

  it('zelfbedieningsschakelaar: gewone gebruiker kan eigen MFA aan/uit zetten, daarna vereist login een code', async () => {
    const email = `${PREFIX}-selfservice@test.local`;
    await createUser(email, 'geheim1234');
    const token = await login(email, 'geheim1234');

    const me1 = await req('GET', '/api/auth/me', { token });
    assert.equal(me1.body.user.mfaEnabled, false);

    const on = await req('PUT', '/api/auth/mfa-enabled', { token, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.mfaEnabled, true);

    const me2 = await req('GET', '/api/auth/me', { token });
    assert.equal(me2.body.user.mfaEnabled, true);

    // Een nieuwe login (nieuwe sessie) vereist nu een code.
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    assert.equal(loginResult.body.mfaRequired, true);
    const code = getLastMfaCode(email);
    assert.ok(code);
    const verify = await req('POST', '/api/auth/mfa/verify', {
      body: { challengeId: loginResult.body.challengeId, code },
    });
    assert.equal(verify.status, 200);
    assert.ok(verify.body.token);

    // En weer uitzetten kan ook.
    const off = await req('PUT', '/api/auth/mfa-enabled', { token: verify.body.token, body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.mfaEnabled, false);
  });

  it('PUT /api/auth/mfa-enabled weigert voor sysadmins (verplicht, geen eigen omweg)', async () => {
    const email = `${PREFIX}-sysadmin-self@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const token = await login(email, 'geheim1234'); // rondt zelf de MFA-stap af
    const { status, body } = await req('PUT', '/api/auth/mfa-enabled', { token, body: { enabled: false } });
    assert.equal(status, 400);
    assert.match(body.error, /verplicht/);
  });

  it('PUT /api/auth/mfa-enabled vereist een boolean', async () => {
    const email = `${PREFIX}-badbody@test.local`;
    await createUser(email, 'geheim1234');
    const token = await login(email, 'geheim1234');
    const { status } = await req('PUT', '/api/auth/mfa-enabled', { token, body: { enabled: 'ja' } });
    assert.equal(status, 400);
  });

  it('POST /api/auth/mfa/verify: onjuiste code hoogt de teller op, na MAX_ATTEMPTS strandt de challenge', async () => {
    const email = `${PREFIX}-attempts@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const challengeId = loginResult.body.challengeId as string;

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      const attempt = await req('POST', '/api/auth/mfa/verify', { body: { challengeId, code: 'ZZZZZZ' } });
      assert.equal(attempt.status, 401);
      assert.equal(attempt.body.reason, 'wrong_code');
    }
    // De laatste (MAX_ATTEMPTS-ste) foute poging kantelt naar too_many_attempts.
    const last = await req('POST', '/api/auth/mfa/verify', { body: { challengeId, code: 'ZZZZZZ' } });
    assert.equal(last.status, 429);
    assert.equal(last.body.reason, 'too_many_attempts');

    // Ook de échte code werkt daarna niet meer op deze challenge.
    const code = getLastMfaCode(email);
    const withRealCode = await req('POST', '/api/auth/mfa/verify', { body: { challengeId, code } });
    assert.equal(withRealCode.status, 429);
    assert.equal(withRealCode.body.reason, 'too_many_attempts');
  });

  it('POST /api/auth/mfa/verify: een al-gebruikte challenge kan niet nogmaals', async () => {
    const email = `${PREFIX}-reuse@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const code = getLastMfaCode(email);
    const first = await req('POST', '/api/auth/mfa/verify', { body: { challengeId: loginResult.body.challengeId, code } });
    assert.equal(first.status, 200);

    const second = await req('POST', '/api/auth/mfa/verify', { body: { challengeId: loginResult.body.challengeId, code } });
    assert.equal(second.status, 401);
    assert.equal(second.body.reason, 'already_used');
  });

  it('POST /api/auth/mfa/verify: onbekende challengeId geeft not_found', async () => {
    const { status, body } = await req('POST', '/api/auth/mfa/verify', { body: { challengeId: 'onzin-id', code: 'ABCDEF' } });
    assert.equal(status, 400);
    assert.equal(body.reason, 'not_found');
  });

  it('POST /api/auth/mfa/verify: een verlopen challenge wordt geweigerd', async () => {
    const email = `${PREFIX}-expired@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const code = getLastMfaCode(email);
    await pool.query(`update mfa_challenges set expires_at = now() - interval '1 minute' where id = $1`, [
      loginResult.body.challengeId,
    ]);
    const verify = await req('POST', '/api/auth/mfa/verify', { body: { challengeId: loginResult.body.challengeId, code } });
    assert.equal(verify.status, 401);
    assert.equal(verify.body.reason, 'expired');
  });

  it('POST /api/auth/mfa/resend: cooldown direct na aanmaken, daarna een nieuwe code die de oude vervangt', async () => {
    const email = `${PREFIX}-resend@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const challengeId = loginResult.body.challengeId as string;
    const originalCode = getLastMfaCode(email);

    const tooSoon = await req('POST', '/api/auth/mfa/resend', { body: { challengeId } });
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.body.reason, 'cooldown');
    assert.ok(tooSoon.body.retryAfterSeconds > 0);

    // Cooldown omzeilen voor de test (niet echt RESEND_COOLDOWN_SECONDS wachten):
    // created_at teruggezet, zelfde challenge-rij.
    await pool.query(
      `update mfa_challenges set created_at = now() - make_interval(secs => $2) where id = $1`,
      [challengeId, RESEND_COOLDOWN_SECONDS + 1]
    );
    const resend = await req('POST', '/api/auth/mfa/resend', { body: { challengeId } });
    assert.equal(resend.status, 200);
    assert.ok(resend.body.expiresInSeconds > 0);

    const newCode = getLastMfaCode(email);
    assert.notEqual(newCode, originalCode);

    // De oude code werkt niet meer, de nieuwe wel.
    const withOldCode = await req('POST', '/api/auth/mfa/verify', { body: { challengeId, code: originalCode } });
    assert.equal(withOldCode.status, 401);
    assert.equal(withOldCode.body.reason, 'wrong_code');

    const withNewCode = await req('POST', '/api/auth/mfa/verify', { body: { challengeId, code: newCode } });
    assert.equal(withNewCode.status, 200);
  });

  it('POST /api/auth/mfa/resend: na MAX_RESENDS keer opnieuw versturen wordt het geweigerd', async () => {
    const email = `${PREFIX}-maxresend@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const challengeId = loginResult.body.challengeId as string;

    for (let i = 0; i < MAX_RESENDS; i += 1) {
      await pool.query(
        `update mfa_challenges set created_at = now() - make_interval(secs => $2) where id = $1`,
        [challengeId, RESEND_COOLDOWN_SECONDS + 1]
      );
      const resend = await req('POST', '/api/auth/mfa/resend', { body: { challengeId } });
      assert.equal(resend.status, 200);
    }

    await pool.query(
      `update mfa_challenges set created_at = now() - make_interval(secs => $2) where id = $1`,
      [challengeId, RESEND_COOLDOWN_SECONDS + 1]
    );
    const oneMore = await req('POST', '/api/auth/mfa/resend', { body: { challengeId } });
    assert.equal(oneMore.status, 429);
    assert.equal(oneMore.body.reason, 'too_many_resends');
  });

  it('herstelpad: sysadmin kan mfaEnabled van een vergrendelde niet-sysadmin uitzetten via PUT /api/users/:id', async () => {
    const sysadminEmail = `${PREFIX}-recovery-admin@test.local`;
    await createSysadminUser(sysadminEmail, 'geheim1234');
    const sysadminToken = await login(sysadminEmail, 'geheim1234');

    const userEmail = `${PREFIX}-recovery-user@test.local`;
    const userId = await createUser(userEmail, 'geheim1234');
    await pool.query('update users set mfa_enabled = true where id = $1', [userId]);

    const updated = await req('PUT', `/api/users/${userId}`, { token: sysadminToken, body: { mfaEnabled: false } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.mfa_enabled, false);

    // De gebruiker kan nu weer zonder code inloggen.
    const loginResult = await req('POST', '/api/auth/login', { body: { email: userEmail, password: 'geheim1234' } });
    assert.equal(loginResult.status, 200);
    assert.ok(loginResult.body.token);
  });

  it('legt mfa_verified en mfa_failed vast in het auditlogboek', async () => {
    const email = `${PREFIX}-audit@test.local`;
    const userId = await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    await req('POST', '/api/auth/mfa/verify', { body: { challengeId: loginResult.body.challengeId, code: 'ZZZZZZ' } });
    const code = getLastMfaCode(email);
    await req('POST', '/api/auth/mfa/verify', { body: { challengeId: loginResult.body.challengeId, code } });

    const rows = await pool.query(
      `select event_type from audit_log where user_id = $1 order by created_at`,
      [userId]
    );
    assert.deepEqual(rows.rows.map((r) => r.event_type), ['mfa_failed', 'mfa_verified']);
  });

  it('een falende e-mailverzending (SMTP onbereikbaar) geeft een nette 502 i.p.v. te blijven hangen', async () => {
    const email = `${PREFIX}-smtpdown@test.local`;
    await createSysadminUser(email, 'geheim1234');
    setMfaEmailFailure(true);
    try {
      const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
      assert.equal(loginResult.status, 502);
      assert.match(loginResult.body.error, /niet bereikbaar/);
    } finally {
      setMfaEmailFailure(false);
    }
  });

  it('een falende e-mailverzending bij /mfa/resend geeft ook een nette 502', async () => {
    const email = `${PREFIX}-smtpdown-resend@test.local`;
    await createSysadminUser(email, 'geheim1234');
    const loginResult = await req('POST', '/api/auth/login', { body: { email, password: 'geheim1234' } });
    const challengeId = loginResult.body.challengeId as string;
    await pool.query(
      `update mfa_challenges set created_at = now() - make_interval(secs => $2) where id = $1`,
      [challengeId, RESEND_COOLDOWN_SECONDS + 1]
    );
    setMfaEmailFailure(true);
    try {
      const resend = await req('POST', '/api/auth/mfa/resend', { body: { challengeId } });
      assert.equal(resend.status, 502);
      assert.match(resend.body.error, /niet bereikbaar/);
    } finally {
      setMfaEmailFailure(false);
    }
  });

  // Tenant-brede verplichte MFA (zie db/init.sql tenants.mfa_required,
  // routes/tenants.ts PUT /api/tenants/:id, auth.ts mfaRequired) — los van de
  // hierboven al geteste sysadmin-verplichting en de eigen (optionele)
  // mfa_enabled-schakelaar.
  it('tenant met mfa_required aan: een gewoon lid moet ook door de MFA-stap, zonder eigen mfa_enabled', async () => {
    const sysadminEmail = `${PREFIX}-tenantmfa-admin@test.local`;
    await createSysadminUser(sysadminEmail, 'geheim1234');
    const sysadminToken = await login(sysadminEmail, 'geheim1234');

    const slug = `${PREFIX}-tenantmfa`;
    const tenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Tenant MFA' } });
    const tenantId = tenant.body.id as number;
    const setRequired = await req('PUT', `/api/tenants/${tenantId}`, {
      token: sysadminToken, body: { mfaRequired: true },
    });
    assert.equal(setRequired.status, 200);
    assert.equal(setRequired.body.mfa_required, true);

    const memberEmail = `${PREFIX}-tenantmfa-lid@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: memberEmail, password: 'geheim1234', role: 'gebruiker' },
    });

    // Geen sysadmin, mfa_enabled staat niet aan — toch moet /login een code
    // vereisen, puur omdat dit account lid is van een tenant met mfa_required.
    const loginResult = await req('POST', '/api/auth/login', { body: { email: memberEmail, password: 'geheim1234' } });
    assert.equal(loginResult.body.mfaRequired, true);
    const code = getLastMfaCode(memberEmail);
    assert.ok(code);
    const verify = await req('POST', '/api/auth/mfa/verify', {
      body: { challengeId: loginResult.body.challengeId, code },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.user.mfaEnabled, false);
    assert.deepEqual(verify.body.user.mfaRequiredTenants, ['Tenant MFA']);

    const me = await req('GET', '/api/auth/me', { token: verify.body.token });
    assert.deepEqual(me.body.user.mfaRequiredTenants, ['Tenant MFA']);

    // Geen individuele opt-out: net als bij sysadmins geeft de zelfbedienings-
    // schakelaar hier een 400, met de tenantnaam erbij ter uitleg.
    const toggle = await req('PUT', '/api/auth/mfa-enabled', { token: verify.body.token, body: { enabled: false } });
    assert.equal(toggle.status, 400);
    assert.match(toggle.body.error, /Tenant MFA/);
  });

  it('tenant met mfa_required uit: een gewoon lid logt zonder MFA-stap in en kan de eigen schakelaar gewoon gebruiken', async () => {
    const sysadminEmail = `${PREFIX}-tenantnomfa-admin@test.local`;
    await createSysadminUser(sysadminEmail, 'geheim1234');
    const sysadminToken = await login(sysadminEmail, 'geheim1234');

    const slug = `${PREFIX}-tenantnomfa`;
    const tenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Tenant zonder MFA' } });
    const tenantId = tenant.body.id as number;
    assert.equal(tenant.body.mfa_required, false, 'default uit');

    const memberEmail = `${PREFIX}-tenantnomfa-lid@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: memberEmail, password: 'geheim1234', role: 'gebruiker' },
    });

    const loginResult = await req('POST', '/api/auth/login', { body: { email: memberEmail, password: 'geheim1234' } });
    assert.equal(loginResult.status, 200);
    assert.equal(loginResult.body.mfaRequired, undefined);

    const toggle = await req('PUT', '/api/auth/mfa-enabled', { token: loginResult.body.token, body: { enabled: true } });
    assert.equal(toggle.status, 200);
  });
});
