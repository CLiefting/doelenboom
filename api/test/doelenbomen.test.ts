import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';

const PREFIX = unique('doelenb');

async function makeTenantWithAdmin(sysadminToken: string, slug: string, adminEmail: string) {
  const tenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: slug } });
  await req('POST', `/api/tenants/${tenant.body.id}/members`, {
    token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
  });
  const adminToken = await login(adminEmail, 'wachtwoord123');
  return { tenantId: tenant.body.id as number, adminToken };
}

describe('doelenbomen', () => {
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

  it('tenant-admin kan een doelenboom aanmaken; gebruiker niet', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t1`, `${PREFIX}-t1-admin@test.local`);

    const gebruikerEmail = `${PREFIX}-t1-gebruiker@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    const asGebruiker = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: gebruikerToken, body: { slug: 'boom1', name: 'Boom 1' },
    });
    assert.equal(asGebruiker.status, 403);

    const asAdmin = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom1', name: 'Boom 1' },
    });
    assert.equal(asAdmin.status, 201);
    assert.equal(asAdmin.body.read_only ?? asAdmin.body.readOnly, false);

    const dup = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom1', name: 'Nog een keer' },
    });
    assert.equal(dup.status, 409);
  });

  it('GET /api/doelenbomen/:id/tree geeft effectiveRole/canWrite correct terug', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t2`, `${PREFIX}-t2-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom2', name: 'Boom 2' },
    });
    const doelenboomId = boom.body.id;

    const gebruikerEmail = `${PREFIX}-t2-gebruiker@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    const asAdmin = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.doelenboom.effectiveRole, 'admin');
    assert.equal(asAdmin.body.doelenboom.canWrite, true);

    const asGebruiker = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(asGebruiker.status, 200);
    assert.equal(asGebruiker.body.doelenboom.effectiveRole, 'gebruiker');
    assert.equal(asGebruiker.body.doelenboom.canWrite, false);

    const asSysadmin = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(asSysadmin.status, 200);
    assert.equal(asSysadmin.body.doelenboom.effectiveRole, 'admin');
    assert.equal(asSysadmin.body.doelenboom.canWrite, true);
  });

  it('read_only blokkeert canWrite ook voor een tenant-admin, maar niet voor sysadmin', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t3`, `${PREFIX}-t3-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom3', name: 'Boom 3' },
    });
    const doelenboomId = boom.body.id;

    const setReadOnly = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3', readOnly: true },
    });
    assert.equal(setReadOnly.status, 200);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(tree.body.doelenboom.canWrite, false);

    const sysadminTree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(sysadminTree.body.doelenboom.canWrite, true);

    // Een tenant-admin mag read-only altijd zelf weer uitzetten (zie rbac.ts-
    // toelichting bij requireTenantRoleForDoelenboomParam) — anders sluit die
    // zichzelf buiten zonder sysadmin erbij te kunnen halen.
    const unsetReadOnly = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3', readOnly: false },
    });
    assert.equal(unsetReadOnly.status, 200);
  });

  it('member-roles: override overrult de tenant-rol binnen één doelenboom', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t4`, `${PREFIX}-t4-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom4', name: 'Boom 4' },
    });
    const doelenboomId = boom.body.id;

    const gebruikerEmail = `${PREFIX}-t4-gebruiker@test.local`;
    const added = await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    const gebruikerUserId = added.body.userId;
    const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    const before = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(before.body.doelenboom.effectiveRole, 'gebruiker');

    const overrideToAdmin = await req('PUT', `/api/doelenbomen/${doelenboomId}/member-roles/${gebruikerUserId}`, {
      token: adminToken, body: { role: 'admin' },
    });
    assert.equal(overrideToAdmin.status, 204);

    const afterOverride = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(afterOverride.body.doelenboom.effectiveRole, 'admin');
    assert.equal(afterOverride.body.doelenboom.canWrite, true);

    const roles = await req('GET', `/api/doelenbomen/${doelenboomId}/member-roles`, { token: adminToken });
    const row = roles.body.find((r: any) => r.userId === gebruikerUserId);
    assert.equal(row.tenantRole, 'gebruiker');
    assert.equal(row.overrideRole, 'admin');
    assert.equal(row.effectiveRole, 'admin');

    const clearOverride = await req('PUT', `/api/doelenbomen/${doelenboomId}/member-roles/${gebruikerUserId}`, {
      token: adminToken, body: { role: null },
    });
    assert.equal(clearOverride.status, 204);
    const backToTenantRole = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(backToTenantRole.body.doelenboom.effectiveRole, 'gebruiker');
  });

  it('duplicate kopieert elementen/edges/producten/tags/org-units naar een nieuwe doelenboom', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t5`, `${PREFIX}-t5-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'bron', name: 'Bron' },
    });
    const sourceId = boom.body.id;

    await req('POST', `/api/doelenbomen/${sourceId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
    await req('POST', `/api/doelenbomen/${sourceId}/elements`, {
      token: adminToken, body: { code: 'C1', type: 'Capability', name: 'Capability 1' },
    });
    await req('POST', `/api/doelenbomen/${sourceId}/edges`, {
      token: adminToken, body: { source: 'P1', target: 'C1', weight: 'primair' },
    });
    await req('POST', `/api/doelenbomen/${sourceId}/elements/P1/products`, {
      token: adminToken, body: { name: 'Deliverable 1' },
    });
    await req('POST', `/api/doelenbomen/${sourceId}/tags`, { token: adminToken, body: { name: 'Tag 1' } });

    const asAdminNotSysadmin = await req('POST', `/api/doelenbomen/${sourceId}/duplicate`, {
      token: adminToken, body: { slug: 'kopie', name: 'Kopie' },
    });
    assert.equal(asAdminNotSysadmin.status, 403);

    const dup = await req('POST', `/api/doelenbomen/${sourceId}/duplicate`, {
      token: sysadminToken, body: { slug: 'kopie', name: 'Kopie' },
    });
    assert.equal(dup.status, 201);
    const newId = dup.body.id;

    const newTree = await req('GET', `/api/doelenbomen/${newId}/tree`, { token: sysadminToken });
    assert.equal(newTree.body.elements.length, 2);
    assert.equal(newTree.body.edges.length, 1);
    assert.equal(newTree.body.products['P1']?.length, 1);
    assert.equal(newTree.body.tags.length, 1);
  });

  it('DELETE /api/doelenbomen/:id verwijdert de boom (cascade)', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t6`, `${PREFIX}-t6-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'weg', name: 'Weg' },
    });
    const del = await req('DELETE', `/api/doelenbomen/${boom.body.id}`, { token: adminToken });
    assert.equal(del.status, 204);
    const getAfter = await req('GET', `/api/doelenbomen/${boom.body.id}`, { token: adminToken });
    assert.equal(getAfter.status, 404);
  });
});
