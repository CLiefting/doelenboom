import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, closePool, getBaseUrl, req, unique } from './helpers.js';
import { registrationRateLimitGlobal, registrationRateLimitPerIp } from '../src/routes/subscriptions.js';
import { createRateLimiter } from '../src/rateLimit.js';

// DOEL-20 (analyse H1): de publieke, ongeauthenticeerde aanvraagroute maakt
// direct tenant + account aan en mailt de beheerder — die moet begrensd zijn.
//
// TRUST_PROXY_HOPS=1: in de test staat er één "proxy" vóór de app, zodat we
// via X-Forwarded-For verschillende client-IP's kunnen simuleren (in productie
// is dit 2: Traefik + nginx, zie docker-compose.prod.yml).
process.env.TRUST_PROXY_HOPS = '1';

async function post(xff: string, body: unknown = {}): Promise<Response> {
  return fetch(`${getBaseUrl()}/api/subscription-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify(body),
  });
}

describe('publieke aanvraagroute: rate limiting (DOEL-20)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    delete process.env.REGISTRATION_RATE_LIMIT_MAX;
    delete process.env.REGISTRATION_GLOBAL_LIMIT_MAX;
    await stopTestServer();
    await closePool();
  });

  beforeEach(() => {
    registrationRateLimitPerIp.reset();
    registrationRateLimitGlobal.reset();
    process.env.REGISTRATION_RATE_LIMIT_MAX = '3';
    process.env.REGISTRATION_GLOBAL_LIMIT_MAX = '1000';
  });

  it('per IP: de 4e aanvraag binnen het uur krijgt 429 met Retry-After en een nette JSON-melding', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await post('203.0.113.10');
      assert.equal(res.status, 400, `aanvraag ${i + 1} hoort gewoon door de validatie te komen`);
    }
    const blocked = await post('203.0.113.10');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal(blocked.headers.get('ratelimit-remaining'), '0');
    const body = await blocked.json();
    assert.match(body.error, /te veel aanvragen/i);
  });

  it('een ander IP heeft een eigen teller', async () => {
    for (let i = 0; i < 4; i += 1) await post('203.0.113.20');
    assert.equal((await post('203.0.113.20')).status, 429);
    assert.equal((await post('203.0.113.21')).status, 400);
  });

  it('een client kan de limiet niet omzeilen door voorloop-entries in X-Forwarded-For te variëren', async () => {
    // Met 1 vertrouwde proxy telt alleen de LAATSTE entry (door de proxy zelf gezet).
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post(`198.51.100.${i + 1}, 203.0.113.30`)).status, 400);
    }
    assert.equal((await post('198.51.100.99, 203.0.113.30')).status, 429);
  });

  it('globaal vangnet: na REGISTRATION_GLOBAL_LIMIT_MAX aanvragen (ongeacht IP) krijgt iedereen 429', async () => {
    process.env.REGISTRATION_RATE_LIMIT_MAX = '1000';
    process.env.REGISTRATION_GLOBAL_LIMIT_MAX = '4';
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await post(`192.0.2.${i + 1}`)).status, 400);
    }
    const blocked = await post('192.0.2.200');
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /tijdelijk niet mogelijk/i);
  });

  it('geblokkeerde aanvragen maken geen tenant of account aan', async () => {
    const before = await req('GET', '/api/subscription-tiers');
    assert.equal(before.status, 200);
    for (let i = 0; i < 3; i += 1) await post('203.0.113.40');
    const email = `${unique('ratelimit')}@example.com`;
    const blocked = await post('203.0.113.40', {
      organizationName: 'Org', applicantName: 'Naam', applicantEmail: email, password: 'wachtwoord123',
      tierId: 1, billingPeriod: 'jaar',
    });
    assert.equal(blocked.status, 429);
    const { pool } = await import('../src/db.js');
    const users = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(users.rows.length, 0);
  });

  it('bovengrenzen op invoer: weigert te lange organisatienaam/naam/e-mail/telefoon/wachtwoord en te veel modules met 400', async () => {
    process.env.REGISTRATION_RATE_LIMIT_MAX = '1000';
    const valid = {
      organizationName: 'Org', applicantName: 'Naam', applicantEmail: 'iemand@example.com',
      password: 'wachtwoord123', tierId: 1, billingPeriod: 'jaar', moduleKeys: [] as string[],
    };
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['organizationName', { organizationName: 'x'.repeat(201) }, /Organisatienaam/],
      ['applicantName', { applicantName: 'x'.repeat(201) }, /Naam mag/],
      ['applicantEmail', { applicantEmail: `${'x'.repeat(250)}@example.com` }, /E-mailadres mag/],
      ['applicantPhone', { applicantPhone: '1'.repeat(51) }, /Telefoonnummer/],
      ['password', { password: 'x'.repeat(73) }, /Wachtwoord mag/],
      ['moduleKeys', { moduleKeys: Array.from({ length: 51 }, (_, i) => `m${i}`) }, /Te veel modules/],
    ];
    for (const [name, override, message] of cases) {
      const res = await req('POST', '/api/subscription-requests', { body: { ...valid, ...override } });
      assert.equal(res.status, 400, name);
      assert.match(res.body.error, message, name);
    }
  });
  it('andere publieke routes worden niet door de aanvraag-limiet geraakt', async () => {
    for (let i = 0; i < 4; i += 1) await post('203.0.113.50');
    assert.equal((await post('203.0.113.50')).status, 429);
    const tiers = await fetch(`${getBaseUrl()}/api/subscription-tiers`, { headers: { 'X-Forwarded-For': '203.0.113.50' } });
    assert.equal(tiers.status, 200);
  });
});

describe('createRateLimiter (unit)', () => {
  it('opent na afloop van het venster weer', async () => {
    const limiter = createRateLimiter({ windowMs: () => 50, max: () => 1, key: () => 'k', message: 'x' });
    const run = () => {
      let status = 200;
      const res: any = { setHeader() {}, status(s: number) { status = s; return this; }, json() { return this; } };
      limiter({ ip: '1.1.1.1' } as any, res, () => {});
      return status;
    };
    assert.equal(run(), 200);
    assert.equal(run(), 429);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(run(), 200);
  });
});
