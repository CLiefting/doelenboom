import { Router } from 'express';
import { AuthedRequest, requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import { listModules, listTiers } from '../license.js';
import { listOffers } from '../offers.js';
import {
  countPendingSubscriptionActions,
  createSubscriptionRequest,
  getSubscriptionRequestById,
  listLicenseEventsForTenant,
  listSubscriptionRequests,
  listUpcomingRenewals,
  quotePriceForTier,
  registerPayment,
  registerRenewal,
  rejectSubscriptionRequest,
  SubscriptionRequestError,
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
  // met een tier zonder (geldige) prijs sowieso niks tonen/aanvragen.
  const tiers = await listTiers();
  const today = new Date().toISOString().slice(0, 10);
  const withPrice = tiers.filter(
    (t) =>
      t.priceEur != null &&
      (t.priceValidFrom == null || t.priceValidFrom <= today) &&
      (t.priceValidUntil == null || t.priceValidUntil >= today)
  );
  res.json(withPrice);
});

// Modulecatalogus, publiek — zelfde data als GET /api/modules maar zonder
// login nodig (die route zit achter licensesRouter.use(requireAuth)), voor de
// modulekeuze op de aanvraagpagina.
subscriptionsRouter.get('/subscription-modules', async (_req, res) => {
  res.json(await listModules());
});

subscriptionsRouter.get('/subscription-offers', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const offers = await listOffers();
  res.json(offers.filter((o) => o.validFrom <= today && o.validUntil >= today));
});

subscriptionsRouter.get('/subscription-tiers/:tierId/price', async (req, res) => {
  const quote = await quotePriceForTier(req.params.tierId);
  if (!quote) return res.status(404).json({ error: 'Tier niet gevonden.' });
  res.json(quote);
});

subscriptionsRouter.post('/subscription-requests', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const organizationName = typeof b.organizationName === 'string' ? b.organizationName.trim() : '';
  const applicantName = typeof b.applicantName === 'string' ? b.applicantName.trim() : '';
  const applicantEmail = typeof b.applicantEmail === 'string' ? b.applicantEmail.trim().toLowerCase() : '';
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
