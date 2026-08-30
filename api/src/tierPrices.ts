import { pool } from './db.js';

// Prijsgeschiedenis van tiers — een abonnement heeft door de tijd heen
// meerdere prijzen (bv. € 125/jaar in 2026, een ander tarief in 2027), dus
// dit is een eigen tabel (tier_prices) i.p.v. een enkel prijsveld op de tier
// zelf. Zie db/migrations/0016_price_history.sql en
// doelenboom_licentiemodel.md §9. Meerdere rijen per tier zijn toegestaan,
// ook met overlappende periodes (de sysadmin is verantwoordelijk voor een
// zinnige, aaneensluitende geschiedenis — de UI markeert alleen duidelijk
// welke rij op dit moment geldig is, zie getCurrentTierPrice hieronder).

export interface TierPrice {
  id: number;
  tierId: number;
  priceEur: string;
  validFrom: string;
  validUntil: string;
}

const TIER_PRICE_SELECT_FIELDS =
  'id, tier_id as "tierId", price_eur as "priceEur", ' +
  'to_char(valid_from, \'YYYY-MM-DD\') as "validFrom", to_char(valid_until, \'YYYY-MM-DD\') as "validUntil"';

export async function listTierPrices(tierId?: number | string): Promise<TierPrice[]> {
  if (tierId != null) {
    const r = await pool.query(
      `select ${TIER_PRICE_SELECT_FIELDS} from tier_prices where tier_id = $1 order by valid_from desc`,
      [tierId]
    );
    return r.rows;
  }
  const r = await pool.query(`select ${TIER_PRICE_SELECT_FIELDS} from tier_prices order by tier_id, valid_from desc`);
  return r.rows;
}

export async function getTierPrice(id: number | string): Promise<TierPrice | null> {
  const r = await pool.query(`select ${TIER_PRICE_SELECT_FIELDS} from tier_prices where id = $1`, [id]);
  return r.rows[0] ?? null;
}

// De op datum `onDate` geldige prijs voor één tier — als meerdere rijen die
// datum overlappen (zou niet moeten voorkomen bij een nette geschiedenis,
// maar is niet hard afgedwongen) wordt de meest recent GESTARTE periode
// gebruikt. Puur leeswerk, gebruikt door zowel de publieke aanvraagpagina
// (subscriptions.ts) als het licentiebeheerscherm (om "huidig geldig" te
// markeren).
export async function getCurrentTierPrice(tierId: number | string, onDate: string): Promise<TierPrice | null> {
  const r = await pool.query(
    `select ${TIER_PRICE_SELECT_FIELDS} from tier_prices
     where tier_id = $1 and valid_from <= $2 and valid_until >= $2
     order by valid_from desc limit 1`,
    [tierId, onDate]
  );
  return r.rows[0] ?? null;
}

export async function createTierPrice(input: {
  tierId: number;
  priceEur: number;
  validFrom: string;
  validUntil: string;
}): Promise<TierPrice> {
  const r = await pool.query(
    `insert into tier_prices (tier_id, price_eur, valid_from, valid_until) values ($1,$2,$3,$4)
     returning ${TIER_PRICE_SELECT_FIELDS}`,
    [input.tierId, input.priceEur, input.validFrom, input.validUntil]
  );
  return r.rows[0];
}

export async function updateTierPrice(
  id: number | string,
  input: { priceEur?: number; validFrom?: string; validUntil?: string }
): Promise<TierPrice | null> {
  const r = await pool.query(
    `update tier_prices set
       price_eur = coalesce($1, price_eur),
       valid_from = coalesce($2, valid_from),
       valid_until = coalesce($3, valid_until),
       updated_at = now()
     where id = $4
     returning ${TIER_PRICE_SELECT_FIELDS}`,
    [input.priceEur ?? null, input.validFrom ?? null, input.validUntil ?? null, id]
  );
  return r.rows[0] ?? null;
}

export async function deleteTierPrice(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from tier_prices where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}
