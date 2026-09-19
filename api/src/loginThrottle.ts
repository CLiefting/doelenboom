import { envInt } from './rateLimit.js';

// Aanvullende inlogbeperkingen naast de per-account-blokkade in auth.ts
// (DOEL-24, analyse M1 — OWASP A07):
//
//  1. per-IP teller van MISLUKTE pogingen: één client kan niet onbeperkt
//     wachtwoorden proberen (over veel accounts) en ook niet onbeperkt accounts
//     van anderen blokkeren (account-DoS);
//  2. blokkade voor ONBEKENDE e-mailadressen met exact dezelfde antwoorden als
//     voor bekende accounts: voorheen gaf alleen een bestaand account na N
//     pogingen een 429 (verraadt dat het account bestaat).
//
// Net als rateLimit.ts in-memory (één API-container); een herstart wist de
// tellers, en de blokkade van bestaande accounts staat in de database.

type IpBucket = { count: number; resetAt: number };
type EmailState = { count: number; lockedUntil: number; touchedAt: number };

const ipFailures = new Map<string, IpBucket>();
const unknownEmails = new Map<string, EmailState>();

const IP_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;
// Ook zonder blokkade vergeten we een onbekend adres na deze tijd (de teller
// is bedoeld voor het "raden binnen een korte periode").
const UNKNOWN_EMAIL_FORGET_MS = 60 * 60_000;

function ipMax(): number {
  return envInt('LOGIN_IP_MAX_FAILURES', 50);
}

function trim<K, V>(map: Map<K, V>, isExpired: (v: V, now: number) => boolean) {
  if (map.size <= MAX_TRACKED) return;
  const now = Date.now();
  for (const [k, v] of map) if (isExpired(v, now)) map.delete(k);
  // Nog te groot: oudste (insertievolgorde) eerst weggooien.
  for (const k of map.keys()) {
    if (map.size <= MAX_TRACKED) break;
    map.delete(k);
  }
}

// Seconden tot het IP weer mag proberen; 0 = geen beperking.
export function ipBlockedForSeconds(ip: string): number {
  const b = ipFailures.get(ip);
  const now = Date.now();
  if (!b || b.resetAt <= now) return 0;
  return b.count >= ipMax() ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : 0;
}

export function recordIpFailure(ip: string): void {
  const now = Date.now();
  let b = ipFailures.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + IP_WINDOW_MS };
    ipFailures.set(ip, b);
    trim(ipFailures, (v, n) => v.resetAt <= n);
  }
  b.count += 1;
}

function emailKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

export type UnknownEmailResult = { locked: false } | { locked: true; minutesLeft: number; justLocked: boolean };

// Is dit (niet-bestaande) adres al geblokkeerd? Zo ja: hoeveel minuten nog.
export function unknownEmailLockState(email: string): { locked: boolean; minutesLeft: number } {
  const s = unknownEmails.get(emailKey(email));
  const now = Date.now();
  if (s && s.lockedUntil > now) return { locked: true, minutesLeft: Math.max(1, Math.ceil((s.lockedUntil - now) / 60000)) };
  return { locked: false, minutesLeft: 0 };
}

// Registreert een mislukte poging op een onbekend adres; spiegelt de
// database-logica voor bestaande accounts (teller tot maxAttempts, dan
// lockoutMinutes blokkade en teller terug naar 0).
export function recordUnknownEmailFailure(email: string, maxAttempts: number, lockoutMinutes: number): UnknownEmailResult {
  const key = emailKey(email);
  const now = Date.now();
  let s = unknownEmails.get(key);
  if (!s || (s.lockedUntil <= now && now - s.touchedAt > UNKNOWN_EMAIL_FORGET_MS)) {
    s = { count: 0, lockedUntil: 0, touchedAt: now };
    unknownEmails.set(key, s);
    trim(unknownEmails, (v, n) => v.lockedUntil <= n && n - v.touchedAt > UNKNOWN_EMAIL_FORGET_MS);
  }
  s.touchedAt = now;
  if (s.lockedUntil > now) {
    return { locked: true, minutesLeft: Math.max(1, Math.ceil((s.lockedUntil - now) / 60000)), justLocked: false };
  }
  s.count += 1;
  if (s.count >= maxAttempts) {
    s.count = 0;
    s.lockedUntil = now + lockoutMinutes * 60_000;
    return { locked: true, minutesLeft: lockoutMinutes, justLocked: true };
  }
  return { locked: false };
}

// Alleen voor tests.
export function resetLoginThrottle(): void {
  ipFailures.clear();
  unknownEmails.clear();
}
