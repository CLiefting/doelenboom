import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';
import { pool } from '../src/db.js';
import { sweepLicenseRenewalReminders, LICENSE_RENEWAL_REMINDER_DAYS } from '../src/licenseRenewalReminder.js';

const PREFIX = unique('klantbeheer');

// Klantbeheer (zie api/src/routes/customerManagement.ts en
// db/migrations/0033_customer_management.sql): contactpersonen, klantgegevens
// (facturatie/tags/contractreferentie), en de afgeleide klantgezondheid.
// Sysadmin-only, net als licensesRouter — deze testset dekt zowel de
// toegangscontrole als de kernfunctionaliteit (primair-contact-wissel +
// geschiedenis via audit_log, upsert van klantgegevens, en de
// verlengingsherinnering-sweep).
describe('klantbeheer (contactpersonen, klantgegevens, klantgezondheid)', () => {
  let sysadminToken: string;
  let tenantId: number;
  let adminToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');

    const tenant = await req('POST', '/api/tenants', {
      token: sysadminToken, body: { slug: `${PREFIX}-t1`, name: `${PREFIX}-t1` },
    });
    tenantId = tenant.body.id as number;
    const adminEmail = `${PREFIX}-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    adminToken = await login(adminEmail, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('is sysadmin-only: een tenant-admin krijgt overal 403', async () => {
    const list = await req('GET', `/api/tenants/${tenantId}/contacts`, { token: adminToken });
    assert.equal(list.status, 403);
    const info = await req('GET', `/api/tenants/${tenantId}/customer-info`, { token: adminToken });
    assert.equal(info.status, 403);
    const health = await req('GET', `/api/tenants/${tenantId}/health`, { token: adminToken });
    assert.equal(health.status, 403);
  });

  it('POST/PUT contacts: precies één primair contact per tenant, overdracht wordt gelogd met geschiedenis', async () => {
    const c1 = await req('POST', `/api/tenants/${tenantId}/contacts`, {
      token: sysadminToken,
      body: { name: 'Alice Admin', email: 'alice@klant.test', role: 'tenant_admin', isPrimary: true },
    });
    assert.equal(c1.status, 201);
    assert.equal(c1.body.isPrimary, true);

    const c2 = await req('POST', `/api/tenants/${tenantId}/contacts`, {
      token: sysadminToken,
      body: { name: 'Carla CISO', email: 'carla@klant.test', role: 'ciso', isPrimary: false },
    });
    assert.equal(c2.status, 201);
    assert.equal(c2.body.isPrimary, false);

    // Ongeldige rol wordt geweigerd.
    const badRole = await req('POST', `/api/tenants/${tenantId}/contacts`, {
      token: sysadminToken, body: { name: 'X', email: 'x@klant.test', role: 'nonsense' },
    });
    assert.equal(badRole.status, 400);

    // Carla wordt het nieuwe primaire contact — Alice verliest is_primary
    // automatisch (partial unique index + de transactie in de route).
    const promote = await req('PUT', `/api/contacts/${c2.body.id}`, {
      token: sysadminToken,
      body: { name: 'Carla CISO', email: 'carla@klant.test', role: 'ciso', isPrimary: true },
    });
    assert.equal(promote.status, 200);
    assert.equal(promote.body.isPrimary, true);

    const list = await req('GET', `/api/tenants/${tenantId}/contacts`, { token: sysadminToken });
    assert.equal(list.status, 200);
    const alice = list.body.find((c: any) => c.id === c1.body.id);
    const carla = list.body.find((c: any) => c.id === c2.body.id);
    assert.equal(alice.isPrimary, false);
    assert.equal(carla.isPrimary, true);

    // De primair-contact-geschiedenis staat in audit_log (event_type
    // 'tenant_contact_changed') en is via de contacts/history-route te lezen.
    const history = await req('GET', `/api/tenants/${tenantId}/contacts/history`, { token: sysadminToken });
    assert.equal(history.status, 200);
    const transferEntry = history.body.find((h: any) => h.detail?.primaryTransfer);
    assert.ok(transferEntry, 'verwacht minstens één primaryTransfer-logregel');
    assert.equal(transferEntry.detail.primaryTransfer.to.id, c2.body.id);

    // Ook rechtstreeks via het generieke auditlog-filter (tenantId+eventType)
    // te vinden — de reden dat auditLog.ts filtering kreeg.
    const viaAuditLog = await req(
      'GET',
      `/api/audit-log?tenantId=${tenantId}&eventType=tenant_contact_changed`,
      { token: sysadminToken }
    );
    assert.equal(viaAuditLog.status, 200);
    assert.ok(viaAuditLog.body.length >= 2);

    // Delete ruimt op en logt.
    const del = await req('DELETE', `/api/contacts/${c1.body.id}`, { token: sysadminToken });
    assert.equal(del.status, 204);
    const del404 = await req('DELETE', `/api/contacts/${c1.body.id}`, { token: sysadminToken });
    assert.equal(del404.status, 404);
  });

  it('klantgegevens: leeg object als er nog niets is ingevuld, upsert + diff-logging bij PUT', async () => {
    const empty = await req('GET', `/api/tenants/${tenantId}/customer-info`, { token: sysadminToken });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.kvkNumber, null);
    assert.deepEqual(empty.body.tags, []);

    const put1 = await req('PUT', `/api/tenants/${tenantId}/customer-info`, {
      token: sysadminToken,
      body: {
        customerSince: '2024-01-15',
        kvkNumber: '12345678',
        vatNumber: 'NL123456789B01',
        billingAddress: 'Hoofdstraat 1, 1234 AB Voorbeeldstad',
        tags: ['overheid', 'pilot'],
        contractReference: 'CTR-2024-001',
        contractDate: '2024-01-10',
        contractUrl: 'https://example.test/contract.pdf',
        customerNumber: 1,
      },
    });
    assert.equal(put1.status, 200);
    assert.equal(put1.body.kvkNumber, '12345678');
    assert.equal(put1.body.customerNumber, 1);
    assert.deepEqual(put1.body.tags, ['overheid', 'pilot']);

    // Ongewijzigde PUT levert geen extra logregel op — alleen een wijziging
    // in kvkNumber hieronder.
    const put2 = await req('PUT', `/api/tenants/${tenantId}/customer-info`, {
      token: sysadminToken,
      body: { ...put1.body, kvkNumber: '87654321' },
    });
    assert.equal(put2.status, 200);
    assert.equal(put2.body.kvkNumber, '87654321');

    const history = await req(
      'GET',
      `/api/audit-log?tenantId=${tenantId}&eventType=tenant_customer_info_changed`,
      { token: sysadminToken }
    );
    assert.equal(history.status, 200);
    assert.ok(history.body.length >= 1);
    const kvkChange = history.body.find((h: any) => h.detail?.changes?.kvkNumber);
    assert.ok(kvkChange);
    assert.equal(kvkChange.detail.changes.kvkNumber.to, '87654321');

    // Ongeldige datum wordt geweigerd.
    const badDate = await req('PUT', `/api/tenants/${tenantId}/customer-info`, {
      token: sysadminToken, body: { customerSince: 'not-a-date' },
    });
    assert.equal(badDate.status, 400);

    // Ongeldig klantnummer (0, negatief of niet-geheel) wordt geweigerd.
    const badNumber = await req('PUT', `/api/tenants/${tenantId}/customer-info`, {
      token: sysadminToken, body: { customerNumber: 0 },
    });
    assert.equal(badNumber.status, 400);
  });

  it('klantnummer: los van tenant-ID, vrij herschikbaar, maar uniek zodra gezet (409 bij dubbel)', async () => {
    const otherTenant = await req('POST', '/api/tenants', {
      token: sysadminToken, body: { slug: `${PREFIX}-t2`, name: `${PREFIX}-t2` },
    });
    const otherTenantId = otherTenant.body.id as number;

    // tenantId heeft al klantnummer 1 (vorige test) — otherTenant mag een
    // ander nummer krijgen, maar niet hetzelfde.
    const ok = await req('PUT', `/api/tenants/${otherTenantId}/customer-info`, {
      token: sysadminToken, body: { customerNumber: 2 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.customerNumber, 2);

    const conflict = await req('PUT', `/api/tenants/${otherTenantId}/customer-info`, {
      token: sysadminToken, body: { customerNumber: 1 },
    });
    assert.equal(conflict.status, 409);

    // null blijft altijd toegestaan (meerdere tenants zonder klantnummer).
    const clearOther = await req('PUT', `/api/tenants/${otherTenantId}/customer-info`, {
      token: sysadminToken, body: { customerNumber: null },
    });
    assert.equal(clearOther.status, 200);
    assert.equal(clearOther.body.customerNumber, null);
  });

  it('licentiewijzigingen loggen als tenant_subscription_changed, en zetten de herinnering-vlag terug', async () => {
    const tiers = await req('GET', '/api/tiers', { token: sysadminToken });
    const tier = tiers.body[0];
    assert.ok(tier, 'verwacht minstens één seed-tier');

    const setTier = await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
      token: sysadminToken, body: { tierId: tier.id },
    });
    assert.equal(setTier.status, 200);

    const setEndDate = await req('PUT', `/api/tenants/${tenantId}/license/end-date`, {
      token: sysadminToken, body: { endDate: '2030-01-01' },
    });
    assert.equal(setEndDate.status, 200);

    const subLog = await req(
      'GET',
      `/api/audit-log?tenantId=${tenantId}&eventType=tenant_subscription_changed`,
      { token: sysadminToken }
    );
    assert.equal(subLog.status, 200);
    assert.ok(subLog.body.some((h: any) => h.detail?.changes?.tier_id));
    assert.ok(subLog.body.some((h: any) => h.detail?.changes?.license_end_date?.to === '2030-01-01'));
  });

  it('klantgezondheid: geeft status/reasons terug en signaleert een verlopen licentie als risico (pas écht "expired"/read-only ná opzegging, zie db/migrations/0035_subscription_cancellation.sql)', async () => {
    const healthy = await req('GET', `/api/tenants/${tenantId}/health`, { token: sysadminToken });
    assert.equal(healthy.status, 200);
    assert.ok(['gezond', 'aandacht', 'risico'].includes(healthy.body.status));

    const expired = await req('PUT', `/api/tenants/${tenantId}/license/end-date`, {
      token: sysadminToken, body: { endDate: '2020-01-01' },
    });
    assert.equal(expired.status, 200);

    // Deze tenant is handmatig aangemaakt (geen subscription_requests-rij) en
    // dus nog niet opgezegd: de einddatum is al lang gepasseerd, maar dat
    // maakt 'm nog NIET read-only (net als een niet-opgezegde polis) — wel al
    // "risico" in de klantgezondheid, met een andere reden dan hierna.
    const healthNotCancelled = await req('GET', `/api/tenants/${tenantId}/health`, { token: sysadminToken });
    assert.equal(healthNotCancelled.status, 200);
    assert.equal(healthNotCancelled.body.status, 'risico');
    assert.equal(healthNotCancelled.body.licenseExpired, false);
    assert.ok(healthNotCancelled.body.reasons.some((r: string) => /niet opgezegd/.test(r)));

    // Pas ná opzegging wordt de gepasseerde einddatum daadwerkelijk afgedwongen.
    const cancel = await req('PUT', `/api/tenants/${tenantId}/license/cancel`, {
      token: sysadminToken, body: { cancelled: true },
    });
    assert.equal(cancel.status, 200);
    assert.ok(cancel.body.cancelledAt);

    const health = await req('GET', `/api/tenants/${tenantId}/health`, { token: sysadminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'risico');
    assert.equal(health.body.licenseExpired, true);
    assert.ok(health.body.subscriptionCancelledAt);

    // Opzegging intrekken herstelt schrijfbaarheid (en laat de tenant weer
    // "verlopen maar niet opgezegd" zien).
    const uncancel = await req('PUT', `/api/tenants/${tenantId}/license/cancel`, {
      token: sysadminToken, body: { cancelled: false },
    });
    assert.equal(uncancel.status, 200);
    assert.equal(uncancel.body.cancelledAt, null);
    assert.equal(uncancel.body.expired, false);
  });

  it('sweepLicenseRenewalReminders: signaleert een bijna-verlopen licentie precies één keer', async () => {
    // t3, niet t2: die slug is al in gebruik door de vorige test hierboven
    // ("klantnummer: los van tenant-ID...") — dezelfde slug hergebruiken gaf
    // hier een 409 i.p.v. 201, en dus (via setupWritableDoelenboom-achtige
    // code die niet op de status controleerde) een tenant2Id van undefined,
    // wat de PUT hieronder liet hangen i.p.v. netjes falen. Zie ook de
    // status-check die nu in test/helpers.ts setupWritableDoelenboom zit
    // voor hetzelfde patroon.
    const tenant2 = await req('POST', '/api/tenants', {
      token: sysadminToken, body: { slug: `${PREFIX}-t3`, name: `${PREFIX}-t3` },
    });
    assert.equal(tenant2.status, 201, `tenant-aanmaak mislukt: ${JSON.stringify(tenant2.body)}`);
    const tenant2Id = tenant2.body.id as number;

    const soonEndDate = new Date(Date.now() + (LICENSE_RENEWAL_REMINDER_DAYS - 1) * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    await req('PUT', `/api/tenants/${tenant2Id}/license/end-date`, {
      token: sysadminToken, body: { endDate: soonEndDate },
    });

    await sweepLicenseRenewalReminders();
    const afterFirstSweep = await pool.query(
      'select license_renewal_reminder_sent_at from tenants where id = $1',
      [tenant2Id]
    );
    assert.ok(afterFirstSweep.rows[0].license_renewal_reminder_sent_at instanceof Date);

    // Idempotent: een tweede sweep verandert het tijdstip niet (geen dubbele
    // herinnering voor dezelfde aflopende licentie).
    const firstSentAt = afterFirstSweep.rows[0].license_renewal_reminder_sent_at as Date;
    await sweepLicenseRenewalReminders();
    const afterSecondSweep = await pool.query(
      'select license_renewal_reminder_sent_at from tenants where id = $1',
      [tenant2Id]
    );
    assert.equal(
      (afterSecondSweep.rows[0].license_renewal_reminder_sent_at as Date).getTime(),
      firstSentAt.getTime()
    );

    // Een nieuwe/verlengde einddatum zet de vlag terug naar null, zodat de
    // volgende sweep weer een (nieuwe) herinnering kan signaleren.
    await req('PUT', `/api/tenants/${tenant2Id}/license/end-date`, {
      token: sysadminToken, body: { endDate: '2031-06-01' },
    });
    const afterRenewal = await pool.query(
      'select license_renewal_reminder_sent_at from tenants where id = $1',
      [tenant2Id]
    );
    assert.equal(afterRenewal.rows[0].license_renewal_reminder_sent_at, null);
  });

  it('GET /api/tenants/:id niet-bestaand -> 404 op alle klantbeheerroutes', async () => {
    const bogusId = 999999999;
    const contacts = await req('GET', `/api/tenants/${bogusId}/contacts`, { token: sysadminToken });
    assert.equal(contacts.status, 404);
    const info = await req('GET', `/api/tenants/${bogusId}/customer-info`, { token: sysadminToken });
    assert.equal(info.status, 404);
    const health = await req('GET', `/api/tenants/${bogusId}/health`, { token: sysadminToken });
    assert.equal(health.status, 404);
  });
});
