import crypto from 'node:crypto';
import { pool } from './db.js';
import { hashSql } from './passwordHash.js';
import { sendRegistrationExistingAccountEmail, sendRegistrationVerificationEmail } from './email.js';
import { createSubscriptionRequest, prepareSubscriptionRequest, SubscriptionRequestInput } from './subscriptions.js';

// E-mailverificatie voor de publieke aanvraag (DOEL-20, analyse H1) — zie
// db/migrations/0040_pending_registrations.sql voor de opzet.
//
// Flow: submitRegistration() (POST /api/subscription-requests) bewaart de
// gevalideerde aanvraag als 'nog te bevestigen' en mailt een link; pas
// confirmRegistration() (POST /api/subscription-requests/confirm) maakt tenant
// + account aan. De respons op het indienen is ALTIJD dezelfde, ook als het
// e-mailadres al een account heeft (dan gaat er een andere mail uit) — zo
// verklapt dit endpoint niet welke adressen bekend zijn.

export const REGISTRATION_TTL_HOURS = 24;
// Maximaal zoveel verificatiemails per e-mailadres per uur — remt mail-
// bombardement van een derde (aanvragen met andermans adres). Daarboven wordt
// er stilzwijgend niet meer gemaild (de respons blijft identiek).
const MAX_MAILS_PER_EMAIL_PER_HOUR = 3;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Basis-URL van de web-app voor links in e-mails (APP_BASE_URL, zonder slash
// aan het eind). Lokale dev: de Vite-server.
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

export type RegistrationInput = Omit<SubscriptionRequestInput, 'password' | 'passwordHash'> & { password: string };

export async function submitRegistration(input: RegistrationInput): Promise<void> {
  // Tier/modules/prijs nu al controleren: een duidelijke 400 voor de aanvrager,
  // en niet afhankelijk van of het adres bekend is. (Gooit SubscriptionRequestError.)
  await prepareSubscriptionRequest(input);

  // Het wachtwoord hashen we ook als het adres al bekend is (en het resultaat
  // dan weggooien): zo verschilt de rekentijd niet merkbaar tussen "bekend" en
  // "onbekend" adres.
  const hash = await pool.query(`select ${hashSql('$1')} as h`, [input.password]);

  const existing = await pool.query('select 1 from users where email = $1', [input.applicantEmail]);
  if (existing.rows.length > 0) {
    // Niet wachten op de mail (uniforme responstijd) en een mailfout mag de respons niet veranderen.
    void sendRegistrationExistingAccountEmail(input.applicantEmail, `${appBaseUrl()}/`).catch((err) => {
      console.error('Mail "account bestaat al" mislukt:', err);
    });
    return;
  }

  const recent = await pool.query(
    `select count(*)::int as n from pending_registrations
     where email = $1 and created_at > now() - interval '1 hour'`,
    [input.applicantEmail]
  );
  if ((recent.rows[0].n as number) >= MAX_MAILS_PER_EMAIL_PER_HOUR) return;

  const token = crypto.randomBytes(32).toString('base64url');
  const { password: _password, ...rest } = input;
  const payload = { ...rest, passwordHash: hash.rows[0].h as string };

  const client = await pool.connect();
  try {
    await client.query('begin');
    // Een nieuwe aanvraag maakt eerdere onbevestigde links voor dit adres
    // ongeldig. De rijen blijven bewaard (als 'verbruikt' gemarkeerd) zodat de
    // per-uur-throttle hierboven ze nog meetelt; de uursweep ruimt ze later op.
    await client.query(
      'update pending_registrations set consumed_at = now() where email = $1 and consumed_at is null',
      [input.applicantEmail]
    );
    await client.query(
      `insert into pending_registrations (email, token_hash, payload, expires_at)
       values ($1, $2, $3, now() + make_interval(hours => $4))`,
      [input.applicantEmail, sha256Hex(token), JSON.stringify(payload), REGISTRATION_TTL_HOURS]
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  // Het token staat in het URL-fragment (#) i.p.v. de querystring: een
  // fragment gaat niet mee naar de server (geen token in nginx-/proxy-logs of
  // Referer-headers).
  const link = `${appBaseUrl()}/aanvraag/bevestigen#${token}`;
  void sendRegistrationVerificationEmail(input.applicantEmail, link, input.organizationName, REGISTRATION_TTL_HOURS).catch(
    (err) => console.error('Verificatiemail versturen mislukt:', err)
  );
}

export class InvalidRegistrationTokenError extends Error {}

export async function confirmRegistration(
  token: string
): Promise<{ tenantId: number; tenantSlug: string; requestId: number }> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new InvalidRegistrationTokenError();
  // Atomisch "verbruiken": twee gelijktijdige kliks maken maar één tenant aan.
  const claimed = await pool.query(
    `update pending_registrations set consumed_at = now()
     where token_hash = $1 and consumed_at is null and expires_at > now()
     returning payload`,
    [sha256Hex(token)]
  );
  if (claimed.rows.length === 0) throw new InvalidRegistrationTokenError();
  const payload = claimed.rows[0].payload as SubscriptionRequestInput;
  // Mislukt het aanmaken (SubscriptionRequestError: bv. tier inmiddels
  // verdwenen of adres tussentijds elders geregistreerd), dan blijft de link
  // verbruikt; de route toont de reden en de aanvrager kan opnieuw aanvragen.
  return createSubscriptionRequest(payload);
}

// Opruimen (uursweep in index.ts): verlopen of al verbruikte rijen na 7 dagen.
export async function sweepPendingRegistrations(): Promise<number> {
  const r = await pool.query(
    `delete from pending_registrations
     where expires_at < now() - interval '7 days' or consumed_at < now() - interval '7 days'`
  );
  return r.rowCount ?? 0;
}
