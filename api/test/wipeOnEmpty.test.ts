import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, createUser, createSysadminUser, login, cleanupByPrefix, unique,
  setupWritableDoelenboom,
} from './helpers.js';
import { pool } from '../src/db.js';
import { sweepIdleTenants } from '../src/tenantWipe.js';

// DOEL-28 (analyse M5, OWASP A04/A09): (1) sessies van gebruikers die alleen
// via open toegang binnen zijn telden niet als "actieve toegang", waardoor de
// minutensweep de inhoud wiste terwijl zij ermee werkten; (2) de wipe bestond
// uit vier losse deletes zonder transactie; (3) er was geen auditlog-spoor.

const PREFIX = unique('wipe');
let counter = 0;

async function endAllSessions() {
  await pool.query('update sessions set ended_at = now() where ended_at is null');
}
async function elementCount(doelenboomId: number): Promise<number> {
  return (await pool.query('select count(*)::int as n from elements where doelenboom_id = $1', [doelenboomId])).rows[0].n;
}
async function wipeAuditRows(doelenboomId: number) {
  return (await pool.query(
    `select user_id, tenant_id, detail from audit_log where event_type = 'doelenboom_wiped' and doelenboom_id = $1 order by id`,
    [doelenboomId]
  )).rows;
}

describe('wipe_on_empty (DOEL-28)', () => {
  let sysToken = '';

  before(async () => {
    await startTestServer();
    const sysEmail = `${PREFIX}-sys@test.local`;
    await createSysadminUser(sysEmail, 'geheim1234');
    sysToken = await login(sysEmail, 'geheim1234');
  });

  after(async () => {
    await endAllSessions();
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  beforeEach(endAllSessions);

  async function fixture(openAccessRole: string | null) {
    counter += 1;
    const prefix = `${PREFIX}-f${counter}`;
    // beforeEach beëindigt alle sessies (ook die van de sysadmin): opnieuw inloggen.
    sysToken = await login(`${PREFIX}-sys@test.local`, 'geheim1234');
    const f = await setupWritableDoelenboom(sysToken, prefix);
    await pool.query('update doelenbomen set wipe_on_empty = true where id = $1', [f.doelenboomId]);
    await pool.query('update tenants set open_access_role = $2 where id = $1', [f.tenantId, openAccessRole]);
    await pool.query(
      `insert into elements (doelenboom_id, code, type, name) values ($1, 'W1', 'Project', 'Moet blijven of weg')`,
      [f.doelenboomId]
    );
    await endAllSessions(); // setup logde in als admin/editor/bezoeker/sysadmin
    // Een nieuwe doelenboom bevat al standaardelementen: vergelijk met het beginaantal.
    const initial = await elementCount(f.doelenboomId);
    assert.ok(initial >= 1);
    return { ...f, prefix, initial };
  }

  it('open toegang: een actieve sessie van iemand die GEEN lid is telt mee — de sweep wist niets', async () => {
    const f = await fixture('bezoeker');
    const outsider = `${f.prefix}-outsider@test.local`;
    await createUser(outsider, 'wachtwoord123');
    await login(outsider, 'wachtwoord123'); // sessie, geen lidmaatschap
    await sweepIdleTenants();
    assert.equal(await elementCount(f.doelenboomId), f.initial, 'inhoud is gewist terwijl een gebruiker via open toegang actief is');
    assert.equal((await wipeAuditRows(f.doelenboomId)).length, 0);
  });

  it('zonder open toegang telt de sessie van een niet-lid niet mee: de sweep wist wel, en logt dat (user null, trigger idle_sweep)', async () => {
    const f = await fixture(null);
    const outsider = `${f.prefix}-outsider@test.local`;
    await createUser(outsider, 'wachtwoord123');
    await login(outsider, 'wachtwoord123');
    await sweepIdleTenants();
    assert.equal(await elementCount(f.doelenboomId), 0);
    const rows = await wipeAuditRows(f.doelenboomId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, null);
    assert.equal(String(rows[0].tenant_id), String(f.tenantId));
    assert.equal(rows[0].detail.trigger, 'idle_sweep');
    assert.equal(rows[0].detail.deleted.elements, f.initial);
  });

  it('een al lege doelenboom wordt bij elke sweep niet opnieuw gelogd (geen logspam per minuut)', async () => {
    const f = await fixture(null);
    await sweepIdleTenants();
    await sweepIdleTenants();
    await sweepIdleTenants();
    assert.equal((await wipeAuditRows(f.doelenboomId)).length, 1);
  });

  it('open toegang zonder enige actieve sessie: de sweep wist gewoon', async () => {
    const f = await fixture('editor');
    await sweepIdleTenants();
    assert.equal(await elementCount(f.doelenboomId), 0);
  });

  it('de wipe is alles-of-niets: faalt een delete halverwege, dan blijft de doelenboom onaangeroerd en komt er geen auditregel', async () => {
    const f = await fixture(null);
    await pool.query(`insert into org_units (doelenboom_id, code, name) values ($1, 'OE1', 'OE test')`, [f.doelenboomId]);
    await pool.query(`
      create or replace function ${PREFIX.replace(/-/g, '_')}_fail() returns trigger as $$
      begin
        if old.doelenboom_id = ${f.doelenboomId} then raise exception 'testfout halverwege de wipe'; end if;
        return old;
      end $$ language plpgsql`);
    await pool.query(`create trigger ${PREFIX.replace(/-/g, '_')}_trg before delete on org_units for each row execute function ${PREFIX.replace(/-/g, '_')}_fail()`);
    const realConsoleError = console.error;
    console.error = () => {};
    try {
      await sweepIdleTenants(); // mag niet gooien: één falende boom houdt de rest niet tegen
      assert.equal(await elementCount(f.doelenboomId), f.initial, 'elementen zijn al gewist terwijl de wipe halverwege faalde');
      assert.equal((await wipeAuditRows(f.doelenboomId)).length, 0);
    } finally {
      console.error = realConsoleError;
      await pool.query(`drop trigger if exists ${PREFIX.replace(/-/g, '_')}_trg on org_units`);
      await pool.query(`drop function if exists ${PREFIX.replace(/-/g, '_')}_fail()`);
    }
    // Zonder de storing lukt de wipe bij de volgende sweep.
    await sweepIdleTenants();
    assert.equal(await elementCount(f.doelenboomId), 0);
    assert.equal((await wipeAuditRows(f.doelenboomId)).length, 1);
  });

  it('wipe bij uitloggen van de laatste gebruiker wordt gelogd met die gebruiker en trigger "logout"', async () => {
    const f = await fixture(null);
    const memberEmail = `${f.prefix}-editor@test.local`;
    const memberToken = await login(memberEmail, 'wachtwoord123');
    const userId = (await pool.query('select id from users where email = $1', [memberEmail])).rows[0].id;
    const res = await req('POST', '/api/auth/logout', { token: memberToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.wiped.some((w: any) => String(w.tenant.id) === String(f.tenantId)));
    assert.equal(await elementCount(f.doelenboomId), 0);
    const rows = await wipeAuditRows(f.doelenboomId);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].user_id), String(userId));
    assert.equal(rows[0].detail.trigger, 'logout');
  });

  it('bij uitloggen blijft de inhoud staan zolang iemand anders via open toegang actief is', async () => {
    const f = await fixture('bezoeker');
    const memberEmail = `${f.prefix}-editor@test.local`;
    const memberToken = await login(memberEmail, 'wachtwoord123');
    const outsider = `${f.prefix}-outsider2@test.local`;
    await createUser(outsider, 'wachtwoord123');
    await login(outsider, 'wachtwoord123');
    const res = await req('POST', '/api/auth/logout', { token: memberToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.wiped, []);
    assert.equal(await elementCount(f.doelenboomId), f.initial);
  });
});
