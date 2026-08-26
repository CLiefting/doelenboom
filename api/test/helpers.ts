// Gedeelde helpers voor de regressietest-suite (api/test/*.test.ts). Elk
// testbestand draait (Node's ingebouwde testrunner start standaard één
// subproces per --test-bestand) zijn eigen createApp()-instantie op een
// ephemeral poort (0 = "geef er zelf een"), en praat er via gewone fetch()
// mee — geen aparte testtool (supertest e.d.) nodig, Node 20 heeft fetch al
// ingebouwd.
//
// Vereist een draaiende Postgres die bereikbaar is via DATABASE_URL (zie
// api/scripts/reset-test-db.ts en de "pretest"/"test"-npm-scripts in
// package.json) — geen mocks: dit zijn integratietests tegen een echte,
// wegwerpbare database (doelenboom_test), dezelfde aanpak als productie.
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let server: Server | null = null;
let baseUrl = '';

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
}

export async function closePool(): Promise<void> {
  await pool.end();
}

type ReqOpts = { token?: string; body?: unknown };
type ReqResult = { status: number; body: any };

// Generieke JSON-fetch-helper — geeft altijd {status, body} terug (body is
// geparsed JSON, of undefined bij een lege 204-respons).
export async function req(method: string, path: string, opts: ReqOpts = {}): Promise<ReqResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: res.status, body };
}

// Voor routes die geen JSON teruggeven (bv. het Excel-export-endpoint, dat een
// binaire .xlsx-stream stuurt) — geeft de ruwe Response terug i.p.v. te proberen
// als JSON te parsen.
export async function rawReq(method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

let counter = 0;
// Uniek, oplopend suffix per aanroep binnen één testrun — voorkomt unique-
// constraint-botsingen (users.email, tenants.slug, ...) tussen tests in
// hetzelfde bestand, zonder dat elke test een willekeurige UUID hoeft te
// verzinnen.
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

// --- Seed-helpers ---
// Rechtstreeks via SQL i.p.v. de API: een allereerste sysadmin-account aanmaken
// kan niet via de API zelf (die vereist al een ingelogde sysadmin — kip-en-ei).
// Verdere fixtures (tenants, doelenbomen, elementen, ...) worden in de tests
// bewust wél via de echte API-routes aangemaakt, niet via SQL — dat oefent
// meteen de create-routes zelf mee uit i.p.v. alleen de routes die de test
// direct wil verifiëren.
export async function createSysadminUser(email: string, password = 'test-wachtwoord-1'): Promise<number> {
  const r = await pool.query(
    `insert into users (email, password_hash, is_sysadmin, must_change_password)
     values ($1, crypt($2, gen_salt('bf')), true, false) returning id`,
    [email, password]
  );
  return r.rows[0].id;
}

export async function login(email: string, password = 'test-wachtwoord-1'): Promise<string> {
  const { status, body } = await req('POST', '/api/auth/login', { body: { email, password } });
  if (status !== 200) {
    throw new Error(`Login mislukt voor ${email}: ${status} ${JSON.stringify(body)}`);
  }
  return body.token as string;
}

// Ruimt alles op wat met dit prefix is aangemaakt — elk testbestand gebruikt
// zijn eigen unique()-prefix, dus dit raakt nooit data van andere bestanden.
// Cascade (db/init.sql) ruimt bij het verwijderen van een tenant automatisch
// alle doelenbomen/elementen/tags/organisatieonderdelen/imports daarbinnen op.
export async function cleanupByPrefix(prefix: string): Promise<void> {
  await pool.query('delete from tenants where slug like $1', [`${prefix}%`]);
  await pool.query('delete from users where email like $1', [`${prefix}%`]);
}

// Veelgebruikte fixture voor de CRUD-testbestanden (elements/tags/orgUnits/
// edges/products/projectStatus): een tenant met een admin-, een gebruiker- en
// een bezoeker-account, plus één schrijfbare (niet read-only) doelenboom erin
// — allemaal via de echte API-routes aangemaakt (sysadmin -> tenant -> leden
// -> doelenboom), zodat elk testbestand niet zelf steeds dezelfde requests
// hoeft te herhalen vóór het de route kan testen waar het eigenlijk om gaat.
// Rolmodel (zie api/src/rbac.ts): 'gebruiker' mag losse boom-inhoud wijzigen
// (elementen/relaties/tags-koppelingen/projectstatus/producten), niet de
// kolommen/instellingen/import — 'bezoeker' mag alleen lezen.
export async function setupWritableDoelenboom(sysadminToken: string, prefix: string) {
  const tenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug: prefix, name: prefix } });
  const tenantId = tenant.body.id as number;

  const adminEmail = `${prefix}-admin@test.local`;
  await req('POST', `/api/tenants/${tenantId}/members`, {
    token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
  });
  const adminToken = await login(adminEmail, 'wachtwoord123');

  const gebruikerEmail = `${prefix}-gebruiker@test.local`;
  await req('POST', `/api/tenants/${tenantId}/members`, {
    token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
  });
  const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

  const bezoekerEmail = `${prefix}-bezoeker@test.local`;
  await req('POST', `/api/tenants/${tenantId}/members`, {
    token: sysadminToken, body: { email: bezoekerEmail, password: 'wachtwoord123', role: 'bezoeker' },
  });
  const bezoekerToken = await login(bezoekerEmail, 'wachtwoord123');

  const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
    token: adminToken, body: { slug: 'boom', name: 'Testboom' },
  });
  const doelenboomId = boom.body.id as number;

  return { tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken };
}
