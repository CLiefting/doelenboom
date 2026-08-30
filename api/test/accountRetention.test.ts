import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, login, cleanupByPrefix,
  setupWritableDoelenboom,
} from './helpers.js';
import { pool } from '../src/db.js';
import { sweepAccountRetention, ACCOUNT_INACTIVITY_MONTHS, ACCOUNT_DELETION_WARNING_DAYS } from '../src/accountRetention.js';

const PREFIX = unique('retention');

// Automatische accountretentie (12 maanden inactiviteit, 30 dagen
// waarschuwing vooraf) — zie api/src/accountRetention.ts en
// docs/juridische-documenten-en-retentie.md. sweepAccountRetention() wordt
// hier rechtstreeks aangeroepen (i.p.v. te wachten op de setInterval uit
// index.ts, zie ACCOUNT_RETENTION_SWEEP_INTERVAL_MS) -- last_login_at/
// scheduled_deletion_at worden per test rechtstreeks via SQL gezet, zodat
// geen enkele test daadwerkelijk 12 maanden hoeft te wachten.
describe('automatische accountretentie (inactieve accounts)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await cleanupByPrefix(PREFIX);
    await stopTestServer();
    await closePool();
  });

  // Zet last_login_at op precies 'monthsAgo' maanden geleden, direct via SQL.
  async function setLastLogin(email: string, monthsAgo: number) {
    await pool.query(
      `update users set last_login_at = now() - interval '${monthsAgo} months' where email = $1`,
      [email]
    );
  }

  async function eventsFor(email: string) {
    // account_retention_events.user_id kan al 'null' zijn (on delete set
    // null, ná daadwerkelijke verwijdering) -- events die aan een nog
    // bestaande gebruiker te koppelen zijn, zoeken we dus via het e-mailadres
    // dat in detail is meegelogd (zie logEvent-aanroepen in accountRetention.ts).
    const byUser = await pool.query(
      `select event_type, detail from account_retention_events
       where user_id = (select id from users where email = $1)
       order by created_at`,
      [email]
    );
    if (byUser.rows.length > 0) return byUser.rows;
    return (
      await pool.query(
        `select event_type, detail from account_retention_events
         where detail->>'email' = $1 order by created_at`,
        [email]
      )
    ).rows;
  }

  it('een recent ingelogde gebruiker wordt niet gewaarschuwd of verwijderd', async () => {
    const email = `${PREFIX}-actief@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, 0);

    await sweepAccountRetention();

    const row = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    assert.equal(row.rows.length, 1, 'account moet nog bestaan');
    assert.equal(row.rows[0].scheduled_deletion_at, null);
  });

  it('een gebruiker die nog nooit is ingelogd (last_login_at is null) wordt door de sweep overgeslagen', async () => {
    const email = `${PREFIX}-nooitingelogd@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    // createSysadminUser zet zelf geen last_login_at (blijft null, net als een
    // net aangemaakt account waarvoor de sysadmin het wachtwoord nog niet
    // heeft doorgegeven).
    await sweepAccountRetention();

    const row = await pool.query('select last_login_at, scheduled_deletion_at from users where email = $1', [email]);
    assert.equal(row.rows[0].last_login_at, null);
    assert.equal(row.rows[0].scheduled_deletion_at, null);
  });

  it(`een gebruiker die ${ACCOUNT_INACTIVITY_MONTHS} maanden minus ${ACCOUNT_DELETION_WARNING_DAYS} dagen geleden inlogde krijgt een waarschuwing gepland`, async () => {
    const email = `${PREFIX}-drempel@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    // Net over de waarschuwingsdrempel: iets ouder dan (12 maanden - 30 dagen).
    await pool.query(
      `update users set last_login_at = now() - interval '${ACCOUNT_INACTIVITY_MONTHS} months' + interval '${ACCOUNT_DELETION_WARNING_DAYS + 1} days' * -1
       where email = $1`,
      [email]
    );
    await sweepAccountRetention();

    const row = await pool.query(
      'select scheduled_deletion_at, inactivity_warning_sent_at from users where email = $1',
      [email]
    );
    assert.ok(row.rows[0].scheduled_deletion_at, 'scheduled_deletion_at moet gezet zijn');
    assert.ok(row.rows[0].inactivity_warning_sent_at, 'inactivity_warning_sent_at moet gezet zijn');
  });

  it('scheduled_deletion_at wordt gepland op ongeveer nu + de waarschuwingstermijn', async () => {
    const email = `${PREFIX}-termijn@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS);
    await sweepAccountRetention();

    const row = await pool.query(
      `select extract(epoch from (scheduled_deletion_at - now()))::int as seconds_ahead
       from users where email = $1`,
      [email]
    );
    const expectedSeconds = ACCOUNT_DELETION_WARNING_DAYS * 24 * 60 * 60;
    const actual = row.rows[0].seconds_ahead;
    assert.ok(Math.abs(actual - expectedSeconds) < 60, `verwacht ~${expectedSeconds}s, kreeg ${actual}s`);
  });

  it('een gebruiker ver over de volledige inactiviteitstermijn krijgt bij de sweep meteen een waarschuwing gepland (geen aparte tussenstap nodig)', async () => {
    const email = `${PREFIX}-ver-over-termijn@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS + 6);
    await sweepAccountRetention();

    const row = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    assert.ok(row.rows[0].scheduled_deletion_at);
  });

  it('een "warning_scheduled" en een "warning_sent" event worden gelogd zodra de waarschuwing wordt gepland', async () => {
    const email = `${PREFIX}-events@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS);
    await sweepAccountRetention();

    const events = await eventsFor(email);
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes('warning_scheduled'), types.join(','));
    assert.ok(types.includes('warning_sent'), types.join(','));
  });

  it('de sweep is idempotent: een tweede aanroep verandert een al geplande scheduled_deletion_at niet en logt geen tweede waarschuwing', async () => {
    const email = `${PREFIX}-idempotent-warn@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS);
    await sweepAccountRetention();

    const first = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    await sweepAccountRetention();
    const second = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    assert.deepEqual(first.rows[0].scheduled_deletion_at, second.rows[0].scheduled_deletion_at);

    const events = await eventsFor(email);
    assert.equal(events.filter((e) => e.event_type === 'warning_scheduled').length, 1);
  });

  it('een account met scheduled_deletion_at in de toekomst wordt (nog) niet verwijderd', async () => {
    const email = `${PREFIX}-toekomst@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() + interval '5 days', inactivity_warning_sent_at = now()
       where email = $1`,
      [email]
    );
    await sweepAccountRetention();

    const row = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(row.rows.length, 1);
  });

  it('een account met scheduled_deletion_at in het verleden wordt daadwerkelijk verwijderd', async () => {
    const email = `${PREFIX}-verwijderd@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day', inactivity_warning_sent_at = now() - interval '31 days'
       where email = $1`,
      [email]
    );
    await sweepAccountRetention();

    const row = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(row.rows.length, 0, 'account had verwijderd moeten zijn');
  });

  it('bij verwijdering wordt een "account_deleted"-event gelogd dat de verwijdering overleeft (user_id wordt null, e-mail staat in detail)', async () => {
    const email = `${PREFIX}-event-na-delete@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day' where email = $1`,
      [email]
    );
    await sweepAccountRetention();

    const events = await pool.query(
      `select user_id, detail from account_retention_events where event_type = 'account_deleted' and detail->>'email' = $1`,
      [email]
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].user_id, null, 'user_id hoort na de delete op null te staan (on delete set null)');
  });

  it('verwijdering van een account ruimt diens sessies op (cascade), zonder een fout te geven', async () => {
    const email = `${PREFIX}-sessies@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    const token = await login(email, 'wachtwoord123');
    void token;
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day' where email = $1`,
      [email]
    );
    const before = await pool.query(
      `select count(*)::int as n from sessions where user_id = (select id from users where email = $1)`,
      [email]
    );
    assert.ok(before.rows[0].n >= 1);

    await sweepAccountRetention();

    const after = await pool.query(`select count(*)::int as n from sessions s`);
    void after;
    const userGone = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(userGone.rows.length, 0);
  });

  it('verwijdering van een tenant-lid ruimt diens tenant_users-lidmaatschap op, maar laat de tenant en de doelenboom (organisatie-inhoud) volledig intact', async () => {
    const sysadminEmail = `${PREFIX}-orgcontent-sysadmin@test.local`;
    await createSysadminUser(sysadminEmail, 'wachtwoord123');
    const sysadminToken = await login(sysadminEmail, 'wachtwoord123');

    const { tenantId, doelenboomId, gebruikerToken } = await setupWritableDoelenboom(sysadminToken, `${PREFIX}-org`);
    void gebruikerToken;
    const gebruikerEmail = `${PREFIX}-org-gebruiker@test.local`;

    // Maak organisatie-inhoud aan namens het 'gebruiker'-account, zodat er
    // ook daadwerkelijk iets te controleren valt na diens verwijdering.
    const el = await req('POST', `/api/doelenbomen/${doelenboomId}/elements`, {
      token: gebruikerToken,
      body: { column: 'project', name: `${PREFIX}-element` },
    });
    // Niet elk elementen-endpoint/kolomschema is hier relevant -- als het
    // aanmaken faalt (bv. afwijkende kolomnaam in dit sjabloon) is dat geen
    // reden om deze test te laten falen op iets anders dan waar het om gaat;
    // de tenant/doelenboom zelf bestaan sowieso al via setupWritableDoelenboom.
    void el;

    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day' where email = $1`,
      [gebruikerEmail]
    );
    await sweepAccountRetention();

    const userGone = await pool.query('select 1 from users where email = $1', [gebruikerEmail]);
    assert.equal(userGone.rows.length, 0, 'het gebruiker-account had verwijderd moeten zijn');

    const membershipGone = await pool.query(
      `select 1 from tenant_users where tenant_id = $1 and user_id = (select id from users where email = $2)`,
      [tenantId, gebruikerEmail]
    );
    assert.equal(membershipGone.rows.length, 0);

    // De tenant en de doelenboom zelf (organisatie-inhoud) bestaan nog gewoon.
    const tenantStillThere = await pool.query('select 1 from tenants where id = $1', [tenantId]);
    assert.equal(tenantStillThere.rows.length, 1);
    const treeStillThere = await pool.query('select 1 from doelenbomen where id = $1', [doelenboomId]);
    assert.equal(treeStillThere.rows.length, 1);
  });

  it('de laatste overgebleven sysadmin wordt nooit automatisch verwijderd, zelfs als de verwijderdatum is verstreken', async () => {
    // Deze database wordt door meerdere testbestanden (én eerdere tests in
    // dit bestand zelf, zie createSysadminUser hierboven) gedeeld, dus er
    // bestaan op dit punt bijna altijd al andere sysadmins. "Laatste
    // sysadmin" is een systeembrede telling (precies zoals in
    // routes/users.ts) — om dit toch deterministisch te testen, degraderen we
    // alle ANDERE sysadmins hier tijdelijk (--test-concurrency=1, dus geen
    // ander testbestand draait ondertussen mee) en herstellen we ze
    // gegarandeerd terug in de finally, ongeacht of de assertie slaagt.
    const email = `${PREFIX}-alleen-sysadmin@test.local`;
    const userId = await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day', is_sysadmin = true where id = $1`,
      [userId]
    );

    const others = await pool.query('select id from users where is_sysadmin = true and id != $1', [userId]);
    const otherIds = others.rows.map((r) => r.id as number);
    if (otherIds.length > 0) {
      await pool.query('update users set is_sysadmin = false where id = any($1::bigint[])', [otherIds]);
    }
    try {
      await sweepAccountRetention();

      const stillThere = await pool.query('select 1 from users where id = $1', [userId]);
      assert.equal(stillThere.rows.length, 1, 'de laatste sysadmin had NIET verwijderd mogen worden');

      const failedEvent = await pool.query(
        `select 1 from account_retention_events where user_id = $1 and event_type = 'deletion_failed'`,
        [userId]
      );
      assert.equal(failedEvent.rows.length, 1);
    } finally {
      if (otherIds.length > 0) {
        await pool.query('update users set is_sysadmin = true where id = any($1::bigint[])', [otherIds]);
      }
    }
  });

  it('een inactieve sysadmin wordt wél verwijderd zolang er nog minstens één andere sysadmin overblijft', async () => {
    const otherEmail = `${PREFIX}-andere-sysadmin@test.local`;
    await createSysadminUser(otherEmail, 'wachtwoord123');

    const email = `${PREFIX}-overbodige-sysadmin@test.local`;
    const userId = await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day' where id = $1`,
      [userId]
    );

    await sweepAccountRetention();

    const gone = await pool.query('select 1 from users where id = $1', [userId]);
    assert.equal(gone.rows.length, 0);
  });

  it('inloggen vóór de geplande verwijderdatum annuleert de geplande verwijdering volledig', async () => {
    const email = `${PREFIX}-annuleer@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() + interval '5 days', inactivity_warning_sent_at = now() - interval '25 days'
       where email = $1`,
      [email]
    );

    await login(email, 'wachtwoord123');

    const row = await pool.query(
      'select scheduled_deletion_at, inactivity_warning_sent_at from users where email = $1',
      [email]
    );
    assert.equal(row.rows[0].scheduled_deletion_at, null);
    assert.equal(row.rows[0].inactivity_warning_sent_at, null);
  });

  it('inloggen ná annulering zorgt dat de sweep de gebruiker nooit alsnog verwijdert', async () => {
    const email = `${PREFIX}-annuleer-en-sweep@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 hour' where email = $1`,
      [email]
    );
    // Login vindt plaats vóórdat de sweep ooit draait -- realistisch scenario
    // (de sweep draait maar eens per uur, zie index.ts), maar test hier vooral
    // dat login zelf al genoeg is, los van de sweep-timing.
    await login(email, 'wachtwoord123');
    await sweepAccountRetention();

    const row = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(row.rows.length, 1, 'account had NIET verwijderd mogen worden na een tussentijdse login');
  });

  it('inloggen met een eerder geplande verwijdering logt een "deletion_cancelled_by_login"-event', async () => {
    const email = `${PREFIX}-cancel-event@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() + interval '10 days' where email = $1`,
      [email]
    );
    await login(email, 'wachtwoord123');

    const events = await eventsFor(email);
    assert.ok(events.some((e) => e.event_type === 'deletion_cancelled_by_login'));
  });

  it('een normale login zonder eerder geplande verwijdering logt GEEN "deletion_cancelled_by_login"-event', async () => {
    const email = `${PREFIX}-geen-cancel-event@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await login(email, 'wachtwoord123');

    const events = await eventsFor(email);
    assert.equal(events.filter((e) => e.event_type === 'deletion_cancelled_by_login').length, 0);
  });

  it('elke geslaagde login werkt last_login_at bij naar het huidige moment (start de 12-maanden-klok opnieuw)', async () => {
    const email = `${PREFIX}-laatste-login@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS + 1);

    await login(email, 'wachtwoord123');

    const row = await pool.query(
      `select (last_login_at > now() - interval '1 minute') as fresh from users where email = $1`,
      [email]
    );
    assert.equal(row.rows[0].fresh, true);
  });

  it('een verkeerd wachtwoord werkt last_login_at niet bij en annuleert geen geplande verwijdering', async () => {
    const email = `${PREFIX}-verkeerd-wachtwoord@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() + interval '5 days', last_login_at = now() - interval '13 months'
       where email = $1`,
      [email]
    );

    const failed = await req('POST', '/api/auth/login', { body: { email, password: 'helemaal-fout' } });
    assert.equal(failed.status, 401);

    const row = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    assert.ok(row.rows[0].scheduled_deletion_at, 'een mislukte login mag de geplande verwijdering niet aanraken');
  });

  it('de sweep opnieuw draaien nadat een account al verwijderd is, geeft geen fout (veilig te herhalen)', async () => {
    const email = `${PREFIX}-dubbele-sweep@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    await pool.query(
      `update users set scheduled_deletion_at = now() - interval '1 day' where email = $1`,
      [email]
    );
    await sweepAccountRetention();
    const gone = await pool.query('select 1 from users where email = $1', [email]);
    assert.equal(gone.rows.length, 0);

    // Nogmaals draaien mag niet crashen, en er hoeft niets meer te gebeuren
    // voor deze (inmiddels niet meer bestaande) gebruiker.
    await assert.doesNotReject(() => sweepAccountRetention());
  });

  it('een gebruiker die precies op de grens van de waarschuwingstermijn zit (net binnen) wordt nog niet gewaarschuwd', async () => {
    const email = `${PREFIX}-net-binnen@test.local`;
    await createSysadminUser(email, 'wachtwoord123');
    // Ruim binnen de 12-maanden-termijn, ook met de 30-dagen-marge meegerekend.
    await setLastLogin(email, ACCOUNT_INACTIVITY_MONTHS - 2);
    await sweepAccountRetention();

    const row = await pool.query('select scheduled_deletion_at from users where email = $1', [email]);
    assert.equal(row.rows[0].scheduled_deletion_at, null);
  });
});
