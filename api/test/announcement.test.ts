import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('announce');

// Systeembrede mededeling (bv. onderhoudsaankondiging) — zie
// api/src/routes/announcement.ts en db/init.sql system_announcements.
describe('systeemmelding (onderhoud)', () => {
  let sysadminToken: string;
  let gebruikerToken: string;

  before(async () => {
    await startTestServer();
    const sysadminEmail = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');

    const gebruikerEmail = `${PREFIX}-gebruiker@test.local`;
    await createSysadminUser(gebruikerEmail, 'wachtwoord123');
    await pool.query('update users set is_sysadmin = false where email = $1', [gebruikerEmail]);
    gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    // Deze singleton-rij wordt door tests in ANDERE bestanden mogelijk ook
    // geraakt (het is systeembreed, niet per-prefix) — begin dus expliciet
    // met een schone, inactieve staat i.p.v. aan te nemen dat 'ie leeg is.
    await req('PUT', '/api/announcement', { token: sysadminToken, body: { message: '', active: false } });
  });

  after(async () => {
    // Nette staat achterlaten voor eventuele volgende testruns/handmatig gebruik.
    await req('PUT', '/api/announcement', { token: sysadminToken, body: { message: '', active: false } });
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/announcement werkt zonder token (ook zichtbaar vóór inloggen)', async () => {
    const res = await req('GET', '/api/announcement');
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);
    assert.equal(res.body.message, '');
  });

  it('PUT /api/announcement is sysadmin-only', async () => {
    const asGebruiker = await req('PUT', '/api/announcement', {
      token: gebruikerToken, body: { message: 'Onderhoud gepland', active: true },
    });
    assert.equal(asGebruiker.status, 403);

    const noToken = await req('PUT', '/api/announcement', { body: { message: 'x', active: true } });
    assert.equal(noToken.status, 401);
  });

  it('sysadmin kan de mededeling aanzetten met tekst, en die verschijnt meteen bij GET (ook ongeauthenticeerd)', async () => {
    const message = 'Onderhoud is gepland op 1 september 20:00. Log voor die tijd uit.';
    const put = await req('PUT', '/api/announcement', { token: sysadminToken, body: { message, active: true } });
    assert.equal(put.status, 200);
    assert.equal(put.body.active, true);
    assert.equal(put.body.message, message);

    const get = await req('GET', '/api/announcement');
    assert.equal(get.status, 200);
    assert.equal(get.body.active, true);
    assert.equal(get.body.message, message);
  });

  it('active=true zonder tekst wordt geweigerd; uitzetten mag altijd', async () => {
    const emptyActive = await req('PUT', '/api/announcement', {
      token: sysadminToken, body: { message: '', active: true },
    });
    assert.equal(emptyActive.status, 400);

    const setFirst = await req('PUT', '/api/announcement', {
      token: sysadminToken, body: { message: 'Even iets', active: true },
    });
    assert.equal(setFirst.status, 200);

    const turnOff = await req('PUT', '/api/announcement', {
      token: sysadminToken, body: { message: 'Even iets', active: false },
    });
    assert.equal(turnOff.status, 200);
    assert.equal(turnOff.body.active, false);

    const get = await req('GET', '/api/announcement');
    assert.equal(get.body.active, false);
  });
});
