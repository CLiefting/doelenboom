import { pool } from './db.js';
import { createTenantDefaultConfig } from './columnConfig.js';
import { computeDefaultLicenseEndDate, listModules, listTiers } from './license.js';
import { computeOfferedPrice, listActiveOffersForTier, ModuleSurchargeLine, PriceQuote } from './offers.js';
import { getCurrentTierPrice } from './tierPrices.js';
import { getCurrentModuleSurcharge } from './moduleSurcharges.js';

// Zelfbedieningsaanvraag voor een nieuw abonnement — zie
// doelenboom_licentiemodel.md §2/§9 (het volledige ontwerp, uit het gesprek
// van 30 augustus 2026) en db/migrations/0015_subscription_requests.sql.
// Bundelt de hele levenscyclus: aanvragen (publiek, zonder login) → proef
// (2 weken, automatisch alleen-lezen erna via de bestaande license_end_date-
// enforcement, zie license.ts isLicenseExpired/rbac.ts requireWritableDoelenboom
// — GEEN nieuwe blokkade-mechaniek nodig) → betaling registreren (sysadmin) →
// actief (12 maanden vanaf de AANVRAAGdatum, met 1 maand coulance na het
// verlopen — ook weer via diezelfde license_end_date-check) → verlengen.
// Elke stap wordt gelogd in license_events (aparte, losstaande logging-module
// voor traceerbaarheid — zie logEvent hieronder).

const TRIAL_DAYS = 14;
const GRACE_DAYS = 30; // ~1 maand coulance na de contractuele einddatum

export interface SubscriptionRequestRow {
  id: number;
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  tierId: number | null;
  tierName: string | null;
  organizationName: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  requestedModules: string[];
  status: 'proef' | 'actief' | 'afgewezen';
  requestedAt: string;
  priceAtRequest: string | null;
  contractEndDate: string | null;
  licenseEndDate: string | null;
  paymentRegisteredAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
}

const REQUEST_SELECT_FIELDS = `
  sr.id, sr.tenant_id as "tenantId", t.slug as "tenantSlug", t.name as "tenantName",
  sr.tier_id as "tierId", ti.name as "tierName",
  sr.organization_name as "organizationName", sr.applicant_name as "applicantName",
  sr.applicant_email as "applicantEmail", sr.applicant_phone as "applicantPhone",
  sr.requested_modules as "requestedModules",
  sr.status, sr.requested_at as "requestedAt", sr.price_at_request as "priceAtRequest",
  to_char(sr.contract_end_date, 'YYYY-MM-DD') as "contractEndDate",
  to_char(t.license_end_date, 'YYYY-MM-DD') as "licenseEndDate",
  sr.payment_registered_at as "paymentRegisteredAt",
  sr.rejected_at as "rejectedAt", sr.rejected_reason as "rejectedReason"
`;

async function logEvent(
  client: { query: typeof pool.query },
  input: {
    tenantId: number | null;
    subscriptionRequestId: number | null;
    eventType: 'aangevraagd' | 'betaling_geregistreerd' | 'afgewezen' | 'verlengd';
    detail: Record<string, unknown>;
    performedBy: number | null;
  }
): Promise<void> {
  await client.query(
    `insert into license_events (tenant_id, subscription_request_id, event_type, detail, performed_by)
     values ($1,$2,$3,$4,$5)`,
    [input.tenantId, input.subscriptionRequestId, input.eventType, JSON.stringify(input.detail), input.performedBy]
  );
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // diakrieten weg (bv. "é" -> "e") na NFKD-normalisatie
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tenant'
  );
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  let i = 1;
  // Eenvoudige oplopende suffix bij botsing — voldoende voor dit
  // aanvraagvolume, geen race-condition-bescherming nodig (uniek-constraint
  // op tenants.slug vangt dat sowieso af als het toch zou gebeuren).
  while (true) {
    const r = await pool.query('select 1 from tenants where slug = $1', [candidate]);
    if (r.rows.length === 0) return candidate;
    i += 1;
    candidate = `${root}-${i}`;
  }
}

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class SubscriptionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionRequestError';
  }
}

// Prijsopgave voor de publieke aanvraagpagina: het op dit moment geldige
// tarief van de gekozen tier (zie tierPrices.ts) + de op dit moment geldige
// opslag van elke gekozen module (moduleSurcharges.ts) + eerst-gevonden
// lopende aanbieding voor die tier (toegepast op tier + modules samen, zie
// computeOfferedPrice). Ongeauthenticeerd te gebruiken
// (routes/subscriptions.ts) — puur leeswerk, geen bijeffecten.
export async function quotePrice(
  tierId: number | string,
  moduleKeys: string[],
  onDate?: string
): Promise<PriceQuote | null> {
  const tiers = await listTiers();
  const tier = tiers.find((t) => String(t.id) === String(tierId));
  if (!tier) return null;
  const today = onDate ?? new Date().toISOString().slice(0, 10);

  const tierPrice = await getCurrentTierPrice(tierId, today);
  const tierPriceEur = tierPrice ? Number(tierPrice.priceEur) : null;

  const allModules = moduleKeys.length > 0 ? await listModules() : [];
  const moduleSurcharges: ModuleSurchargeLine[] = [];
  if (tierPriceEur != null) {
    for (const key of moduleKeys) {
      const mod = allModules.find((m) => m.key === key);
      if (!mod) continue;
      const surcharge = await getCurrentModuleSurcharge(mod.id, today);
      if (!surcharge) continue; // (nog) geen opslag ingesteld voor deze module -> telt niet mee
      const pct = Number(surcharge.surchargePct);
      moduleSurcharges.push({
        moduleKey: mod.key,
        moduleName: mod.name,
        surchargePct: pct,
        amountEur: Math.round(tierPriceEur * (pct / 100) * 100) / 100,
      });
    }
  }

  const offers = await listActiveOffersForTier(tierId, today);
  return computeOfferedPrice(tierPriceEur, moduleSurcharges, offers);
}

// De publieke aanvraag zelf: maakt in één transactie de tenant, het
// admin-account (zelfgekozen wachtwoord, zie interview: geen
// must_change_password nodig) en de subscription_requests-rij aan.
// license_end_date van de tenant wordt meteen op aanvraagdatum + 14 dagen
// gezet — de proefperiode blokkeert zichzelf dus automatisch via de
// bestaande license.isLicenseExpired-enforcement, geen aparte sweep nodig.
export async function createSubscriptionRequest(input: {
  organizationName: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  password: string;
  tierId: number;
  moduleKeys: string[];
}): Promise<{ tenantId: number; tenantSlug: string; requestId: number }> {
  const emailExists = await pool.query('select 1 from users where email = $1', [input.applicantEmail]);
  if (emailExists.rows.length > 0) {
    throw new SubscriptionRequestError('Er bestaat al een account met dit e-mailadres.');
  }
  const tiers = await listTiers();
  const tier = tiers.find((t) => String(t.id) === String(input.tierId));
  if (!tier) throw new SubscriptionRequestError('Onbekende tier.');

  // Tiers met allModulesIncluded (bv. Evaluatie, zie db/migrations/
  // 0018_evaluatie_tier.sql) negeren de door de aanvrager aangevinkte modules
  // en krijgen ALTIJD alle op dit moment bestaande modules — vóór de
  // validatie hieronder, zodat een leeg of onbekend moduleKeys-veld van de
  // aanvrager hier al geen verschil meer maakt.
  const moduleKeys = tier.allModulesIncluded ? (await listModules()).map((m) => m.key) : input.moduleKeys;

  if (moduleKeys.length > 0) {
    const modRows = await pool.query('select key from modules where key = any($1)', [moduleKeys]);
    if (modRows.rows.length !== moduleKeys.length) {
      throw new SubscriptionRequestError('Eén of meer gekozen modules bestaan niet.');
    }
  }

  const now = new Date();
  const requestedAt = now.toISOString();
  // Tier-specifieke proefduur (bv. Evaluatie: 30 dagen) valt terug op de
  // standaard TRIAL_DAYS als de tier zelf geen eigen trialDays heeft.
  const trialEndDate = addDays(now, tier.trialDays ?? TRIAL_DAYS);
  const slug = await uniqueSlug(input.organizationName);

  const today = requestedAt.slice(0, 10);
  const quote = await quotePrice(tier.id, moduleKeys, today);
  if (!quote) throw new SubscriptionRequestError('Onbekende tier.'); // kan hier niet echt gebeuren (tier hierboven al gevonden)

  const client = await pool.connect();
  try {
    await client.query('begin');

    const tenantResult = await client.query(
      `insert into tenants (slug, name, tier_id, license_end_date) values ($1,$2,$3,$4)
       returning id, slug, name`,
      [slug, input.organizationName, tier.id, trialEndDate]
    );
    const tenantId = tenantResult.rows[0].id as number;
    await createTenantDefaultConfig(client, tenantId, input.organizationName);

    const userResult = await client.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ($1, crypt($2, gen_salt('bf')), false, false) returning id`,
      [input.applicantEmail, input.password]
    );
    const userId = userResult.rows[0].id as number;
    await client.query(`insert into tenant_users (tenant_id, user_id, role) values ($1,$2,'admin')`, [
      tenantId,
      userId,
    ]);

    for (const key of moduleKeys) {
      await client.query(
        `insert into tenant_modules (tenant_id, module_id)
         select $1, id from modules where key = $2 on conflict do nothing`,
        [tenantId, key]
      );
    }

    const requestResult = await client.query(
      `insert into subscription_requests
         (tenant_id, tier_id, organization_name, applicant_name, applicant_email, applicant_phone,
          requested_modules, status, requested_at, price_at_request, applied_offer_id)
       values ($1,$2,$3,$4,$5,$6,$7,'proef',$8,$9,$10)
       returning id`,
      [
        tenantId,
        tier.id,
        input.organizationName,
        input.applicantName,
        input.applicantEmail,
        input.applicantPhone,
        JSON.stringify(moduleKeys),
        requestedAt,
        quote.finalPriceEur,
        quote.offer?.id ?? null,
      ]
    );
    const requestId = requestResult.rows[0].id as number;

    await logEvent(client, {
      tenantId,
      subscriptionRequestId: requestId,
      eventType: 'aangevraagd',
      detail: {
        tierId: tier.id,
        tierName: tier.name,
        modules: moduleKeys,
        tierPriceEur: quote.tierPriceEur,
        moduleSurcharges: quote.moduleSurcharges,
        subtotalEur: quote.subtotalEur,
        priceAtRequest: quote.finalPriceEur,
        offerId: quote.offer?.id ?? null,
        trialEndDate,
      },
      performedBy: null,
    });

    await client.query('commit');
    return { tenantId, tenantSlug: tenantResult.rows[0].slug, requestId };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface TenantSubscriptionOverviewRow {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  // null als deze tenant geen zelfbedieningsaanvraag heeft (handmatig door
  // een sysadmin aangemaakt) — bepaalt in de UI of bewerken van
  // aanvrager-/contactgegevens en betaling/verlenging registreren mogelijk
  // is (die acties werken op een subscription_requests-rij).
  requestId: number | null;
  tierId: number | null;
  tierName: string | null;
  licenseEndDate: string | null;
  status: 'proef' | 'actief' | 'afgewezen' | null;
  applicantName: string | null;
  applicantEmail: string | null;
  applicantPhone: string | null;
  requestedAt: string | null;
}

// Eén rij per tenant (in tegenstelling tot listSubscriptionRequests hierboven,
// dat alleen tenants toont die via de zelfbedieningsaanvraag zijn ontstaan) —
// voor het sorteerbare abonnementenoverzicht naast Tenantbeheer (verzoek van
// Charles, 30 augustus 2026: "welk abonnement bij de tenant hoort, tot
// wanneer, wie de aanvrager is en wat het email/tel nummer is"). Tier en
// verloopdatum komen bewust van tenants zelf (tier_id/license_end_date) i.p.v.
// subscription_requests — dat zijn de levende/actuele velden, ook voor een
// handmatig door een sysadmin aangemaakte tenant zonder aanvraag (dan blijven
// status/aanvrager/e-mail/telefoon gewoon null).
export async function listTenantSubscriptionOverview(): Promise<TenantSubscriptionOverviewRow[]> {
  const r = await pool.query(
    `select t.id as "tenantId", t.slug as "tenantSlug", t.name as "tenantName",
            sr.id as "requestId",
            t.tier_id as "tierId", ti.name as "tierName",
            to_char(t.license_end_date, 'YYYY-MM-DD') as "licenseEndDate",
            sr.status,
            sr.applicant_name as "applicantName",
            sr.applicant_email as "applicantEmail",
            sr.applicant_phone as "applicantPhone",
            sr.requested_at as "requestedAt"
     from tenants t
     left join tiers ti on ti.id = t.tier_id
     left join subscription_requests sr on sr.tenant_id = t.id
     order by t.name`
  );
  return r.rows;
}

export async function listSubscriptionRequests(): Promise<SubscriptionRequestRow[]> {
  const r = await pool.query(
    `select ${REQUEST_SELECT_FIELDS}
     from subscription_requests sr
     join tenants t on t.id = sr.tenant_id
     left join tiers ti on ti.id = sr.tier_id
     order by sr.requested_at desc`
  );
  return r.rows;
}

// Abonnementen die binnen `withinDays` verlopen (contract_end_date) en nog
// actief zijn — voor de vervalwaarschuwing (melding bovenin + Aanvragen-
// scherm). Puur een live query op datum, geen sweep/achtergrondtaak nodig.
export async function listUpcomingRenewals(withinDays = 30): Promise<SubscriptionRequestRow[]> {
  const r = await pool.query(
    `select ${REQUEST_SELECT_FIELDS}
     from subscription_requests sr
     join tenants t on t.id = sr.tenant_id
     left join tiers ti on ti.id = sr.tier_id
     where sr.status = 'actief'
       and sr.contract_end_date is not null
       and sr.contract_end_date <= current_date + make_interval(days => $1)
     order by sr.contract_end_date`,
    [withinDays]
  );
  return r.rows;
}

// Telling voor de meldingsbanner bovenin (sysadmin-only, zie
// routes/subscriptions.ts en AnnouncementBanner/App.tsx): aanvragen nog in
// de proefperiode (nog geen betaling geregistreerd) + abonnementen die
// binnen 30 dagen aflopen.
export async function countPendingSubscriptionActions(): Promise<{ pendingRequests: number; upcomingRenewals: number }> {
  const [pending, renewals] = await Promise.all([
    pool.query(`select count(*)::int as n from subscription_requests where status = 'proef'`),
    pool.query(
      `select count(*)::int as n from subscription_requests
       where status = 'actief' and contract_end_date is not null
         and contract_end_date <= current_date + make_interval(days => 30)`
    ),
  ]);
  return { pendingRequests: pending.rows[0].n, upcomingRenewals: renewals.rows[0].n };
}

// Betaling van de EERSTE periode registreren (status 'proef' -> 'actief').
// contract_end_date = computeDefaultLicenseEndDate vanaf de oorspronkelijke
// AANVRAAGdatum (zie interview: looptijd telt vanaf de aanvraag, niet vanaf
// de betaaldatum) — "laatste dag van de maand, 12 maanden later".
// tenants.license_end_date krijgt daar nog eens 30 dagen coulance bovenop
// (GRACE_DAYS), zodat het abonnement na de contractuele einddatum nog even
// doorloopt voordat de bestaande license.isLicenseExpired-check de tenant
// daadwerkelijk blokkeert (zie doelenboom_licentiemodel.md §6 — "verlenging").
export async function registerPayment(
  requestId: number | string,
  performedBy: number
): Promise<SubscriptionRequestRow | null> {
  const existing = await pool.query(
    `select id, tenant_id, status, requested_at from subscription_requests where id = $1`,
    [requestId]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.status !== 'proef') {
    throw new SubscriptionRequestError('Deze aanvraag staat niet (meer) op "proef".');
  }

  const contractEndDate = computeDefaultLicenseEndDate(new Date(row.requested_at));
  const licenseEndDate = addDays(new Date(`${contractEndDate}T00:00:00Z`), GRACE_DAYS);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update subscription_requests set status = 'actief', payment_registered_at = now(),
         payment_registered_by = $1, contract_end_date = $2 where id = $3`,
      [performedBy, contractEndDate, requestId]
    );
    await client.query('update tenants set license_end_date = $1 where id = $2', [licenseEndDate, row.tenant_id]);
    await logEvent(client, {
      tenantId: row.tenant_id,
      subscriptionRequestId: Number(requestId),
      eventType: 'betaling_geregistreerd',
      detail: { contractEndDate, licenseEndDate, renewal: false },
      performedBy,
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return getSubscriptionRequestById(requestId);
}

// Verlenging: contract_end_date +12 maanden (zelfde "laatste dag van de
// maand"-logica, nu vanaf de HUIDIGE contract_end_date i.p.v. de
// aanvraagdatum), license_end_date opnieuw met 30 dagen coulance erboven op.
// Mag alleen op een al 'actief' abonnement (een 'proef'-aanvraag heeft nog
// geen contract_end_date om vanaf te verlengen — dat is registerPayment
// hierboven; 'afgewezen' kan niet meer verlengd worden).
export async function registerRenewal(
  requestId: number | string,
  performedBy: number
): Promise<SubscriptionRequestRow | null> {
  const existing = await pool.query(
    `select id, tenant_id, status, to_char(contract_end_date, 'YYYY-MM-DD') as contract_end_date
     from subscription_requests where id = $1`,
    [requestId]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.status !== 'actief' || !row.contract_end_date) {
    throw new SubscriptionRequestError('Alleen een actief abonnement met een contractuele einddatum kan verlengd worden.');
  }

  // De huidige contract_end_date is altijd al "laatste dag van een maand"
  // (zie hierboven/registerPayment) — computeDefaultLicenseEndDate rechtstreeks
  // op déze datum voeden geeft dus "dezelfde maand, +12 maanden" (i.p.v. een
  // dag erna te nemen, wat de boel een maand zou opschuiven).
  const newContractEndDate = computeDefaultLicenseEndDate(new Date(`${row.contract_end_date}T00:00:00Z`));
  const newLicenseEndDate = addDays(new Date(`${newContractEndDate}T00:00:00Z`), GRACE_DAYS);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update subscription_requests set contract_end_date = $1, payment_registered_at = now(),
         payment_registered_by = $2 where id = $3`,
      [newContractEndDate, performedBy, requestId]
    );
    await client.query('update tenants set license_end_date = $1 where id = $2', [newLicenseEndDate, row.tenant_id]);
    await logEvent(client, {
      tenantId: row.tenant_id,
      subscriptionRequestId: Number(requestId),
      eventType: 'verlengd',
      detail: { previousContractEndDate: row.contract_end_date, contractEndDate: newContractEndDate, licenseEndDate: newLicenseEndDate },
      performedBy,
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return getSubscriptionRequestById(requestId);
}

// Afwijzen: alleen mogelijk vanuit 'proef' (een reeds actief/betaald
// abonnement afwijzen is geen zinnig concept meer — dat verloopt gewoon
// natuurlijk als niet verlengd wordt). Blokkeert de tenant onmiddellijk door
// license_end_date op gisteren te zetten — hergebruikt dezelfde bestaande
// enforcement (isLicenseExpired) i.p.v. een nieuw blokkade-mechanisme.
export async function rejectSubscriptionRequest(
  requestId: number | string,
  performedBy: number,
  reason: string
): Promise<SubscriptionRequestRow | null> {
  const existing = await pool.query(`select id, tenant_id, status from subscription_requests where id = $1`, [
    requestId,
  ]);
  const row = existing.rows[0];
  if (!row) return null;
  if (row.status !== 'proef') {
    throw new SubscriptionRequestError('Alleen een aanvraag die nog op "proef" staat kan afgewezen worden.');
  }

  const yesterday = addDays(new Date(), -1);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update subscription_requests set status = 'afgewezen', rejected_at = now(),
         rejected_by = $1, rejected_reason = $2 where id = $3`,
      [performedBy, reason, requestId]
    );
    await client.query('update tenants set license_end_date = $1 where id = $2', [yesterday, row.tenant_id]);
    await logEvent(client, {
      tenantId: row.tenant_id,
      subscriptionRequestId: Number(requestId),
      eventType: 'afgewezen',
      detail: { reason },
      performedBy,
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return getSubscriptionRequestById(requestId);
}

// Aanvrager-/contactgegevens van een bestaande aanvraag corrigeren (bv. een
// tikfout, of een gewijzigd telefoonnummer) — zie het abonnementenoverzicht
// (SubscriptionOverviewPage.tsx). BEWUST alleen de kolommen op
// subscription_requests zelf: dit raakt NIET het inlogaccount (users.email/
// wachtwoord) van de aanvrager — dat is een apart, bewust gescheiden concept
// (zie AccountManagementPage.tsx voor accountbeheer). Elk veld is optioneel:
// alleen meegegeven velden worden bijgewerkt (undefined = ongewijzigd
// laten); applicantPhone mag expliciet naar null (leegmaken).
export async function updateSubscriptionRequestApplicant(
  id: number | string,
  input: { applicantName?: string; applicantEmail?: string; applicantPhone?: string | null }
): Promise<SubscriptionRequestRow | null> {
  const r = await pool.query(
    `update subscription_requests set
       applicant_name = coalesce($1, applicant_name),
       applicant_email = coalesce($2, applicant_email),
       applicant_phone = case when $3 then $4 else applicant_phone end
     where id = $5
     returning id`,
    [
      input.applicantName ?? null,
      input.applicantEmail ?? null,
      'applicantPhone' in input,
      input.applicantPhone ?? null,
      id,
    ]
  );
  if (r.rows.length === 0) return null;
  return getSubscriptionRequestById(id);
}

export async function getSubscriptionRequestById(id: number | string): Promise<SubscriptionRequestRow | null> {
  const r = await pool.query(
    `select ${REQUEST_SELECT_FIELDS}
     from subscription_requests sr
     join tenants t on t.id = sr.tenant_id
     left join tiers ti on ti.id = sr.tier_id
     where sr.id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export async function listLicenseEventsForTenant(tenantId: number | string): Promise<
  Array<{
    id: number;
    eventType: string;
    detail: Record<string, unknown>;
    performedBy: number | null;
    performedByEmail: string | null;
    createdAt: string;
  }>
> {
  const r = await pool.query(
    `select le.id, le.event_type as "eventType", le.detail, le.performed_by as "performedBy",
            u.email as "performedByEmail", le.created_at as "createdAt"
     from license_events le
     left join users u on u.id = le.performed_by
     where le.tenant_id = $1
     order by le.created_at desc`,
    [tenantId]
  );
  return r.rows;
}
