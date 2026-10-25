// Regressietests voor DOEL-123 (OWASP A06: Vulnerable and Outdated Components;
// raakt A04/A05: beschikbaarheid/DoS).
//
// Aanleiding: de dagelijkse componentencontrole (melding 24-10-2026) vond twee
// Hoog-kwetsbaarheden (CVSS 7.5) in de API, beide DoS:
//   - body-parser < 1.20.9 (GHSA-27r3-jxmh-p828 / CVE-2026-111181): na een
//     gecomprimeerde body kon een decompressie-stream zonder error-listener
//     achterblijven; een late zlib-fout gooit dan een unhandled 'error' en
//     brengt het hele proces neer. Komt transitief binnen via express 4.22.3
//     (dat nog 1.20.8 vastzet), daarom een "overrides"-regel in package.json.
//   - multer 2.0.0 - 2.4.0 (GHSA-q7qp-rjg7-q26m): na afbreken van een upload
//     werden alle listeners van busboy verwijderd; een late busboy-fout (bv.
//     via een openstaande asynchrone fileFilter) crashte het proces.
// Meegenomen: nodemailer < 10.1.4 (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w,
// GHSA-85x2-q946-cp5h, Gemiddeld): addressparser-fouten waardoor weergavetekst
// als ontvanger kon eindigen (email.ts weigert zulke ontvangers al, zie
// emailDependencies.test.ts, dit is verdediging in de diepte).
//
// Op de oude stand (body-parser 1.20.8, multer 2.4.0, nodemailer 10.0.14)
// falen de versietests hieronder aantoonbaar. Het crashpad zelf bleek in
// onze configuratie (express.json() zonder verify-optie, multer zonder
// fileFilter) niet te reproduceren; de gedragstest bewaakt wel dat een
// gzip-body met rommel erachter netjes een 4xx geeft en de API blijft draaien.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { getBaseUrl, req, startTestServer, stopTestServer, closePool } from './helpers.js';

const require = createRequire(import.meta.url);

function semverAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// De body-parser die express ZELF laadt (niet een eventuele losse kopie op
// het hoogste niveau): zo faalt deze test ook als de override verdwijnt.
function bodyParserVersionAsSeenByExpress(): string {
  const expressRequire = createRequire(require.resolve('express/package.json'));
  return expressRequire('body-parser/package.json').version as string;
}

describe('DOEL-123: body-parser, multer en nodemailer (DoS / A06)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  it('A06: express laadt body-parser >= 1.20.9 (GHSA-27r3-jxmh-p828)', () => {
    const v = bodyParserVersionAsSeenByExpress();
    assert.ok(semverAtLeast(v, '1.20.9'), `body-parser ${v} < 1.20.9 (via express)`);
  });

  it('A06: multer >= 2.5.0 (GHSA-q7qp-rjg7-q26m)', () => {
    const v = require('multer/package.json').version as string;
    assert.ok(semverAtLeast(v, '2.5.0'), `multer ${v} < 2.5.0`);
  });

  it('A06: nodemailer >= 10.1.4 (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h)', () => {
    const v = require('nodemailer/package.json').version as string;
    assert.ok(semverAtLeast(v, '10.1.4'), `nodemailer ${v} < 10.1.4`);
  });

  it('A04: gzip-body met rommel erachter geeft een 4xx en de API blijft antwoorden', async () => {
    const { hostname, port } = new URL(getBaseUrl());
    const variants = [
      Buffer.concat([zlib.gzipSync('{"email":"a@b.c"}'), Buffer.from('TRAILING-GARBAGE')]),
      Buffer.concat([zlib.gzipSync('{"email":"a@b.c"}'), Buffer.from([0x1f, 0x8b, 0x99, 1, 2, 3, 4, 5])]),
    ];
    for (const body of variants) {
      const status = await new Promise<number>((resolve, reject) => {
        const sock = net.connect(Number(port), hostname, () => {
          sock.write(
            'POST /api/auth/login HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\n' +
            `Content-Encoding: gzip\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
          );
          sock.write(body);
        });
        let resp = '';
        sock.setEncoding('utf8');
        sock.on('data', (d: string) => { resp += d; });
        sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(resp)?.[1] ?? 0)));
        sock.on('error', reject);
        sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
      });
      assert.ok(status >= 400 && status < 500, `verwachtte 4xx, kreeg ${status}`);
      // Proces nog in leven: een volgend gewoon verzoek slaagt.
      const r = await req('GET', '/api/hello');
      assert.equal(r.status, 200);
    }
  });
});
