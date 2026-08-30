import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { requireSysadmin, requireTenantRoleForTenantParam } from '../rbac.js';
import * as license from '../license.js';
import * as offers from '../offers.js';
import * as tierPrices from '../tierPrices.js';
import * as moduleSurcharges from '../moduleSurcharges.js';

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// trialDays: optioneel, null = "gebruik de standaard proefduur" (zie
// subscriptions.ts TRIAL_DAYS), een positief geheel getal = eigen proefduur
// voor deze tier (bv. Evaluatie: 30). undefined (veld ontbreekt) wordt door
// de aanroeper onderscheiden van expliciet null via hasTrialDays hieronder.
function parseTrialDays(raw: unknown): { trialDays: number | null } | { error: string } {
  if (raw === null || raw === undefined) return { trialDays: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return { trialDays: raw };
  return { error: 'trialDays moet een positief geheel getal of null zijn.' };
}

licensesRouter.post('/tiers', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const maxAdmins = Number(b.maxAdmins);
  const maxBomen = Number(b.maxBomen);
  const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 0;
  const allModulesIncluded = b.allModulesIncluded === true;
  const trialDaysParsed = parseTrialDays(b.trialDays);

  const errors: string[] = [];
  if (!name) errors.push('Naam is verplicht.');
  if (!Number.isFinite(maxAdmins) || maxAdmins <= 0) errors.push('maxAdmins moet een positief getal zijn.');
  if (!Number.isFinite(maxBomen) || maxBomen <= 0) errors.push('maxBomen moet een positief getal zijn.');
  if ('error' in trialDaysParsed) errors.push(trialDaysParsed.error);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    const tier = await license.createTier({
      name,
      maxAdmins,
      maxBomen,
      sortOrder,
      trialDays: (trialDaysParsed as { trialDays: number | null }).trialDays,
      allModulesIncluded,
    });
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
  const allModulesIncluded = typeof b.allModulesIncluded === 'boolean' ? b.allModulesIncluded : undefined;
  const hasTrialDays = b.trialDays !== undefined;
  const trialDaysParsed = hasTrialDays ? parseTrialDays(b.trialDays) : null;

  if (b.maxAdmins !== undefined && maxAdmins === undefined) {
    return res.status(400).json({ error: 'maxAdmins moet een positief getal zijn.' });
  }
  if (b.maxBomen !== undefined && maxBomen === undefined) {
    return res.status(400).json({ error: 'maxBomen moet een positief getal zijn.' });
  }
  if (trialDaysParsed && 'error' in trialDaysParsed) {
    return res.status(400).json({ error: trialDaysParsed.error });
  }

  try {
    const tier = await license.updateTier(req.params.id, {
      name,
      maxAdmins,
      maxBomen,
      sortOrder,
      allModulesIncluded,
      hasTrialDays,
      trialDays: trialDaysParsed && 'trialDays' in trialDaysParsed ? trialDaysParsed.trialDays : undefined,
    });
    if (!tier) return res.status(404).json({ error: 'Tier niet gevonden.' });
    res.json(tier);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Er bestaat al een tier met naam "${name}".` });
    res.status(500).json({ error: 'Bijwerken van tier mislukt', detail: (err as Error).message });
  }
});

// --- Prijsgeschiedenis van een tier — zie tierPrices.ts. Een abonnement heeft
// door de tijd heen meerdere prijzen (bv. 2026 en 2027 een ander tarief), dus
// dit is een eigen resource i.p.v. een enkel prijsveld op de tier. Lezen mag
// iedereen ingelogd (nodig voor de publieke aanvraagpagina/prijsopgave via
// subscriptions.ts, en om in het licentiebeheerscherm te tonen), wijzigen is
// sysadmin-only. ---

function parseTierPriceBody(b: Record<string, unknown>): { priceEur: number; validFrom: string; validUntil: string } | { error: string } {
  if (typeof b.priceEur !== 'number' || !Number.isFinite(b.priceEur) || b.priceEur < 0) {
    return { error: 'priceEur is verplicht (niet-negatief getal).' };
  }
  if (typeof b.validFrom !== 'string' || !DATE_RE.test(b.validFrom)) {
    return { error: 'validFrom moet "YYYY-MM-DD" zijn.' };
  }
  if (typeof b.validUntil !== 'string' || !DATE_RE.test(b.validUntil)) {
    return { error: 'validUntil moet "YYYY-MM-DD" zijn.' };
  }
  if (b.validUntil < b.validFrom) return { error: 'validUntil mag niet vóór validFrom liggen.' };
  return { priceEur: b.priceEur, validFrom: b.validFrom, validUntil: b.validUntil };
}

licensesRouter.get('/tiers/:tierId/prices', async (req, res) => {
  res.json(await tierPrices.listTierPrices(req.params.tierId));
});

licensesRouter.post('/tiers/:tierId/prices', requireSysadmin, async (req, res) => {
  const parsed = parseTierPriceBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const price = await tierPrices.createTierPrice({ tierId: Number(req.params.tierId), ...parsed });
  res.status(201).json(price);
});

licensesRouter.put('/tier-prices/:id', requireSysadmin, async (req, res) => {
  const parsed = parseTierPriceBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const price = await tierPrices.updateTierPrice(req.params.id, parsed);
  if (!price) return res.status(404).json({ error: 'Prijsperiode niet gevonden.' });
  res.json(price);
});

licensesRouter.delete('/tier-prices/:id', requireSysadmin, async (req, res) => {
  const ok = await tierPrices.deleteTierPrice(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Prijsperiode niet gevonden.' });
  res.status(204).send();
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

// --- Opslagpercentage-geschiedenis van een module — zie moduleSurcharges.ts.
// Zelfde reden voor een eigen geschiedenis-resource als bij tier-prijzen
// hierboven: de opslag kan door de tijd heen wijzigen (initieel Projecten
// 20%, Templating 10% — zie db/migrations/0016_price_history.sql). ---

function parseModuleSurchargeBody(b: Record<string, unknown>): { surchargePct: number; validFrom: string; validUntil: string } | { error: string } {
  if (typeof b.surchargePct !== 'number' || !Number.isFinite(b.surchargePct) || b.surchargePct < 0) {
    return { error: 'surchargePct is verplicht (niet-negatief getal).' };
  }
  if (typeof b.validFrom !== 'string' || !DATE_RE.test(b.validFrom)) {
    return { error: 'validFrom moet "YYYY-MM-DD" zijn.' };
  }
  if (typeof b.validUntil !== 'string' || !DATE_RE.test(b.validUntil)) {
    return { error: 'validUntil moet "YYYY-MM-DD" zijn.' };
  }
  if (b.validUntil < b.validFrom) return { error: 'validUntil mag niet vóór validFrom liggen.' };
  return { surchargePct: b.surchargePct, validFrom: b.validFrom, validUntil: b.validUntil };
}

licensesRouter.get('/modules/:moduleId/surcharges', async (req, res) => {
  res.json(await moduleSurcharges.listModuleSurcharges(req.params.moduleId));
});

licensesRouter.post('/modules/:moduleId/surcharges', requireSysadmin, async (req, res) => {
  const parsed = parseModuleSurchargeBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const surcharge = await moduleSurcharges.createModuleSurcharge({ moduleId: Number(req.params.moduleId), ...parsed });
  res.status(201).json(surcharge);
});

licensesRouter.put('/module-surcharges/:id', requireSysadmin, async (req, res) => {
  const parsed = parseModuleSurchargeBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const surcharge = await moduleSurcharges.updateModuleSurcharge(req.params.id, parsed);
  if (!surcharge) return res.status(404).json({ error: 'Opslagperiode niet gevonden.' });
  res.json(surcharge);
});

licensesRouter.delete('/module-surcharges/:id', requireSysadmin, async (req, res) => {
  const ok = await moduleSurcharges.deleteModuleSurcharge(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Opslagperiode niet gevonden.' });
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

// --- Aanbiedingen (offers) — zie offers.ts en doelenboom_licentiemodel.md §9.
// Zelfde toegangsmodel als tiers/modules hierboven: lezen mag iedereen
// ingelogd (nodig voor het Sjablonen/Aanvragen-scherm en de publieke
// aanvraagpagina, zie routes/subscriptions.ts), wijzigen is sysadmin-only. ---

licensesRouter.get('/offers', async (_req, res) => {
  res.json(await offers.listOffers());
});

function parseOfferBody(b: Record<string, unknown>): {
  name: string;
  kind: offers.OfferKind;
  value: number | null;
  validFrom: string;
  validUntil: string;
  tierIds: number[];
} | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const kind = b.kind === 'percentage' || b.kind === 'fixed_amount' || b.kind === 'btw_vrij' ? b.kind : null;
  const validFrom = typeof b.validFrom === 'string' ? b.validFrom : '';
  const validUntil = typeof b.validUntil === 'string' ? b.validUntil : '';
  // tiers.id is bigint -> de pg-driver geeft 'm als STRING terug om precisie-
  // verlies te voorkomen (zelfde conventie als parseTierId hierboven), dus een
  // client die een eerder opgehaalde tier.id ongewijzigd terugstuurt (zoals de
  // OfferForm-checkboxes in LicenseCatalogPage.tsx, gevuld vanuit GET
  // /api/tiers) stuurt numerieke STRINGS, geen getallen — filteren op
  // `typeof === 'number'` liet die dus stilzwijgend allemaal vallen.
  const tierIds = Array.isArray(b.tierIds)
    ? b.tierIds
        .map((x) => {
          if (typeof x === 'number' && Number.isInteger(x) && x > 0) return x;
          if (typeof x === 'string' && /^[1-9][0-9]*$/.test(x)) return Number(x);
          return null;
        })
        .filter((x): x is number => x !== null)
    : [];

  if (!name) return { error: 'Naam is verplicht.' };
  if (!kind) return { error: 'kind moet "percentage", "fixed_amount" of "btw_vrij" zijn.' };
  if (!DATE_RE.test(validFrom) || !DATE_RE.test(validUntil)) {
    return { error: 'validFrom/validUntil moeten "YYYY-MM-DD" zijn.' };
  }
  if (validUntil < validFrom) return { error: 'validUntil mag niet vóór validFrom liggen.' };

  let value: number | null = null;
  if (kind === 'percentage' || kind === 'fixed_amount') {
    if (typeof b.value !== 'number' || !Number.isFinite(b.value) || b.value < 0) {
      return { error: 'value is verplicht (niet-negatief getal) voor kind "percentage"/"fixed_amount".' };
    }
    if (kind === 'percentage' && b.value > 100) return { error: 'Een percentagekorting kan niet boven 100 zijn.' };
    value = b.value;
  }

  return { name, kind, value, validFrom, validUntil, tierIds };
}

licensesRouter.post('/offers', requireSysadmin, async (req, res) => {
  const parsed = parseOfferBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const offer = await offers.createOffer(parsed);
  res.status(201).json(offer);
});

licensesRouter.put('/offers/:id', requireSysadmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseOfferBody({
    name: b.name, kind: b.kind, validFrom: b.validFrom, validUntil: b.validUntil, value: b.value, tierIds: b.tierIds,
  });
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const offer = await offers.updateOffer(req.params.id, { ...parsed, hasValue: true });
  if (!offer) return res.status(404).json({ error: 'Aanbieding niet gevonden.' });
  res.json(offer);
});

licensesRouter.delete('/offers/:id', requireSysadmin, async (req, res) => {
  const ok = await offers.deleteOffer(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Aanbieding niet gevonden.' });
  res.status(204).send();
});
