import { pool } from './db.js';

// Startup-controle voor het standaard sysadmin-wachtwoord (DOEL-23, analyse H4).
//
// db/seed.sql maakt bij de allereerste initialisatie `admin@code072.nl` aan met
// het in README.md/deploy/README.md gedocumenteerde wachtwoord. Dat is voor
// lokale ontwikkeling gewenst, maar op een productieomgeving mag dat account
// nooit meer met het bekende wachtwoord bereikbaar zijn — de enige remmende
// factor is dan nog de e-mail-MFA. Analoog aan assertCurrentJwtSecretIsSafe()
// in auth.ts: in productie weigert de API te starten zolang het bekende
// wachtwoord werkt; buiten productie alleen een waarschuwing.

// Publiek gedocumenteerde standaardwachtwoorden (README.md, deploy/README.md,
// db/seed.sql).
const KNOWN_DEFAULT_PASSWORDS = ['changeme'];
const SEEDED_ADMIN_EMAIL = 'admin@code072.nl';

export class DefaultAdminPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefaultAdminPasswordError';
  }
}

// E-mailadressen van sysadmin-accounts (of het geseede admin-account) waarvan
// het wachtwoord nog een bekende default is. Vergelijkt via pgcrypto's
// crypt(wachtwoord, opgeslagen_hash) — dezelfde functie als bij het inloggen,
// dus er wordt nooit een hash of wachtwoord gelogd of teruggegeven.
export async function findAccountsWithDefaultPassword(): Promise<string[]> {
  const found = new Set<string>();
  for (const candidate of KNOWN_DEFAULT_PASSWORDS) {
    const result = await pool.query(
      `select email from users
       where (is_sysadmin or email = $2) and password_hash = crypt($1, password_hash)`,
      [candidate, SEEDED_ADMIN_EMAIL]
    );
    for (const row of result.rows as { email: string }[]) found.add(row.email);
  }
  return [...found].sort();
}

export async function assertNoDefaultAdminPassword(nodeEnv: string | undefined): Promise<void> {
  const accounts = await findAccountsWithDefaultPassword();
  if (accounts.length === 0) return;
  const message =
    `Sysadmin-account(s) ${accounts.join(', ')} gebruiken nog het standaardwachtwoord uit de documentatie. ` +
    `Wijzig dit wachtwoord voordat de API in productie draait, bv. via de database: ` +
    `update users set password_hash = crypt('<nieuw-wachtwoord>', gen_salt('bf', 12)), must_change_password = false ` +
    `where email = '${accounts[0]}'; (zie deploy/README.md §6).`;
  if (nodeEnv === 'production') throw new DefaultAdminPasswordError(message);
  console.warn(`WAARSCHUWING: ${message}`);
}

// Aangeroepen door index.ts vóór app.listen(). Alleen een aangetroffen
// standaardwachtwoord in productie stopt het proces; een niet-bereikbare
// database niet (dan faalt elk request toch al, en zo blijft een tijdelijke
// db-storing bij het opstarten geen tweede oorzaak van uitval).
export async function runStartupChecks(nodeEnv: string | undefined = process.env.NODE_ENV): Promise<void> {
  try {
    await assertNoDefaultAdminPassword(nodeEnv);
  } catch (err) {
    if (err instanceof DefaultAdminPasswordError) {
      console.error(`STARTUP GEWEIGERD: ${err.message}`);
      process.exit(1);
    }
    console.error('Startup-controle standaardwachtwoord overgeslagen (database niet bereikbaar?):', err);
  }
}
