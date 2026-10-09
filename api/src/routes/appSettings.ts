import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import {
  AppSettings, getAppSettings, updateAppSettings, IDLE_TIMEOUT_MAX_MINUTES, IDLE_TIMEOUT_MIN_MINUTES,
} from '../appSettings.js';
import { logAuditEvent } from '../auditLog.js';

// GET/PUT /api/app-settings — sysadmin-only, app-breed (geen tenant-scope,
// zie db/init.sql app_settings). De twee parameters van de inlog-blokkade
// (auth.ts POST /login) en (DOEL-97) de inactiviteitstermijn voor automatisch
// uitloggen (auth.ts requireAuth); "Accountbeheer" in de frontend is hier
// bewust de plek voor, want dit gaat over accounts/inloggen, niet over een
// specifieke tenant of doelenboom.
export const appSettingsRouter = Router();
appSettingsRouter.use(requireAuth, requireSysadmin);

appSettingsRouter.get('/', async (_req, res) => {
  res.json(await getAppSettings());
});

function isWholeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

appSettingsRouter.put('/', async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const maxFailedLoginAttempts = b.maxFailedLoginAttempts;
  const loginLockoutMinutes = b.loginLockoutMinutes;
  const idleTimeoutMinutes = b.idleTimeoutMinutes;

  if (maxFailedLoginAttempts === undefined && loginLockoutMinutes === undefined && idleTimeoutMinutes === undefined) {
    return res.status(400).json({ error: 'Geef maxFailedLoginAttempts, loginLockoutMinutes en/of idleTimeoutMinutes mee.' });
  }
  if (maxFailedLoginAttempts !== undefined && (!isWholeNumber(maxFailedLoginAttempts) || maxFailedLoginAttempts < 1)) {
    return res.status(400).json({ error: 'maxFailedLoginAttempts moet een geheel getal ≥ 1 zijn.' });
  }
  if (loginLockoutMinutes !== undefined && (!isWholeNumber(loginLockoutMinutes) || loginLockoutMinutes < 1)) {
    return res.status(400).json({ error: 'loginLockoutMinutes moet een geheel getal ≥ 1 zijn.' });
  }
  // DOEL-97: alleen een geheel getal binnen de grenzen (ook als check-constraint
  // in de database). Strings, ook numerieke, worden geweigerd.
  if (
    idleTimeoutMinutes !== undefined &&
    (!isWholeNumber(idleTimeoutMinutes) ||
      idleTimeoutMinutes < IDLE_TIMEOUT_MIN_MINUTES ||
      idleTimeoutMinutes > IDLE_TIMEOUT_MAX_MINUTES)
  ) {
    return res.status(400).json({
      error: `idleTimeoutMinutes moet een geheel getal van ${IDLE_TIMEOUT_MIN_MINUTES} t/m ${IDLE_TIMEOUT_MAX_MINUTES} zijn.`,
    });
  }

  const before = await getAppSettings();
  const updated = await updateAppSettings({
    maxFailedLoginAttempts: maxFailedLoginAttempts as number | undefined,
    loginLockoutMinutes: loginLockoutMinutes as number | undefined,
    idleTimeoutMinutes: idleTimeoutMinutes as number | undefined,
  });

  // DOEL-97 (OWASP A09): een wijziging van deze beveiligingsinstellingen hoort
  // in het auditlog — per gewijzigd veld de oude en nieuwe waarde (alleen getallen).
  const changes: Record<string, { from: number; to: number }> = {};
  for (const key of ['maxFailedLoginAttempts', 'loginLockoutMinutes', 'idleTimeoutMinutes'] as (keyof AppSettings)[]) {
    if (before[key] !== updated[key]) changes[key] = { from: before[key], to: updated[key] };
  }
  if (Object.keys(changes).length) {
    await logAuditEvent({ eventType: 'app_settings_updated', userId: req.user!.id, detail: { changes } });
  }
  res.json(updated);
});
