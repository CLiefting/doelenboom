import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, closePool, createUser, cleanupByPrefix, unique, getBaseUrl } from './helpers.js';
import { pool } from '../src/db.js';
import { resetLoginThrottle } from '../src/loginThrottle.js';

// DOEL-24 (analyse M1, OWASP A07): login-lockout was te omzeilen met
// parallelle requests (read-check-write op failed_login_count), verraadde
// via de 429 dat een account bestaat, en had geen per-IP-beperking.
//
// TRUST_PROXY_HOPS=1: via X-Forwarded-For simuleren we verschillende client-IP's.
process.env.TRUST_PROXY_HOPS = '1';

const PREFIX = unique('loginhard');
const OK_PASSWORD = 'juist-wachtwoord-1';

async function login(email: unknown, password: unknown, ip = '198.51.100.1'): Promise<{ status: number; body: any; retryAfter: string | null }> {
  const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, retryAfter: res.headers.get('retry-after') };
}

async function setLockout(max: number, minutes = 15) {
  await pool.query('update app_settings set max_failed_login_attempts = $1, login_lockout_minutes = $2 where id = 1', [max, minutes]);
}

describe('login: lockout-hardening (DOEL-24)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await pool.query('update app_settings set max_failed_login_attempts = 5, login_lockout_minutes = 15 where id = 1');
    delete process.env.LOGIN_IP_MAX_FAILURES;
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  beforeEach(async () => {
    resetLoginThrottle();
    process.env.LOGIN_IP_MAX_FAILURES = '100000';
    await setLockout(5);
  });

  it('een burst van 40 PARALLELLE foute pogingen geeft maximaal (drempel - 1) keer 401; de rest wordt geblokkeerd', async () => {
    const email = `${PREFIX}-burst@test.local`;
    await createUser(email, OK_PASSWORD);
    const results = await Promise.all(Array.from({ length: 40 }, () => login(email, 'fout')));
    const wrong = results.filter((r) => r.status === 401).length;
    const locked = results.filter((r) => r.status === 429).length;
    assert.ok(wrong <= 4, `${wrong} pogingen kregen 401 — de drempel (5) is omzeild`);
    assert.equal(wrong + locked, 40);
    const row = await pool.query('select locked_until from users where email = $1', [email]);
    assert.ok(row.rows[0].locked_until, 'account had geblokkeerd moeten zijn');
    // Ook het juiste wachtwoord komt er nu niet meer in.
    assert.equal((await login(email, OK_PASSWORD)).status, 429);
  });

  it('bij een burst wordt na de blokkade geen wachtwoord meer gecontroleerd: een gelijktijdige juiste poging kan er hoogstens binnen de eerste (drempel) pogingen doorheen', async () => {
    const email = `${PREFIX}-burst2@test.local`;
    await createUser(email, OK_PASSWORD);
    const tries = [...Array.from({ length: 30 }, () => 'fout'), OK_PASSWORD];
    const results = await Promise.all(tries.map((p) => login(email, p)));
    const okCount = results.filter((r) => r.status === 200).length;
    assert.ok(okCount <= 1);
    // Het aantal echt beoordeelde pogingen (200 of 401, of de vergrendelende 429) is begrensd.
    assert.ok(results.filter((r) => r.status === 401 || r.status === 200).length <= 5);
  });

  it('een juist wachtwoord op de poging die de drempel zou bereiken, slaagt (na 4 foute)', async () => {
    const email = `${PREFIX}-vijfde@test.local`;
    await createUser(email, OK_PASSWORD);
    for (let i = 0; i < 4; i += 1) assert.equal((await login(email, 'fout')).status, 401);
    assert.equal((await login(email, OK_PASSWORD)).status, 200);
    const row = await pool.query('select failed_login_count, locked_until from users where email = $1', [email]);
    assert.equal(row.rows[0].failed_login_count, 0);
    assert.equal(row.rows[0].locked_until, null);
  });

  it('een onbekend adres gedraagt zich exact als een bestaand account (geen account-enumeratie via 429)', async () => {
    await setLockout(3);
    const known = `${PREFIX}-enum-known@test.local`;
    const unknown = `${PREFIX}-enum-unknown@test.local`;
    await createUser(known, OK_PASSWORD);
    const seqKnown: Array<[number, string | undefined]> = [];
    const seqUnknown: Array<[number, string | undefined]> = [];
    for (let i = 0; i < 4; i += 1) {
      const a = await login(known, 'fout');
      const b = await login(unknown, 'fout');
      seqKnown.push([a.status, a.body.reason]);
      seqUnknown.push([b.status, b.body.reason]);
      if (i >= 2) assert.equal(a.body.error.replace(/\d+/g, 'N'), b.body.error.replace(/\d+/g, 'N'));
    }
    assert.deepEqual(seqUnknown, seqKnown);
    assert.deepEqual(seqKnown.map((s) => s[0]), [401, 401, 429, 429]);
  });

  it('onbekende adressen worden hoofdletterongevoelig geteld', async () => {
    await setLockout(2);
    assert.equal((await login(`${PREFIX}-CASE@test.local`, 'x')).status, 401);
    assert.equal((await login(`${PREFIX}-case@test.local`, 'x')).status, 429);
  });

  it('per IP: na te veel mislukte pogingen (over verschillende adressen) geeft ook een juiste poging 429 met Retry-After; een ander IP is niet geraakt', async () => {
    process.env.LOGIN_IP_MAX_FAILURES = '4';
    const email = `${PREFIX}-ip@test.local`;
    await createUser(email, OK_PASSWORD);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await login(`${PREFIX}-ghost-${i}@test.local`, 'fout', '203.0.113.50')).status, 401);
    }
    const blocked = await login(email, OK_PASSWORD, '203.0.113.50');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.reason, 'too_many_attempts_ip');
    assert.ok(Number(blocked.retryAfter) > 0);
    assert.equal((await login(email, OK_PASSWORD, '203.0.113.51')).status, 200);
  });

  it('een geslaagde login telt niet mee voor de IP-teller', async () => {
    process.env.LOGIN_IP_MAX_FAILURES = '2';
    const email = `${PREFIX}-ipok@test.local`;
    await createUser(email, OK_PASSWORD);
    for (let i = 0; i < 6; i += 1) assert.equal((await login(email, OK_PASSWORD, '203.0.113.60')).status, 200);
  });

  it('e-mail/wachtwoord die geen string zijn worden geweigerd (400), ook NoSQL-achtige objecten', async () => {
    for (const [e, p] of [[{ $ne: 1 }, 'x'], ['a@b.nl', { $ne: 1 }], [['a@b.nl'], 'x'], ['a@b.nl', ['x']], ['a'.repeat(400) + '@b.nl', 'x'], ['a@b.nl', 'p'.repeat(2000)]] as unknown[][]) {
      const res = await login(e, p);
      assert.equal(res.status, 400, JSON.stringify([e, p]).slice(0, 60));
    }
  });
});
