import { pool } from './db.js';

// Tier-specifieke, VASTE module-opslag — sinds 7 september 2026 (zie
// doelenboom_licentiemodel.md §3 v3 en de prijsstrategie-notitie van
// Charles): in tegenstelling tot moduleSurcharges.ts (één percentage van de
// tier-basisprijs, voor alle tiers gelijk) geeft deze tabel per tier ÉN per
// facturatieperiode (maand/jaar) een eigen vast bedrag — precies zoals de
// notitie het voorstelt (Projecten: Brons +€10/maand, Zilver +€20/maand,
// Goud +€30/maand, Diamant inbegrepen/€0). quotePrice (subscriptions.ts)
// gebruikt, per module, deze tabel als er een geldige rij bestaat voor de
// gekozen tier+periode; anders valt hij terug op het percentage in
// module_surcharges. Zelfde "meerdere periodes, meest recente valid_from
// wint bij overlap"-principe als tierPrices.ts/moduleSurcharges.ts.

export interface ModuleTierSurcharge {
  id: number;
  moduleId: number;
  tierId: number;
  period: 'maand' | 'jaar';
  priceEur: string;
  validFrom: string;
  validUntil: string;
}

const SELECT_FIELDS =
  'id, module_id as "moduleId", tier_id as "tierId", period, price_eur as "priceEur", ' +
  'to_char(valid_from, \'YYYY-MM-DD\') as "validFrom", to_char(valid_until, \'YYYY-MM-DD\') as "validUntil"';

export async function listModuleTierSurcharges(moduleId?: number | string): Promise<ModuleTierSurcharge[]> {
  if (moduleId != null) {
    const r = await pool.query(
      `select ${SELECT_FIELDS} from module_tier_surcharges where module_id = $1 order by tier_id, period, valid_from desc`,
      [moduleId]
    );
    return r.rows;
  }
  const r = await pool.query(
    `select ${SELECT_FIELDS} from module_tier_surcharges order by module_id, tier_id, period, valid_from desc`
  );
  return r.rows;
}

export async function getModuleTierSurcharge(id: number | string): Promise<ModuleTierSurcharge | null> {
  const r = await pool.query(`select ${SELECT_FIELDS} from module_tier_surcharges where id = $1`, [id]);
  return r.rows[0] ?? null;
}

// Zelfde "meest recent gestarte periode wint bij overlap"-principe als
// getCurrentTierPrice/getCurrentModuleSurcharge. Geeft null als er (nog)
// geen vaste opslag voor deze module+tier+periode is ingesteld — de
// aanroeper (quotePrice) valt dan terug op het generieke percentage.
export async function getCurrentModuleTierSurcharge(
  moduleId: number | string,
  tierId: number | string,
  period: 'maand' | 'jaar',
  onDate: string
): Promise<ModuleTierSurcharge | null> {
  const r = await pool.query(
    `select ${SELECT_FIELDS} from module_tier_surcharges
     where module_id = $1 and tier_id = $2 and period = $3 and valid_from <= $4 and valid_until >= $4
     order by valid_from desc limit 1`,
    [moduleId, tierId, period, onDate]
  );
  return r.rows[0] ?? null;
}

export async function createModuleTierSurcharge(input: {
  moduleId: number;
  tierId: number;
  period: 'maand' | 'jaar';
  priceEur: number;
  validFrom: string;
  validUntil: string;
}): Promise<ModuleTierSurcharge> {
  const r = await pool.query(
    `insert into module_tier_surcharges (module_id, tier_id, period, price_eur, valid_from, valid_until)
     values ($1,$2,$3,$4,$5,$6)
     returning ${SELECT_FIELDS}`,
    [input.moduleId, input.tierId, input.period, input.priceEur, input.validFrom, input.validUntil]
  );
  return r.rows[0];
}

export async function updateModuleTierSurcharge(
  id: number | string,
  input: { priceEur?: number; validFrom?: string; validUntil?: string }
): Promise<ModuleTierSurcharge | null> {
  const r = await pool.query(
    `update module_tier_surcharges set
       price_eur = coalesce($1, price_eur),
       valid_from = coalesce($2, valid_from),
       valid_until = coalesce($3, valid_until),
       updated_at = now()
     where id = $4
     returning ${SELECT_FIELDS}`,
    [input.priceEur ?? null, input.validFrom ?? null, input.validUntil ?? null, id]
  );
  return r.rows[0] ?? null;
}

export async function deleteModuleTierSurcharge(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from module_tier_surcharges where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}
