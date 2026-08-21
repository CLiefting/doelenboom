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

    const dup = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Nog een keer' } });
    assert.equal(dup.status, 409);
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
});
