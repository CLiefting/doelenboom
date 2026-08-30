import { pool } from './db.js';

// Prijsgeschiedenis van module-opslagpercentages — zelfde principe als
// tierPrices.ts, maar dan voor de opslag (% van de tier-basisprijs) die een
// module toevoegt (zie doelenboom_licentiemodel.md §3/§9). Initieel: Projecten
// 20%, Templating 10% (db/migrations/0016_price_history.sql); KPI/Backup/
// Auditing hebben (nog) geen opslagpercentage — zo'n module telt dan simpelweg
// niet mee in de aanvraagprijs, net zoals een tier zonder prijs niet op de
// aanvraagpagina verschijnt.

export interface ModuleSurcharge {
  id: number;
  moduleId: number;
  surchargePct: string;
  validFrom: string;
  validUntil: string;
}

const SURCHARGE_SELECT_FIELDS =
  'id, module_id as "moduleId", surcharge_pct as "surchargePct", ' +
  'to_char(valid_from, \'YYYY-MM-DD\') as "validFrom", to_char(valid_until, \'YYYY-MM-DD\') as "validUntil"';

export async function listModuleSurcharges(moduleId?: number | string): Promise<ModuleSurcharge[]> {
  if (moduleId != null) {
    const r = await pool.query(
      `select ${SURCHARGE_SELECT_FIELDS} from module_surcharges where module_id = $1 order by valid_from desc`,
      [moduleId]
    );
    return r.rows;
  }
  const r = await pool.query(
    `select ${SURCHARGE_SELECT_FIELDS} from module_surcharges order by module_id, valid_from desc`
  );
  return r.rows;
}

export async function getModuleSurcharge(id: number | string): Promise<ModuleSurcharge | null> {
  const r = await pool.query(`select ${SURCHARGE_SELECT_FIELDS} from module_surcharges where id = $1`, [id]);
  return r.rows[0] ?? null;
}

// Zelfde "meest recent gestarte periode wint bij overlap"-principe als
// getCurrentTierPrice.
export async function getCurrentModuleSurcharge(
  moduleId: number | string,
  onDate: string
): Promise<ModuleSurcharge | null> {
  const r = await pool.query(
    `select ${SURCHARGE_SELECT_FIELDS} from module_surcharges
     where module_id = $1 and valid_from <= $2 and valid_until >= $2
     order by valid_from desc limit 1`,
    [moduleId, onDate]
  );
  return r.rows[0] ?? null;
}

export async function createModuleSurcharge(input: {
  moduleId: number;
  surchargePct: number;
  validFrom: string;
  validUntil: string;
}): Promise<ModuleSurcharge> {
  const r = await pool.query(
    `insert into module_surcharges (module_id, surcharge_pct, valid_from, valid_until) values ($1,$2,$3,$4)
     returning ${SURCHARGE_SELECT_FIELDS}`,
    [input.moduleId, input.surchargePct, input.validFrom, input.validUntil]
  );
  return r.rows[0];
}

export async function updateModuleSurcharge(
  id: number | string,
  input: { surchargePct?: number; validFrom?: string; validUntil?: string }
): Promise<ModuleSurcharge | null> {
  const r = await pool.query(
    `update module_surcharges set
       surcharge_pct = coalesce($1, surcharge_pct),
       valid_from = coalesce($2, valid_from),
       valid_until = coalesce($3, valid_until),
       updated_at = now()
     where id = $4
     returning ${SURCHARGE_SELECT_FIELDS}`,
    [input.surchargePct ?? null, input.validFrom ?? null, input.validUntil ?? null, id]
  );
  return r.rows[0] ?? null;
}

export async function deleteModuleSurcharge(id: number | string): Promise<boolean> {
  const r = await pool.query('delete from module_surcharges where id = $1 returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}
