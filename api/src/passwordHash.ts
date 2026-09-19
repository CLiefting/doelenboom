// Bcrypt-kosten voor wachtwoordhashes (DOEL-25, analyse M2 — OWASP A02).
//
// Alle wachtwoorden worden in Postgres gehasht met pgcrypto:
// crypt(wachtwoord, gen_salt('bf', kosten)). Zonder tweede argument gebruikt
// gen_salt('bf') kosten 6 (64 iteraties) — ver onder wat nu gangbaar is
// (OWASP: bcrypt work factor >= 10). De kosten zitten in de opgeslagen hash
// zelf ($2a$12$...), dus verificatie werkt ook voor oude hashes met lagere
// kosten; die worden bij de eerstvolgende geslaagde login opnieuw gehasht
// (zie POST /login in auth.ts).
//
// BCRYPT_COST (env) is bedoeld voor tests (laag = snel) en om de kosten bij
// sterkere hardware te verhogen; ongeldige waarden vallen terug op de
// standaard. De kosten worden als geheel getal in de SQL gezet (nooit een
// ruwe env-string), dus er is geen injectierisico.

export const DEFAULT_BCRYPT_COST = 12;
const MIN_COST = 4; // ondergrens van pgcrypto
const MAX_COST = 15; // erboven wordt één login onwerkbaar traag

export function bcryptCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (raw === undefined || raw === '') return DEFAULT_BCRYPT_COST;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_COST || n > MAX_COST) return DEFAULT_BCRYPT_COST;
  return n;
}

// SQL-fragment: hasht de gegeven parameter (bv. '$2') met de huidige kosten.
export function hashSql(paramRef: string): string {
  return `crypt(${paramRef}, gen_salt('bf', ${bcryptCost()}))`;
}
