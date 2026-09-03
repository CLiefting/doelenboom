import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
} from './helpers.js';
import { pool } from '../src/db.js';

const PREFIX = unique('auth');

describe('auth', () => {
  let sysadminEmail: string;

  before(async () => {
    await startTestServer();
    sysadminEmail = `${PREFIX}-admin@test.local`;
    await createSysadminUser(sysadminEmail, 'geheim1234');
  });

  after(async () => {
    // De lockout-tests hieronder wijzigen app_settings (een app-brede
    // singleton, niet PREFIX-gescopet) — terugzetten naar de standaardwaarden
    // zodat dit niet doorlekt naar andere testbestanden in dezelfde run.
    await pool.query(
      'update app_settings set max_failed_login_attempts = 5, login_lockout_minutes = 15 where id = 1'
    );
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  it('POST /api/auth/login weigert onbekend e-mailadres', async () => {
    const { status, body } = await req('POST', '/api/auth/login', {
      body: { email: 'niet-bestaand@test.local', password: 'watdanook' },
    });
    assert.equal(status, 401);
    assert.match(body.error, /Onjuiste inloggegevens/);
  });

  it('POST /api/auth/login weigert verkeerd wachtwoord', async () => {
    const { status } = await req('POST', '/api/auth/login', {
      body: { email: sysadminEmail, password: 'fout-wachtwoord' },
    });
    assert.equal(status, 401);
  });

  it('POST /api/auth/login geeft 400 zonder e-mail/wachtwoord', async () => {
    const { status } = await req('POST', '/api/auth/login', { body: {} });
    assert.equal(status, 400);
  });

  it('POST /api/auth/login geeft een token + user terug bij juiste gegevens', async () => {
    const { status, body } = await req('POST', '/api/auth/login', {
      body: { email: sysadminEmail, password: 'geheim1234' },
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.user.email, sysadminEmail);
    assert.equal(body.user.isSysadmin, true);
  });

  it('GET /api/auth/me vereist een geldig token', async () => {
    const noToken = await req('GET', '/api/auth/me');
    assert.equal(noToken.status, 401);

    const badToken = await req('GET', '/api/auth/me', { token: 'onzin.token.hier' });
    assert.equal(badToken.status, 401);

    const token = await login(sysadminEmail, 'geheim1234');
    const ok = await req('GET', '/api/auth/me', { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, sysadminEmail);
  });

  it('POST /api/auth/change-password wijzigt het wachtwoord en logt daarna in met het nieuwe', async () => {
    const email = `${PREFIX}-cp@test.local`;
    await createSysadminUser(email, 'oud-wachtwoord1');
    const token = await login(email, 'oud-wachtwoord1');

    const wrongCurrent = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'niet-het-huidige', newPassword: 'nieuw-wachtwoord1' },
    });
    assert.equal(wrongCurrent.status, 401);

    const tooShort = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'oud-wachtwoord1', newPassword: 'kort' },
    });
    assert.equal(tooShort.status, 400);

    const ok = await req('POST', '/api/auth/change-password', {
      token,
      body: { currentPassword: 'oud-wachtwoord1', newPassword: 'nieuw-wachtwoord1' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.mustChangePassword, false);

    const newLogin = await req('POST', '/api/auth/login', { body: { email, password: 'nieuw-wachtwoord1' } });
    assert.equal(newLogin.status, 200);
    const oldLogin = await req('POST', '/api/auth/login', { body: { email, password: 'oud-wachtwoord1' } });
    assert.equal(oldLogin.status, 401);
  });

  it('POST /api/auth/heartbeat werkt de sessie bij (204, geen body)', async () => {
    const token = await login(sysadminEmail, 'geheim1234');
    const res = await req('POST', '/api/auth/heartbeat', { token });
    assert.equal(res.status, 204);
  });

  it('logout-preview en logout werken voor een ingelogde gebruiker zonder tenants', async () => {
    const email = `${PREFIX}-logout@test.local`;
    await createSysadminUser(email, 'logout-wachtwoord1');
    const token = await login(email, 'logout-wachtwoord1');

    const preview = await req('GET', '/api/auth/logout-preview', { token });
    assert.equal(preview.status, 200);
    assert.ok(Array.isArray(preview.body.wouldWipe));

    const out = await req('POST', '/api/auth/logout', { token });
    assert.equal(out.status, 200);
    assert.ok(Array.isArray(out.body.wiped));
  });

  it('een beëindigde sessie (na logout) werkt niet meer, ook al is de JWT zelf nog geldig', async () => {
    const email = `${PREFIX}-ended@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    const before = await req('GET', '/api/auth/me', { token });
    assert.equal(before.status, 200);

    await req('POST', '/api/auth/logout', { token });

    const after = await req('GET', '/api/auth/me', { token });
    assert.equal(after.status, 401);
    assert.equal(after.body.reason, 'session_ended');
  });

  // 15-minuten-inactiviteit-beveiliging (zie auth.ts requireAuth/IDLE_TIMEOUT_MINUTES
  // en POST /activity). Simuleert "15+ minuten geleden" door last_activity_at
  // rechtstreeks terug te zetten — geen 15 minuten wachten in de testrun.
  it('POST /api/auth/activity ververst last_activity_at (échte activiteit, anders dan heartbeat)', async () => {
    const email = `${PREFIX}-activity@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    const res = await req('POST', '/api/auth/activity', { token });
    assert.equal(res.status, 204);

    const row = await pool.query(
      `select (last_activity_at > now() - interval '1 minute') as fresh
       from sessions s join users u on u.id = s.user_id where u.email = $1`,
      [email]
    );
    assert.equal(row.rows[0].fresh, true);
  });

  it('een sessie zonder activiteit voor langer dan 15 minuten wordt door requireAuth geweigerd', async () => {
    const email = `${PREFIX}-idle@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');

    // Nog vers (net ingelogd): werkt gewoon.
    const fresh = await req('GET', '/api/auth/me', { token });
    assert.equal(fresh.status, 200);

    // Simuleer 20 minuten geen activiteit.
    await pool.query(
      `update sessions set last_activity_at = now() - interval '20 minutes'
       where user_id = (select id from users where email = $1)`,
      [email]
    );

    const stale = await req('GET', '/api/auth/me', { token });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.reason, 'idle_timeout');

    // Eenmaal over de 15-minuten-grens is er geen stilzwijgend herstel meer —
    // ook /heartbeat en /activity zelf lopen eerst door requireAuth en falen
    // dus net zo goed met 401. Dit is bewust een harde afkap, geen glijdend
    // venster: de enige weg terug is opnieuw inloggen (een nieuwe sessie met
    // een verse last_activity_at), niet één latere activiteit die de oude,
    // al-verlopen sessie stilletjes nieuw leven inblaast.
    const heartbeatStillBlocked = await req('POST', '/api/auth/heartbeat', { token });
    assert.equal(heartbeatStillBlocked.status, 401);
    const activityStillBlocked = await req('POST', '/api/auth/activity', { token });
    assert.equal(activityStillBlocked.status, 401);
    assert.equal(activityStillBlocked.body.reason, 'idle_timeout');

    // Opnieuw inloggen geeft een verse sessie (nieuwe JWT + nieuwe sessions-rij
    // met last_activity_at = now()) die weer gewoon werkt.
    const freshToken = await login(email, 'wachtwoord123');
    const afterRelogin = await req('GET', '/api/auth/me', { token: freshToken });
    assert.equal(afterRelogin.status, 200);
  });

  // Rate limiting / accountblokkade (zie auth.ts POST /login en
  // appSettings.ts) — drempel/duur zijn hier bewust laag gezet via
  // /api/app-settings zelf, zodat de test niet op de standaardwaarden
  // (5 pogingen / 15 minuten) hoeft te wachten of te vertrouwen. Alles wordt
  // in de after-hook hierboven weer teruggezet naar de standaardwaarden.
  it('een account wordt na het instelbare aantal mislukte pogingen tijdelijk geblokkeerd', async () => {
    const settingsRes = await req('PUT', '/api/app-settings', {
      token: await login(sysadminEmail, 'geheim1234'),
      body: { maxFailedLoginAttempts: 3, loginLockoutMinutes: 15 },
    });
    assert.equal(settingsRes.status, 200);

    const email = `${PREFIX}-lockout@test.local`;
    await createSysadminUser(email, 'juist-wachtwoord1');

    // 2 mislukte pogingen: nog gewoon 401, geen blokkade.
    const eerste = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(eerste.status, 401);
    const tweede = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(tweede.status, 401);

    // Zelfs het JUISTE wachtwoord wordt hierna nog niet geaccepteerd, want de
    // teller staat nu op 2 (nog niet geblokkeerd) — dit checkt puur dat een
    // niet-geblokkeerd account met een juist wachtwoord gewoon doorgaat, dus
    // we bewaren deze poging niet en gaan door naar de 3e mislukte poging.

    // 3e mislukte poging bereikt de drempel (3): account raakt geblokkeerd.
    const derde = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(derde.status, 429);
    assert.equal(derde.body.reason, 'account_locked');

    // Ook het JUISTE wachtwoord wordt nu geweigerd zolang de blokkade actief is
    // — geen vroegtijdige uitzondering voor een toevallig correcte poging.
    const juistTijdensBlokkade = await req('POST', '/api/auth/login', {
      body: { email, password: 'juist-wachtwoord1' },
    });
    assert.equal(juistTijdensBlokkade.status, 429);
    assert.equal(juistTijdensBlokkade.body.reason, 'account_locked');

    // Simuleer dat de blokkadeperiode al is verstreken (geen 15 minuten
    // wachten in de testrun) door locked_until rechtstreeks terug te zetten.
    await pool.query(
      `update users set locked_until = now() - interval '1 minute' where email = $1`,
      [email]
    );
    const naBlokkade = await req('POST', '/api/auth/login', {
      body: { email, password: 'juist-wachtwoord1' },
    });
    assert.equal(naBlokkade.status, 200);

    // Een geslaagde login reset de teller/blokkade volledig.
    const row = await pool.query(
      'select failed_login_count, locked_until from users where email = $1',
      [email]
    );
    assert.equal(row.rows[0].failed_login_count, 0);
    assert.equal(row.rows[0].locked_until, null);
  });

  it('een geslaagde login tussen mislukte pogingen in reset de teller (geen opeenstapeling)', async () => {
    const settingsRes = await req('PUT', '/api/app-settings', {
      token: await login(sysadminEmail, 'geheim1234'),
      body: { maxFailedLoginAttempts: 3, loginLockoutMinutes: 15 },
    });
    assert.equal(settingsRes.status, 200);

    const email = `${PREFIX}-lockout-reset@test.local`;
    await createSysadminUser(email, 'juist-wachtwoord1');

    await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    const geslaagd = await req('POST', '/api/auth/login', { body: { email, password: 'juist-wachtwoord1' } });
    assert.equal(geslaagd.status, 200);

    // Teller staat weer op 0: nog 2 mislukte pogingen nodig voordat de
    // volgende (3e) daadwerkelijk blokkeert, niet meteen weer 1 poging.
    const derdeInRij = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(derdeInRij.status, 401);
    const vierdeInRij = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(vierdeInRij.status, 401);
    const vijfdeInRij = await req('POST', '/api/auth/login', { body: { email, password: 'fout' } });
    assert.equal(vijfdeInRij.status, 429);
  });
});
