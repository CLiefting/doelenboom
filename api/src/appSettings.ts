import { pool } from './db.js';

// App-brede instellingen (zie db/init.sql app_settings, sysadmin-only via
// routes/appSettings.ts) — precies één rij, id altijd 1. Op dit moment
// alleen de twee parameters van de inlog-blokkade (auth.ts POST /login).
export interface AppSettings {
  maxFailedLoginAttempts: number;
  loginLockoutMinutes: number;
}

const DEFAULTS: AppSettings = { maxFailedLoginAttempts: 5, loginLockoutMinutes: 15 };

export async function getAppSettings(): Promise<AppSettings> {
  const result = await pool.query(
    `select max_failed_login_attempts as "maxFailedLoginAttempts",
            login_lockout_minutes as "loginLockoutMinutes"
     from app_settings where id = 1`
  );
  // Zou altijd precies 1 rij moeten zijn (geseed in db/init.sql/migratie
  // 0026) — een noodfallback op de ingebouwde standaardwaarden voorkomt dat
  // een onverwacht lege tabel het inloggen blokkeert.
  return result.rows[0] ?? DEFAULTS;
}

export async function updateAppSettings(patch: {
  maxFailedLoginAttempts?: number;
  loginLockoutMinutes?: number;
}): Promise<AppSettings> {
  const result = await pool.query(
    `update app_settings set
       max_failed_login_attempts = coalesce($1, max_failed_login_attempts),
       login_lockout_minutes = coalesce($2, login_lockout_minutes)
     where id = 1
     returning max_failed_login_attempts as "maxFailedLoginAttempts",
       login_lockout_minutes as "loginLockoutMinutes"`,
    [patch.maxFailedLoginAttempts ?? null, patch.loginLockoutMinutes ?? null]
  );
  return result.rows[0];
}
