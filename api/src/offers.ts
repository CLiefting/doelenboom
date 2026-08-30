import { pool } from './db.js';

// Tijdelijke aanbiedingen (bv. "eerste jaar 33% korting", "nu zonder BTW") —
// zie doelenboom_licentiemodel.md §2/§9 en db/migrations/
// 0015_subscription_requests.sql. Per tier instelbaar (offer_tiers): een
// aanbieding kan aan meerdere tiers gekoppeld zijn, of aan geen enkele (dan
// is 'ie aangemaakt maar nergens toegepast — geen foutsituatie, gewoon nog
// niet gekoppeld).

export type OfferKind = 'percentage' | 'fixed_amount' | 'btw_vrij';

export interface Offer {
  id: number;
  name: string;
  kind: OfferKind;
  value: string | null;
  validFrom: string;
  validUntil: string;
  tierIds: number[];
}

const OFFER_SELECT_FIELDS =
  `o.id, o.name, o.kind, o.value, to_char(o.valid_from, 'YYYY-MM-DD') as "validFrom", ` +
  `to_char(o.valid_until, 'YYYY-MM-DD') as "validUntil"`;

async function attachTierIds(offers: Omit<Offer, 'tierIds'>[]): Promise<Offer[]> {
  if (offers.length === 0) return [];
  const ids = offers.map((o) => o.id);
  const r = await pool.query('select offer_id, tier_id from offer_tiers where offer_id = any($1)', [ids]);
  const byOffer = new Map<number, number[]>();
  for (const row of r.rows) {
    const list = byOffer.get(row.offer_id) ?? [];
    list.push(row.tier_id);
    byOffer.set(row.offer_id, list);
  }
  return offers.map((o) => ({ ...o, tierIds: byOffer.get(o.id) ?? [] }));
}

export async function listOffers(): Promise<Offer[]> {
  const r = await pool.query(`select ${OFFER_SELECT_FIELDS} from offers o order by o.valid_from desc, o.name`);
  return attachTierIds(r.rows);
}

// Aanbiedingen die NU (of op de gegeven datum) geldig zijn voor één specifieke
// tier — gebruikt door de publieke aanvraagpagina om automatisch een korting
// te tonen (zie interview-antwoord: "automatisch zichtbaar tijdens
// geldigheid"). Kan meerdere rijen teruggeven (meerdere lopende aanbiedingen
// voor dezelfde tier) — de aanroeper kiest zelf welke toegepast wordt (zie
// computeOfferedPrice hieronder, die gewoon de eerste/beste pakt).
export async function listActiveOffersForTier(tierId: number | string, onDate: string): Promise<Offer[]> {
  const r = await pool.query(
    `select ${OFFER_SELECT_FIELDS}
     from offers o join offer_tiers ot on ot.offer_id = o.id
     where ot.tier_id = $1 and o.valid_from <= $2 and o.valid_until >= $2
     order by o.valid_from desc`,
    [tierId, onDate]
  );
  return attachTierIds(r.rows);
}

export async function getOffer(id: number | string): Promise<Offer | null> {
  const r = await pool.query(`select ${OFFER_SELECT_FIELDS} from offers o where o.id = $1`, [id]);
  if (r.rows.length === 0) return null;
  const [offer] = await attachTierIds(r.rows);
  return offer;
}

async function setOfferTiers(offerId: number, tierIds: number[]): Promise<void> {
  await pool.query('delete from offer_tiers where offer_id = $1', [offerId]);
  for (const tierId of tierIds) {
    await pool.query('insert into offer_tiers (offer_id, tier_id) values ($1,$2) on conflict do nothing', [
      offerId,
      tierId,
    ]);
  }
}

export async function createOffer(input: {
  name: string;
  kind: OfferKind;
  value: number | null;
  validFrom: string;
  validUntil: string;
  tierIds: number[];
}): Promise<Offer> {
  const r = await pool.query(
    `insert into offers (name, kind, value, valid_from, valid_until) values ($1,$2,$3,$4,$5) returning id`,
    [input.name, input.kind, input.value, input.validFrom, input.validUntil]
  );
  const offerId = r.rows[0].id as number;
  await setOfferTiers(offerId, input.tierIds);
  return (await getOffer(offerId))!;
}

export async function updateOffer(
  id: number | string,
  input: {
    name?: string;
    kind?: OfferKind;
    value?: number | null;
    hasValue?: boolean;
    validFrom?: string;
    validUntil?: string;
    tierIds?: number[];
  }
): Promise<Offer | null> {
  const existing = await getOffer(id);
  if (!existing) return null;
  await pool.query(
    `update offers set
       name = coalesce($1, name),
       kind = coalesce($2, kind),
       value = case when $3 then $4 else value end,
       valid_from = coalesce($5, valid_from),
       valid_until = coalesce($6, valid_until),
       updated_at = now()
     where id = $7`,
    [
      input.name ?? null,
      input.kind ?? null,
      !!input.hasValue,
      input.value ?? null,
      input.validFrom ?? null,
      input.validUntil ?? null,
      id,
    ]
  );
  if (input.tierIds) await setOfferTiers(Number(id), input.tierIds);
  return getOffer(id);
}

export async function deleteOffer(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from offers where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}

// Eén geselecteerde module in de prijsopgave: het bedrag is altijd het
// percentage van de tier-BASISPRIJS (niet van het subtotaal/de vorige
// module) — zie doelenboom_licentiemodel.md §3 ("opslag als percentage van
// de tier-basisprijs").
export interface ModuleSurchargeLine {
  moduleKey: string;
  moduleName: string;
  surchargePct: number;
  amountEur: number;
}

export interface PriceQuote {
  tierPriceEur: number | null;
  moduleSurcharges: ModuleSurchargeLine[];
  // tierPriceEur + som van moduleSurcharges, vóór een eventuele aanbieding.
  subtotalEur: number | null;
  offer: Offer | null;
  finalPriceEur: number | null;
  btwVrij: boolean;
}

// Berekent het effectieve tarief: tier-basisprijs (op dit moment geldig, zie
// tierPrices.ts getCurrentTierPrice) + module-opslagen (module_surcharges,
// eveneens "op dit moment geldig" — zie moduleSurcharges.ts) min een
// eventuele automatisch-toepasbare aanbieding (de eerst gevonden lopende
// aanbieding voor deze tier — zie listActiveOffersForTier), toegepast op het
// SUBTOTAAL (tier + modules), niet alleen op de tier-basisprijs. Puur
// berekening, geen bijeffecten — gebruikt door zowel de publieke
// aanvraagpagina (GET .../price) als het aanmaken van de aanvraag zelf (om
// price_at_request/applied_offer_id te snapshotten).
export function computeOfferedPrice(
  tierPriceEur: number | null,
  moduleSurcharges: ModuleSurchargeLine[],
  offers: Offer[]
): PriceQuote {
  const subtotalEur =
    tierPriceEur == null
      ? null
      : Math.round((tierPriceEur + moduleSurcharges.reduce((sum, m) => sum + m.amountEur, 0)) * 100) / 100;

  const offer = offers[0] ?? null;
  if (subtotalEur == null || !offer) {
    return { tierPriceEur, moduleSurcharges, subtotalEur, offer, finalPriceEur: subtotalEur, btwVrij: false };
  }

  let finalPriceEur = subtotalEur;
  if (offer.kind === 'percentage' && offer.value != null) {
    finalPriceEur = Math.round(subtotalEur * (1 - Number(offer.value) / 100) * 100) / 100;
  } else if (offer.kind === 'fixed_amount' && offer.value != null) {
    finalPriceEur = Math.max(0, Math.round((subtotalEur - Number(offer.value)) * 100) / 100);
  }
  return { tierPriceEur, moduleSurcharges, subtotalEur, offer, finalPriceEur, btwVrij: offer.kind === 'btw_vrij' };
}
