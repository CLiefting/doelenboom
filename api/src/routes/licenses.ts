import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { requireSysadmin, requireTenantRoleForTenantParam } from '../rbac.js';
import * as license from '../license.js';

// Licentiebeheer — zie doelenboom_licentiemodel.md in het Doelenboom-project.
// Twee niveaus:
// - de CATALOGUS (/api/tiers, /api/modules): tiers en modules zelf, vrij door
//   sysadmins te beheren (naam/limieten/omschrijving) — lezen mag iedereen
//   ingelogd (nodig om bv. "je zit op Brons" te kunnen tonen), wijzigen is
//   sysadmin-only.
// - de TOEWIJZING per tenant (/api/tenants/:tenantId/license, .../tier,
//   .../modules/:moduleKey): welk tier en welke modules een specifieke tenant
//   heeft. Bewust volledig sysadmin-only om te WIJZIGEN (dit is een
//   commerciële/contractuele beslissing, geen zelfbedieningsactie voor een
//   tenant-admin) — lezen mag een tenant-admin van díe tenant wel (nodig om
//   de eigen limieten/gebruik te kunnen zien).
// Gemount op '/api' (niet '/api/licenses'), net als doelenbomenRouter — zie
// app.ts.
export const licensesRouter = Router();
licensesRouter.use(requireAuth);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// --- Tiers-catalogus ---

licensesRouter.get('/tiers', async (_req, res) => {
  res.json(await license.listTiers());
});

licensesRouter.post('/tiers', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const maxAdmins = Number(b.maxAdmins);
  const maxBomen = Number(b.maxBomen);
  const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 0;

  const errors: string[] = [];
  if (!name) errors.push('Naam is verplicht.');
  if (!Number.isFinite(maxAdmins) || maxAdmins <= 0) errors.push('maxAdmins moet een positief getal zijn.');
  if (!Number.isFinite(maxBomen) || maxBomen <= 0) errors.push('maxBomen moet een positief getal zijn.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    const tier = await license.createTier({ name, maxAdmins, maxBomen, sortOrder });
    res.status(201).json(tier);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Er bestaat al een tier met naam "${name}".` });
    res.status(500).json({ error: 'Aanmaken van tier mislukt', detail: (err as Error).message });
  }
});

licensesRouter.put('/tiers/:id', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined;
  const maxAdmins = typeof b.maxAdmins === 'number' && Number.isFinite(b.maxAdmins) && b.maxAdmins > 0 ? b.maxAdmins : undefined;
  const maxBomen = typeof b.maxBomen === 'number' && Number.isFinite(b.maxBomen) && b.maxBomen > 0 ? b.maxBomen : undefined;
  const sortOrder = typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder) ? b.sortOrder : undefined;

  if (b.maxAdmins !== undefined && maxAdmins === undefined) {
    return res.status(400).json({ error: 'maxAdmins moet een positief getal zijn.' });
  }
  if (b.maxBomen !== undefined && maxBomen === undefined) {
    return res.status(400).json({ error: 'maxBomen moet een positief getal zijn.' });
  }

  try {
    const tier = await license.updateTier(req.params.id, { name, maxAdmins, maxBomen, sortOrder });
    if (!tier) return res.status(404).json({ error: 'Tier niet gevonden.' });
    res.json(tier);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Er bestaat al een tier met naam "${name}".` });
    res.status(500).json({ error: 'Bijwerken van tier mislukt', detail: (err as Error).message });
  }
});

// Verwijderen mag altijd — tenants die deze tier hadden vallen terug op
// "geen licentie ingesteld" (tier_id = null), zie license.ts deleteTier.
licensesRouter.delete('/tiers/:id', requireSysadmin, async (req, res) => {
  const ok = await license.deleteTier(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Tier niet gevonden.' });
  res.status(204).send();
});

// --- Modules-catalogus ---

licensesRouter.get('/modules', async (_req, res) => {
  res.json(await license.listModules());
});

licensesRouter.post('/modules', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const key = typeof b.key === 'string' ? b.key.trim().toLowerCase() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const description = typeof b.description === 'string' ? b.description : '';

  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
    errors.push('key moet kleine letters/cijfers/koppelteken/underscore zijn en beginnen met een letter of cijfer (bv. "projecten").');
  }
  if (!name) errors.push('Naam is verplicht.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    const mod = await license.createModule({ key, name, description });
    res.status(201).json(mod);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Er bestaat al een module met key "${key}".` });
    res.status(500).json({ error: 'Aanmaken van module mislukt', detail: (err as Error).message });
  }
});

licensesRouter.put('/modules/:id', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined;
  const description = typeof b.description === 'string' ? b.description : undefined;
  const mod = await license.updateModule(req.params.id, { name, description });
  if (!mod) return res.status(404).json({ error: 'Module niet gevonden.' });
  res.json(mod);
});

licensesRouter.delete('/modules/:id', requireSysadmin, async (req, res) => {
  const ok = await license.deleteModule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Module niet gevonden.' });
  res.status(204).send();
});

// --- Licentie van één tenant: tier + actieve modules + gebruik ---

licensesRouter.get(
  '/tenants/:tenantId/license',
  requireTenantRoleForTenantParam('admin', 'tenantId'),
  async (req, res) => {
    const result = await license.getTenantLicense(req.params.tenantId);
    if (!result) return res.status(404).json({ error: 'Tenant niet gevonden.' });
    res.json(result);
  }
);

// PUT .../license/tier — { tierId: number | string | null }. Sysadmin-only:
// dit is een commerciële beslissing (welke licentie heeft deze klant), geen
// zelfbedieningsactie. null = licentiebeperking opheffen (onbeperkt/legacy).
// tierId accepteert bewust zowel een getal als een numerieke string: tiers.id
// is "bigserial" (zie db/migrations/0002_licenses.sql, zelfde conventie als de
// rest van dit schema), en de pg-driver geeft bigint-kolommen als STRING terug
// om precisieverlies bij grote waarden te voorkomen — een client die een eerder
// opgehaalde tier.id ongewijzigd terugstuurt (zoals GET /api/tiers teruggeeft)
// stuurt 'm dus als string, geen getal. Alleen JSON-getallen/strings die er ook
// werkelijk als een niet-negatief heel getal uitzien worden geaccepteerd.
function parseTierId(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return undefined;
}

licensesRouter.put('/tenants/:tenantId/license/tier', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const tierId = parseTierId(b.tierId);
  if (tierId === undefined) {
    return res.status(400).json({ error: 'tierId moet een getal, numerieke tekst, of null zijn.' });
  }
  try {
    await license.setTenantTier(req.params.tenantId, tierId);
    res.json(await license.getTenantLicense(req.params.tenantId));
  } catch (err) {
    if (err instanceof license.LicenseLimitError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Instellen van tier mislukt', detail: (err as Error).message });
  }
});

// PUT .../license/modules/:moduleKey — { active: boolean }. Sysadmin-only,
// zelfde reden als hierboven.
licensesRouter.put('/tenants/:tenantId/license/modules/:moduleKey', requireSysadmin, async (req, res) => {
  const active = (req.body ?? {}).active === true;
  try {
    await license.setTenantModuleActive(req.params.tenantId, req.params.moduleKey, active);
    res.json(await license.getTenantLicense(req.params.tenantId));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// PUT .../license/end-date — { endDate: "YYYY-MM-DD" | null }. Sysadmin-only,
// zelfde reden als tier/modules hierboven (commerciële beslissing, geen
// zelfbedieningsactie). null = geen einddatum ingesteld (nooit verlopen) —
// zie license.ts setTenantLicenseEndDate/isLicenseExpired.
licensesRouter.put('/tenants/:tenantId/license/end-date', requireSysadmin, async (req, res) => {
  const raw = (req.body ?? {}).endDate;
  if (raw !== null && !(typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw))) {
    return res.status(400).json({ error: 'endDate moet "YYYY-MM-DD" of null zijn.' });
  }
  await license.setTenantLicenseEndDate(req.params.tenantId, raw);
  res.json(await license.getTenantLicense(req.params.tenantId));
});
