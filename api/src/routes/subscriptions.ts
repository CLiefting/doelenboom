import { Router } from 'express';
import { AuthedRequest, requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import { listModules, listTiers } from '../license.js';
import { listOffers } from '../offers.js';
import { getCurrentTierPrice } from '../tierPrices.js';
import { getCurrentModuleSurcharge } from '../moduleSurcharges.js';
import {
  countPendingSubscriptionActions,
  createSubscriptionRequest,
  getSubscriptionRequestById,
  listLicenseEventsForTenant,
  listSubscriptionRequests,
  listTenantSubscriptionOverview,
  listUpcomingRenewals,
  quotePrice,
  registerPayment,
  registerRenewal,
  rejectSubscriptionRequest,
  SubscriptionRequestError,
  updateSubscriptionRequestApplicant,
} from '../subscriptions.js';

// Zelfbedieningsaanvraag voor een nieuw abonnement — zie
// doelenboom_licentiemodel.md §2/§9 en subscriptions.ts. De eerste drie
// routes zijn BEWUST publiek/ongeauthenticeerd (zie app.ts: dit moet vóór de
// generieke '/api'-routers gemount worden, net als announcementRouter) —
// iemand die nog geen account heeft moet een aanvraag kunnen indienen. Alle
// overige routes (beheer van aanvragen) zijn sysadmin-only.
export const subscriptionsRouter = Router();

subscriptionsRouter.get('/subscription-tiers', async (_req, res) => {
  // Alleen tiers met een op dit moment geldige prijs — de aanvraagpagina kan
  // met een tier zonder (geldige) prijs sowieso niks tonen/aanvragen. De
  // huidige prijs wordt meegegeven als "currentPriceEur" (geen los endpoint
  // nodig per tier alleen om de tegel te vullen) — het volledige, met modules/
  // aanbieding verdisconteerde tarief blijft via .../price hieronder.
  const [tiers] = await Promise.all([listTiers()]);
  const today = new Date().toISOString().slice(0, 10);
  const withPrice = (
    await Promise.all(
      tiers.map(async (t) => ({ ...t, currentPriceEur: (await getCurrentTierPrice(t.id, today))?.priceEur ?? null }))
    )
  ).filter((t) => t.currentPriceEur != null);
  res.json(withPrice);
});

// Modulecatalogus, publiek — zelfde data als GET /api/modules maar zonder
// login nodig (die route zit achter licensesRouter.use(requireAuth)), voor de
// modulekeuze op de aanvraagpagina. currentSurchargePct erbij zodat de UI kan
// tonen wat een module momenteel aan opslag kost (null = nog niet bepaald).
subscriptionsRouter.get('/subscription-modules', async (_req, res) => {
  const modules = await listModules();
  const today = new Date().toISOString().slice(0, 10);
  const withSurcharge = await Promise.all(
    modules.map(async (m) => ({
      ...m,
      currentSurchargePct: (await getCurrentModuleSurcharge(m.id, today))?.surchargePct ?? null,
    }))
  );
  res.json(withSurcharge);
});

subscriptionsRouter.get('/subscription-offers', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const offers = await listOffers();
  res.json(offers.filter((o) => o.validFrom <= today && o.validUntil >= today));
});

// ?modules=projecten,templating — optioneel, om de opslag van geselecteerde
// modules mee te laten wegen in de prijsopgave (zie subscriptions.ts quotePrice).
subscriptionsRouter.get('/subscription-tiers/:tierId/price', async (req, res) => {
  const rawModules = typeof req.query.modules === 'string' ? req.query.modules : '';
  const moduleKeys = rawModules.split(',').map((k) => k.trim()).filter(Boolean);
  const quote = await quotePrice(req.params.tierId, moduleKeys);
  if (!quote) return res.status(404).json({ error: 'Tier niet gevonden.' });
  res.json(quote);
});

subscriptionsRouter.post('/subscription-requests', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const organizationName = typeof b.organizationName === 'string' ? b.organizationName.trim() : '';
  const applicantName = typeof b.applicantName === 'string' ? b.applicantName.trim() : '';
  const applicantEmail = typeof b.applicantEmail === 'string' ? b.applicantEmail.trim().toLowerCase() : '';
  // Optioneel — zie db/migrations/0019_applicant_phone.sql, geen validatie op
  // format (internationale nummers, spaties/haakjes etc. moeten allemaal kunnen).
  const applicantPhone = typeof b.applicantPhone === 'string' && b.applicantPhone.trim() ? b.applicantPhone.trim() : null;
  const password = typeof b.password === 'string' ? b.password : '';
  const tierId = Number(b.tierId);
  const moduleKeys = Array.isArray(b.moduleKeys) ? b.moduleKeys.filter((x): x is string => typeof x === 'string') : [];

  const errors: string[] = [];
  if (!organizationName) errors.push('Organisatienaam is verplicht.');
  if (!applicantName) errors.push('Naam is verplicht.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicantEmail)) errors.push('Geldig e-mailadres is verplicht.');
  if (!password || password.length < 8) errors.push('Wachtwoord (min. 8 tekens) is verplicht.');
  if (!Number.isFinite(tierId) || tierId <= 0) errors.push('Kies een geldige tier.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    const result = await createSubscriptionRequest({
      organizationName,
      applicantName,
      applicantEmail,
      applicantPhone,
      password,
      tierId,
      moduleKeys,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof SubscriptionRequestError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Aanvraag indienen mislukt', detail: (err as Error).message });
  }
});

// --- Sysadmin-beheer van aanvragen/verlengingen ---

subscriptionsRouter.use('/subscription-requests', requireAuth);
subscriptionsRouter.use('/subscription-requests', requireSysadmin);

subscriptionsRouter.get('/subscription-requests', async (_req, res) => {
  res.json(await listSubscriptionRequests());
});

// Eén rij per tenant (ook tenants zonder zelfbedieningsaanvraag) — voor het
// sorteerbare abonnementenoverzicht naast Tenantbeheer, zie
// listTenantSubscriptionOverview in subscriptions.ts. Sortering zelf gebeurt
// client-side (web/src/pages/SubscriptionOverviewPage.tsx) — dit endpoint
// geeft altijd de volledige, ongesorteerde lijst.
subscriptionsRouter.get('/subscription-requests/overview', async (_req, res) => {
  res.json(await listTenantSubscriptionOverview());
});

// Telling voor de meldingsbanner bovenin (zie App.tsx/PickerPage.tsx) —
// aparte, lichte route i.p.v. de hele lijst laten ophalen puur voor een getal.
subscriptionsRouter.get('/subscription-requests/pending-count', async (_req, res) => {
  res.json(await countPendingSubscriptionActions());
});

subscriptionsRouter.get('/subscription-requests/upcoming-renewals', async (req, res) => {
  const within = Number(req.query.withinDays);
  res.json(await listUpcomingRenewals(Number.isFinite(within) && within > 0 ? within : 30));
});

subscriptionsRouter.get('/subscription-requests/:id/events', async (req, res) => {
  const request = await getSubscriptionRequestById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Aanvraag niet gevonden.' });
  res.json(await listLicenseEventsForTenant(request.tenantId));
});

// Aanvrager-/contactgegevens corrigeren (naam/e-mail/telefoon) — zie het
// abonnementenoverzicht (SubscriptionOverviewPage.tsx). Raakt bewust NIET het
// inlogaccount van de aanvrager, zie updateSubscriptionRequestApplicant.
subscriptionsRouter.put('/subscription-requests/:id', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const updates: { applicantName?: string; applicantEmail?: string; applicantPhone?: string | null } = {};

  if ('applicantName' in b) {
    const v = typeof b.applicantName === 'string' ? b.applicantName.trim() : '';
    if (!v) return res.status(400).json({ error: 'Naam mag niet leeg zijn.' });
    updates.applicantName = v;
  }
  if ('applicantEmail' in b) {
    const v = typeof b.applicantEmail === 'string' ? b.applicantEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return res.status(400).json({ error: 'Geldig e-mailadres is verplicht.' });
    updates.applicantEmail = v;
  }
  if ('applicantPhone' in b) {
    updates.applicantPhone = typeof b.applicantPhone === 'string' && b.applicantPhone.trim() ? b.applicantPhone.trim() : null;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Niets om bij te werken.' });

  const updated = await updateSubscriptionRequestApplicant(req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Aanvraag niet gevonden.' });
  res.json(updated);
});

subscriptionsRouter.post('/subscription-requests/:id/register-payment', async (req: AuthedRequest, res) => {
  try {
    const updated = await registerPayment(req.params.id, req.user!.id);
    if (!updated) return res.status(404).json({ error: 'Aanvraag niet gevonden.' });
    res.json(updated);
  } catch (err) {
    if (err instanceof SubscriptionRequestError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Betaling registreren mislukt', detail: (err as Error).message });
  }
});

subscriptionsRouter.post('/subscription-requests/:id/register-renewal', async (req: AuthedRequest, res) => {
  try {
    const updated = await registerRenewal(req.params.id, req.user!.id);
    if (!updated) return res.status(404).json({ error: 'Aanvraag niet gevonden.' });
    res.json(updated);
  } catch (err) {
    if (err instanceof SubscriptionRequestError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Verlenging registreren mislukt', detail: (err as Error).message });
  }
});

subscriptionsRouter.post('/subscription-requests/:id/reject', async (req: AuthedRequest, res) => {
  const reason = typeof (req.body ?? {}).reason === 'string' ? (req.body as { reason: string }).reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'Reden is verplicht bij afwijzen.' });
  try {
    const updated = await rejectSubscriptionRequest(req.params.id, req.user!.id, reason);
    if (!updated) return res.status(404).json({ error: 'Aanvraag niet gevonden.' });
    res.json(updated);
  } catch (err) {
    if (err instanceof SubscriptionRequestError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Afwijzen mislukt', detail: (err as Error).message });
  }
});
