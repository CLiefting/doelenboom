import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';

const PREFIX = unique('dbtmpl');

describe('doelenboom-templates', () => {
  let sysadminToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('systeembreed "Batenboom"-sjabloon is standaard aanwezig voor elke tenant', async () => {
    const slug = `${PREFIX}-t1`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 1' } });
    const tenantId = created.body.id;

    const list = await req('GET', `/api/tenants/${tenantId}/doelenboom-templates`, { token: sysadminToken });
    assert.equal(list.status, 200);
    const batenboom = list.body.find((t: any) => t.name === 'Batenboom');
    assert.ok(batenboom, 'Batenboom-sjabloon ontbreekt in de lijst');
    assert.equal(batenboom.tenantId, null);
  });

  it('opslaan als sjabloon (tenant-scope): vereist tenant-admin, gebruiker/bezoeker mogen niet', async () => {
    const slug = `${PREFIX}-t2`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 2' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t2-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');

    const gebruikerEmail = `${PREFIX}-t2-gebruiker@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: gebruikerEmail, password: 'wachtwoord123', role: 'gebruiker' },
    });
    const gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');

    // Een boom om als bron te gebruiken — de generieke voorbeeldboom (via het
    // Batenboom-sjabloon, want dit is een net aangemaakte tenant) volstaat.
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'bron', name: 'Bronboom' },
    });
    const doelenboomId = boom.body.id;

    const asGebruiker = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: gebruikerToken, body: { name: 'Mijn sjabloon', description: '', scope: 'tenant' },
    });
    assert.equal(asGebruiker.status, 403);

    const missingName = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: '', scope: 'tenant' },
    });
    assert.equal(missingName.status, 400);

    const asAdmin = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: 'Programma-sjabloon', description: 'Voor programma-bomen', scope: 'tenant' },
    });
    assert.equal(asAdmin.status, 201);
    assert.equal(asAdmin.body.tenantId, tenantId);
    assert.equal(asAdmin.body.name, 'Programma-sjabloon');

    // Verschijnt in de lijst van déze tenant...
    const list = await req('GET', `/api/tenants/${tenantId}/doelenboom-templates`, { token: adminToken });
    assert.ok(list.body.some((t: any) => t.id === asAdmin.body.id));

    // ...maar niet in de lijst van een andere tenant.
    const otherTenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug: `${PREFIX}-t2b`, name: 'Andere tenant' } });
    const otherList = await req('GET', `/api/tenants/${otherTenant.body.id}/doelenboom-templates`, { token: sysadminToken });
    assert.ok(!otherList.body.some((t: any) => t.id === asAdmin.body.id));
  });

  it('opslaan als systeembreed sjabloon: alleen een sysadmin mag scope=global kiezen', async () => {
    const slug = `${PREFIX}-t3`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 3' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t3-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'bron', name: 'Bronboom' },
    });
    const doelenboomId = boom.body.id;

    // Tenant-admin (geen sysadmin) mag geen systeembreed sjabloon opslaan.
    const asAdmin = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: adminToken, body: { name: 'Poging systeembreed', scope: 'global' },
    });
    assert.equal(asAdmin.status, 403);

    // Een sysadmin zónder eigen koppeling aan deze tenant/boom mag de
    // boominhoud sowieso niet lezen (privacy-rolmodel, zie rbac.ts) — ook
    // niet om als systeembreed sjabloon op te slaan.
    const asUnlinkedSysadmin = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: sysadminToken, body: { name: 'Poging systeembreed', scope: 'global' },
    });
    assert.equal(asUnlinkedSysadmin.status, 403);

    // Een sysadmin die zichzelf wél als admin aan deze tenant koppelt, mag het wel.
    const sysadminEmailInTenant = `${PREFIX}-sysadmin@test.local`; // al sysadmin, voegt zichzelf nu ook toe als lid
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: sysadminEmailInTenant, role: 'admin' },
    });
    const asLinkedSysadmin = await req('POST', `/api/doelenbomen/${doelenboomId}/save-as-template`, {
      token: sysadminToken, body: { name: 'Programma & projecten', description: '', scope: 'global' },
    });
    assert.equal(asLinkedSysadmin.status, 201);
    assert.equal(asLinkedSysadmin.body.tenantId, null);

    // Systeembreed, dus zichtbaar voor een andere, willekeurige tenant.
    const otherTenant = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug: `${PREFIX}-t3b`, name: 'Andere tenant' } });
    const otherList = await req('GET', `/api/tenants/${otherTenant.body.id}/doelenboom-templates`, { token: sysadminToken });
    assert.ok(otherList.body.some((t: any) => t.id === asLinkedSysadmin.body.id));
  });

  it('nieuwe doelenboom met templateId krijgt de kolommen + elementen + relaties van dat sjabloon', async () => {
    const slug = `${PREFIX}-t4`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 4' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t4-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');

    // Round-trip: bronboom aanmaken mét het systeembrede Batenboom-sjabloon
    // (expliciete templateId, i.p.v. de default-fallback), 'm daarna zelf
    // weer opslaan als (tenant-eigen) sjabloon, en controleren dat een derde
    // boom die dát sjabloon gebruikt exact dezelfde structuur krijgt — dit
    // toetst de volledige snapshot-heenweg (kolommen incl. positie/relaties)
    // én terugweg (elementen/relaties via code-mapping) in één keer, zonder
    // de kolommen-validatie (elementen-nog-in-gebruik-check) in de weg te
    // hoeven zitten.
    const templateList = await req('GET', `/api/tenants/${tenantId}/doelenboom-templates`, { token: adminToken });
    const batenboomTemplate = templateList.body.find((t: any) => t.name === 'Batenboom' && t.tenantId === null);
    assert.ok(batenboomTemplate);

    const bron = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'bron', name: 'Bronboom', templateId: batenboomTemplate.id },
    });
    assert.equal(bron.status, 201);
    const bronId = bron.body.id;

    const saved = await req('POST', `/api/doelenbomen/${bronId}/save-as-template`, {
      token: adminToken, body: { name: 'Kopie van Batenboom', description: 'Testsjabloon', scope: 'tenant' },
    });
    assert.equal(saved.status, 201);
    const templateId = saved.body.id;

    const nieuw = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'nieuw', name: 'Nieuwe boom', templateId },
    });
    assert.equal(nieuw.status, 201);
    const nieuwId = nieuw.body.id;

    const bronCols = await req('GET', `/api/doelenbomen/${bronId}/column-config`, { token: adminToken });
    const nieuwCols = await req('GET', `/api/doelenbomen/${nieuwId}/column-config`, { token: adminToken });
    assert.equal(nieuwCols.status, 200);
    assert.deepEqual(
      nieuwCols.body.columns.map((c: any) => c.typeName),
      bronCols.body.columns.map((c: any) => c.typeName)
    );
    assert.equal(nieuwCols.body.columns.length, 8);

    const tree = await req('GET', `/api/doelenbomen/${nieuwId}/tree`, { token: adminToken });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.elements.length, 8);
    assert.ok(tree.body.elements.some((e: any) => e.type === 'Project' && e.name === 'Voorbeeld van Project'));
    assert.ok(tree.body.elements.some((e: any) => e.type === 'Missie' && e.name === 'Voorbeeld van Missie'));
    assert.equal(tree.body.edges.length, 7);
    assert.ok(tree.body.edges.some((e: any) => e.source === 'V1' && e.target === 'V2'));
  });

  it('nieuwe doelenboom met onbekend/onzichtbaar templateId geeft 400 en maakt niets aan', async () => {
    const slug = `${PREFIX}-t5`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 5' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t5-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');

    const res = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'nieuw', name: 'Nieuwe boom', templateId: 999999999 },
    });
    assert.equal(res.status, 400);

    const list = await req('GET', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken });
    assert.equal(list.body.length, 0);
  });

  it('sjabloon verwijderen: sysadmin mag alles, tenant-admin alleen eigen tenant-sjablonen (niet systeembreed)', async () => {
    const slug = `${PREFIX}-t6`;
    const created = await req('POST', '/api/tenants', { token: sysadminToken, body: { slug, name: 'Test tenant 6' } });
    const tenantId = created.body.id;

    const adminEmail = `${PREFIX}-t6-admin@test.local`;
    await req('POST', `/api/tenants/${tenantId}/members`, {
      token: sysadminToken, body: { email: adminEmail, password: 'wachtwoord123', role: 'admin' },
    });
    const adminToken = await login(adminEmail, 'wachtwoord123');

    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: 'bron', name: 'Bronboom' },
    });
    const eigenSjabloon = await req('POST', `/api/doelenbomen/${boom.body.id}/save-as-template`, {
      token: adminToken, body: { name: 'Eigen sjabloon', scope: 'tenant' },
    });
    assert.equal(eigenSjabloon.status, 201);

    const listVoorGlobal = await req('GET', `/api/tenants/${tenantId}/doelenboom-templates`, { token: adminToken });
    const batenboom = listVoorGlobal.body.find((t: any) => t.name === 'Batenboom');

    // Tenant-admin mag het systeembrede sjabloon niet verwijderen.
    const failGlobal = await req('DELETE', `/api/doelenboom-templates/${batenboom.id}`, { token: adminToken });
    assert.equal(failGlobal.status, 403);

    // Tenant-admin mag het eigen tenant-sjabloon wel verwijderen.
    const okOwn = await req('DELETE', `/api/doelenboom-templates/${eigenSjabloon.body.id}`, { token: adminToken });
    assert.equal(okOwn.status, 204);

    const notFoundAgain = await req('DELETE', `/api/doelenboom-templates/${eigenSjabloon.body.id}`, { token: adminToken });
    assert.equal(notFoundAgain.status, 404);
  });
});
