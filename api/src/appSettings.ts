import { pool } from './db.js';

// App-brede instellingen (zie db/init.sql app_settings, sysadmin-only via
// routes/appSettings.ts) — precies één rij, id altijd 1. De twee parameters
// van de inlog-blokkade (auth.ts POST /login) en (DOEL-97) de
// inactiviteitstermijn voor automatisch uitloggen (auth.ts requireAuth).
export interface AppSettings {
  maxFailedLoginAttempts: number;
  loginLockoutMinutes: number;
  idleTimeoutMinutes: number;
}

// Grenzen van de inactiviteitstermijn (DOEL-97). Ook als check-constraint in de
// database (db/init.sql, migratie 0050). Ondergrens: korter dan 5 minuten maakt
// normaal werken onmogelijk (de frontend meldt activiteit hooguit 1x per minuut).
// Bovengrens: 8 uur; het inlogtoken zelf verloopt sowieso na 12 uur.
export const IDLE_TIMEOUT_MIN_MINUTES = 5;
export const IDLE_TIMEOUT_MAX_MINUTES = 480;
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

const DEFAULTS: AppSettings = {
  maxFailedLoginAttempts: 5,
  loginLockoutMinutes: 15,
  idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES,
};

const SELECT_FIELDS = `max_failed_login_attempts as "maxFailedLoginAttempts",
       login_lockout_minutes as "loginLockoutMinutes",
       idle_timeout_minutes as "idleTimeoutMinutes"`;

export async function getAppSettings(): Promise<AppSettings> {
  const result = await pool.query(`select ${SELECT_FIELDS} from app_settings where id = 1`);
  // Zou altijd precies 1 rij moeten zijn (geseed in db/init.sql/migratie
  // 0026) — een noodfallback op de ingebouwde standaardwaarden voorkomt dat
  // een onverwacht lege tabel het inloggen blokkeert.
  return result.rows[0] ?? DEFAULTS;
}

export async function updateAppSettings(patch: {
  maxFailedLoginAttempts?: number;
  loginLockoutMinutes?: number;
  idleTimeoutMinutes?: number;
}): Promise<AppSettings> {
  const result = await pool.query(
    `update app_settings set
       max_failed_login_attempts = coalesce($1, max_failed_login_attempts),
       login_lockout_minutes = coalesce($2, login_lockout_minutes),
       idle_timeout_minutes = coalesce($3, idle_timeout_minutes)
     where id = 1
     returning ${SELECT_FIELDS}`,
    [patch.maxFailedLoginAttempts ?? null, patch.loginLockoutMinutes ?? null, patch.idleTimeoutMinutes ?? null]
  );
  return result.rows[0];
}
