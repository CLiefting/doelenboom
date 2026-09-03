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

export async function verifyMfaChallenge(challengeId: string, code: string): Promise<VerifyMfaResult> {
  const result = await pool.query(
    `select user_id, attempts, expires_at, consumed_at, (code_hash = crypt($2, code_hash)) as code_ok
     from mfa_challenges where id = $1`,
    [challengeId, code]
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (!row.code_ok) {
    const newAttempts = row.attempts + 1;
    await pool.query('update mfa_challenges set attempts = $2 where id = $1', [challengeId, newAttempts]);
    const reason = newAttempts >= MAX_ATTEMPTS ? 'too_many_attempts' : 'wrong_code';
    await logAuditEvent({ eventType: 'mfa_failed', userId: row.user_id, detail: { challengeId, reason } });
    return { ok: false, reason };
  }

  await pool.query('update mfa_challenges set consumed_at = now() where id = $1', [challengeId]);
  await logAuditEvent({ eventType: 'mfa_verified', userId: row.user_id, detail: { challengeId } });
  return { ok: true, userId: row.user_id };
}

export type ResendMfaResult =
  | { ok: true; expiresInSeconds: number }
  | { ok: false; reason: 'not_found' | 'already_used' | 'cooldown' | 'too_many_resends'; retryAfterSeconds?: number };

// Vervangt de code IN dezelfde challenge-rij (reset code/vervaltijd/pogingen-
// teller, created_at wordt de nieuwe referentie voor de cooldown hieronder) —
// bewust geen nieuwe rij/challengeId, zodat de frontend gewoon dezelfde
// challengeId blijft gebruiken.
export async function resendMfaChallenge(challengeId: string): Promise<ResendMfaResult> {
  const result = await pool.query(
    `select mc.resend_count, mc.consumed_at, mc.created_at, u.email
     from mfa_challenges mc join users u on u.id = mc.user_id
     where mc.id = $1`,
    [challengeId]
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at) return { ok: false, reason: 'already_used' };

  const ageSeconds = (Date.now() - new Date(row.created_at).getTime()) / 1000;
  if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds) };
  }
  // >= i.p.v. > : resend_count telt al gebruikte hernieuwingen, dus bij
  // MAX_RESENDS=3 zijn precies 3 keer opnieuw versturen toegestaan.
  if (row.resend_count >= MAX_RESENDS) {
    return { ok: false, reason: 'too_many_resends' };
  }

  const code = generateMfaCode();
  await pool.query(
    `update mfa_challenges set
       code_hash = crypt($2, gen_salt('bf')),
       attempts = 0,
       resend_count = resend_count + 1,
       created_at = now(),
       expires_at = now() + make_interval(mins => $3)
     where id = $1`,
    [challengeId, code, CODE_TTL_MINUTES]
  );
  await sendMfaEmail(row.email, code, CODE_TTL_MINUTES);
  return { ok: true, expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

// Puur nette huishouding (geen functionele noodzaak — een verlopen challenge
// wordt door verifyMfaChallenge() toch al geweigerd): ruimt lang-verlopen
// rijen op. Zelfde in-process setInterval-patroon als de bestaande idle-/
// accountretentiesweep in index.ts.
export async function sweepExpiredMfaChallenges(): Promise<void> {
  await pool.query(`delete from mfa_challenges where expires_at < now() - interval '1 day'`);
}
