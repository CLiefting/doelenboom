import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, createUser, login,
  cleanupByPrefix, getRegistrationToken, registrationMailCounts,
} from './helpers.js';
import { pool } from '../src/db.js';
import { sweepPendingRegistrations } from '../src/pendingRegistrations.js';

// DOEL-20 (analyse H1): een aanvraag maakt pas een tenant + account aan nadat
// de aanvrager het e-mailadres via de mail bevestigd heeft.

const PREFIX = unique('regver');

describe('publieke aanvraag: e-mailverificatie (DOEL-20)', () => {
  let sysadminToken = '';
  let tierId = 0;
  let n = 0;

  const newEmail = () => `${PREFIX}-${++n}@test.local`;
  const body = (email: string, extra: Record<string, unknown> = {}) => ({
    organizationName: `${PREFIX} Org ${n}`, applicantName: 'Aanvrager', applicantEmail: email,
    password: 'wachtwoord123', tierId, moduleKeys: [], billingPeriod: 'jaar', ...extra,
  });
  const submit = (email: string, extra: Record<string, unknown> = {}) =>
    req('POST', '/api/subscription-requests', { body: body(email, extra) });
  const confirm = (token: string | undefined) => req('POST', '/api/subscription-requests/confirm', { body: { token } });
  const countRows = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows.length;

  before(async () => {
    await startTestServer();
    await createSysadminUser(`${PREFIX}-sys@test.local`, 'wachtwoord123');
    sysadminToken = await login(`${PREFIX}-sys@test.local`, 'wachtwoord123');
    const t = await req('POST', '/api/tiers', {
      token: sysadminToken, body: { name: `${PREFIX}-tier`, maxEditors: 5, maxBomen: 20, sortOrder: 0 },
    });
    assert.equal(t.status, 201);
    tierId = t.body.id;
    const d = (x: number) => new Date(Date.now() + x * 86400000).toISOString().slice(0, 10);
    const p = await req('POST', `/api/tiers/${tierId}/prices`, {
      token: sysadminToken, body: { priceEur: 500, period: 'jaar', validFrom: d(-30), validUntil: d(30) },
    });
    assert.equal(p.status, 201);
  });

  after(async () => {
    delete process.env.REGISTRATION_CONFIRM_RATE_LIMIT_MAX;
    await pool.query('delete from pending_registrations where email like $1', [`${PREFIX}%`]);
    await pool.query('delete from subscription_requests where applicant_email like $1', [`${PREFIX}%`]);
    await pool.query('delete from tenants where name like $1', [`${PREFIX}%`]);
    await cleanupByPrefix(PREFIX);
    await pool.query('delete from tiers where name like $1', [`${PREFIX}%`]);
    await stopTestServer();
    await closePool();
  });

  it('indienen geeft 202 en maakt nog GEEN tenant, account of aanvraag aan; er gaat een verificatielink uit', async () => {
    const email = newEmail();
    const res = await submit(email);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { status: 'bevestiging-verzonden' });

    assert.equal(await countRows('select 1 from users where email = $1', [email]), 0);
    assert.equal(await countRows('select 1 from subscription_requests where applicant_email = $1', [email]), 0);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [email]), 1);

    const token = getRegistrationToken(email);
    assert.ok(token && token.length >= 40, 'geen (voldoende lang) token in de opgevangen mail');
    assert.equal(registrationMailCounts(email).verification, 1);
    await assert.rejects(() => login(email, 'wachtwoord123'), /Login mislukt/);
  });

  it('het token en het wachtwoord staan niet leesbaar in de database', async () => {
    const email = newEmail();
    await submit(email);
    const token = getRegistrationToken(email)!;
    const row = (await pool.query('select token_hash, payload::text as payload from pending_registrations where email = $1', [email])).rows[0];
    assert.notEqual(row.token_hash, token);
    assert.ok(!row.payload.includes(token));
    assert.ok(!row.payload.includes('wachtwoord123'), 'wachtwoord staat leesbaar in de payload');
    assert.match(JSON.parse(row.payload).passwordHash, /^\$2[abxy]\$/);
  });

  it('bevestigen maakt tenant + account + aanvraag aan; het gekozen wachtwoord werkt', async () => {
    const email = newEmail();
    await submit(email);
    const res = await confirm(getRegistrationToken(email));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.tenantId && res.body.requestId && res.body.tenantSlug);
    const userToken = await login(email, 'wachtwoord123');
    assert.equal((await req('GET', '/api/doelenbomen', { token: userToken })).status, 200);
    assert.equal(await countRows('select 1 from subscription_requests where applicant_email = $1', [email]), 1);
  });

  it('een link is eenmalig bruikbaar', async () => {
    const email = newEmail();
    await submit(email);
    const token = getRegistrationToken(email);
    assert.equal((await confirm(token)).status, 201);
    const again = await confirm(token);
    assert.equal(again.status, 400);
    assert.match(again.body.error, /ongeldig of verlopen/);
    assert.equal(await countRows('select 1 from tenants where name = $1', [`${PREFIX} Org ${n}`]), 1);
  });

  it('twee gelijktijdige bevestigingen maken precies één tenant aan', async () => {
    const email = newEmail();
    await submit(email);
    const token = getRegistrationToken(email);
    const results = await Promise.all([confirm(token), confirm(token), confirm(token)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400, 400]);
    assert.equal(await countRows('select 1 from subscription_requests where applicant_email = $1', [email]), 1);
  });

  it('een verlopen link (>24 uur) werkt niet meer', async () => {
    const email = newEmail();
    await submit(email);
    await pool.query(`update pending_registrations set expires_at = now() - interval '1 minute' where email = $1`, [email]);
    assert.equal((await confirm(getRegistrationToken(email))).status, 400);
    assert.equal(await countRows('select 1 from users where email = $1', [email]), 0);
  });

  it('onzin-, ontbrekende en te korte tokens geven 400', async () => {
    for (const token of [undefined, '', 'abc', 'x'.repeat(43), 'y'.repeat(500), { $ne: 1 }, 123] as unknown[]) {
      const res = await req('POST', '/api/subscription-requests/confirm', { body: { token } });
      assert.equal(res.status, 400, JSON.stringify(token));
    }
    const noBody = await req('POST', '/api/subscription-requests/confirm', {});
    assert.equal(noBody.status, 400);
  });

  it('een nieuwe aanvraag voor hetzelfde adres maakt het eerdere token ongeldig', async () => {
    const email = newEmail();
    await submit(email);
    const first = getRegistrationToken(email);
    await submit(email);
    const second = getRegistrationToken(email);
    assert.notEqual(first, second);
    assert.equal((await confirm(first)).status, 400);
    assert.equal((await confirm(second)).status, 201);
  });

  it('bestaand adres: identieke respons als bij een nieuw adres, geen link, wel een "account bestaat al"-mail (geen enumeratie)', async () => {
    const existing = newEmail();
    await createUser(existing, 'wachtwoord123');
    const fresh = newEmail();
    const a = await submit(existing);
    const b = await submit(fresh);
    assert.equal(a.status, b.status);
    assert.deepEqual(a.body, b.body);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [existing]), 0);
    assert.equal(registrationMailCounts(existing).verification, 0);
    assert.equal(registrationMailCounts(existing).existingAccount, 1);
    assert.equal(getRegistrationToken(existing), undefined);
  });

  it('per e-mailadres maximaal 3 verificatiemails per uur; de respons blijft gelijk en het laatst verstuurde token blijft geldig', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i += 1) assert.equal((await submit(email)).status, 202);
    assert.equal(registrationMailCounts(email).verification, 3);
    // 3 rijen zijn aangemaakt (de 4e/5e aanvraag maken niets aan); elke nieuwe
    // maakte de vorige ongeldig, dus er is er maar 1 nog actief.
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [email]), 3);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1 and consumed_at is null', [email]), 1);
    assert.equal((await confirm(getRegistrationToken(email))).status, 201);
  });

  it('validatiefouten (onbekende tier) blijven een directe 400 en laten niets achter', async () => {
    const email = newEmail();
    const res = await submit(email, { tierId: 999999999 });
    assert.equal(res.status, 400);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [email]), 0);
    assert.equal(registrationMailCounts(email).verification, 0);
  });

  it('is het adres tussen indienen en bevestigen elders geregistreerd, dan geeft bevestigen 400 en blijft het bestaande account onaangeroerd', async () => {
    const email = newEmail();
    await submit(email);
    await createUser(email, 'ander-wachtwoord-1');
    const res = await confirm(getRegistrationToken(email));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /bestaat al/);
    assert.equal((await login(email, 'ander-wachtwoord-1')).length > 10, true);
  });

  it('de opruimsweep verwijdert verlopen/verbruikte rijen na 7 dagen, maar geen verse', async () => {
    const oud = newEmail();
    const vers = newEmail();
    await submit(oud);
    await submit(vers);
    await pool.query(`update pending_registrations set expires_at = now() - interval '8 days' where email = $1`, [oud]);
    const removed = await sweepPendingRegistrations();
    assert.ok(removed >= 1);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [oud]), 0);
    assert.equal(await countRows('select 1 from pending_registrations where email = $1', [vers]), 1);
  });

  it('de bevestigroute heeft een eigen rate limit', async () => {
    process.env.REGISTRATION_CONFIRM_RATE_LIMIT_MAX = '1';
    const res = await confirm('z'.repeat(43));
    const res2 = await confirm('z'.repeat(43));
    assert.ok([res.status, res2.status].includes(429), `statussen ${res.status}/${res2.status}`);
  });
});
