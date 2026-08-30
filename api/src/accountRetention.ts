import { pool } from './db.js';

// Automatische accountretentie (inactieve accounts) — zie
// db/migrations/0017_legal_and_retention.sql en
// docs/juridische-documenten-en-retentie.md voor het volledige ontwerp.
//
// Beleid (§25 van de opdracht: geen magic numbers, centraal configureerbaar —
// een wijziging hier moet bewust gebeuren en nooit stilzwijgend afwijken van
// wat de gepubliceerde voorwaarden/privacyverklaring beschrijven):
//   - Een account is "inactief" wanneer users.last_login_at ouder is dan
//     ACCOUNT_INACTIVITY_MONTHS maanden. last_login_at is de enige gekozen
//     definitie van "relevant gebruik" (gezet bij elke geslaagde login, zie
//     auth.ts) — bewust NIET sessions.last_seen_at/last_activity_at, want die
//     zijn per-sessie en vluchtig (verdwijnen niet bij afmelden, zeggen niets
//     over "is dit account nog in gebruik").
//   - ACCOUNT_DELETION_WARNING_DAYS vóór de daadwerkelijke verwijderdatum
//     krijgt de gebruiker een waarschuwing (nu: alleen gelogd, zie
//     sendInactivityWarning hieronder — expliciete keuze van de opdrachtgever,
//     "Nu alleen loggen, mail later aansluiten").
//
// Idempotentie: elke stap controleert eerst of hij al is uitgevoerd
// (inactivity_warning_sent_at / scheduled_deletion_at) voordat hij iets doet,
// zodat de sweep onbeperkt vaak opnieuw mag draaien (§11 van de opdracht) —
// zowel bij een herstart van het proces als bij een interval dat elkaar
// overlapt.
export const ACCOUNT_INACTIVITY_MONTHS = 12;
export const ACCOUNT_DELETION_WARNING_DAYS = 30;

async function logEvent(
  userId: number | null,
  eventType:
    | 'warning_scheduled'
    | 'warning_sent'
    | 'warning_send_failed'
    | 'deletion_cancelled_by_login'
    | 'account_deleted'
    | 'deletion_failed',
  detail: Record<string, unknown> = {}
) {
  await pool.query(
    `insert into account_retention_events (user_id, event_type, detail) values ($1, $2, $3::jsonb)`,
    [userId, eventType, JSON.stringify(detail)]
  );
}

// Stap 1: gebruikers die nu de waarschuwingsdrempel (12 maanden - 30 dagen
// inactiviteit) overschrijden krijgen een scheduled_deletion_at gezet en een
// (voorlopig alleen gelogde) waarschuwingsmail. Alleen wie nog geen
// scheduled_deletion_at heeft (idempotent — een keer per account, niet
// opnieuw bij elke sweep) en waarvan last_login_at niet null is (accounts
// zonder ooit een login worden hier bewust buiten gelaten, zie
// docs/juridische-documenten-en-retentie.md — "relevant gebruik" veronderstelt
// tenminste één login te hebben plaatsgevonden).
async function scheduleWarnings() {
  const candidates = await pool.query(
    `select id, email from users
     where last_login_at is not null
       and scheduled_deletion_at is null
       and last_login_at < now() - interval '${ACCOUNT_INACTIVITY_MONTHS} months' + interval '${ACCOUNT_DELETION_WARNING_DAYS} days'`
  );

  for (const row of candidates.rows) {
    const userId = row.id as number;
    const scheduledDeletionAt = `now() + interval '${ACCOUNT_DELETION_WARNING_DAYS} days'`;
    await pool.query(
      `update users
       set scheduled_deletion_at = ${scheduledDeletionAt}, inactivity_warning_sent_at = now()
       where id = $1 and scheduled_deletion_at is null`,
      [userId]
    );
    await logEvent(userId, 'warning_scheduled', { email: row.email });
    await sendInactivityWarning(userId, row.email as string);
  }
}

// Verzenden van de waarschuwingsmail — bewust een geïsoleerde functie met
// eigen try/catch: een falende verzending mag de sweep, en zeker de
// uiteindelijke automatische verwijdering, nooit blokkeren (§10 van de
// opdracht). Er bestaat op dit moment nergens in dit project een
// mailprovider (geen SMTP/nodemailer/sendgrid/etc., zie analyse) — in overleg
// met de opdrachtgever ("Nu alleen loggen, mail later aansluiten") is dit
// daarom voorlopig een log-only stub. Het aanroepende punt
// (scheduleWarnings hierboven) en het account_retention_events-logboek zijn al
// volledig op orde; het enige dat later verandert is de inhoud van deze ene
// functie zodra er een echte provider wordt aangesloten.
async function sendInactivityWarning(userId: number, email: string) {
  try {
    // TODO: vervang door een echte mailprovider zodra die is gekozen/aangesloten.
    console.log(
      `[accountRetention] (log-only, geen mailprovider aangesloten) ` +
        `Zou waarschuwingsmail sturen naar ${email} (user ${userId}): ` +
        `"Je Doelenboom-account wordt binnenkort verwijderd"`
    );
    await logEvent(userId, 'warning_sent', { email, channel: 'log-only' });
  } catch (err) {
    await logEvent(userId, 'warning_send_failed', { email, error: (err as Error).message });
  }
}

// Stap 2: accounts waarvan de geplande verwijderdatum is verstreken worden nu
// daadwerkelijk verwijderd. Hergebruikt exact dezelfde 'delete from users
// where id = $1' als het bestaande handmatige DELETE /api/users/:id (zie
// routes/users.ts) — die is al aantoonbaar veilig voor organisatie-inhoud:
// geen enkele organisatie-content-tabel (elementen, kanten, producten,
// activiteiten, ...) heeft een foreign key naar users, dus verwijdering van
// een account kan nooit organisatiedata meenemen (§13/14 van de opdracht).
// Sessies/tenant-lidmaatschappen/rollen cascaden wél (sessions, tenant_users,
// doelenboom_user_roles) — dat zijn puur toegangsrechten van dit ene account,
// geen organisatie-inhoud, en cascaden dus terecht weg.
//
// Dezelfde "minstens één sysadmin moet overblijven"-bescherming als het
// handmatige verwijderendpoint (routes/users.ts) wordt hier gerepliceerd: een
// inactieve sysadmin wordt nooit automatisch verwijderd als daarmee het
// laatste sysadmin-account zou verdwijnen. In dat geval wordt de verwijdering
// overgeslagen (niet hard gefaald) en gelogd, zodat een sysadmin het
// handmatig kan beoordelen.
async function deleteExpiredAccounts() {
  const candidates = await pool.query(
    `select id, email, is_sysadmin from users
     where scheduled_deletion_at is not null and scheduled_deletion_at < now()`
  );

  for (const row of candidates.rows) {
    const userId = row.id as number;
    try {
      if (row.is_sysadmin) {
        const countResult = await pool.query(
          'select count(*)::int as n from users where is_sysadmin = true and id != $1',
          [userId]
        );
        if (countResult.rows[0].n === 0) {
          await logEvent(userId, 'deletion_failed', {
            email: row.email,
            reason: 'laatste-sysadmin-zou-overblijven',
          });
          continue;
        }
      }
      // Log vóór de delete (na de delete zou een 'on delete set null' de
      // user_id al naar null hebben gezet — dat is prima voor het historische
      // audit-record, maar we willen het e-mailadres nu nog vastleggen als
      // extra context bij het moment van verwijdering).
      await logEvent(userId, 'account_deleted', {
        email: row.email,
        reason: 'inactiviteit',
        inactivityMonths: ACCOUNT_INACTIVITY_MONTHS,
      });
      await pool.query('delete from users where id = $1', [userId]);
    } catch (err) {
      await logEvent(userId, 'deletion_failed', { email: row.email, error: (err as Error).message });
    }
  }
}

// Eén functie die beide stappen doet — dit is wat index.ts periodiek aanroept
// (zie de nieuwe setInterval daar, naast de al bestaande idle-sweep). Bewust
// niet vaker dan één keer per (ruim) etmaal nodig: dit is een dag-granulaire
// beleidscontrole, geen realtime concern, zie de gekozen interval in index.ts.
export async function sweepAccountRetention() {
  await scheduleWarnings();
  await deleteExpiredAccounts();
}
