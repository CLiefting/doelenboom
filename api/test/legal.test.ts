import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('legal');

// Gebruiksvoorwaarden/privacyverklaring en de acceptatieregistratie — zie
// api/src/legal.ts, api/src/routes/legal.ts en
// db/migrations/0017_legal_and_retention.sql. Deze tests draaien tegen de
// systeembreed gezaaide "terms"/0.3-rij (net als system_announcements: één
// rij, geraakt door meerdere testbestanden) — waar een test zelf een extra
// versie nodig heeft (bv. voor requires_reacceptance-gedrag) maakt hij die
// zelf aan met een uniek, prefix-gebonden versienummer en ruimt 'm zelf weer
// op, zodat andere testbestanden nooit een onverwachte "huidige versie" zien.
describe('juridische documenten en acceptatie', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/legal/terms werkt zonder token en geeft de gepubliceerde voorwaarden terug', async () => {
    const res = await req('GET', '/api/legal/terms');
    assert.equal(res.status, 200);
    assert.equal(res.body.docType, 'terms');
    assert.equal(res.body.status, 'published');
    assert.ok(res.body.content.includes('Gebruiksvoorwaarden'));
  });

  it('GET /api/legal/privacy werkt zonder token en geeft de conceptplaceholder terug (nog geen gepubliceerde versie)', async () => {
    const res = await req('GET', '/api/legal/privacy');
    assert.equal(res.status, 200);
    assert.equal(res.body.docType, 'privacy');
    // Bewust geen 'published' -- er bestaat nog geen goedgekeurde privacytekst,
    // zie §3 van de opdracht en de toelichting bij de seed-insert in db/init.sql.
    assert.equal(res.body.status, 'draft');
  });

  it('GET /api/legal/:type met een onbekend documenttype geeft 404', async () => {
    const res = await req('GET', '/api/legal/onzin');
    assert.equal(res.status, 404);
  });

  it('GET /api/legal/terms/status vereist een token', async () => {
    const res = await req('GET', '/api/legal/terms/status');
    assert.equal(res.status, 401);
  });

  it('POST /api/legal/terms/accept vereist een token', async () => {
    const res = await req('POST', '/api/legal/terms/accept');
    assert.equal(res.status, 401);
  });

  it('een nieuwe gebruiker moet de voorwaarden nog accepteren', async () => {
    const email = `${PREFIX}-nieuw@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    const status = await req('GET', '/api/legal/terms/status', { token });
    assert.equal(status.status, 200);
    assert.equal(status.body.acceptanceRequired, true);
  });

  it('na POST /api/legal/terms/accept is acceptanceRequired false, en de acceptatie is geregistreerd op de juiste user/versie', async () => {
    const email = `${PREFIX}-accepteert@test.local`;
    const userId = await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    const accept = await req('POST', '/api/legal/terms/accept', { token });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.accepted, true);
    assert.equal(accept.body.version, '0.3');

    const status = await req('GET', '/api/legal/terms/status', { token });
    assert.equal(status.body.acceptanceRequired, false);

    const row = await pool.query(
      `select la.user_id, ld.version from legal_acceptances la
       join legal_documents ld on ld.id = la.legal_document_id
       where la.user_id = $1 and ld.doc_type = 'terms'`,
      [userId]
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].version, '0.3');
  });

  it('POST /api/legal/terms/accept is idempotent -- nogmaals aanroepen geeft geen fout en geen dubbele rij', async () => {
    const email = `${PREFIX}-dubbel@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    const first = await req('POST', '/api/legal/terms/accept', { token });
    assert.equal(first.status, 200);
    const second = await req('POST', '/api/legal/terms/accept', { token });
    assert.equal(second.status, 200);

    const count = await pool.query(
      `select count(*)::int as n from legal_acceptances la
       join legal_documents ld on ld.id = la.legal_document_id
       join users u on u.id = la.user_id
       where u.email = $1 and ld.doc_type = 'terms'`,
      [email]
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('acceptatie wordt altijd op de eigen gebruiker (uit het token) geregistreerd, nooit op basis van de request-body', async () => {
    const emailA = `${PREFIX}-a@test.local`;
    const emailB = `${PREFIX}-b@test.local`;
    const userIdB = await createSysadminUser(emailB, 'wachtwoord123');
    await createSysadminUser(emailA, 'wachtwoord123');
    const tokenA = await login(emailA, 'wachtwoord123');

    // Zelfs als de body een ander userId meestuurt, mag dat de acceptatie van
    // gebruiker B niet raken -- routes/legal.ts leest uitsluitend req.user!.id.
    const accept = await req('POST', '/api/legal/terms/accept', {
      token: tokenA,
      body: { userId: userIdB } as unknown,
    });
    assert.equal(accept.status, 200);

    const bAccepted = await pool.query(
      `select 1 from legal_acceptances la
       join legal_documents ld on ld.id = la.legal_document_id
       where la.user_id = $1 and ld.doc_type = 'terms'`,
      [userIdB]
    );
    assert.equal(bAccepted.rows.length, 0, 'gebruiker B mag niet als geaccepteerd geregistreerd staan');
  });

  it('requires_reacceptance = false: een gebruiker die een oudere versie accepteerde hoeft een nieuwe versie niet opnieuw te accepteren', async () => {
    const email = `${PREFIX}-geenreaccept@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');
    await req('POST', '/api/legal/terms/accept', { token });

    const newVersion = `${PREFIX}-0.4`;
    await pool.query(
      `insert into legal_documents (doc_type, version, effective_date, published_at, status, requires_reacceptance, content)
       values ('terms', $1, now(), now(), 'published', false, 'Testversie zonder heracceptatieplicht.')`,
      [newVersion]
    );
    try {
      const status = await req('GET', '/api/legal/terms/status', { token });
      assert.equal(status.body.acceptanceRequired, false);
    } finally {
      await pool.query(
        `delete from legal_acceptances where legal_document_id in
         (select id from legal_documents where version = $1 and doc_type = $2)`,
        [newVersion, 'terms']
      );
      await pool.query('delete from legal_documents where version = $1 and doc_type = $2', [newVersion, 'terms']);
    }
  });

  it('requires_reacceptance = true: een nieuwe versie blokkeert opnieuw, ook als de vorige versie al geaccepteerd was', async () => {
    const email = `${PREFIX}-welreaccept@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');
    await req('POST', '/api/legal/terms/accept', { token });

    const newVersion = `${PREFIX}-0.5`;
    await pool.query(
      `insert into legal_documents (doc_type, version, effective_date, published_at, status, requires_reacceptance, content)
       values ('terms', $1, now(), now(), 'published', true, 'Testversie met heracceptatieplicht.')`,
      [newVersion]
    );
    try {
      const status = await req('GET', '/api/legal/terms/status', { token });
      assert.equal(status.body.acceptanceRequired, true);

      // En accepteren van precies déze nieuwe versie lost de blokkade weer op.
      const accept = await req('POST', '/api/legal/terms/accept', { token });
      assert.equal(accept.status, 200);
      assert.equal(accept.body.version, newVersion);
      const statusAfter = await req('GET', '/api/legal/terms/status', { token });
      assert.equal(statusAfter.body.acceptanceRequired, false);
    } finally {
      // legal_acceptances.legal_document_id is 'on delete restrict' (zie
      // db/migrations/0017_legal_and_retention.sql) -- eerst de acceptatie-
      // rij(en) opruimen die deze testversie net heeft aangemaakt, anders
      // faalt de delete hieronder en blijft deze testversie onbedoeld de
      // "huidige" versie voor alle ná deze test lopende tests.
      await pool.query(
        `delete from legal_acceptances where legal_document_id in
         (select id from legal_documents where version = $1 and doc_type = $2)`,
        [newVersion, 'terms']
      );
      await pool.query('delete from legal_documents where version = $1 and doc_type = $2', [newVersion, 'terms']);
    }
  });

  it('oudere versies blijven bewaard nadat een nieuwe versie is gepubliceerd (historie gaat nooit verloren)', async () => {
    const email = `${PREFIX}-historie@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');
    await req('POST', '/api/legal/terms/accept', { token });

    const before = await pool.query(
      `select count(*)::int as n from legal_documents where doc_type = 'terms'`
    );
    assert.ok(before.rows[0].n >= 1);

    // De oorspronkelijke v0.3-rij zelf moet nog altijd bestaan en ongewijzigd zijn.
    const original = await req('GET', '/api/legal/terms');
    assert.equal(original.body.version, '0.3');
  });

  it('POST /api/legal/terms/accept geeft 409 wanneer er (tijdelijk) geen gepubliceerde versie bestaat', async () => {
    const email = `${PREFIX}-geenpublicatie@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    // Zet de systeembrede 0.3-versie tijdelijk op 'draft' om het "nog niets
    // gepubliceerd"-pad te testen -- direct hersteld in finally, ongeacht
    // eventuele assertion-failures hierboven, zodat andere testbestanden die
    // van de gepubliceerde 0.3-versie uitgaan hier nooit last van hebben.
    await pool.query(`update legal_documents set status = 'draft' where doc_type = 'terms' and version = '0.3'`);
    try {
      const accept = await req('POST', '/api/legal/terms/accept', { token });
      assert.equal(accept.status, 409);
    } finally {
      await pool.query(`update legal_documents set status = 'published' where doc_type = 'terms' and version = '0.3'`);
    }
  });
});
