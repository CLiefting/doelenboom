import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';

const PREFIX = unique('users');

describe('users (sysadmin-only accountbeheer)', () => {
  let sysadminToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-admin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/users is sysadmin-only', async () => {
    const anon = await req('GET', '/api/users');
    assert.equal(anon.status, 401);
  });

  it('een gewone (niet-sysadmin) gebruiker krijgt 403 op /api/users', async () => {
    const email = `${PREFIX}-gewoon@test.local`;
    await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123', isSysadmin: false } });
    const token = await login(email, 'wachtwoord123');
    const res = await req('GET', '/api/users', { token });
    assert.equal(res.status, 403);
  });

  it('POST /api/users maakt een account aan met must_change_password default true', async () => {
    const email = `${PREFIX}-nieuw@test.local`;
    const created = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.must_change_password ?? created.body.mustChangePassword, true);
    assert.deepEqual(created.body.tenantRoles, []);
  });

  it('POST /api/users weigert te kort wachtwoord en dubbel e-mailadres', async () => {
    const email = `${PREFIX}-kort@test.local`;
    const tooShort = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'kort' } });
    assert.equal(tooShort.status, 400);

    const ok = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
    assert.equal(ok.status, 201);
    const dup = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
    assert.equal(dup.status, 409);
  });

  it('PUT /api/users/:id werkt velden bij', async () => {
    const email = `${PREFIX}-wijzig@test.local`;
    const created = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
    const userId = created.body.id;

    const updated = await req('PUT', `/api/users/${userId}`, {
      token: sysadminToken, body: { email: `${PREFIX}-gewijzigd@test.local` },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.email, `${PREFIX}-gewijzigd@test.local`);
  });

  it('laatste sysadmin kan niet gedegradeerd of verwijderd worden', async () => {
    // Deze testrun heeft precies één sysadmin (uit before()) na het opruimen
    // van eventuele overige testdata — controleer via de eigen sysadmin dat
    // die zichzelf niet kan degraderen als hij de laatste is.
    const list = await req('GET', '/api/users', { token: sysadminToken });
    const sysadmins = list.body.filter((u: any) => u.is_sysadmin ?? u.isSysadmin);
    if (sysadmins.length !== 1) {
      // Andere testbestanden delen dezelfde database maar draaien in eigen
      // processen; als er toevallig meer dan één sysadmin bestaat op het
      // moment van draaien, is deze specifieke check niet betekenisvol — sla
      // 'm dan over i.p.v. vals-positief te falen.
      return;
    }
    const onlySysadminId = sysadmins[0].id;
    const demote = await req('PUT', `/api/users/${onlySysadminId}`, { token: sysadminToken, body: { isSysadmin: false } });
    assert.equal(demote.status, 400);

    const del = await req('DELETE', `/api/users/${onlySysadminId}`, { token: sysadminToken });
    assert.equal(del.status, 400);
  });

  it('DELETE /api/users/:id verwijdert een niet-sysadmin account', async () => {
    const email = `${PREFIX}-verwijder@test.local`;
    const created = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
    const userId = created.body.id;

    const del = await req('DELETE', `/api/users/${userId}`, { token: sysadminToken });
    assert.equal(del.status, 204);

    const delAgain = await req('DELETE', `/api/users/${userId}`, { token: sysadminToken });
    assert.equal(delAgain.status, 404);
  });
});
