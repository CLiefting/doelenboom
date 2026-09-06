import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';
import { pool } from '../src/db.js';
import { sweepTenantRetention, TENANT_RETENTION_MONTHS } from '../src/tenantRetention.js';

const PREFIX = unique('tenantretention');

// Beëindiging + bewaartermijn van een tenant (zie api/src/tenantRetention.ts
// en db/migrations/0032_tenant_retention.sql): "Tenant verwijderen" zet nu
// alleen terminated_at i.p.v. meteen hard te verwijderen. Deze testset
// controleert alle drie de effecten in één keer: onzichtbaar/ontoegankelijk
// voor gewone leden, alleen-lezen voor een sysadmin, en pas na de
// bewaartermijn definitief weg via de sweep.
describe('tenant-beëindiging en -bewaartermijn', () => {
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

  it('DELETE beëindigt (soft) i.p.v. meteen hard te verwijderen: leden verliezen toegang, sysadmin krijgt alleen-lezen', async () => {
    const { tenantId, doelenboomId, adminToken, gebruikerToken, bezoekerToken } =
      await setupWritableDoelenboom(sysadminToken, `${PREFIX}-t1`);

    const terminate = await req('DELETE', `/api/tenants/${tenantId}`, { token: sysadminToken });
    assert.equal(terminate.status, 204);

    // De tenant blijft fysiek bestaan (geen cascade-delete meer) — alleen
    // terminated_at is gezet.
    const row = await pool.query('select terminated_at from tenants where id = $1', [tenantId]);
    assert.equal(row.rowCount, 1);
    assert.ok(row.rows[0].terminated_at instanceof Date);

    // Gewone leden: volledig ontoegankelijk, alsof de tenant niet meer bestaat.
    const asAdmin = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: adminToken });
    assert.equal(asAdmin.status, 403);
    const asGebruiker = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: gebruikerToken });
    assert.equal(asGebruiker.status, 403);
    const asBezoeker = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: bezoekerToken });
    assert.equal(asBezoeker.status, 403);

    // Ook onzichtbaar in de eigen tenant-/doelenbomenlijst.
    const tenantsAsAdmin = await req('GET', '/api/tenants', { token: adminToken });
    assert.equal(tenantsAsAdmin.status, 200);
    assert.ok(!tenantsAsAdmin.body.some((t: any) => t.id === tenantId));
    const doelenbomenAsAdmin = await req('GET', '/api/doelenbomen', { token: adminToken });
    assert.equal(doelenbomenAsAdmin.status, 200);
    assert.ok(!doelenbomenAsAdmin.body.some((d: any) => d.id === doelenboomId));

    // Sysadmin: alleen-lezen toegang, ook zonder eigen tenant_users-koppeling
    // (de enige uitzondering op de normale privacy-regel, specifiek voor deze
    // bewaartermijn-periode).
    const asSysadmin = await req('GET', `/api/doelenbomen/${doelenboomId}/tree`, { token: sysadminToken });
    assert.equal(asSysadmin.status, 200);

    // Maar geen schrijftoegang, ook niet voor een sysadmin.
    const writeAsSysadmin = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: sysadminToken, body: { code: 'X1', type: 'Project', name: 'Mag niet meer' },
    });
    assert.equal(writeAsSysadmin.status, 403);

    // Sysadmin blijft de tenant zelf wél zien in Tenantbeheer (met
    // terminated_at) — zodat de resterende bewaartermijn zichtbaar is.
    const tenantsAsSysadmin = await req('GET', '/api/tenants', { token: sysadminToken });
    const found = tenantsAsSysadmin.body.find((t: any) => t.id === tenantId);
    assert.ok(found);
    assert.ok(found.terminated_at);

    // Opnieuw beëindigen kan niet meer (al beëindigd) — 404, geen dubbele
    // event-regel of hernieuwde terminated_at.
    const terminateAgain = await req('DELETE', `/api/tenants/${tenantId}`, { token: sysadminToken });
    assert.equal(terminateAgain.status, 404);
  });

  it('sweepTenantRetention laat een net-beëindigde tenant met rust, en verwijdert hem pas definitief na de bewaartermijn', async () => {
    const tenantName = `${PREFIX}-t2`;
    const { tenantId, doelenboomId } = await setupWritableDoelenboom(sysadminToken, tenantName);
    const terminate = await req('DELETE', `/api/tenants/${tenantId}`, { token: sysadminToken });
    assert.equal(terminate.status, 204);

    // Nog (ruim) binnen de bewaartermijn: de sweep laat 'm met rust.
    await sweepTenantRetention();
    const stillThere = await pool.query('select id from tenants where id = $1', [tenantId]);
    assert.equal(stillThere.rowCount, 1);

    // Zet terminated_at kunstmatig net voorbij de bewaartermijn (simuleert het
    // verstrijken van TENANT_RETENTION_MONTHS zonder er echt op te wachten).
    await pool.query(
      `update tenants set terminated_at = now() - interval '${TENANT_RETENTION_MONTHS} months' - interval '1 day' where id = $1`,
      [tenantId]
    );
    await sweepTenantRetention();

    const gone = await pool.query('select id from tenants where id = $1', [tenantId]);
    assert.equal(gone.rowCount, 0);
    // Cascade: de doelenboom is meeverdwenen.
    const boomGone = await pool.query('select id from doelenbomen where id = $1', [doelenboomId]);
    assert.equal(boomGone.rowCount, 0);

    // De retentie-events zelf blijven staan (tenant_id wordt null, zie
    // on delete set null) — het historische logboek raakt niet mee weg.
    const events = await pool.query(
      `select event_type from tenant_retention_events where detail->>'name' = $1 order by created_at`,
      [tenantName]
    );
    assert.deepEqual(events.rows.map((r) => r.event_type), ['terminated', 'purged']);
  });
});
