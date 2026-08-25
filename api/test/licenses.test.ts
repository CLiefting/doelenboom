import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('lic');

// Zie license.ts/doelenboom_licentiemodel.md voor het volledige ontwerp. Twee
// sporen: de catalogus (tiers/modules, sysadmin-CRUD) en de toewijzing per
// tenant (tier + modules + handhaving) — zie ook routes/licenses.ts.
describe('licenties', () => {
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

  describe('tiers-catalogus', () => {
    it('GET /api/tiers vereist auth, maar geen sysadmin; toont de geseede tiers uit de migratie', async () => {
      const anon = await req('GET', '/api/tiers');
      assert.equal(anon.status, 401);

      const { adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t1`);
      const asTenantAdmin = await req('GET', '/api/tiers', { token: adminToken });
      assert.equal(asTenantAdmin.status, 200);
      // db/init.sql/0002_licenses.sql zaait deze 5 tiers standaard — zie
      // doelenboom_licentiemodel.md. Namen zijn instelbaar voor sysadmins,
      // maar horen bij een verse database nog op deze standaardwaarden te staan.
      const names = asTenantAdmin.body.map((t: any) => t.name);
      for (const expected of ['Single-Use', 'Brons', 'Zilver', 'Goud', 'Diamant']) {
        assert.ok(names.includes(expected), `verwachtte tier "${expected}", kreeg ${JSON.stringify(names)}`);
      }
    });

    it('POST/PUT/DELETE /api/tiers zijn sysadmin-only en valideren invoer', async () => {
      const { adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t2`);

      const asTenantAdmin = await req('POST', '/api/tiers', {
        token: adminToken, body: { name: `${PREFIX}-poging`, maxAdmins: 1, maxBomen: 1, sortOrder: 99 },
      });
      assert.equal(asTenantAdmin.status, 403);

      const invalid = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: '', maxAdmins: 0, maxBomen: -1 },
      });
      assert.equal(invalid.status, 400);

      const created = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-Test-tier`, maxAdmins: 3, maxBomen: 7, sortOrder: 99 },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.maxAdmins, 3);
      assert.equal(created.body.maxBomen, 7);
      const tierId = created.body.id;

      // Namen zijn instelbaar voor sysadmin's, maar wel uniek (zie
      // routes/licenses.ts isUniqueViolation-afhandeling).
      const dup = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-Test-tier`, maxAdmins: 1, maxBomen: 1, sortOrder: 0 },
      });
      assert.equal(dup.status, 409);

      const updated = await req('PUT', `/api/tiers/${tierId}`, {
        token: sysadminToken, body: { maxAdmins: 4 },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.maxAdmins, 4);
      assert.equal(updated.body.maxBomen, 7, 'niet-meegegeven velden moeten ongewijzigd blijven (coalesce)');

      const missing = await req('PUT', '/api/tiers/999999999', { token: sysadminToken, body: { maxAdmins: 1 } });
      assert.equal(missing.status, 404);

      const asTenantAdminDelete = await req('DELETE', `/api/tiers/${tierId}`, { token: adminToken });
      assert.equal(asTenantAdminDelete.status, 403);

      const deleted = await req('DELETE', `/api/tiers/${tierId}`, { token: sysadminToken });
      assert.equal(deleted.status, 204);
      const deletedAgain = await req('DELETE', `/api/tiers/${tierId}`, { token: sysadminToken });
      assert.equal(deletedAgain.status, 404);
    });

    it('een tenant op een verwijderde tier valt terug op "geen licentie" (tier_id -> null)', async () => {
      const { tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t3`);
      const tier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-Weg-tier`, maxAdmins: 5, maxBomen: 5, sortOrder: 0 },
      });
      const tierId = tier.body.id;

      const setTier = await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
        token: sysadminToken, body: { tierId },
      });
      assert.equal(setTier.status, 200);
      assert.equal(setTier.body.tier.id, tierId);

      await req('DELETE', `/api/tiers/${tierId}`, { token: sysadminToken });

      const license = await req('GET', `/api/tenants/${tenantId}/license`, { token: adminToken });
      assert.equal(license.status, 200);
      assert.equal(license.body.tier, null);
    });
  });

  describe('modules-catalogus', () => {
    it('GET /api/modules toont de geseede "projecten"-module; POST valideert de key', async () => {
      const modules = await req('GET', '/api/modules', { token: sysadminToken });
      assert.equal(modules.status, 200);
      assert.ok(modules.body.some((m: any) => m.key === 'projecten'));

      const badKey = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: 'Met Spaties!', name: 'Fout' },
      });
      assert.equal(badKey.status, 400);

      const created = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: `${PREFIX}-kpi`, name: 'KPI', description: 'Testmodule' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.key, `${PREFIX}-kpi`);

      const dupKey = await req('POST', '/api/modules', {
        token: sysadminToken, body: { key: `${PREFIX}-kpi`, name: 'Nog een keer' },
      });
      assert.equal(dupKey.status, 409);

      const updated = await req('PUT', `/api/modules/${created.body.id}`, {
        token: sysadminToken, body: { description: 'Bijgewerkte omschrijving' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.key, `${PREFIX}-kpi`, 'key blijft ongewijzigd via update (zie license.ts)');
      assert.equal(updated.body.description, 'Bijgewerkte omschrijving');

      const removed = await req('DELETE', `/api/modules/${created.body.id}`, { token: sysadminToken });
      assert.equal(removed.status, 204);
    });
  });

  describe('licentie per tenant: toewijzing en gebruik', () => {
    it('GET .../license vereist tenant-admin of sysadmin, niet enkel lidmaatschap', async () => {
      const { tenantId, gebruikerToken, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t4`);

      const asGebruiker = await req('GET', `/api/tenants/${tenantId}/license`, { token: gebruikerToken });
      assert.equal(asGebruiker.status, 403);

      const asAdmin = await req('GET', `/api/tenants/${tenantId}/license`, { token: adminToken });
      assert.equal(asAdmin.status, 200);
      assert.equal(asAdmin.body.tier, null);
      assert.deepEqual(asAdmin.body.activeModules, []);
      // setupWritableDoelenboom heeft al 1 admin + 1 doelenboom aangemaakt.
      assert.equal(asAdmin.body.usage.activeAdmins, 1);
      assert.equal(asAdmin.body.usage.activeBomen, 1);
      assert.equal(asAdmin.body.usage.lifetimeBomenAangemaakt, 1);
    });

    it('PUT .../license/tier en .../license/modules/:key zijn sysadmin-only', async () => {
      const { tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t5`);
      const tier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t5-tier`, maxAdmins: 5, maxBomen: 5, sortOrder: 0 },
      });

      const asAdminTier = await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
        token: adminToken, body: { tierId: tier.body.id },
      });
      assert.equal(asAdminTier.status, 403);

      const asAdminModule = await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
        token: adminToken, body: { active: true },
      });
      assert.equal(asAdminModule.status, 403);

      const asSysadmin = await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
        token: sysadminToken, body: { tierId: tier.body.id },
      });
      assert.equal(asSysadmin.status, 200);
      assert.equal(asSysadmin.body.tier.id, tier.body.id);
    });

    it('modules aan/uit zetten is idempotent en zichtbaar in activeModules', async () => {
      const { tenantId } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t6`);

      const activate = await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
        token: sysadminToken, body: { active: true },
      });
      assert.equal(activate.status, 200);
      assert.deepEqual(activate.body.activeModules, ['projecten']);

      // Nogmaals activeren mag geen fout geven (on conflict do nothing).
      const activateAgain = await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
        token: sysadminToken, body: { active: true },
      });
      assert.equal(activateAgain.status, 200);
      assert.deepEqual(activateAgain.body.activeModules, ['projecten']);

      const deactivate = await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
        token: sysadminToken, body: { active: false },
      });
      assert.equal(deactivate.status, 200);
      assert.deepEqual(deactivate.body.activeModules, []);
    });

    it('onbekende module-key geeft een duidelijke fout', async () => {
      const { tenantId } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t7`);
      const res = await req('PUT', `/api/tenants/${tenantId}/license/modules/bestaat-niet`, {
        token: sysadminToken, body: { active: true },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('handhaving: admins', () => {
    it('een admin toevoegen boven de tier-limiet geeft 403; een bestaande admin opnieuw admin maken mag altijd', async () => {
      const { tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t8`);
      // setupWritableDoelenboom heeft al 1 admin — een tier met maxAdmins=1 zit
      // dus al meteen "vol".
      const tier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t8-tier`, maxAdmins: 1, maxBomen: 10, sortOrder: 0 },
      });
      await req('PUT', `/api/tenants/${tenantId}/license/tier`, { token: sysadminToken, body: { tierId: tier.body.id } });

      const tweedeAdminEmail = `${PREFIX}-t8-admin2@test.local`;
      const geblokkeerd = await req('POST', `/api/tenants/${tenantId}/members`, {
        token: sysadminToken, body: { email: tweedeAdminEmail, password: 'wachtwoord123', role: 'admin' },
      });
      assert.equal(geblokkeerd.status, 403);
      assert.match(geblokkeerd.body.error, /maximaal 1/);

      // De bestaande admin z'n rol nogmaals op 'admin' zetten mag altijd,
      // ongeacht de limiet (zie license.ts assertCanAddAdmin-toelichting).
      const members = await req('GET', `/api/tenants/${tenantId}/members`, { token: sysadminToken });
      const bestaandeAdmin = members.body.find((m: any) => m.role === 'admin');
      const opnieuw = await req('PUT', `/api/tenants/${tenantId}/members/${bestaandeAdmin.user_id}`, {
        token: sysadminToken, body: { role: 'admin' },
      });
      assert.equal(opnieuw.status, 200);

      // Na upgraden van de tier lukt het wél.
      const groteTier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t8-tier-groot`, maxAdmins: 2, maxBomen: 10, sortOrder: 0 },
      });
      await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
        token: sysadminToken, body: { tierId: groteTier.body.id },
      });
      const nuWel = await req('POST', `/api/tenants/${tenantId}/members`, {
        token: sysadminToken, body: { email: tweedeAdminEmail, password: 'wachtwoord123', role: 'admin' },
      });
      assert.equal(nuWel.status, 201);

      void adminToken;
    });

    it('downgraden naar een tier die niet meer past geeft 409 (eerst afbouwen)', async () => {
      const { tenantId } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t9`);
      // 1 admin + 1 doelenboom al aanwezig (setupWritableDoelenboom) — een tier
      // met maxAdmins=0 is niet toegestaan via de API (moet > 0 zijn), dus
      // gebruik een tier die precies te klein is voor de bomen-limiet i.p.v.
      // de admin-limiet, dat is even goed een "downgrade past niet"-geval.
      const tePas = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t9-te-klein`, maxAdmins: 5, maxBomen: 5, sortOrder: 0 },
      });
      await req('PUT', `/api/tenants/${tenantId}/license/tier`, { token: sysadminToken, body: { tierId: tePas.body.id } });

      // Zet de tenant kunstmatig boven de admin-limiet van de VOLGENDE tier
      // door een tweede admin toe te voegen (mag, huidige tier staat 5 toe).
      await req('POST', `/api/tenants/${tenantId}/members`, {
        token: sysadminToken,
        body: { email: `${PREFIX}-t9-admin2@test.local`, password: 'wachtwoord123', role: 'admin' },
      });

      const teKleineTier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t9-single`, maxAdmins: 1, maxBomen: 5, sortOrder: 0 },
      });
      const downgrade = await req('PUT', `/api/tenants/${tenantId}/license/tier`, {
        token: sysadminToken, body: { tierId: teKleineTier.body.id },
      });
      assert.equal(downgrade.status, 409);
      assert.match(downgrade.body.error, /eerst afbouwen/);

      // Tier van de tenant is ongewijzigd gebleven na de mislukte downgrade.
      const license = await req('GET', `/api/tenants/${tenantId}/license`, { token: sysadminToken });
      assert.equal(license.body.tier.id, tePas.body.id);
    });
  });

  describe('handhaving: doelenbomen (archiveren telt niet mee)', () => {
    it('een doelenboom aanmaken boven de tier-limiet geeft 403; archiveren maakt weer ruimte', async () => {
      const { tenantId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t10`);
      // setupWritableDoelenboom heeft al 1 doelenboom aangemaakt.
      const tier = await req('POST', '/api/tiers', {
        token: sysadminToken, body: { name: `${PREFIX}-t10-tier`, maxAdmins: 5, maxBomen: 1, sortOrder: 0 },
      });
      await req('PUT', `/api/tenants/${tenantId}/license/tier`, { token: sysadminToken, body: { tierId: tier.body.id } });

      const geblokkeerd = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
        token: adminToken, body: { slug: 'boom2', name: 'Boom 2' },
      });
      assert.equal(geblokkeerd.status, 403);
      assert.match(geblokkeerd.body.error, /maximaal 1 actieve doelenbomen/);

      const doelenbomen = await req('GET', `/api/tenants/${tenantId}/doelenbomen`, { token: adminToken });
      const eersteBoomId = doelenbomen.body[0].id;

      const archiveer = await req('PUT', `/api/doelenbomen/${eersteBoomId}`, {
        token: adminToken, body: { name: doelenbomen.body[0].name, archived: true },
      });
      assert.equal(archiveer.status, 200);
      assert.ok(archiveer.body.archivedAt, 'archivedAt moet gezet zijn na archiveren');

      // Nu is er weer ruimte binnen de limiet van 1 actieve boom.
      const nuWel = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
        token: adminToken, body: { slug: 'boom2', name: 'Boom 2' },
      });
      assert.equal(nuWel.status, 201);

      // De-archiveren van de eerste boom zou nu weer over de limiet gaan (2 > 1).
      const dearchiveer = await req('PUT', `/api/doelenbomen/${eersteBoomId}`, {
        token: adminToken, body: { name: doelenbomen.body[0].name, archived: false },
      });
      assert.equal(dearchiveer.status, 403);

      // De lifetime-teller telt gewoon door (puur rapportage, geen handhaving)
      // — 2 bomen ooit aangemaakt, ondanks dat er nu maar 1 actief is.
      const license = await req('GET', `/api/tenants/${tenantId}/license`, { token: adminToken });
      assert.equal(license.body.usage.activeBomen, 1);
      assert.equal(license.body.usage.lifetimeBomenAangemaakt, 2);
    });
  });

  describe('module-gating: "Projecten"', () => {
    it('zonder de module: schrijven naar producten is geblokkeerd en de boom levert lege project-data', async () => {
      const { tenantId, doelenboomId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t11`);
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
      });

      const geblokkeerd = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
        token: adminToken, body: { name: 'Deliverable 1' },
      });
      assert.equal(geblokkeerd.status, 403);
      assert.match(geblokkeerd.body.error, /projecten/);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.equal(tree.status, 200);
      assert.deepEqual(tree.body.activeModules, []);
      assert.deepEqual(tree.body.products, {});
      assert.deepEqual(tree.body.projectStatus, {});

      // Sysadmin mag altijd door, module of niet (zelfde bypass-conventie als
      // de rest van rbac.ts).
      const alsSysadmin = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
        token: sysadminToken, body: { name: 'Deliverable via sysadmin' },
      });
      assert.equal(alsSysadmin.status, 201);

      void tenantId;
    });

    it('met de module actief: schrijven naar producten werkt en de boom levert de data', async () => {
      const { tenantId, doelenboomId, adminToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t12`);
      await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
        token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
      });
      await req('PUT', `/api/tenants/${tenantId}/license/modules/projecten`, {
        token: sysadminToken, body: { active: true },
      });

      const toegestaan = await req('POST', `/api/doelenbomen/${doelenboomId}/elements/P1/products`, {
        token: adminToken, body: { name: 'Deliverable 1' },
      });
      assert.equal(toegestaan.status, 201);

      const tree = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
      assert.deepEqual(tree.body.activeModules, ['projecten']);
      assert.equal(tree.body.products['P1']?.length, 1);
    });
  });
});
