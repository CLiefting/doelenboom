import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, createUser, createSysadminUser, login, cleanupByPrefix, unique,
  getBaseUrl, getLastMfaCode,
} from './helpers.js';
import { pool } from '../src/db.js';

// DOEL-26 (analyse M3, OWASP A07/A01): (1) na een wachtwoordwijziging of -reset
// bleven alle bestaande sessies/JWT's tot 12 uur geldig; (2) must_change_password
// werd alleen door de frontend afgedwongen.

const PREFIX = unique('sessrev');

describe('sessies na wachtwoordwijziging/-reset + must_change_password (DOEL-26)', () => {
  let sysToken = '';
  const sysEmail = `${PREFIX}-sys@test.local`;

  before(async () => {
    await startTestServer();
    await createSysadminUser(sysEmail, 'geheim1234');
    sysToken = await login(sysEmail, 'geheim1234');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('change-password beëindigt alle ANDERE sessies; de huidige sessie blijft werken', async () => {
    const email = `${PREFIX}-chg@test.local`;
    await createUser(email, 'oud-wachtwoord-1');
    const a = await login(email, 'oud-wachtwoord-1'); // bv. de gestolen/oude sessie
    const b = await login(email, 'oud-wachtwoord-1'); // de sessie die het wachtwoord wijzigt
    assert.equal((await req('GET', '/api/auth/me', { token: a })).status, 200);

    const res = await req('POST', '/api/auth/change-password', {
      token: b, body: { currentPassword: 'oud-wachtwoord-1', newPassword: 'nieuw-wachtwoord-2' },
    });
    assert.equal(res.status, 200);

    const oldSession = await req('GET', '/api/auth/me', { token: a });
    assert.equal(oldSession.status, 401);
    assert.equal(oldSession.body.reason, 'session_ended');
    assert.equal((await req('GET', '/api/auth/me', { token: b })).status, 200);
    assert.equal((await login(email, 'nieuw-wachtwoord-2')).length > 10, true);
  });

  it('een wachtwoord-reset door een sysadmin beëindigt alle sessies van dat account, niet van anderen', async () => {
    const email = `${PREFIX}-reset@test.local`;
    const other = `${PREFIX}-other@test.local`;
    const id = await createUser(email, 'oud-wachtwoord-1');
    await createUser(other, 'oud-wachtwoord-1');
    const t1 = await login(email, 'oud-wachtwoord-1');
    const t2 = await login(email, 'oud-wachtwoord-1');
    const otherToken = await login(other, 'oud-wachtwoord-1');

    const res = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { password: 'reset-wachtwoord-1' } });
    assert.equal(res.status, 200);

    for (const t of [t1, t2]) {
      const r = await req('GET', '/api/auth/me', { token: t });
      assert.equal(r.status, 401);
      assert.equal(r.body.reason, 'session_ended');
    }
    assert.equal((await req('GET', '/api/auth/me', { token: otherToken })).status, 200);
    assert.equal((await req('GET', '/api/auth/me', { token: sysToken })).status, 200);
  });

  it('een sysadmin die zijn EIGEN wachtwoord zet via PUT /api/users/:id blijft ingelogd', async () => {
    const email = `${PREFIX}-selfreset@test.local`;
    const id = await createSysadminUser(email, 'oud-wachtwoord-1');
    const own = await login(email, 'oud-wachtwoord-1');
    const res = await req('PUT', `/api/users/${id}`, { token: own, body: { password: 'nieuw-wachtwoord-3', mustChangePassword: false } });
    assert.equal(res.status, 200);
    assert.equal((await req('GET', '/api/auth/me', { token: own })).status, 200);
  });

  it('een PUT zonder wachtwoord (bv. alleen e-mail/mfa) beëindigt geen sessies', async () => {
    const email = `${PREFIX}-nopw@test.local`;
    const id = await createUser(email, 'oud-wachtwoord-1');
    const t = await login(email, 'oud-wachtwoord-1');
    const res = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { mfaEnabled: false } });
    assert.equal(res.status, 200);
    assert.equal((await req('GET', '/api/auth/me', { token: t })).status, 200);
  });

  it('een openstaande MFA-challenge (inlogpoging met het oude wachtwoord) is na een reset onbruikbaar', async () => {
    const email = `${PREFIX}-mfa@test.local`;
    const id = await createUser(email, 'oud-wachtwoord-1');
    await pool.query('update users set mfa_enabled = true where id = $1', [id]);
    const first = await req('POST', '/api/auth/login', { body: { email, password: 'oud-wachtwoord-1' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.mfaRequired, true);
    const code = getLastMfaCode(email)!;
    assert.ok(code);

    const reset = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { password: 'reset-wachtwoord-2' } });
    assert.equal(reset.status, 200);

    const verify = await req('POST', '/api/auth/mfa/verify', { body: { challengeId: first.body.challengeId, code } });
    assert.ok(verify.status >= 400, `challenge was nog bruikbaar: ${verify.status}`);
    assert.equal(verify.body.token, undefined);
  });

  describe('must_change_password wordt server-side afgedwongen', () => {
    const email = `${PREFIX}-must@test.local`;
    let token = '';

    before(async () => {
      const created = await req('POST', '/api/users', { token: sysToken, body: { email, password: 'tijdelijk-1234' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.must_change_password, true);
      token = await login(email, 'tijdelijk-1234', { keepMustChange: true });
    });

    it('gewone API-routes geven 403 must_change_password, ook al is het token geldig', async () => {
      for (const p of ['/api/doelenbomen', '/api/tenants', '/api/subscription-requests/pending-count']) {
        const r = await req('GET', p, { token });
        assert.equal(r.status, 403, p);
        assert.equal(r.body.reason, 'must_change_password', p);
      }
      const post = await req('POST', '/api/auth/mfa-enabled', { token, body: {} });
      assert.equal(post.status, 403);
    });

    it('een sysadmin met een tijdelijk wachtwoord komt evenmin bij sysadmin-routes', async () => {
      const sEmail = `${PREFIX}-mustsys@test.local`;
      const id = await createSysadminUser(sEmail, 'tijdelijk-1234');
      await pool.query('update users set must_change_password = true where id = $1', [id]);
      const t = await login(sEmail, 'tijdelijk-1234', { keepMustChange: true });
      const r = await req('GET', '/api/users', { token: t });
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, 'must_change_password');
    });

    it('de routes die nodig zijn om het wachtwoord te wijzigen/uit te loggen blijven bereikbaar (ook met query string en slash)', async () => {
      assert.equal((await req('GET', '/api/auth/me', { token })).status, 200);
      assert.equal((await req('GET', '/api/auth/me?x=1', { token })).status, 200);
      assert.equal((await req('GET', '/api/auth/me/', { token })).status, 200);
      assert.equal((await req('POST', '/api/auth/activity', { token }).catch(() => ({ status: 204 }))).status, 204);
      const res = await fetch(`${getBaseUrl()}/api/auth/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 204);
      assert.equal((await req('GET', '/api/auth/logout-preview', { token })).status, 200);
    });

    it('padvarianten omzeilen de blokkade niet (hoofdletters, dubbele slash, punt-segmenten)', async () => {
      for (const p of ['/API/DOELENBOMEN', '/api/doelenbomen/', '/api//doelenbomen', '/api/auth/../doelenbomen']) {
        const res = await fetch(`${getBaseUrl()}${p}`, { headers: { Authorization: `Bearer ${token}` } });
        assert.notEqual(res.status, 200, p);
      }
    });

    it('na change-password werkt hetzelfde token weer overal (de vlag wordt live gecontroleerd)', async () => {
      const change = await req('POST', '/api/auth/change-password', {
        token, body: { currentPassword: 'tijdelijk-1234', newPassword: 'eigen-wachtwoord-1' },
      });
      assert.equal(change.status, 200);
      const r = await req('GET', '/api/doelenbomen', { token });
      assert.equal(r.status, 200);
    });
  });
});
