import type { PoolClient } from 'pg';
import { pool } from './db.js';

// Gemotiveerde afwijkingen van controleregels (DOEL-64, epic DOEL-61 — zie
// db/migrations/0045_control_rule_deviations.sql voor het datamodel). Een
// afwijking hoort bij (element, regel-id): de overtreding blijft bestaan,
// maar telt in de boom als "gemotiveerd afgeweken" i.p.v. open.
//
// Uitgangspunten:
// - motivatie is een KORTE tekst op hoofdlijnen (1-500 tekens), geen
//   inhoudelijke of gerubriceerde informatie; komt nooit in audit_log en
//   nooit in de SVG-export.
// - door wie/wanneer zet alleen de server (zie routes/controlRuleDeviations.ts).
// - verdwijnt een regel uit de configuratie van de boom, dan worden de
//   bijbehorende afwijkingen in dezelfde transactie opgeruimd (besluit
//   Charles 2 oktober 2026) — zie deleteDeviationsForMissingRules.
export const MOTIVATIE_MAX_LENGTH = 500;

export interface ControlRuleDeviation {
  elementCode: string;
  ruleId: string;
  motivatie: string;
  updatedAt: string;
  // Alleen voor rollen die mogen bewerken (zelfde privacykeuze als
  // projectStatus.updatedByEmail, zie routes/tree.ts) — de route strip dit
  // veld voor een bezoeker.
  updatedByEmail?: string | null;
}

const SELECT_DEVIATIONS = `
  select e.code as "elementCode", d.rule_id as "ruleId", d.motivatie,
         d.updated_at as "updatedAt", u.email as "updatedByEmail"
  from control_rule_deviations d
  join elements e on e.id = d.element_id
  left join users u on u.id = d.updated_by
  where d.doelenboom_id = $1`;

export async function getDeviationsForDoelenboom(doelenboomId: number | string): Promise<ControlRuleDeviation[]> {
  const r = await pool.query(`${SELECT_DEVIATIONS} order by e.code, d.rule_id`, [doelenboomId]);
  return r.rows;
}

export async function getDeviation(
  doelenboomId: number | string,
  elementId: number,
  ruleId: string
): Promise<ControlRuleDeviation | null> {
  const r = await pool.query(`${SELECT_DEVIATIONS} and d.element_id = $2 and d.rule_id = $3`, [doelenboomId, elementId, ruleId]);
  return r.rows[0] ?? null;
}

export function stripEditorOnlyFields(list: ControlRuleDeviation[]): ControlRuleDeviation[] {
  return list.map(({ updatedByEmail: _omit, ...rest }) => rest);
}

// Aantal afwijkingen per regel-id — voor de waarschuwing in de regel-editor
// ("verwijderen wist ook n motivaties").
export async function countDeviationsPerRule(doelenboomId: number | string): Promise<Record<string, number>> {
  const r = await pool.query(
    'select rule_id, count(*)::int as n from control_rule_deviations where doelenboom_id = $1 group by rule_id',
    [doelenboomId]
  );
  return Object.fromEntries(r.rows.map((row) => [row.rule_id, row.n]));
}

// Opruimen bij het opslaan van de regels van een boom: alles waarvan de
// regel niet meer bestaat. Binnen de transactie van de aanroeper, zodat
// regels en afwijkingen nooit uit elkaar lopen. Geeft het aantal verwijderde
// rijen terug (voor het audit-detail — alleen een aantal, geen tekst).
export async function deleteDeviationsForMissingRules(
  client: PoolClient,
  doelenboomId: number | string,
  keepRuleIds: string[]
): Promise<number> {
  const r = await client.query(
    'delete from control_rule_deviations where doelenboom_id = $1 and not (rule_id = any($2::text[]))',
    [doelenboomId, keepRuleIds]
  );
  return r.rowCount ?? 0;
}

// Excel-import publiceren vervangt alle elementen (delete + insert, zie
// routes/imports.ts): zonder deze twee stappen zou elke import alle
// motivaties wissen via de cascade op element_id. Vooraf vastleggen op
// elementCODE, daarna terugzetten voor de codes die nog bestaan — met de
// oorspronkelijke door-wie/wanneer-velden. Afwijkingen van elementen die
// niet meer in het bestand staan vervallen (het element bestaat niet meer).
export interface DeviationSnapshotRow {
  code: string; rule_id: string; motivatie: string;
  created_by: number | null; created_at: Date; updated_by: number | null; updated_at: Date;
}

export async function snapshotDeviations(client: PoolClient, doelenboomId: number | string): Promise<DeviationSnapshotRow[]> {
  const r = await client.query(
    `select e.code, d.rule_id, d.motivatie, d.created_by, d.created_at, d.updated_by, d.updated_at
     from control_rule_deviations d join elements e on e.id = d.element_id
     where d.doelenboom_id = $1`,
    [doelenboomId]
  );
  return r.rows;
}

export async function restoreDeviations(
  client: PoolClient,
  doelenboomId: number | string,
  snapshot: DeviationSnapshotRow[],
  elementIdByCode: Map<string, number>
): Promise<void> {
  for (const row of snapshot) {
    const elementId = elementIdByCode.get(row.code);
    if (!elementId) continue;
    await client.query(
      `insert into control_rule_deviations
         (doelenboom_id, element_id, rule_id, motivatie, created_by, created_at, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (element_id, rule_id) do nothing`,
      [doelenboomId, elementId, row.rule_id, row.motivatie, row.created_by, row.created_at, row.updated_by, row.updated_at]
    );
  }
}
