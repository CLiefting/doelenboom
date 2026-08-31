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

  it('GET /api/doelenbomen/:id/tree geeft effectiveRole/canWrite/canWriteContent correct terug', async () => {
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

    const bezoekerEmail = `${PREFIX}-t2-bezoeker@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: bezoekerEmail, password: 'wachtwoord123', role: 'bezoeker' },
    });
    const bezoekerToken = await login(bezoekerEmail, 'wachtwoord123');

    const asAdmin = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.doelenboom.effectiveRole, 'admin');
    assert.equal(asAdmin.body.doelenboom.canWrite, true);
    assert.equal(asAdmin.body.doelenboom.canWriteContent, true);

    // 'gebruiker' mag geen kolommen/instellingen (canWrite=false), maar wel de
    // losse boom-inhoud (canWriteContent=true) — dat is precies het onderscheid
    // dat de rol 'gebruiker' toevoegt t.o.v. de oude, puur read-only betekenis.
    const asGebruiker = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(asGebruiker.status, 200);
    assert.equal(asGebruiker.body.doelenboom.effectiveRole, 'gebruiker');
    assert.equal(asGebruiker.body.doelenboom.canWrite, false);
    assert.equal(asGebruiker.body.doelenboom.canWriteContent, true);

    // 'bezoeker' is de nieuwe, volledig read-only rol — geen van beide.
    const asBezoeker = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: bezoekerToken });
    assert.equal(asBezoeker.status, 200);
    assert.equal(asBezoeker.body.doelenboom.effectiveRole, 'bezoeker');
    assert.equal(asBezoeker.body.doelenboom.canWrite, false);
    assert.equal(asBezoeker.body.doelenboom.canWriteContent, false);

    // Privacy (zie rbac.ts rolmodel-comment): sysadmin heeft GEEN automatische
    // toegang meer tot boom-inhoud zonder zelf gekoppeld te zijn.
    const asSysadminUnlinked = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(asSysadminUnlinked.status, 403);

    // Koppel sysadmin alsnog als admin aan deze tenant (via ledenbeheer, dat
    // blijft wél sysadmin-only toegankelijk) — dan werkt het gewoon, net als
    // voor iedere andere admin.
    const sysadminEmail = `${PREFIX}-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: sysadminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const asSysadminLinked = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(asSysadminLinked.status, 200);
    assert.equal(asSysadminLinked.body.doelenboom.effectiveRole, 'admin');
    assert.equal(asSysadminLinked.body.doelenboom.canWrite, true);
    assert.equal(asSysadminLinked.body.doelenboom.canWriteContent, true);
  });

  it('read_only blokkeert canWrite voor iedereen, ook een gekoppelde sysadmin — settings blijven bereikbaar voor sysadmin', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t3`, `${PREFIX}-t3-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom3', name: 'Boom 3' },
    });
    const doelenboomId = boom.body.id;

    // Doelenboom-instellingen (readOnly aan/uit) blijven sysadmin-toegankelijk
    // zonder koppeling (zie rbac.ts: allowSysadmin:true op deze route) — dat is
    // precies de "gematigde" uitzondering, geen boom-inhoud.
    const setReadOnly = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: sysadminToken, body: { name: 'Boom 3', readOnly: true },
    });
    assert.equal(setReadOnly.status, 200);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(tree.body.doelenboom.canWrite, false);
    // read-only blokkeert ook canWriteContent voor een admin — geen enkele
    // rol mag nog iets wijzigen, zie requireWritableDoelenboom.
    assert.equal(tree.body.doelenboom.canWriteContent, false);

    // Sysadmin is hier niet gekoppeld aan de tenant, dus krijgt sowieso al 403
    // op de boom-inhoud (los van read-only) — zie de vorige test.
    const sysadminTree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(sysadminTree.status, 403);

    // Een tenant-admin mag read-only altijd zelf weer uitzetten (zie rbac.ts-
    // toelichting bij requireTenantRoleForDoelenboomParam) — anders sluit die
    // zichzelf buiten zonder sysadmin erbij te kunnen halen.
    const unsetReadOnly = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3', readOnly: false },
    });
    assert.equal(unsetReadOnly.status, 200);
  });

  it('staleAfterDays: default 60, instelbaar (1-3650), gevalideerd, en zichtbaar via GET tree', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t3b`, `${PREFIX}-t3b-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom3b', name: 'Boom 3b' },
    });
    const doelenboomId = boom.body.id;
    assert.equal(boom.body.staleAfterDays, 60, 'default drempel is 60 dagen');

    const tooLow = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3b', staleAfterDays: 0 },
    });
    assert.equal(tooLow.status, 400);
    const notInteger = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3b', staleAfterDays: 12.5 },
    });
    assert.equal(notInteger.status, 400);

    const updated = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3b', staleAfterDays: 30 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.staleAfterDays, 30);

    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(tree.body.doelenboom.staleAfterDays, 30);

    // Zonder staleAfterDays in de body blijft de huidige waarde staan (niet
    // terugvallen op de default) — zelfde "omitted = ongewijzigd"-gedrag als
    // readOnly/wipeOnEmpty hierboven.
    const renameOnly = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: adminToken, body: { name: 'Boom 3b hernoemd' },
    });
    assert.equal(renameOnly.status, 200);
    assert.equal(renameOnly.body.staleAfterDays, 30);
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
    // Producten horen bij de "Projecten"-module (zie license.ts/routes/products.ts
    // requireModule) — voor deze test gaat het puur om het kopieergedrag van
    // /duplicate, dus activeren we de module hier expliciet, los van de
    // licentie-specifieke tests in licenses.test.ts.
    await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
      token: sysadminToken, body: { active: true },
    });
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

    // "Bron" is zelf al gezaaid met 1 voorbeeldelement per standaardkolom
    // (8 kolommen -> 8 elementen V1..V8, 7 edges, zie exampleTree.ts) bovenop
    // de hier expliciet toegevoegde P1/C1/edge — duplicate kopieert alles.
    // /duplicate is sysadmin-only maar de kopie landt (zonder targetTenantId/
    // newTenant) in dezelfde tenant als de bron — sysadmin is daar zelf niet
    // aan gekoppeld (privacy, zie rbac.ts), dus de resulterende boom lezen we
    // via adminToken (die is wél tenant-lid en heeft dus toegang tot elke
    // doelenboom in die tenant, inclusief deze nieuwe).
    const newTree = await req('GET', `/api/doelenbomen/${newId}/tree`, { token: adminToken });
    assert.equal(newTree.body.elements.length, 10);
    assert.equal(newTree.body.edges.length, 8);
    assert.ok(newTree.body.elements.some((e: { code: string }) => e.code === 'P1'));
    assert.ok(newTree.body.elements.some((e: { code: string }) => e.code === 'C1'));
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

  // Privacy (zie rbac.ts rolmodel-comment): een ongekoppelde sysadmin mag nog
  // wél de doelenbomen-lijst zien en de "instellingen"-laag van een doelenboom
  // beheren (naam/slug/alleen-lezen/archiveren/verwijderen, en wie welke rol
  // heeft) — dat is de "gematigde" uitzondering. Maar géén enkele boom-inhoud:
  // niet de tree zelf (al gedekt door eerdere tests hierboven), niet de
  // kolomconfiguratie, en niet imports/exports.
  it('sysadmin zonder koppeling: wel de doelenbomen-lijst en -instellingen, geen boom-inhoud (kolommen/import/export)', async () => {
    const { tenantId, adminToken } = await makeTenantWithAdmin(sysadminToken, `${PREFIX}-t7`, `${PREFIX}-t7-admin@test.local`);
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'boom7', name: 'Boom 7' },
    });
    const doelenboomId = boom.body.id;

    // Lijst + los item: metadata, geen inhoud — sysadmin ziet dit zonder koppeling.
    const list = await req('GET', '/api/doelenbomen', { token: sysadminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.some((d: { id: number }) => d.id === doelenboomId));

    const tenantList = await req('GET', `/api/tenants/${tenantId}/doelenbomen`, { token: sysadminToken });
    assert.equal(tenantList.status, 200);
    assert.ok(tenantList.body.some((d: { id: number }) => d.id === doelenboomId));

    const single = await req('GET', `/api/doelenbomen/${doelenboomId}`, { token: sysadminToken });
    assert.equal(single.status, 200);

    // Instellingen: hernoemen mag zonder koppeling.
    const rename = await req('PUT', `/api/doelenbomen/${doelenboomId}`, {
      token: sysadminToken, body: { name: 'Boom 7 hernoemd door sysadmin' },
    });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.name, 'Boom 7 hernoemd door sysadmin');

    // Member-roles beheren (wie is admin/gebruiker/bezoeker) mag ook zonder
    // koppeling — dat IS precies hoe sysadmin iemand anders koppelt.
    const roles = await req('GET', `/api/doelenbomen/${doelenboomId}/member-roles`, { token: sysadminToken });
    assert.equal(roles.status, 200);

    // Boom-inhoud: allemaal 403 zonder koppeling.
    const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(tree.status, 403);

    const columns = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: sysadminToken });
    assert.equal(columns.status, 403);

    const exportRes = await req('GET', `/api/doelenbomen/${doelenboomId}/export?format=oud&mode=data`, { token: sysadminToken });
    assert.equal(exportRes.status, 403);

    const imports = await req('GET', `/api/doelenbomen/${doelenboomId}/imports`, { token: sysadminToken });
    assert.equal(imports.status, 403);
  });
});
