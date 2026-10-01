// Regressietests voor DOEL-67 (OWASP A03, invoervalidatie van e-mailadressen):
// zie api/src/emailAddress.ts. Een e-mailadres moet bij invoer één kaal adres
// zijn — geen lijst (komma/puntkomma), geen weergavenaam, geen CRLF — omdat
// nodemailer de waarde anders als adreslijst/header leest (extra ontvangers
// van o.a. de MFA-code). Faalt op de oude code: users.ts en tenants.ts
// (leden) accepteerden elk adres, de aanvraagroute liet komma's door.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmailAddress } from '../src/emailAddress.js';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('emailval');

const BAD = [
  'a@example.test, b@evil.test',
  'a@example.test;b@evil.test',
  'a@example.test\r\nBcc: b@evil.test',
  'Naam <b@evil.test>',
  'a@example.test(b@evil.test)',
  '"a b"@example.test',
  'a@b@example.test',
  'a@example',
  'a b@example.test',
  '@example.test',
  'a@',
  `${'a'.repeat(250)}@x.nl`,
];
const GOOD = ['a@example.test', 'voor.naam+tag@sub.example.nl', "o'brien@example.test", 'x_y-z@xn--bcher-kva.example'];

describe('e-mailadresvalidatie (DOEL-67)', () => {
  it('isValidEmailAddress: lijsten/headers/weergavenamen geweigerd, gewone adressen geaccepteerd', () => {
    for (const b of BAD) assert.equal(isValidEmailAddress(b), false, `ten onrechte geldig: ${JSON.stringify(b)}`);
    for (const g of GOOD) assert.equal(isValidEmailAddress(g), true, `ten onrechte ongeldig: ${g}`);
    assert.equal(isValidEmailAddress(undefined), false);
    assert.equal(isValidEmailAddress({}), false);
  });

  describe('routes', () => {
    let sysadminToken: string;
    let tenantId: number;
    let adminToken: string;

    before(async () => {
      await startTestServer();
      const email = `${PREFIX}-sysadmin@test.local`;
      await createSysadminUser(email, 'wachtwoord123');
      sysadminToken = await login(email, 'wachtwoord123');
      ({ tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
    });

    after(async () => {
      await cleanupByPrefix(PREFIX);
      await stopTestServer();
      await closePool();
    });

    it('sysadmin: account aanmaken met adreslijst/CRLF geeft 400', async () => {
      for (const email of [`${PREFIX}-x@test.local, aanvaller@evil.test`, `${PREFIX}-y@test.local\r\nBcc: aanvaller@evil.test`]) {
        const res = await req('POST', '/api/users', { token: sysadminToken, body: { email, password: 'wachtwoord123' } });
        assert.equal(res.status, 400, JSON.stringify(res.body));
      }
      const ok = await req('POST', '/api/users', { token: sysadminToken, body: { email: `${PREFIX}-ok@test.local`, password: 'wachtwoord123' } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const upd = await req('PUT', `/api/users/${ok.body.id}`, { token: sysadminToken, body: { email: `${PREFIX}-ok@test.local;aanvaller@evil.test` } });
      assert.equal(upd.status, 400, JSON.stringify(upd.body));
    });

    it('tenant-admin: lid toevoegen met adreslijst geeft 400', async () => {
      const res = await req('POST', `/api/tenants/${tenantId}/members`, {
        token: adminToken, body: { email: `${PREFIX}-lid@test.local,aanvaller@evil.test`, password: 'wachtwoord123', role: 'editor' },
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    it('publieke aanvraag: komma in het e-mailadres geeft 400', async () => {
      const res = await req('POST', '/api/subscription-requests', {
        body: {
          organizationName: `${PREFIX} org`, applicantName: 'Naam', applicantEmail: 'iemand,aanvaller@evil.test',
          password: 'wachtwoord123', tierId: 1, billingPeriod: 'jaar',
        },
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(JSON.stringify(res.body), /e-mailadres/i);
    });
  });
});
