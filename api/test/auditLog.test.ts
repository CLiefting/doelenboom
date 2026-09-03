import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('auditlog');

describe('audit log (sysadmin-only, append-only)', () => {
  let sysadminToken: string;
  let gebruikerToken: string;

  before(async () => {
    await startTestServer();
    const sysadminEmail = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');

    const gebruikerEmail = `${PREFIX}-gebruiker@test.local`;
    await createSysadminUser(gebruikerEmail, 'wachtwoord123'); // eenvoudigst: los account, alleen voor de 403-check
    await pool.query('update users set is_sysadmin = false where email = $1', [gebruikerEmail]);
    gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('GET /api/audit-log en /api/audit-log/export zijn sysadmin-only', async () => {
    const listAsGebruiker = await req('GET', '/api/audit-log', { token: gebruikerToken });
    assert.equal(listAsGebruiker.status, 403);

    const exportAsGebruiker = await rawReq('GET', '/api/audit-log/export', { token: gebruikerToken });
    assert.equal(exportAsGebruiker.status, 403);

    const listAsSysadmin = await req('GET', '/api/audit-log', { token: sysadminToken });
    assert.equal(listAsSysadmin.status, 200);
    assert.ok(Array.isArray(listAsSysadmin.body));
  });

  it('geen enkele DELETE-route bestaat voor het auditlogboek (append-only)', async () => {
    // rawReq i.p.v. req: een niet-gematchte route levert Express' standaard
    // HTML-404-pagina op, geen JSON — req() zou daar met een JSON.parse-fout
    // op struikelen.
    const del1 = await rawReq('DELETE', '/api/audit-log', { token: sysadminToken });
    assert.equal(del1.status, 404);
    const del2 = await rawReq('DELETE', '/api/audit-log/1', { token: sysadminToken });
    assert.equal(del2.status, 404);
  });

  it('het openen van een boom (GET .../tree) legt een doelenboom_view-regel vast', async () => {
    const fixture = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-view`);

    const treeRes = await req('GET', `/api/doelenbomen/${fixture.doelenboomId}/tree`, { token: fixture.gebruikerToken });
    assert.equal(treeRes.status, 200);

    const logRes = await req('GET', '/api/audit-log', { token: sysadminToken });
    assert.equal(logRes.status, 200);
    // tenantName/doelenboomName zijn "naam (id)" (namen zijn niet uniek, zie
    // withId() in auditLog.ts) — hier volstaat controleren dat de juiste id
    // erin voorkomt, ongeacht de exacte naam.
    const entry = logRes.body.find(
      (e: any) =>
        e.eventType === 'doelenboom_view' &&
        e.doelenboomName === `Testboom (${fixture.doelenboomId})` &&
        e.tenantName === `${PREFIX}-view (${fixture.tenantId})`
    );
    assert.ok(entry, 'verwacht een doelenboom_view-logregel voor deze boom');
    assert.equal(entry.userEmail, `${PREFIX}-view-gebruiker@test.local`);
    assert.equal(entry.role, 'gebruiker');
  });

  it('een tenant-instellingen-wijziging legt een tenant_settings_changed-regel vast met changes-diff', async () => {
    const fixture = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-tenant`);

    const putRes = await req('PUT', `/api/tenants/${fixture.tenantId}`, {
      token: fixture.adminToken,
      body: { sessionTimeoutMinutes: 45 },
    });
    assert.equal(putRes.status, 200);

    const logRes = await req('GET', '/api/audit-log', { token: sysadminToken });
    const entry = logRes.body.find(
      (e: any) => e.eventType === 'tenant_settings_changed' && e.tenantName === `${PREFIX}-tenant (${fixture.tenantId})`
    );
    assert.ok(entry, 'verwacht een tenant_settings_changed-logregel');
    assert.equal(entry.userEmail, `${PREFIX}-tenant-admin@test.local`);
    assert.equal(entry.detail.changes.session_timeout_minutes.to, 45);
  });

  it('een PUT zonder daadwerkelijke wijziging (zelfde waarde) levert GEEN logregel op', async () => {
    const fixture = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-nochg`);

    // Eerst een keer daadwerkelijk wijzigen zodat we de huidige waarde kennen.
    const first = await req('PUT', `/api/tenants/${fixture.tenantId}`, {
      token: fixture.adminToken,
      body: { sessionTimeoutMinutes: 60 },
    });
    assert.equal(first.status, 200);

    const beforeCount = (await req('GET', '/api/audit-log', { token: sysadminToken })).body.filter(
      (e: any) => e.eventType === 'tenant_settings_changed' && e.tenantName === `${PREFIX}-nochg (${fixture.tenantId})`
    ).length;

    // Zelfde waarde nogmaals meesturen — mag geen nieuwe logregel opleveren.
    const second = await req('PUT', `/api/tenants/${fixture.tenantId}`, {
      token: fixture.adminToken,
      body: { sessionTimeoutMinutes: 60 },
    });
    assert.equal(second.status, 200);

    const afterCount = (await req('GET', '/api/audit-log', { token: sysadminToken })).body.filter(
      (e: any) => e.eventType === 'tenant_settings_changed' && e.tenantName === `${PREFIX}-nochg (${fixture.tenantId})`
    ).length;
    assert.equal(afterCount, beforeCount, 'een ongewijzigde PUT mag geen extra logregel opleveren');
  });

  it('GET /api/audit-log/export levert een .xlsx-bestand', async () => {
    const res = await rawReq('GET', '/api/audit-log/export', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') ?? '', /spreadsheetml/);
    assert.match(res.headers.get('Content-Disposition') ?? '', /auditlogboek\.xlsx/);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });
});
