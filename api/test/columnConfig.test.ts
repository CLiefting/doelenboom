// Regressietests voor de configureerbare kolommen (zie
// docs/kolommen-configuratie-ontwerp.md): tenant-default kolomconfiguratie
// (sysadmin-only), de eigen/onafhankelijke config per doelenboom, en de manier
// waarop nieuwe/gedupliceerde doelenbomen hun startconfig krijgen. De dynamische
// elements.type-validatie (die tegen déze config valideert) wordt al gedekt in
// elements.test.ts — hier ligt de nadruk op de column-config-routes zelf en de
// interactie daarvan met tenant-/doelenboom-aanmaak en -duplicatie.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';

const PREFIX = unique('colcfg');

const STANDARD_TYPE_NAMES = [
  'Project', 'Capability', 'Operationele benefit', 'Sub-benefit',
  'Programmabaat', 'Strategische benefit', 'Strategisch doel', 'Missie',
];

describe('kolomconfiguratie', () => {
  let sysadminToken: string;
  let tenantId: number;
  let doelenboomId: number;
  let adminToken: string;
  let gebruikerToken: string;

  before(async () => {
    await startTestServer();
    const email = `${PREFIX}-sysadmin@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    sysadminToken = await login(email, 'wachtwoord123');
    ({ tenantId, doelenboomId, adminToken, gebruikerToken } = await setupWritableDoelenboom(sysadminToken, PREFIX));
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('nieuwe tenant krijgt automatisch een tenant-default met de 8 standaardkolommen', async () => {
    const res = await req('GET', `/api/tenants/${tenantId}/column-config`, { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.columns.length, 8);
    assert.deepEqual(
      res.body.columns.map((c: any) => c.typeName),
      STANDARD_TYPE_NAMES
    );
    assert.equal(res.body.columns.filter((c: any) => c.isProjectRole).length, 1);
    assert.equal(res.body.columns[7].relationLabelToNext, null);
  });

  it('nieuwe doelenboom krijgt een onafhankelijke kopie van de tenant-default', async () => {
    const res = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.columns.map((c: any) => c.typeName),
      STANDARD_TYPE_NAMES
    );
  });

  it('alleen sysadmin mag de tenant-default lezen/wijzigen', async () => {
    const getAsAdmin = await req('GET', `/api/tenants/${tenantId}/column-config`, { token: adminToken });
    assert.equal(getAsAdmin.status, 403);

    const putAsAdmin = await req('PUT', `/api/tenants/${tenantId}/column-config`, {
      token: adminToken, body: { columns: [] },
    });
    assert.equal(putAsAdmin.status, 403);
  });

  it('doelenboom-config lezen mag een gebruiker (alleen-lezen), wijzigen niet', async () => {
    const getAsGebruiker = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: gebruikerToken });
    assert.equal(getAsGebruiker.status, 200);

    const putAsGebruiker = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: gebruikerToken, body: { columns: [] },
    });
    assert.equal(putAsGebruiker.status, 403);
  });

  it('validatie: lege lijst, dubbele type-naam, ontbrekende/meerdere projectrol, ongeldige kleur', async () => {
    const empty = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: adminToken, body: { columns: [] },
    });
    assert.equal(empty.status, 400);

    const base = { title: 'T', subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, relationLabelToNext: null };

    const duplicateType = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: adminToken,
      body: { columns: [
        { ...base, typeName: 'A', isProjectRole: true },
        { ...base, typeName: 'A', isProjectRole: false },
      ] },
    });
    assert.equal(duplicateType.status, 400);

    const noProjectRole = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: adminToken,
      body: { columns: [{ ...base, typeName: 'A', isProjectRole: false }] },
    });
    assert.equal(noProjectRole.status, 400);

    const twoProjectRoles = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: adminToken,
      body: { columns: [
        { ...base, typeName: 'A', isProjectRole: true },
        { ...base, typeName: 'B', isProjectRole: true },
      ] },
    });
    assert.equal(twoProjectRoles.status, 400);

    const badColor = await req('PUT', `/api/doelenbomen/${doelenboomId}/column-config`, {
      token: adminToken,
      body: { columns: [{ ...base, typeName: 'A', isProjectRole: true, color: 'niet-een-hexcode' }] },
    });
    assert.equal(badColor.status, 400);
  });

  it('kan geen kolom verwijderen/hernoemen waarvan nog elementen bestaan; wél nadat ze weg zijn', async () => {
    // Gebruik een verse doelenboom binnen dezelfde tenant, zodat deze test niet
    // botst met de andere tests die óók doelenboomId's kolommen bewerken.
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: `${PREFIX}-inuse`, name: 'In gebruik' },
    });
    const boomId = boom.body.id as number;

    const created = await req('POST', `/api/doelenbomen/${boomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
    assert.equal(created.status, 201);

    const cfg = (await req('GET', `/api/doelenbomen/${boomId}/column-config`, { token: adminToken })).body.columns;
    const withoutProject = cfg.filter((c: any) => c.typeName !== 'Project');

    const blocked = await req('PUT', `/api/doelenbomen/${boomId}/column-config`, {
      token: adminToken, body: { columns: withoutProject.map((c: any, i: number) => ({ ...c, isProjectRole: i === 0, position: i })) },
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Project/);

    const del = await req('DELETE', `/api/doelenbomen/${boomId}/elements/P1`, { token: adminToken });
    assert.equal(del.status, 204);

    // Een nieuwe doelenboom wordt automatisch gezaaid met één voorbeeldelement
    // per kolom (zie exampleTree.ts) — voor de Project-kolom is dat V1. Ook
    // dat moet weg voordat de Project-kolom verwijderd mag worden.
    const delSeed = await req('DELETE', `/api/doelenbomen/${boomId}/elements/V1`, { token: adminToken });
    assert.equal(delSeed.status, 204);

    const nowAllowed = await req('PUT', `/api/doelenbomen/${boomId}/column-config`, {
      token: adminToken, body: { columns: withoutProject.map((c: any, i: number) => ({ ...c, isProjectRole: i === 0, position: i })) },
    });
    assert.equal(nowAllowed.status, 200);
    assert.equal(nowAllowed.body.columns.length, 7);
  });

  it('elements-route valideert type dynamisch tegen de (aangepaste) doelenboom-config', async () => {
    const boom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: `${PREFIX}-dyntype`, name: 'Dynamisch type' },
    });
    const boomId = boom.body.id as number;

    const rejected = await req('POST', `/api/doelenbomen/${boomId}/elements`, {
      token: adminToken, body: { code: 'I1', type: 'Initiatief', name: 'Init 1' },
    });
    assert.equal(rejected.status, 400);

    // Een nieuwe doelenboom wordt automatisch gezaaid met één voorbeeldelement
    // per standaardkolom (zie exampleTree.ts) — die moeten eerst weg, anders
    // blokkeert de kolomconfig-PUT hieronder (kolommen verwijderen mag niet
    // zolang er nog elementen van dat type bestaan).
    const seeded = await req('GET', `/api/doelenbomen/${boomId}/tree`, { token: adminToken });
    for (const el of seeded.body.elements as { code: string }[]) {
      await req('DELETE', `/api/doelenbomen/${boomId}/elements/${el.code}`, { token: adminToken });
    }

    const put = await req('PUT', `/api/doelenbomen/${boomId}/column-config`, {
      token: adminToken,
      body: { columns: [
        { typeName: 'Initiatief', title: 'Initiatief', subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, isProjectRole: true, relationLabelToNext: null },
      ] },
    });
    assert.equal(put.status, 200);

    const accepted = await req('POST', `/api/doelenbomen/${boomId}/elements`, {
      token: adminToken, body: { code: 'I1', type: 'Initiatief', name: 'Init 1' },
    });
    assert.equal(accepted.status, 201);

    // Het oude type ("Project") bestaat niet meer in de config van déze
    // doelenboom, dus wordt nu ook geweigerd.
    const oldTypeRejected = await req('POST', `/api/doelenbomen/${boomId}/elements`, {
      token: adminToken, body: { code: 'P1', type: 'Project', name: 'Project 1' },
    });
    assert.equal(oldTypeRejected.status, 400);

    const tree = await req('GET', `/api/doelenbomen/${boomId}/tree`, { token: adminToken });
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.columns.map((c: any) => c.typeName), ['Initiatief']);
  });

  it('tenant-default wijzigen raakt geen bestaande doelenbomen (onafhankelijke kopie)', async () => {
    const before = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken });
    const beforeTypes = before.body.columns.map((c: any) => c.typeName);

    const putDefault = await req('PUT', `/api/tenants/${tenantId}/column-config`, {
      token: sysadminToken,
      body: { columns: [
        { typeName: 'HeleAndereConfig', title: 'Anders', subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, isProjectRole: true, relationLabelToNext: null },
      ] },
    });
    assert.equal(putDefault.status, 200);

    const after = await req('GET', `/api/doelenbomen/${doelenboomId}/column-config`, { token: adminToken });
    assert.deepEqual(after.body.columns.map((c: any) => c.typeName), beforeTypes);

    // Een NIEUWE doelenboom, aangemaakt ná deze wijziging, start wél vanuit de
    // nieuwe tenant-default.
    const newBoom = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: `${PREFIX}-na-default-wijziging`, name: 'Na wijziging' },
    });
    const newBoomCfg = await req('GET', `/api/doelenbomen/${newBoom.body.id}/column-config`, { token: adminToken });
    assert.deepEqual(newBoomCfg.body.columns.map((c: any) => c.typeName), ['HeleAndereConfig']);
  });

  it('dupliceren van een doelenboom kopieert de EIGEN config van de bron, niet de tenant-default', async () => {
    const source = await req('POST', `/api/tenants/${tenantId}/doelenbomen`, {
      token: adminToken, body: { slug: `${PREFIX}-dup-bron`, name: 'Dup bron' },
    });
    const sourceId = source.body.id as number;

    // Zie toelichting hierboven: eerst de automatisch gezaaide
    // voorbeeldelementen weg, anders blokkeert de kolomconfig-PUT.
    const seeded = await req('GET', `/api/doelenbomen/${sourceId}/tree`, { token: adminToken });
    for (const el of seeded.body.elements as { code: string }[]) {
      await req('DELETE', `/api/doelenbomen/${sourceId}/elements/${el.code}`, { token: adminToken });
    }

    const putCfg = await req('PUT', `/api/doelenbomen/${sourceId}/column-config`, {
      token: adminToken,
      body: { columns: [
        { typeName: 'EigenTypeVanBron', title: 'Eigen', subtitle: '', color: '#3E6FA6', isNarrow: false, nodeFontSize: null, isProjectRole: true, relationLabelToNext: null },
      ] },
    });
    assert.equal(putCfg.status, 200);

    const dup = await req('POST', `/api/doelenbomen/${sourceId}/duplicate`, {
      token: sysadminToken, body: { slug: `${PREFIX}-dup-kopie`, name: 'Dup kopie' },
    });
    assert.equal(dup.status, 201);

    const dupCfg = await req('GET', `/api/doelenbomen/${dup.body.id}/column-config`, { token: adminToken });
    assert.deepEqual(dupCfg.body.columns.map((c: any) => c.typeName), ['EigenTypeVanBron']);
  });
});
