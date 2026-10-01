// Regressietests voor DOEL-67 (OWASP A06: Vulnerable and Outdated Components)
// en de e-mailpaden die via nodemailer lopen (api/src/email.ts).
//
// Aanleiding: `npm audit` in api/ meldde nodemailer <= 10.0.8 (high:
// GHSA-8vvx-rff5-p5rq, GHSA-v53p-9fqp-m79j, GHSA-prgh-xp8r-p3m5,
// GHSA-g57g-f23g-4646), brace-expansion (high) en multer (moderate). Op de
// oude stand (nodemailer 9.1.1) faalt dit bestand aantoonbaar:
//   - geneste ontvanger-arrays: RangeError "Maximum call stack size exceeded";
//   - addressparser free-text-fallback: kwadratisch (40k tekens ~3,6 s);
//   - de versie-ondergrenzen hieronder.
//
// Daarnaast wordt elk echt verzendpad (MFA, registratieverificatie, "account
// bestaat al", notificatie nieuwe aanvraag) end-to-end gedraaid tegen een
// minimale SMTP-server in dit testproces — de overige testbestanden
// vervangen de verzendfuncties door mocks (helpers.ts), zodat een
// regressie in nodemailer zelf daar onzichtbaar zou blijven. Inclusief
// OWASP A03-checks: geen header-injectie via CRLF in gebruikersinvoer en
// HTML-escaping in de notificatiemail.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);

// --- Minimale SMTP-server (alleen wat nodemailer zonder TLS/AUTH nodig heeft) ---
interface Captured { from: string; rcpt: string[]; data: string }
const captured: Captured[] = [];
let server: net.Server;

function startSmtp(): Promise<number> {
  server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let cur: Captured = { from: '', rcpt: [], data: '' };
    let inData = false;
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            captured.push(cur);
            cur = { from: '', rcpt: [], data: '' };
            sock.write('250 OK queued\r\n');
          } else {
            cur.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { cur.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { cur.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else sock.write('502 not implemented\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function headerBlock(raw: string): string {
  return raw.split('\r\n\r\n')[0];
}

function semverAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('DOEL-67: dependencies en e-mailpaden', () => {
  let email: typeof import('../src/email.js');

  before(async () => {
    const port = await startSmtp();
    // Vóór het (dynamisch) laden van email.ts: dat leest de SMTP-config bij laden.
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    process.env.SMTP_FROM = 'afzender@example.test';
    process.env.SUBSCRIPTION_REQUEST_NOTIFY_EMAIL = 'beheer@example.test';
    email = await import('../src/email.js');
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  // --- OWASP A06: versies -------------------------------------------------------

  it('A06: gepatchte versies van nodemailer, multer en brace-expansion', () => {
    const nodemailerVersion = require('nodemailer/package.json').version as string;
    const multerVersion = require('multer/package.json').version as string;
    const braceVersion = require('brace-expansion/package.json').version as string;
    assert.ok(semverAtLeast(nodemailerVersion, '10.0.13'), `nodemailer ${nodemailerVersion} < 10.0.13`);
    assert.ok(semverAtLeast(multerVersion, '2.4.0'), `multer ${multerVersion} < 2.4.0`);
    const braceMin = braceVersion.startsWith('1.') ? '1.1.21' : '2.1.7';
    assert.ok(semverAtLeast(braceVersion, braceMin), `brace-expansion ${braceVersion} < ${braceMin}`);
  });

  it('A06: geneste ontvanger-arrays geven geen stack-overflow (GHSA-8vvx-rff5-p5rq)', async () => {
    const nodemailer = require('nodemailer');
    let to: unknown = 'x@example.test';
    for (let i = 0; i < 20000; i++) to = [to];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail({ from: 'f@example.test', to, text: 'x' });
    assert.deepEqual(info.envelope.to, ['x@example.test']);
  });

  it('A06: addressparser verwerkt lange vrije tekst in lineaire tijd (GHSA-v53p-9fqp-m79j)', () => {
    const addressparser = require('nodemailer/lib/addressparser');
    const start = Date.now();
    addressparser('a.'.repeat(40000) + '@');
    const ms = Date.now() - start;
    // Op 9.1.1 ~3600 ms (kwadratisch), op 10.0.13 enkele ms. Ruime marge voor trage CI.
    assert.ok(ms < 1000, `addressparser deed ${ms} ms over 80k tekens`);
  });

  // --- Echte verzendpaden via SMTP ---------------------------------------------

  it('MFA-mail gaat via SMTP naar de juiste ontvanger met de code', async () => {
    const before = captured.length;
    await email.sendMfaEmail('gebruiker@example.test', '123456', 10);
    const m = captured[before];
    assert.ok(m, 'geen mail ontvangen');
    assert.match(m.from, /afzender@example\.test/);
    assert.deepEqual(m.rcpt.map((r) => r.replace(/^RCPT TO:\s*/i, '')), ['<gebruiker@example.test>']);
    assert.match(headerBlock(m.data), /^Subject: Je Doelenboom-inlogcode$/m);
    assert.match(m.data, /123456/);
  });

  it('registratieverificatie en "account bestaat al" gaan via SMTP', async () => {
    const before = captured.length;
    await email.sendRegistrationVerificationEmail('aanvrager@example.test', 'https://app.example.test/bevestig?t=abc', 'Org', 24);
    await email.sendRegistrationExistingAccountEmail('bestaand@example.test', 'https://app.example.test/login');
    assert.equal(captured.length, before + 2);
    assert.match(captured[before].rcpt[0], /aanvrager@example\.test/);
    assert.match(captured[before + 1].rcpt[0], /bestaand@example\.test/);
  });

  it('A03: CRLF in gebruikersinvoer leidt niet tot header-injectie of extra ontvangers', async () => {
    const before = captured.length;
    await email.sendNewSubscriptionRequestEmail({
      requestId: 1,
      organizationName: 'Org\r\nBcc: aanvaller@evil.test\r\nX-Injected: ja',
      applicantName: 'Naam',
      applicantEmail: 'a@example.test',
      applicantPhone: null,
      tierName: 'Brons',
      billingPeriod: 'jaar',
      priceEur: 100,
      trialEndDate: '2026-12-31',
    });
    const m = captured[before];
    assert.ok(m);
    assert.deepEqual(m.rcpt.map((r) => r.replace(/^RCPT TO:\s*/i, '')), ['<beheer@example.test>']);
    const headers = headerBlock(m.data);
    assert.doesNotMatch(headers, /^Bcc:/im);
    assert.doesNotMatch(headers, /^X-Injected:/im);
  });

  // Gevonden tijdens DOEL-67 (faalt op de oude code, ook met nodemailer 10):
  // nodemailer leest "to" als adreslijst, dus een komma/puntkomma gaf een
  // extra ontvanger en "x\r\nBcc: y" stuurde de mail ALLEEN naar y.
  // email.ts weigert zo'n ontvanger nu vóór er iets naar de SMTP-server gaat.
  for (const [name, to] of [
    ['CRLF + Bcc', 'slachtoffer@example.test\r\nBcc: aanvaller@evil.test'],
    ['komma', 'slachtoffer@example.test, aanvaller@evil.test'],
    ['puntkomma', 'slachtoffer@example.test;aanvaller@evil.test'],
    ['weergavenaam', 'Slachtoffer <aanvaller@evil.test>'],
    ['commentaar', 'slachtoffer@example.test(aanvaller@evil.test)'],
  ] as const) {
    it(`A03: ontvanger met ${name} wordt geweigerd, niets verstuurd`, async () => {
      const before = captured.length;
      await assert.rejects(() => email.sendMfaEmail(to, '654321', 10), { name: 'UnsafeRecipientError' });
      await assert.rejects(() => email.sendRegistrationVerificationEmail(to, 'https://x.test', 'Org', 24), { name: 'UnsafeRecipientError' });
      await assert.rejects(() => email.sendRegistrationExistingAccountEmail(to, 'https://x.test'), { name: 'UnsafeRecipientError' });
      assert.equal(captured.length, before, 'er ging toch een mail naar de SMTP-server');
    });
  }

  it('A03: HTML in de notificatiemail wordt ge-escaped', async () => {
    const before = captured.length;
    await email.sendNewSubscriptionRequestEmail({
      requestId: 2,
      organizationName: '<script>alert(1)</script>',
      applicantName: '<img src=x onerror=alert(2)>',
      applicantEmail: 'b@example.test',
      applicantPhone: null,
      tierName: 'Brons',
      billingPeriod: 'maand',
      priceEur: null,
      trialEndDate: '2026-12-31',
    });
    const m = captured[before];
    assert.ok(m);
    // Body kan quoted-printable zijn: soft line breaks en =3D/=3C eerst terugdraaien.
    const decoded = m.data
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const html = decoded.slice(decoded.indexOf('text/html'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'organisatienaam niet ge-escaped in HTML');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'ruwe <script> in HTML-deel');
    assert.ok(!html.includes('<img src=x onerror'), 'ruwe <img onerror> in HTML-deel');
  });
});
