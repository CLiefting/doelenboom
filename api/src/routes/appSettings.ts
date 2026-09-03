import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import { getAppSettings, updateAppSettings } from '../appSettings.js';

// GET/PUT /api/app-settings — sysadmin-only, app-breed (geen tenant-scope,
// zie db/init.sql app_settings). Op dit moment alleen de twee parameters van
// de inlog-blokkade (auth.ts POST /login); "Accountbeheer" in de frontend is
// hier bewust de plek voor, want dit gaat over accounts/inloggen, niet over
// een specifieke tenant of doelenboom.
export const appSettingsRouter = Router();
appSettingsRouter.use(requireAuth, requireSysadmin);

appSettingsRouter.get('/', async (_req, res) => {
  res.json(await getAppSettings());
});

appSettingsRouter.put('/', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const maxFailedLoginAttempts = b.maxFailedLoginAttempts;
  const loginLockoutMinutes = b.loginLockoutMinutes;

  if (maxFailedLoginAttempts === undefined && loginLockoutMinutes === undefined) {
    return res.status(400).json({ error: 'Geef maxFailedLoginAttempts en/of loginLockoutMinutes mee.' });
  }
  if (
    maxFailedLoginAttempts !== undefined &&
    (typeof maxFailedLoginAttempts !== 'number' || !Number.isInteger(maxFailedLoginAttempts) || maxFailedLoginAttempts < 1)
  ) {
    return res.status(400).json({ error: 'maxFailedLoginAttempts moet een geheel getal ≥ 1 zijn.' });
  }
  if (
    loginLockoutMinutes !== undefined &&
    (typeof loginLockoutMinutes !== 'number' || !Number.isInteger(loginLockoutMinutes) || loginLockoutMinutes < 1)
  ) {
    return res.status(400).json({ error: 'loginLockoutMinutes moet een geheel getal ≥ 1 zijn.' });
  }

  const updated = await updateAppSettings({
    maxFailedLoginAttempts: maxFailedLoginAttempts as number | undefined,
    loginLockoutMinutes: loginLockoutMinutes as number | undefined,
  });
  res.json(updated);
});
