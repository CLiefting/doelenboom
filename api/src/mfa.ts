import crypto from 'node:crypto';
import { pool } from './db.js';
import { sendMfaEmail } from './email.js';
import { logAuditEvent } from './auditLog.js';

// Tweestapsverificatie (MFA) — zie doelenboom_mfa_ontwerp.md in het project
// voor het volledige ontwerp. Kernprincipe: er bestaat GEEN sessie/JWT totdat
// een challenge hier succesvol geverifieerd is (auth.ts roept dit pas ná
// createMfaChallenge() de eigenlijke login-afronding aan) — anders dan
// mustChangePassword (dat geeft al wél een geldig token) zou een kaal token
// vóór MFA de bedoelde bescherming omzeilbaar maken.

// Geen 0/O/1/I/L — te makkelijk te verwarren bij overtypen vanuit een
// e-mail. 31 tekens, 6 lang => 31^6 ≈ 887 miljoen combinaties, ruim genoeg
// gegeven de 10-minuten-geldigheid en MAX_ATTEMPTS hieronder.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const MAX_RESENDS = 3;
export const RESEND_COOLDOWN_SECONDS = 30;

export function generateMfaCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    // crypto.randomInt (niet Math.random()) — cryptografisch veilige
    // willekeur, zelfde eis als bij het JWT-geheim/sessie-ids elders.
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function generateChallengeId(): string {
  // Ondoorzichtige, willekeurige token — dit IS de "challengeId" die de
  // frontend tussen /login en /mfa/verify heen en weer stuurt. Niet geheim op
  // zichzelf (de échte beveiliging zit in de gemailde code), maar wel
  // onvoorspelbaar zodat niemand een andermans lopende challenge kan raden.
  return crypto.randomBytes(24).toString('base64url');
}

export interface MfaChallenge {
  challengeId: string;
  expiresInSeconds: number;
}

// Maakt een nieuwe challenge aan én verstuurt de code — hergebruikt door
// zowel "net ingelogd, MFA vereist" (auth.ts) als een expliciete resend
// hieronder (die vervangt de code IN dezelfde challenge-rij, zie
// resendMfaChallenge).
export async function createMfaChallenge(userId: number, email: string): Promise<MfaChallenge> {
  const code = generateMfaCode();
  const id = generateChallengeId();
  await pool.query(
    `insert into mfa_challenges (id, user_id, code_hash, expires_at)
     values ($1, $2, crypt($3, gen_salt('bf')), now() + make_interval(mins => $4))`,
    [id, userId, code, CODE_TTL_MINUTES]
  );
  await sendMfaEmail(email, code, CODE_TTL_MINUTES);
  return { challengeId: id, expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

export type VerifyMfaResult =
  | { ok: true; userId: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' | 'too_many_attempts' | 'wrong_code' };

// SEC-004: dit was voorheen een SELECT (lees attempts/expires_at/consumed_at,
// vergelijk de code) gevolgd door een aparte UPDATE die de gelezen waarde
// ophoogde — een klassieke read-check-write race. Twee gelijktijdige verify-
// aanvragen op dezelfde challenge konden allebei dezelfde (verouderde)
// attempts-waarde lezen vóórdat de eerste zijn UPDATE had weggeschreven,
// waardoor de MAX_ATTEMPTS-limiet met genoeg parallelle requests te omzeilen
// was; hetzelfde gold voor het tweemaal "succesvol" verbruiken van precies
// dezelfde (juiste) code.
//
// Nu: één atomische UPDATE ... WHERE ... RETURNING. Postgres vergrendelt de
// rij per UPDATE-transactie, dus concurrent aanvragen op dezelfde challenge
// worden geserialiseerd — elke aanvraag evalueert de WHERE-voorwaarden tegen
// de dan actuele rijstatus, nooit tegen een waarde die een andere, nog niet
// gecommitte aanvraag inmiddels alweer heeft gewijzigd:
//   - bij een foute code: attempts + 1 (consumed_at blijft ongemoeid);
//   - bij de juiste code: consumed_at = now() (attempts blijft ongemoeid) —
//     dit claimt de challenge in dezelfde stap, dus een tweede gelijktijdige
//     aanvraag met exact dezelfde juiste code kan de rij niet meer matchen
//     (consumed_at is dan al niet meer null) en krijgt terecht 'already_used'.
// De WHERE-voorwaarden (niet verbruikt, niet verlopen, attempts nog onder de
// limiet) zorgen er bovendien voor dat een challenge die de limiet al had
// bereikt sowieso niet meer matcht — ook niet met de juiste code, zelfde
// gedrag als voorheen.
//
// Matcht de UPDATE niets, dan is de challenge onbekend, al verbruikt,
// verlopen, of had 'm de limiet al bereikt — de losse SELECT hieronder dient
// dan alléén nog om de juiste foutmelding te bepalen. Die tweede lezing hoeft
// niet atomisch te zijn: de afdwinging zelf is hierboven al gebeurd.
export async function verifyMfaChallenge(challengeId: string, code: string): Promise<VerifyMfaResult> {
  const claim = await pool.query(
    `update mfa_challenges
       set attempts = case when code_hash = crypt($2, code_hash) then attempts else attempts + 1 end,
           consumed_at = case when code_hash = crypt($2, code_hash) then now() else consumed_at end
     where id = $1
       and consumed_at is null
       and expires_at > now()
       and attempts < $3
     returning user_id, (code_hash = crypt($2, code_hash)) as code_ok`,
    [challengeId, code, MAX_ATTEMPTS]
  );
  const claimed = claim.rows[0];

  if (claimed) {
    if (claimed.code_ok) {
      await logAuditEvent({ eventType: 'mfa_verified', userId: claimed.user_id, detail: { challengeId } });
      return { ok: true, userId: claimed.user_id };
    }
    // Foute code: was dit precies de poging die de limiet deed kantelen?
    const after = await pool.query('select attempts from mfa_challenges where id = $1', [challengeId]);
    const reason = (after.rows[0]?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS ? 'too_many_attempts' : 'wrong_code';
    await logAuditEvent({ eventType: 'mfa_failed', userId: claimed.user_id, detail: { challengeId, reason } });
    return { ok: false, reason };
  }

  const lookup = await pool.query(
    'select expires_at, consumed_at from mfa_challenges where id = $1',
    [challengeId]
  );
  const row = lookup.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'too_many_attempts' };
}

export type ResendMfaResult =
  | { ok: true; expiresInSeconds: number }
  | { ok: false; reason: 'not_found' | 'already_used' | 'cooldown' | 'too_many_resends'; retryAfterSeconds?: number };

// Vervangt de code IN dezelfde challenge-rij (reset code/vervaltijd/pogingen-
// teller, created_at wordt de nieuwe referentie voor de cooldown hieronder) —
// bewust geen nieuwe rij/challengeId, zodat de frontend gewoon dezelfde
// challengeId blijft gebruiken.
//
// SEC-004: zelfde read-check-write race als bij verifyMfaChallenge
// hierboven, nu op resend_count/cooldown — met genoeg gelijktijdige resend-
// aanvragen konden er meer dan MAX_RESENDS nieuwe codes verstuurd worden
// omdat elke aanvraag de teller kon lezen vóórdat een andere zijn UPDATE had
// weggeschreven. Ook hier daarom één atomische UPDATE ... WHERE ...
// RETURNING i.p.v. losse SELECT + UPDATE: de limiet- en cooldown-check zitten
// nu IN de WHERE, dus Postgres' rijvergrendeling per UPDATE-transactie
// serialiseert concurrent aanvragen en voorkomt dat de teller ooit boven
// MAX_RESENDS uitkomt. De nieuwe code wordt bewust vóór de UPDATE gegenereerd
// maar pas ná een geslaagde (gematchte) UPDATE gemaild — bij een niet-
// gematchte UPDATE wordt hij gewoon weggegooid, geen neveneffect.
export async function resendMfaChallenge(challengeId: string): Promise<ResendMfaResult> {
  const code = generateMfaCode();
  const claim = await pool.query(
    `update mfa_challenges mc
       set code_hash = crypt($2, gen_salt('bf')),
           attempts = 0,
           resend_count = mc.resend_count + 1,
           created_at = now(),
           expires_at = now() + make_interval(mins => $3)
     from users u
     where mc.id = $1
       and u.id = mc.user_id
       and mc.consumed_at is null
       and mc.resend_count < $4
       and mc.created_at <= now() - make_interval(secs => $5)
     returning u.email`,
    [challengeId, code, CODE_TTL_MINUTES, MAX_RESENDS, RESEND_COOLDOWN_SECONDS]
  );
  const claimed = claim.rows[0];
  if (claimed) {
    await sendMfaEmail(claimed.email, code, CODE_TTL_MINUTES);
    return { ok: true, expiresInSeconds: CODE_TTL_MINUTES * 60 };
  }

  // UPDATE matchte niets — de losse SELECT hieronder dient alleen nog om de
  // juiste foutmelding te bepalen (zelfde volgorde als voorheen: cooldown
  // gaat vóór too_many_resends). Geen afdwinging meer nodig, die is
  // hierboven al atomisch gebeurd.
  const lookup = await pool.query(
    'select resend_count, consumed_at, created_at from mfa_challenges where id = $1',
    [challengeId]
  );
  const row = lookup.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };
  const ageSeconds = (Date.now() - new Date(row.created_at).getTime()) / 1000;
  if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds) };
  }
  return { ok: false, reason: 'too_many_resends' };
}

// Puur nette huishouding (geen functionele noodzaak — een verlopen challenge
// wordt door verifyMfaChallenge() toch al geweigerd): ruimt lang-verlopen
// rijen op. Zelfde in-process setInterval-patroon als de bestaande idle-/
// accountretentiesweep in index.ts.
export async function sweepExpiredMfaChallenges(): Promise<void> {
  await pool.query(`delete from mfa_challenges where expires_at < now() - interval '1 day'`);
}
