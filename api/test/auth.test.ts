import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';

const PREFIX = unique('auth');

describe('auth', () => {
  let sysadminEmail: string;

  before(async () => {
    await startTestServer();
    sysadminEmail = `${PREFIX}-admin@test.local`;
    await createSysadminUser(sysadminEmail, 'geheim1234');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('POST /api/auth/login weigert onbekend e-mailadres', async () => {
    const { status, body } = await req('POST', '/api/auth/login', {
      body: { email: 'niet-bestaand@test.local', password: 'watdanook' },
    });
    assert.equal(status, 401);
    assert.match(body.error, /Onjuiste inloggegevens/);
  });

  it('POST /api/auth/login weigert verkeerd wachtwoord', async () => {
    const { status } = await req('POST', '/api/auth/login', {
      body: { email: sysadminEmail, password: 'fout-wachtwoord' },
    });
    assert.equal(status, 401);
  });

  it('POST /api/auth/login geeft 400 zonder e-mail/wachtwoord', async () => {
    const { status } = await req('POST', '/api/auth/login', { body: {} });
    assert.equal(status, 400);
  });

  it('POST /api/auth/login geeft een token + user terug bij juiste gegevens', async () => {
    const { status, body } = await req('POST', '/api/auth/login', {
      body: { email: sysadminEmail, password: 'geheim1234' },
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.user.email, sysadminEmail);
    assert.equal(body.user.isSysadmin, true);
  });

  it('GET /api/auth/me vereist een geldig token', async () => {
    const noToken = await req('GET', '/api/auth/me');
    assert.equal(noToken.status, 401);

    const badToken = await req('GET', '/api/auth/me', { token: 'onzin.token.hier' });
    assert.equal(badToken.status, 401);

    const token = await login(sysadminEmail, 'geheim1234');
    const ok = await req('GET', '/api/auth/me', { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, sysadminEmail);
  });

  it('POST /api/auth/change-password wijzigt het wachtwoord en logt daarna in met het nieuwe', async () => {
    const email = `${PREFIX}-cp@test.local`;
    await createSysadminUser(email, 'oud-wachtwoord1');
    const token = await login(email, 'oud-wachtwoord1');

    const wrongCurrent = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'niet-het-huidige', newPassword: 'nieuw-wachtwoord1' },
    });
    assert.equal(wrongCurrent.status, 401);

    const tooShort = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'oud-wachtwoord1', newPassword: 'kort' },
    });
    assert.equal(tooShort.status, 400);

    const ok = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'oud-wachtwoord1', newPassword: 'nieuw-wachtwoord1' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.mustChangePassword, false);

    const newLogin = await req('POST', '/api/auth/login', { body: { email, password: 'nieuw-wachtwoord1' } });
    assert.equal(newLogin.status, 200);
    const oldLogin = await req('POST', '/api/auth/login', { body: { email, password: 'oud-wachtwoord1' } });
    assert.equal(oldLogin.status, 401);
  });

  it('POST /api/auth/heartbeat werkt de sessie bij (204, geen body)', async () => {
    const token = await login(sysadminEmail, 'geheim1234');
    const res = await req('POST', '/api/auth/heartbeat', { token });
    assert.equal(res.status, 204);
  });

  it('logout-preview en logout werken voor een ingelogde gebruiker zonder tenants', async () => {
    const email = `${PREFIX}-logout@test.local`;
    await createSysadminUser(email, 'logout-wachtwoord1');
    const token = await login(email, 'logout-wachtwoord1');

    const preview = await req('GET', '/api/auth/logout-preview', { token });
    assert.equal(preview.status, 200);
    assert.ok(Array.isArray(preview.body.wouldWipe));

    const out = await req('POST', '/api/auth/logout', { token });
    assert.equal(out.status, 200);
    assert.ok(Array.isArray(out.body.wiped));
  });
});
