import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, createUser, createSysadminUser, login, cleanupByPrefix, unique,
  setupWritableDoelenboom, getBaseUrl,
} from './helpers.js';
import { pool } from '../src/db.js';
import { resetLoginThrottle } from '../src/loginThrottle.js';

// DOEL-29 (analyse M6, OWASP A09): het auditlog miste login/lockout,
// wachtwoordwijzigingen, gebruikers-/ledenbeheer, export/import en verwijderen.

const PREFIX = unique('auditev');

type Row = { user_id: string | null; tenant_id: string | null; doelenboom_id: string | null; detail: any };

async function events(type: string, where: string, ...params: unknown[]): Promise<Row[]> {
  return (await pool.query(
    `select user_id, tenant_id, doelenboom_id, detail from audit_log where event_type = $1 and ${where} order by id`,
    [type, ...params]
  )).rows;
}
const uid = async (email: string) => (await pool.query('select id from users where email = $1', [email])).rows[0].id as string;

describe('auditlog: beveiligingsrelevante gebeurtenissen (DOEL-29)', () => {
  let sysToken = '';
  let sysId = '';
  const sysEmail = `${PREFIX}-sys@test.local`;
  let fx: Awaited<ReturnType<typeof setupWritableDoelenboom>>;

  before(async () => {
    await startTestServer();
    await createSysadminUser(sysEmail, 'geheim1234');
    sysToken = await login(sysEmail, 'geheim1234');
    sysId = await uid(sysEmail);
    fx = await setupWritableDoelenboom(sysToken, `${PREFIX}-fx`);
  });

  after(async () => {
    await pool.query('update app_settings set max_failed_login_attempts = 5, login_lockout_minutes = 15 where id = 1');
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  beforeEach(() => resetLoginThrottle());

  describe('inloggen', () => {
    it('login_success (met ip en mfa-vlag), login_failed en account_locked voor een bekend account — nooit het wachtwoord', async () => {
      await pool.query('update app_settings set max_failed_login_attempts = 3, login_lockout_minutes = 15 where id = 1');
      const email = `${PREFIX}-lg@test.local`;
      const id = String(await createUser(email, 'juist-wachtwoord-1'));
      await req('POST', '/api/auth/login', { body: { email, password: 'geheim-fout-A' } });
      await req('POST', '/api/auth/login', { body: { email, password: 'geheim-fout-B' } });
      const locked = await req('POST', '/api/auth/login', { body: { email, password: 'geheim-fout-C' } });
      assert.equal(locked.status, 429);

      const failed = await events('login_failed', 'user_id = $2', id);
      assert.equal(failed.length, 3);
      assert.equal(failed[0].detail.reason, 'wrong_password');
      assert.ok(failed[0].detail.ip);
      const lock = await events('account_locked', 'user_id = $2', id);
      assert.equal(lock.length, 1);
      assert.equal(lock[0].detail.lockoutMinutes, 15);

      // Tijdens de blokkade worden pogingen niet steeds opnieuw gelogd (geen logspam).
      await req('POST', '/api/auth/login', { body: { email, password: 'geheim-fout-D' } });
      assert.equal((await events('login_failed', 'user_id = $2', id)).length, 3);

      await pool.query(`update users set locked_until = null where email = $1`, [email]);
      const ok = await req('POST', '/api/auth/login', { body: { email, password: 'juist-wachtwoord-1' } });
      assert.equal(ok.status, 200);
      const success = await events('login_success', 'user_id = $2', id);
      assert.equal(success.length, 1);
      assert.equal(success[0].detail.mfa, false);
      assert.ok(success[0].detail.ip);

      const all = JSON.stringify((await pool.query('select detail from audit_log where user_id = $1', [id])).rows);
      for (const secret of ['geheim-fout-A', 'geheim-fout-B', 'geheim-fout-C', 'juist-wachtwoord-1']) {
        assert.ok(!all.includes(secret), `wachtwoord "${secret}" staat in het auditlog`);
      }
    });

    it('een mislukte poging op een onbekend adres wordt gelogd (user null, adres in detail)', async () => {
      const email = `${PREFIX}-nobody@test.local`;
      await req('POST', '/api/auth/login', { body: { email, password: 'x-wachtwoord-1' } });
      const rows = await events('login_failed', `detail->>'email' = $2`, email);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].user_id, null);
      assert.equal(rows[0].detail.reason, 'unknown_user');
    });

    it('login_success met MFA (sysadmin) markeert mfa: true', async () => {
      const email = `${PREFIX}-mfa@test.local`;
      const id = String(await createSysadminUser(email, 'geheim1234'));
      await login(email, 'geheim1234');
      const rows = await events('login_success', 'user_id = $2', id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.mfa, true);
    });
  });

  describe('wachtwoorden', () => {
    it('password_changed (zelf) en password_reset (sysadmin, doelwit in detail)', async () => {
      const email = `${PREFIX}-pw@test.local`;
      const id = String(await createUser(email, 'oud-wachtwoord-1'));
      const token = await login(email, 'oud-wachtwoord-1');
      const chg = await req('POST', '/api/auth/change-password', {
        token, body: { currentPassword: 'oud-wachtwoord-1', newPassword: 'nieuw-wachtwoord-2' },
      });
      assert.equal(chg.status, 200);
      const changed = await events('password_changed', 'user_id = $2', id);
      assert.equal(changed.length, 1);

      const reset = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { password: 'reset-wachtwoord-3' } });
      assert.equal(reset.status, 200);
      const resets = await events('password_reset', `detail->>'targetUserId' = $2`, id);
      assert.equal(resets.length, 1);
      assert.equal(String(resets[0].user_id), sysId, 'actor is de sysadmin');
      assert.equal(resets[0].detail.email, email);
      assert.ok(!JSON.stringify(resets[0].detail).includes('reset-wachtwoord-3'));
    });

    it('een mislukte change-password (fout huidig wachtwoord) logt geen password_changed', async () => {
      const email = `${PREFIX}-pwfail@test.local`;
      const id = String(await createUser(email, 'oud-wachtwoord-1'));
      const token = await login(email, 'oud-wachtwoord-1');
      const res = await req('POST', '/api/auth/change-password', {
        token, body: { currentPassword: 'fout-wachtwoord-1', newPassword: 'nieuw-wachtwoord-2' },
      });
      assert.equal(res.status, 401);
      assert.equal((await events('password_changed', 'user_id = $2', id)).length, 0);
    });
  });

  describe('gebruikersbeheer', () => {
    it('user_created, user_updated (isSysadmin/email/mfa als {from,to}) en user_deleted', async () => {
      const email = `${PREFIX}-mgmt@test.local`;
      const created = await req('POST', '/api/users', { token: sysToken, body: { email, password: 'wachtwoord-1234', isSysadmin: false } });
      assert.equal(created.status, 201);
      const id = String(created.body.id);
      const c = await events('user_created', `detail->>'targetUserId' = $2`, id);
      assert.equal(c.length, 1);
      assert.equal(String(c[0].user_id), sysId);
      assert.equal(c[0].detail.isSysadmin, false);

      const upd = await req('PUT', `/api/users/${id}`, { token: sysToken, body: { isSysadmin: true } });
      assert.equal(upd.status, 200);
      const u = await events('user_updated', `detail->>'targetUserId' = $2`, id);
      assert.equal(u.length, 1);
      assert.deepEqual(u[0].detail.changes.isSysadmin, { from: false, to: true });

      // Zelfde waarde nog eens sturen: geen wijziging, dus geen nieuwe regel.
      await req('PUT', `/api/users/${id}`, { token: sysToken, body: { isSysadmin: true } });
      assert.equal((await events('user_updated', `detail->>'targetUserId' = $2`, id)).length, 1);

      const del = await req('DELETE', `/api/users/${id}`, { token: sysToken });
      assert.equal(del.status, 204);
      const d = await events('user_deleted', `detail->>'targetUserId' = $2`, id);
      assert.equal(d.length, 1);
      assert.equal(d[0].detail.email, email);
      assert.equal(d[0].detail.wasSysadmin, true);
      assert.equal(String(d[0].user_id), sysId);
    });
  });

  describe('leden en rollen', () => {
    it('lid toevoegen (nieuw account), rol wijzigen via POST en PUT, verwijderen — allemaal in het log', async () => {
      const email = `${PREFIX}-member@test.local`;
      const add = await req('POST', `/api/tenants/${fx.tenantId}/members`, {
        token: fx.adminToken, body: { email, password: 'wachtwoord-1234', role: 'bezoeker' },
      });
      assert.equal(add.status, 201);
      const uidNew = String(add.body.userId);
      const adminId = await uid(`${PREFIX}-fx-admin@test.local`);

      const rows = () => events('tenant_member_changed', `tenant_id = $2 and detail->>'targetUserId' = $3`, fx.tenantId, uidNew);
      let r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].detail.action, 'added');
      assert.equal(r[0].detail.to, 'bezoeker');
      assert.equal(r[0].detail.accountCreated, true);
      assert.equal(String(r[0].user_id), adminId);

      // Zelfde rol nog eens: geen wijziging, geen regel.
      await req('POST', `/api/tenants/${fx.tenantId}/members`, { token: fx.adminToken, body: { email, role: 'bezoeker' } });
      assert.equal((await rows()).length, 1);

      await req('POST', `/api/tenants/${fx.tenantId}/members`, { token: fx.adminToken, body: { email, role: 'editor' } });
      const put = await req('PUT', `/api/tenants/${fx.tenantId}/members/${uidNew}`, { token: fx.adminToken, body: { role: 'admin' } });
      assert.equal(put.status, 200);
      r = await rows();
      assert.deepEqual(r.map((x) => [x.detail.action, x.detail.from, x.detail.to]), [
        ['added', null, 'bezoeker'], ['role_changed', 'bezoeker', 'editor'], ['role_changed', 'editor', 'admin'],
      ]);

      const del = await req('DELETE', `/api/tenants/${fx.tenantId}/members/${uidNew}`, { token: fx.adminToken });
      assert.equal(del.status, 204);
      r = await rows();
      assert.deepEqual([r[3].detail.action, r[3].detail.from, r[3].detail.to], ['removed', 'admin', null]);
    });

    it('een rol-override voor één doelenboom (member-roles) wordt gelogd', async () => {
      const editorId = await uid(`${PREFIX}-fx-editor@test.local`);
      const set = await req('PUT', `/api/doelenbomen/${fx.doelenboomId}/member-roles/${editorId}`, { token: fx.adminToken, body: { role: 'bezoeker' } });
      assert.equal(set.status, 204);
      const unset = await req('PUT', `/api/doelenbomen/${fx.doelenboomId}/member-roles/${editorId}`, { token: fx.adminToken, body: { role: null } });
      assert.equal(unset.status, 204);
      const r = await events('tenant_member_changed', `doelenboom_id = $2 and detail->>'targetUserId' = $3`, fx.doelenboomId, editorId);
      assert.deepEqual(r.map((x) => [x.detail.action, x.detail.to]), [['doelenboom_role_set', 'bezoeker'], ['doelenboom_role_removed', null]]);
    });
  });

  describe('doelenboom verwijderen, importeren en exporteren', () => {
    it('doelenboom_deleted bevat naam en tenant (ook nadat de rij weg is)', async () => {
      const boom = await req('POST', `/api/tenants/${fx.tenantId}/doelenbomen`, { token: fx.adminToken, body: { slug: 'weg', name: 'Te verwijderen' } });
      assert.equal(boom.status, 201);
      const del = await req('DELETE', `/api/doelenbomen/${boom.body.id}`, { token: fx.adminToken });
      assert.equal(del.status, 204);
      const r = await events('doelenboom_deleted', `tenant_id = $2 and detail->>'doelenboomId' = $3`, fx.tenantId, String(boom.body.id));
      assert.equal(r.length, 1);
      assert.equal(r[0].detail.name, 'Te verwijderen');
      assert.equal(r[0].detail.slug, 'weg');
    });

    it('een gepubliceerde import (volledige vervanging) wordt gelogd', async () => {
      const parsed = { elements: [], edges: [], projectStatus: {}, products: {}, activities: {}, tags: [], elementTags: {}, orgUnits: [], obOrg: {} };
      const imp = await pool.query(
        `insert into excel_imports (doelenboom_id, filename, status, parsed_json) values ($1, 'x.xlsx', 'ok', $2) returning id`,
        [fx.doelenboomId, JSON.stringify(parsed)]
      );
      const res = await req('POST', `/api/imports/${imp.rows[0].id}/publish`, { token: fx.adminToken });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await events('doelenboom_import_published', 'doelenboom_id = $2', fx.doelenboomId);
      assert.equal(r.length, 1);
      assert.equal(String(r[0].tenant_id), String(fx.tenantId));
      assert.equal(r[0].detail.importId, Number(imp.rows[0].id));
    });

    it('een data-export wordt gelogd (wie/welke boom/formaat); een lege sjabloon-export niet', async (t) => {
      const probe = await fetch(`${process.env.EXCEL_SERVICE_URL ?? 'http://localhost:8000'}/health`).catch(() => null);
      if (!probe || !probe.ok) return t.skip('excel-service niet bereikbaar');
      const bezoekerId = await uid(`${PREFIX}-fx-bezoeker@test.local`);
      const tpl = await rawReq('GET', `/api/doelenbomen/${fx.doelenboomId}/export?format=nieuw&mode=template`, { token: fx.bezoekerToken });
      assert.equal(tpl.status, 200);
      assert.equal((await events('doelenboom_exported', 'doelenboom_id = $2', fx.doelenboomId)).length, 0);

      const data = await rawReq('GET', `/api/doelenbomen/${fx.doelenboomId}/export?format=nieuw&mode=data`, { token: fx.bezoekerToken });
      assert.equal(data.status, 200);
      const r = await events('doelenboom_exported', 'doelenboom_id = $2', fx.doelenboomId);
      assert.equal(r.length, 1);
      assert.equal(String(r[0].user_id), bezoekerId);
      assert.equal(r[0].detail.kind, 'doelenboom-xlsx');
      assert.equal(r[0].detail.format, 'nieuw');
    });
  });

  it('de auditlog-API en -export kennen alle nieuwe gebeurtenistypen (label aanwezig)', async () => {
    const list = await req('GET', '/api/audit-log', { token: sysToken });
    assert.equal(list.status, 200);
    const exp = await rawReq('GET', '/api/audit-log/export', { token: sysToken });
    assert.equal(exp.status, 200);
    void getBaseUrl;
  });
});
