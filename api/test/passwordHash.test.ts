import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startTestServer, stopTestServer, closePool, req, createUser, createSysadminUser, login, cleanupByPrefix, unique,
  registerSubscription,
} from './helpers.js';
import { pool } from '../src/db.js';
import { bcryptCost, DEFAULT_BCRYPT_COST } from '../src/passwordHash.js';

// DOEL-25 (analyse M2, OWASP A02): wachtwoordhashes gebruikten de pgcrypto-
// standaard (bcrypt-kosten 6). Nu kosten 12 (of BCRYPT_COST), en oude hashes
// worden bij een geslaagde login opnieuw gehasht.

const PREFIX = unique('bcrypt');
const COST = 8; // snel genoeg voor de suite, duidelijk boven de oude 6

async function hashOf(email: string): Promise<string> {
  return (await pool.query('select password_hash from users where email = $1', [email])).rows[0].password_hash;
}
const costOf = (hash: string) => Number(hash.slice(4, 6));

describe('bcrypt-kosten (DOEL-25)', () => {
  let sysToken = '';
  const sysEmail = `${PREFIX}-sys@test.local`;

  before(async () => {
    process.env.BCRYPT_COST = String(COST);
    await startTestServer();
    await createSysadminUser(sysEmail, 'geheim1234');
    sysToken = await login(sysEmail, 'geheim1234');
  });

  after(async () => {
    process.env.BCRYPT_COST = '4';
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('bcryptCost(): standaard 12, geldige env-waarde geldt, ongeldige/te lage/te hoge waarden vallen terug op de standaard', () => {
    const saved = process.env.BCRYPT_COST;
    try {
      delete process.env.BCRYPT_COST;
      assert.equal(bcryptCost(), 12);
      assert.equal(DEFAULT_BCRYPT_COST, 12);
      process.env.BCRYPT_COST = '10';
      assert.equal(bcryptCost(), 10);
      for (const bad of ['abc', '3', '99', '10.5', '', "6); drop table users; --"]) {
        process.env.BCRYPT_COST = bad;
        assert.equal(bcryptCost(), 12, bad);
      }
    } finally {
      process.env.BCRYPT_COST = saved;
    }
  });

  it('nieuw account via POST /api/users krijgt de geconfigureerde kosten', async () => {
    const email = `${PREFIX}-new@test.local`;
    const res = await req('POST', '/api/users', { token: sysToken, body: { email, password: 'nieuw-wachtwoord-1' } });
    assert.equal(res.status, 201);
    assert.equal(costOf(await hashOf(email)), COST);
    assert.equal((await login(email, 'nieuw-wachtwoord-1')).length > 10, true);
  });

  it('wachtwoord-reset door een sysadmin (PUT /api/users/:id) gebruikt de geconfigureerde kosten', async () => {
    const email = `${PREFIX}-reset@test.local`;
    const id = await createUser(email, 'oud-wachtwoord-1'); // helper: kosten uit env (hier 8)
    await pool.query(`update users set password_hash = crypt('oud-wachtwoord-1', gen_salt('bf', 5)) where id = $1`, [id]);
    const res = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { password: 'reset-wachtwoord-1' } });
    assert.equal(res.status, 200);
    assert.equal(costOf(await hashOf(email)), COST);
  });

  it('eigen wachtwoord wijzigen (change-password) gebruikt de geconfigureerde kosten', async () => {
    const email = `${PREFIX}-chg@test.local`;
    await createUser(email, 'oud-wachtwoord-1');
    const token = await login(email, 'oud-wachtwoord-1');
    const res = await req('POST', '/api/auth/change-password', {
      token, body: { currentPassword: 'oud-wachtwoord-1', newPassword: 'nieuw-wachtwoord-2' },
    });
    assert.equal(res.status, 200);
    assert.equal(costOf(await hashOf(email)), COST);
  });

  it('een account aangemaakt via de publieke aanvraag (verificatieflow) krijgt de geconfigureerde kosten', async () => {
    const email = `${PREFIX}-signup@test.local`;
    const tierRes = await req('POST', '/api/tiers', {
      token: sysToken, body: { name: `${PREFIX}-tier`, maxEditors: 5, maxBomen: 20, sortOrder: 0 },
    });
    assert.equal(tierRes.status, 201, JSON.stringify(tierRes.body));
    const priceRes = await req('POST', `/api/tiers/${tierRes.body.id}/prices`, {
      token: sysToken, body: { priceEur: 100, period: 'jaar', validFrom: '2020-01-01', validUntil: '2099-12-31' },
    });
    assert.equal(priceRes.status, 201, JSON.stringify(priceRes.body));
    const res = await registerSubscription({
      organizationName: `${PREFIX} org`, applicantName: 'Test', applicantEmail: email, password: 'aanvraag-wachtwoord-1',
      tierId: tierRes.body.id, moduleKeys: [], billingPeriod: 'jaar',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(costOf(await hashOf(email)), COST);
    await pool.query('delete from tenants where id = $1', [res.body.tenantId]);
  });

  it('een oude hash (kosten 6) wordt bij een geslaagde login opnieuw gehasht; het wachtwoord blijft werken', async () => {
    const email = `${PREFIX}-legacy@test.local`;
    const id = await createUser(email, 'legacy-wachtwoord-1');
    await pool.query(`update users set password_hash = crypt('legacy-wachtwoord-1', gen_salt('bf', 6)) where id = $1`, [id]);
    assert.equal(costOf(await hashOf(email)), 6);

    await login(email, 'legacy-wachtwoord-1');
    const upgraded = await hashOf(email);
    assert.equal(costOf(upgraded), COST);

    // Tweede login: hash is al goed en blijft ongewijzigd (geen herhash bij elke login).
    await login(email, 'legacy-wachtwoord-1');
    assert.equal(await hashOf(email), upgraded);
  });

  it('een MISLUKTE login herhasht niet (het wachtwoord is dan niet geverifieerd)', async () => {
    const email = `${PREFIX}-failed@test.local`;
    const id = await createUser(email, 'juist-wachtwoord-1');
    await pool.query(`update users set password_hash = crypt('juist-wachtwoord-1', gen_salt('bf', 6)) where id = $1`, [id]);
    const before = await hashOf(email);
    const res = await req('POST', '/api/auth/login', { body: { email, password: 'fout-wachtwoord-1' } });
    assert.equal(res.status, 401);
    assert.equal(await hashOf(email), before);
  });

  it('een hash met hogere kosten dan gewenst wordt niet teruggezet', async () => {
    const email = `${PREFIX}-higher@test.local`;
    const id = await createUser(email, 'hoog-wachtwoord-1');
    await pool.query(`update users set password_hash = crypt('hoog-wachtwoord-1', gen_salt('bf', 10)) where id = $1`, [id]);
    const before = await hashOf(email);
    await login(email, 'hoog-wachtwoord-1');
    assert.equal(await hashOf(email), before);
  });

  it("geen plek in api/src hasht nog met kale gen_salt('bf') (kosten 6), behalve de kortlevende MFA-codes", () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith('.ts') || name === 'mfa.ts') continue;
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (/gen_salt\('bf'\)/.test(line) && !line.trim().startsWith('//')) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, []);
  });
});
