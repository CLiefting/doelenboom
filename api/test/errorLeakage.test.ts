import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';
import { pool } from '../src/db.js';

// DOEL-32 (analyse M, OWASP A05/A09): 500/502-antwoorden bevatten geen interne
// foutteksten meer (databasefouten, upstream-responsen); de oorzaak staat
// alleen in het serverlog, gekoppeld aan een correlatie-id in het antwoord.

const PREFIX = unique('errleak');
const SECRET = 'GEHEIM-host=10.9.8.7 password=hunter2 relation "users" constraint users_email_key';

describe('geen interne foutdetails naar de client (DOEL-32)', () => {
  let sysToken = '';
  let fx: Awaited<ReturnType<typeof setupWritableDoelenboom>>;
  const realQuery = pool.query.bind(pool);
  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;
  let logged: string[] = [];

  // pool.query laten falen voor SQL die aan het patroon voldoet (de rest gaat gewoon door).
  const failQueriesMatching = (re: RegExp) => {
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
      if (re.test(sql)) return Promise.reject(new Error(SECRET));
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    };
  };

  before(async () => {
    await startTestServer();
    await createSysadminUser(`${PREFIX}-sys@test.local`, 'wachtwoord123');
    sysToken = await login(`${PREFIX}-sys@test.local`, 'wachtwoord123');
    fx = await setupWritableDoelenboom(sysToken, `${PREFIX}-fx`);
  });

  afterEach(() => {
    (pool as unknown as { query: unknown }).query = realQuery;
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
    logged = [];
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  const captureLog = () => {
    logged = [];
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  };

  function assertGeneric(res: { status: number; body: any }, status: number, error: string) {
    assert.equal(res.status, status, JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    for (const leak of ['hunter2', '10.9.8.7', 'users_email_key', 'GEHEIM']) {
      assert.ok(!text.includes(leak), `antwoord lekt "${leak}": ${text}`);
    }
    assert.ok(!('detail' in res.body), 'geen detail-veld meer');
    assert.equal(res.body.error, error);
    assert.match(res.body.errorId, /^[0-9a-f]{8}$/);
    // Dezelfde correlatie-id staat, met de echte oorzaak, in het serverlog.
    const line = logged.find((l) => l.includes(res.body.errorId));
    assert.ok(line, 'correlatie-id ontbreekt in het serverlog');
    assert.ok(line.includes('hunter2') || line.includes('GEHEIM') || line.includes('Traceback'), 'oorzaak ontbreekt in het serverlog');
  }

  it('GET /api/health bij een databasefout: geen foutmelding van de database', async () => {
    captureLog();
    failQueriesMatching(/^\s*select 1\s*$/i);
    const res = await req('GET', '/api/health');
    assert.equal(res.status, 500);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.db, 'unreachable');
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
    assert.ok(!('error' in res.body), 'geen error-tekst in de health-respons');
    assert.match(res.body.errorId, /^[0-9a-f]{8}$/);
    assert.ok(logged.some((l) => l.includes(res.body.errorId) && l.includes('hunter2')));
  });

  it('POST /api/users: databasefout wordt een generieke 500', async () => {
    captureLog();
    failQueriesMatching(/insert into users/i);
    const res = await req('POST', '/api/users', { token: sysToken, body: { email: `${PREFIX}-x@test.local`, password: 'wachtwoord123' } });
    assertGeneric(res, 500, 'Aanmaken van gebruiker mislukt');
  });

  it('POST tags en org-units: databasefout wordt een generieke 500', async () => {
    captureLog();
    failQueriesMatching(/insert into tags/i);
    assertGeneric(
      await req('POST', `/api/doelenbomen/${fx.doelenboomId}/tags`, { token: fx.adminToken, body: { name: 'x' } }),
      500, (await realQueryError('tags')));
    captureLog();
    failQueriesMatching(/insert into org_units/i);
    assertGeneric(
      await req('POST', `/api/doelenbomen/${fx.doelenboomId}/org-units`, { token: fx.adminToken, body: { name: 'x' } }),
      500, (await realQueryError('org')));
  });

  it('Excel-import: excel-service-fout (responstekst of verbindingsfout) komt niet bij de client', async () => {
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob(['x']), 'x.xlsx');
      const r = await realFetch(`${getBaseUrl()}/api/doelenbomen/${fx.doelenboomId}/imports`, {
        method: 'POST', headers: { authorization: `Bearer ${fx.adminToken}` }, body: form,
      });
      return { status: r.status, body: await r.json() };
    };
    const patchExcel = (impl: () => Promise<Response>) => {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/parse') ? impl() : realFetch(input, init)) as typeof fetch;
    };

    captureLog();
    patchExcel(async () => new Response(`Traceback (most recent call last): ${SECRET}`, { status: 500 }));
    assertGeneric(await upload(), 502, 'Excel-service gaf een fout terug');

    captureLog();
    patchExcel(async () => { throw new Error(`connect ECONNREFUSED ${SECRET}`); });
    assertGeneric(await upload(), 502, 'Excel-service niet bereikbaar');
  });

  it('een onbekende module geeft nog steeds een duidelijke 400, andere fouten een generieke 500', async () => {
    const bad = await req('PUT', `/api/tenants/${fx.tenantId}/license/modules/bestaat-niet`, { token: sysToken, body: { active: true } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /bestaat niet/);
    captureLog();
    failQueriesMatching(/from modules where key/i);
    const res = await req('PUT', `/api/tenants/${fx.tenantId}/license/modules/bestaat-niet`, { token: sysToken, body: { active: true } });
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  });

  it('een dubbele tenant-slug blijft een 409; een databasefout daarbij is geen 409 meer', async () => {
    const dup = await req('POST', '/api/tenants', { token: sysToken, body: { slug: `${PREFIX}-fx`, name: 'dubbel' } });
    assert.equal(dup.status, 409);
    assert.ok(!('detail' in dup.body));
  });

  it('structureel: geen route stuurt nog err.message of upstream-tekst als detail mee', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (line.trim().startsWith('//')) return;
            if (/\bdetail:\s*(\(err as Error\)\.message|text|err\.message|String\(err\))/.test(line)) offenders.push(`${p}:${i + 1}`);
            if (/\.json\(\{[^}]*\berror:\s*\(err as Error\)\.message/.test(line)) offenders.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(dir);
    assert.deepEqual(offenders, []);
  });
});

// Hulpje: de vaste melding per route (staat in de routecode) — zo hoeft de test
// de tekst niet te dupliceren maar toetst hij wel dat er precies één vaste melding is.
async function realQueryError(kind: 'tags' | 'org'): Promise<string> {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', kind === 'tags' ? 'tags.ts' : 'orgUnits.ts'), 'utf8');
  const m = src.match(/sendServerError\(res, err, '([^']*)'\)/);
  assert.ok(m, 'sendServerError niet gevonden');
  return m[1];
}
