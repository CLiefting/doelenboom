import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';

const PREFIX = unique('tenants');

describe('tenants', () => {
  let sysadminToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-admin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('POST /api/tenants is sysadmin-only', async () => {
    const slug = `${PREFIX}-t1`;
    const asAnon = await req('POST', '/api/tenants', { body: { slug, name: 'Test tenant 1' } });
    assert.equal(asAnon.status, 401);
  });

  it('sysadmin kan een tenant aanmaken; dubbele slug geeft 409', async () => {
    const slug = `${PREFIX}-t2`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 2' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, slug);
    // Let op: deze route aliast session_timeout_minutes niet naar camelCase
    // (anders dan bv. products.ts/projectStatus.ts) — bewust letterlijk getest,
    // zodat een toekomstige "opschoning" naar camelCase hier zichtbaar breekt.
    assert.equal(created.body.session_timeout_minutes, 30);
    // Default aan (opt-out, geen opt-in) — zie db/init.sql nightly_export_enabled.
    assert.equal(created.body.nightly_export_enabled, true);

    const dup = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Nog een keer' } });
    assert.equal(dup.status, 409);
  });

  it('PUT /api/tenants/:id: nightlyExportEnabled is aanpasbaar (tenant-brede standaardwaarde)', async () => {
    const slug = `${PREFIX}-t8`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 8' } });
    const tenantId = created.body.id;
    assert.equal(created.body.nightly_export_enabled, true, 'default aan');

    const adminEmail = `${PREFIX}-t8-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const tenantAdminToken = await login(adminEmail, 'wachtwoord123');

    const asAdmin = await req('PUT', `/api/tenants/${tenantId}`, {
      token: tenantAdminToken, body: { nightlyExportEnabled: false },
    });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.nightly_export_enabled, false);

    // Zonder nightlyExportEnabled in de body blijft de huidige waarde staan
    // (niet terugvallen op de default) — zelfde "omitted = ongewijzigd"-gedrag
    // als wipeOnEmpty/sessionTimeoutMinutes.
    const renameOnly = await req('PUT', `/api/tenants/${tenantId}`, {
      token: tenantAdminToken, body: { sessionTimeoutMinutes: 45 },
    });
    assert.equal(renameOnly.status, 200);
    assert.equal(renameOnly.body.nightly_export_enabled, false);
  });

  it('POST /api/tenants valideert verplichte velden', async () => {
    const res = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug: '' } });
    assert.equal(res.status, 400);
  });

  it('GET /api/tenants: sysadmin ziet alles, tenant-lid alleen eigen tenants', async () => {
    const slug = `${PREFIX}-t3`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 3' } });
    const tenantId = created.body.id;

    const memberEmail = `${PREFIX}-lid@test.local`;
    const addMember = await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken,
      body: { email: memberEmail, password: 'lidwachtwoord1', role: 'gebruiker' },
    });
    assert.equal(addMember.status, 201);
    const memberToken = await login(memberEmail, 'lidwachtwoord1');

    const asSysadmin = await req('GET', '/api/tenants', { token: sysadminToken });
    assert.equal(asSysadmin.status, 200);
    assert.ok(asSysadmin.body.some((t: any) => t.slug === slug));

    const asMember = await req('GET', '/api/tenants', { token: memberToken });
    assert.equal(asMember.status, 200);
    assert.ok(asMember.body.every((t: any) => t.slug === slug));
    assert.equal(asMember.body[0].my_role, 'gebruiker');
  });

  it('PUT /api/tenants/:id vereist tenant-admin, niet enkel lidmaatschap', async () => {
    const slug = `${PREFIX}-t4`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 4' } });
    const tenantId = created.body.id;

    const gebruikerEmail = `${PREFIX}-t4-gebruiker@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    const asGebruiker = await req('PUT', `/api/tenants/${tenantId}`, { token: gebruikerToken, body: { wipeOnEmpty: true } });
    assert.equal(asGebruiker.status, 403);

    const adminEmail = `${PREFIX}-t4-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const tenantAdminToken = await login(adminEmail, 'wachtwoord123');
    const asAdmin = await req('PUT', `/api/tenants/${tenantId}`, { token: tenantAdminToken, body: { wipeOnEmpty: true } });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.wipe_on_empty ?? asAdmin.body.wipeOnEmpty, true);
  });

  it('leden beheren: toevoegen, rol wijzigen, verwijderen', async () => {
    const slug = `${PREFIX}-t5`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 5' } });
    const tenantId = created.body.id;

    const email = `${PREFIX}-t5-lid@test.local`;
    const added = await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email, password: 'wachtwoord123', role: 'gebruiker' },
    });
    assert.equal(added.status, 201);
    const userId = added.body.userId;

    const missingRole = await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: `${PREFIX}-x@test.local` },
    });
    assert.equal(missingRole.status, 400);

    const members = await req('GET', `/api/tenants/${tenantId}/members`, { token: sysadminToken });
    assert.equal(members.status, 200);
    assert.ok(members.body.some((m: any) => m.user_id === userId && m.role === 'gebruiker'));

    const upgraded = await req('PUT', `/api/tenants/${tenantId}/members/${userId}`, {
      token: sysadminToken, body: { role: 'admin' },
    });
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.body.role, 'admin');

    const removed = await req('DELETE', `/api/tenants/${tenantId}/members/${userId}`, { token: sysadminToken });
    assert.equal(removed.status, 204);

    const removedAgain = await req('DELETE', `/api/tenants/${tenantId}/members/${userId}`, { token: sysadminToken });
    assert.equal(removedAgain.status, 404);
  });

  it('DELETE /api/tenants/:id is sysadmin-only, ook voor de eigen tenant-admin', async () => {
    const slug = `${PREFIX}-t6`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 6' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t6-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const tenantAdminToken = await login(adminEmail, 'wachtwoord123');

    const asTenantAdmin = await req('DELETE', `/api/tenants/${tenantId}`, { token: tenantAdminToken });
    assert.equal(asTenantAdmin.status, 403);

    const asSysadmin = await req('DELETE', `/api/tenants/${tenantId}`, { token: sysadminToken });
    assert.equal(asSysadmin.status, 204);
  });

  it('open_access_role: geeft niet-leden toegang, expliciet lidmaatschap wint, uitzetten trekt toegang weer in', async () => {
    // Tenant T waar we open toegang op gaan testen.
    const slug = `${PREFIX}-t7`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 7' } });
    const tenantId = created.body.id;
    assert.equal(created.body.open_access_role, null); // default: uit

    const adminEmail = `${PREFIX}-t7-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom', name: 'Testboom T7' },
    });
    const doelenboomId = boom.body.id;

    // Volledige buitenstaander: lid van een heel andere tenant (U), geen enkele
    // relatie tot T — dit is de "elk account met een login"-situatie.
    const otherSlug = `${PREFIX}-t7-elders`;
    const otherTenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug: otherSlug, name: 'Elders' } });
    const outsiderEmail = `${PREFIX}-t7-buitenstaander@test.local`;
    await req('POST', `/api/tenants/${otherTenant.body.id}/members`, {
      token: sysadminToken, body: { email: outsiderEmail, password: 'wachtwoord123', role: 'bezoeker' },
    });
    const outsiderToken = await login(outsiderEmail, 'wachtwoord123');

    // Vóór open toegang: geen toegang tot T.
    const before = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: outsiderToken });
    assert.equal(before.status, 403);
    const listBefore = await req('GET', '/api/doelenbomen', { token: outsiderToken });
    assert.ok(!listBefore.body.some((d: any) => d.id === doelenboomId));

    // Validatie: ongeldige waarde -> 400.
    const invalid = await req('PUT', `/api/tenants/${tenantId}`, {
      token: sysadminToken, body: { openAccessRole: 'superadmin' },
    });
    assert.equal(invalid.status, 400);

    // Open toegang aanzetten op 'bezoeker'.
    const opened = await req('PUT', `/api/tenants/${tenantId}`, {
      token: sysadminToken, body: { openAccessRole: 'bezoeker' },
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.open_access_role, 'bezoeker');

    const afterRead = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: outsiderToken });
    assert.equal(afterRead.status, 200);
    const listAfter = await req('GET', '/api/doelenbomen', { token: outsiderToken });
    assert.ok(listAfter.body.some((d: any) => d.id === doelenboomId));

    // 'bezoeker' via open toegang mag niet schrijven.
    const writeAsBezoeker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: outsiderToken, body: { code: 'X1', type: 'Project', name: 'Mag niet' },
    });
    assert.equal(writeAsBezoeker.status, 403);

    // Expliciet lidmaatschap wint van open_access_role (kan ook OPHOGEN).
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: outsiderEmail, role: 'gebruiker' },
    });
    const writeAsGebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: outsiderToken, body: { code: 'X1', type: 'Project', name: 'Mag nu wel' },
    });
    assert.equal(writeAsGebruiker.status, 201);

    // Een TWEEDE buitenstaander (nooit ergens expliciet lid van geweest) om
    // het weer uitzetten van open toegang op te testen — de eerste
    // buitenstaander heeft inmiddels een eigen lidmaatschap en zou dus sowieso
    // toegang houden, dat zou het uitzetten zelf niet aantonen.
    const outsider2Email = `${PREFIX}-t7-buitenstaander2@test.local`;
    await req('POST', `/api/tenants/${otherTenant.body.id}/members`, {
      token: sysadminToken, body: { email: outsider2Email, password: 'wachtwoord123', role: 'bezoeker' },
    });
    const outsider2Token = await login(outsider2Email, 'wachtwoord123');
    const beforeClose = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: outsider2Token });
    assert.equal(beforeClose.status, 200); // open toegang staat nog aan

    // Open toegang weer uitzetten (null expliciet meesturen, niet weglaten).
    const closed = await req('PUT', `/api/tenants/${tenantId}`, {
      token: sysadminToken, body: { openAccessRole: null },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.open_access_role, null);
    // wipeOnEmpty/sessionTimeoutMinutes blijven intussen ongemoeid (niet
    // meegestuurd in deze PUT) — regressie voor de tri-state-implementatie.
    assert.equal(closed.body.session_timeout_minutes, 30);

    const afterClose = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: outsider2Token });
    assert.equal(afterClose.status, 403);
    // De eerste buitenstaander (nu een echt lid met role='gebruiker') houdt
    // wél gewoon toegang — het uitzetten van open toegang raakt alleen de
    // fallback, niet expliciete lidmaatschappen.
    const outsiderStillOk = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: outsiderToken });
    assert.equal(outsiderStillOk.status, 200);
  });
});
