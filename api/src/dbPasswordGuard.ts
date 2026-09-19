// Startup-controle op het databasewachtwoord (DOEL-31).
//
// docker-compose.yml valt terug op POSTGRES_PASSWORD "doelenboom" als er geen
// .env is (lokale dev). Op een productieomgeving is dat wachtwoord publiek (het
// staat in de repo); wie het netwerk van de containers bereikt — of de
// 127.0.0.1:5432-tunnel — heeft dan volledige databasetoegang. Analoog aan
// assertJwtSecretIsSafe() in auth.ts: in productie weigert de API te starten
// met een bekend standaardwachtwoord, buiten productie alleen een waarschuwing.

const KNOWN_DEFAULT_DB_PASSWORDS = ['doelenboom', 'postgres', 'password', 'changeme', 'admin', 'root', 'secret'];

export class UnsafeDatabasePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabasePasswordError';
  }
}

// Wachtwoord uit een postgres://-URL; null als er geen URL/wachtwoord is (bv.
// verbinding via PG*-variabelen of trust-auth — dan valt er niets te toetsen).
export function databasePasswordFromUrl(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    const pw = new URL(databaseUrl).password;
    return pw === '' ? null : decodeURIComponent(pw);
  } catch {
    return null;
  }
}

// Gooit in productie bij een bekend standaardwachtwoord, tenzij
// ALLOW_DEFAULT_DB_PASSWORD=true (bewuste, tijdelijke overgangsvlag: eerst
// uitrollen met de vlag, dan het wachtwoord wijzigen, dan de vlag weghalen).
export function assertDatabasePasswordIsSafe(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
  allowDefault: string | undefined = process.env.ALLOW_DEFAULT_DB_PASSWORD
): void {
  const pw = databasePasswordFromUrl(databaseUrl);
  if (pw === null || !KNOWN_DEFAULT_DB_PASSWORDS.includes(pw.toLowerCase())) return;
  const message =
    'DATABASE_URL gebruikt een bekend standaardwachtwoord voor de database. Zet een sterk POSTGRES_PASSWORD in .env ' +
    'en wijzig het bestaande wachtwoord in de database (docker compose exec db psql -U <gebruiker> -c ' +
    '"alter user <gebruiker> password \'<nieuw>\'"); zie deploy/README.md.';
  if (nodeEnv === 'production') {
    if (allowDefault === 'true') {
      console.warn(`WAARSCHUWING (ALLOW_DEFAULT_DB_PASSWORD=true): ${message}`);
      return;
    }
    throw new UnsafeDatabasePasswordError(`${message} (Tijdelijk overrulen: ALLOW_DEFAULT_DB_PASSWORD=true.)`);
  }
  console.warn(`WAARSCHUWING: ${message}`);
}
