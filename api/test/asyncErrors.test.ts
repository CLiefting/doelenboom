import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  startTestServer, stopTestServer, closePool, createUser, createSysadminUser, login,
  cleanupByPrefix, unique, getBaseUrl,
} from './helpers.js';
import { errorHandler, installAsyncErrorSupport } from '../src/errors.js';

// DOEL-22 (analyse H3): Express 4 vangt geen rejections uit async handlers,
// waardoor één DB-fout op een niet-numeriek id het request voor altijd liet
// hangen. Deze suite bewaakt (1) de generieke async-wrapper + globale
// foutafhandelaar en (2) dat de bekende niet-numerieke-id-routes netjes met
// 404/400 antwoorden i.p.v. te hangen.

const HANG_MS = 4000;

async function get(path: string, token?: string): Promise<{ status: number; body: any; contentType: string }> {
  // AbortSignal.timeout: een hangend request laat de test falen i.p.v. de
  // hele suite eindeloos te laten wachten.
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(HANG_MS),
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, contentType: res.headers.get('content-type') ?? '' };
}

describe('errors.ts — async-wrapper + globale foutafhandelaar (los van de app)', () => {
  let server: Server;
  let base = '';
  const logged: unknown[][] = [];
  const realConsoleError = console.error;

  before(async () => {
    installAsyncErrorSupport();
    installAsyncErrorSupport(); // idempotent: tweede aanroep mag niets dubbel wrappen
    const app = express();
    app.use(express.json());
    app.get('/async-throw', async () => {
      throw new Error('geheime interne details: password=hunter2');
    });
    app.get('/sync-throw', () => {
      throw new Error('sync geheim');
    });
    app.get('/ok', async (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/pg-invalid-text', async () => {
      throw Object.assign(new Error('invalid input syntax for type bigint: "abc"'), { code: '22P02' });
    });
    app.get('/pg-out-of-range', async () => {
      throw Object.assign(new Error('value out of range'), { code: '22003' });
    });
    app.get('/async-middleware-throw', async (_req, _res, next) => {
      // async middleware (zoals requireTenantRole...) die faalt vóór next()
      await Promise.reject(new Error('middleware faalt'));
      next();
    }, (_req, res) => res.json({ bereikt: true }));
    app.get('/headers-al-verstuurd', async (_req, res) => {
      res.write('begin');
      throw new Error('na eerste write');
    });
    app.post('/json', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    console.error = (...args: unknown[]) => { logged.push(args); };
  });

  after(async () => {
    console.error = realConsoleError;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('een gooiende async handler geeft 500 met generieke JSON — zonder interne details', async () => {
    const res = await fetch(`${base}/async-throw`, { signal: AbortSignal.timeout(HANG_MS) });
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const text = await res.text();
    assert.ok(!text.includes('hunter2'), 'interne foutmelding mag niet naar de client');
    assert.ok(!text.includes('at '), 'geen stacktrace naar de client');
    const body500 = JSON.parse(text);
    assert.equal(body500.error, 'Interne serverfout.');
    assert.match(body500.errorId, /^[0-9a-f]{8}$/);
  });

  it('de echte fout wordt wél server-side gelogd', () => {
    const flat = logged.map((a) => a.map(String).join(' ')).join('\n');
    assert.match(flat, /GET \/async-throw/);
    assert.match(flat, /hunter2/);
  });

  it('een gooiende sync handler geeft ook 500 (Express-standaardgedrag blijft werken)', async () => {
    const res = await fetch(`${base}/sync-throw`, { signal: AbortSignal.timeout(HANG_MS) });
    assert.equal(res.status, 500);
    const body500 = await res.json();
    assert.equal(body500.error, 'Interne serverfout.');
    assert.match(body500.errorId, /^[0-9a-f]{8}$/);
  });

  it('een falende async middleware (vóór next()) hangt niet maar geeft 500', async () => {
    const res = await fetch(`${base}/async-middleware-throw`, { signal: AbortSignal.timeout(HANG_MS) });
    assert.equal(res.status, 500);
  });

  it('een normale async handler blijft gewoon werken', async () => {
    const res = await fetch(`${base}/ok`, { signal: AbortSignal.timeout(HANG_MS) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('Postgres-invoerfouten (klasse 22: ongeldig id/bereik) worden 400, geen 500', async () => {
    for (const p of ['/pg-invalid-text', '/pg-out-of-range']) {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(HANG_MS) });
      assert.equal(res.status, 400, p);
      assert.deepEqual(await res.json(), { error: 'Ongeldige invoer.' });
    }
  });

  it('kapotte JSON-body geeft 400 JSON — geen HTML/stacktrace van de Express-default', async () => {
    const res = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"kapot":',
      signal: AbortSignal.timeout(HANG_MS),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'Ongeldig verzoek.' });
    assert.ok(!/SyntaxError|node_modules|at /.test(text));
  });

  it('te grote body geeft 413 JSON', async () => {
    const res = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'a'.repeat(200_000) }),
      signal: AbortSignal.timeout(HANG_MS),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Het verzoek is te groot.' });
  });

  it('als de headers al verstuurd zijn wordt de verbinding afgebroken i.p.v. dubbel te antwoorden', async () => {
    await assert.rejects(async () => {
      const res = await fetch(`${base}/headers-al-verstuurd`, { signal: AbortSignal.timeout(HANG_MS) });
      await res.text();
    });
  });
});

describe('niet-numerieke id\'s in de echte app: 404/400 i.p.v. een hangend request (DOEL-22)', () => {
  const prefix = unique('asyncerr');
  let userToken = '';
  let sysadminToken = '';

  before(async () => {
    await startTestServer();
    await createUser(`${prefix}-user@example.com`);
    await createSysadminUser(`${prefix}-sys@example.com`);
    userToken = await login(`${prefix}-user@example.com`);
    sysadminToken = await login(`${prefix}-sys@example.com`);
  });

  after(async () => {
    await cleanupByPrefix(prefix);
    await stopTestServer();
    await closePool();
  });

  const bad = ['abc', '1abc', '1.5', '-1', '99999999999999999999', '%20', '1e3'];

  it('/api/doelenbomen/:id/tree met een ongeldig id geeft 404 (niet-lid, via tenantIdForDoelenboom)', async () => {
    for (const id of bad) {
      const res = await get(`/api/doelenbomen/${id}/tree`, userToken);
      assert.equal(res.status, 404, `id=${id}`);
    }
  });

  it('/api/tenants/:tenantId/members met een ongeldig id geeft 404 voor een gewone gebruiker', async () => {
    for (const id of bad) {
      const res = await get(`/api/tenants/${id}/members`, userToken);
      assert.equal(res.status, 404, `id=${id}`);
    }
  });

  it('GET /api/tenants/:id/members met een niet-numeriek id geeft ook voor een sysadmin een nette 4xx (JSON)', async () => {
    // Een sysadmin passeert requireTenantRole zonder id-controle; de route zelf
    // (of de globale foutafhandelaar voor Postgres-invoerfouten) geeft dan 400.
    // '-1' is een geldig getal en geeft gewoon een lege ledenlijst.
    for (const id of bad.filter((x) => x !== '-1')) {
      const res = await get(`/api/tenants/${id}/members`, sysadminToken);
      assert.ok(res.status === 400 || res.status === 404, `id=${id} gaf ${res.status}`);
      assert.match(res.contentType, /application\/json/);
    }
  });

  it('PUT /api/tenants/:id met een ongeldig id hangt niet', async () => {
    const res = await fetch(`${getBaseUrl()}/api/tenants/abc`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wipeOnEmpty: true }),
      signal: AbortSignal.timeout(HANG_MS),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/tenants/:tenantId/members/:userId met ongeldige id\'s hangt niet', async () => {
    const res = await fetch(`${getBaseUrl()}/api/tenants/abc/members/xyz`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(HANG_MS),
    });
    assert.equal(res.status, 404);
  });

  it('kapotte JSON op een echte route geeft 400 JSON', async () => {
    const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":',
      signal: AbortSignal.timeout(HANG_MS),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});
