import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('sessdb');

describe('sessions + dbstat (sysadmin-only diagnostiek)', () => {
  let sysadminToken: string;
  let gebruikerToken: string;

  before(async () => {
    await startTestServer();
    const sysadminEmail = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');

    const gebruikerEmail = `${PREFIX}-gebruiker@test.local`;
    await createSysadminUser(gebruikerEmail, 'wachtwoord123'); // eenvoudigst: los account, alleen voor de 403-check hieronder
    // Zet 'm expliciet terug naar niet-sysadmin (createSysadminUser is hier alleen
    // gebruikt als generieke "los account aanmaken"-helper).
    await pool.query('update users set is_sysadmin = false where email = $1', [gebruikerEmail]);
    gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/sessions is sysadmin-only en toont deze sessie', async () => {
    const asGebruiker = await req('GET', '/api/sessions', { token: gebruikerToken });
    assert.equal(asGebruiker.status, 403);

    const asSysadmin = await req('GET', '/api/sessions', { token: sysadminToken });
    assert.equal(asSysadmin.status, 200);
    assert.ok(Array.isArray(asSysadmin.body));
    assert.ok(asSysadmin.body.some((s: any) => s.email === `${PREFIX}-sysadmin@test.local`));
  });

  it('GET /api/dbstat is sysadmin-only en groepeert per tenant', async () => {
    const asGebruiker = await req('GET', '/api/dbstat', { token: gebruikerToken });
    assert.equal(asGebruiker.status, 403);

    const asSysadmin = await req('GET', '/api/dbstat', { token: sysadminToken });
    assert.equal(asSysadmin.status, 200);
    assert.ok(Array.isArray(asSysadmin.body));
  });
});
