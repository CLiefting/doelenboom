import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { ColumnDef, columnForTypeName } from './columnConfig.js';
import { ATTRIBUTE_ID_PATTERN, AttributeDef } from './elementAttributes.js';

// Kenmerkwaarden per element (DOEL-76, epic DOEL-61 — datamodel in
// db/migrations/0048_element_attribute_values.sql; de definities staan in
// column_configs.attributes, zie elementAttributes.ts).
//
// Uitgangspunten:
// - alleen metagegevens: geen inhoudelijke of gerubriceerde informatie. De
//   waarden komen nooit in audit_log (het invullen wordt niet gelogd, net als
//   het bewerken van andere elementvelden) en niet in de Excel-export
//   (DOEL-66) of de SVG-export.
// - een leeg kenmerk heeft geen rij; "leeg opslaan" = de rij verwijderen.
// - door wie/wanneer zet alleen de server.
// - verdwijnt een kenmerk of een keuzelijstwaarde uit de definities, dan
//   worden de bijbehorende waarden in dezelfde transactie gewist (zie
//   deleteValuesForChangedDefinitions).

export const ATTRIBUTE_TEXT_MAX_LENGTH = 200;
// Getallen: hooguit 15 significante cijfers, waarvan hooguit 6 achter de
// komma. Binnen die grens is een JavaScript-getal exact gelijk aan wat
// Postgres (numeric) opslaat en teruggeeft, dus browser en database tonen
// dezelfde waarde.
const NUMBER_MAX_ABS = 999_999_999_999_999;

export type AttributeValue = string | number | boolean;
// Per elementcode: kenmerk-id -> waarde. Datum als 'JJJJ-MM-DD'.
export type AttributeValuesByElement = Record<string, Record<string, AttributeValue>>;

// Geldt dit kenmerk voor een element van dit type? Rechtstreeks, of via het
// basistype van een alias ("aliassen volgen hun basistype") — zelfde regel als
// `matches` in evaluateControlRules (web/public/tree.html).
export function attributeAppliesToType(def: AttributeDef, elementType: string, columns: ColumnDef[]): boolean {
  const subjects = def.subjectTypes ?? [];
  if (subjects.includes(elementType)) return true;
  const base = columnForTypeName(columns, elementType)?.typeName;
  return base != null && subjects.includes(base);
}

function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export type ParsedValue =
  | { clear: true }
  | { clear: false; column: 'value_text' | 'value_number' | 'value_date' | 'value_bool'; value: AttributeValue };

// Valideert één waarde tegen de definitie. null of een lege tekst = wissen.
// Geeft een foutmelding (zonder de invoer terug te kaatsen) of de te
// schrijven kolom + genormaliseerde waarde.
export function parseAttributeValue(def: AttributeDef, raw: unknown): { error: string } | ParsedValue {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { clear: true };
  const where = `Kenmerk ${def.id}`;
  switch (def.kind) {
    case 'text': {
      if (typeof raw !== 'string') return { error: `${where}: de waarde moet tekst zijn.` };
      const value = raw.trim();
      if (value.length > ATTRIBUTE_TEXT_MAX_LENGTH) {
        return { error: `${where}: de tekst mag maximaal ${ATTRIBUTE_TEXT_MAX_LENGTH} tekens zijn.` };
      }
      return { clear: false, column: 'value_text', value };
    }
    case 'choice': {
      if (typeof raw !== 'string') return { error: `${where}: kies een waarde uit de keuzelijst.` };
      const value = raw.trim();
      if (!(def.options ?? []).includes(value)) return { error: `${where}: deze waarde staat niet in de keuzelijst.` };
      return { clear: false, column: 'value_text', value };
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return { error: `${where}: de waarde moet een getal zijn.` };
      if (Math.abs(raw) > NUMBER_MAX_ABS || Number(raw.toPrecision(15)) !== raw || Number(raw.toFixed(6)) !== raw) {
        return { error: `${where}: een getal mag maximaal 15 cijfers hebben, waarvan hooguit 6 achter de komma.` };
      }
      // -0 opslaan als 0.
      return { clear: false, column: 'value_number', value: raw === 0 ? 0 : raw };
    }
    case 'date': {
      if (typeof raw !== 'string' || !isRealDate(raw.trim())) {
        return { error: `${where}: de waarde moet een bestaande datum zijn (JJJJ-MM-DD).` };
      }
      return { clear: false, column: 'value_date', value: raw.trim() };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { error: `${where}: de waarde moet ja of nee zijn.` };
      return { clear: false, column: 'value_bool', value: raw };
    }
    default:
      return { error: `${where}: onbekende soort.` };
  }
}

// Valideert de PUT-body { values: { <kenmerk-id>: waarde|null } } voor één
// element. Alleen de meegestuurde kenmerken worden gezet of gewist; niet
// genoemde kenmerken blijven ongewijzigd. Onbekende kenmerken en kenmerken
// die niet voor het type van het element gelden worden geweigerd.
export function validateElementValuesInput(
  input: unknown,
  definitions: AttributeDef[],
  elementType: string,
  columns: ColumnDef[]
): { errors: string[]; changes: Array<{ attributeId: string; parsed: ParsedValue }> } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { errors: ['Kenmerkwaarden moeten als object { kenmerk-id: waarde } worden aangeleverd.'], changes: [] };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  // Meer sleutels dan er kenmerken kunnen bestaan is per definitie ongeldig.
  if (entries.length > 30) return { errors: ['Te veel kenmerken in één verzoek.'], changes: [] };
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const errors: string[] = [];
  const changes: Array<{ attributeId: string; parsed: ParsedValue }> = [];
  let unknown = 0;
  for (const [attributeId, raw] of entries) {
    const def = ATTRIBUTE_ID_PATTERN.test(attributeId) ? byId.get(attributeId) : undefined;
    if (!def) {
      // Sleutelnamen zijn invoer van de client: niet terugkaatsen.
      unknown += 1;
      continue;
    }
    if (!attributeAppliesToType(def, elementType, columns)) {
      errors.push(`Kenmerk ${def.id}: geldt niet voor elementen van dit type.`);
      continue;
    }
    const parsed = parseAttributeValue(def, raw);
    if ('error' in parsed) errors.push(parsed.error);
    else changes.push({ attributeId, parsed });
  }
  if (unknown) errors.push(`${unknown} onbekend(e) kenmerk(en) voor deze doelenboom.`);
  return { errors, changes };
}

export async function applyElementValueChanges(
  client: PoolClient,
  doelenboomId: number | string,
  elementId: number,
  userId: number | string,
  changes: Array<{ attributeId: string; parsed: ParsedValue }>
): Promise<void> {
  for (const { attributeId, parsed } of changes) {
    if (parsed.clear) {
      await client.query('delete from element_attribute_values where element_id = $1 and attribute_id = $2', [elementId, attributeId]);
      continue;
    }
    // De kolomnaam komt uit de vaste union hierboven, nooit uit invoer.
    const cols = { value_text: null, value_number: null, value_date: null, value_bool: null } as Record<string, AttributeValue | null>;
    cols[parsed.column] = parsed.value;
    await client.query(
      `insert into element_attribute_values
         (doelenboom_id, element_id, attribute_id, value_text, value_number, value_date, value_bool, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (element_id, attribute_id) do update set
         value_text = excluded.value_text, value_number = excluded.value_number,
         value_date = excluded.value_date, value_bool = excluded.value_bool,
         updated_by = excluded.updated_by, updated_at = now()`,
      [doelenboomId, elementId, attributeId, cols.value_text, cols.value_number, cols.value_date, cols.value_bool, userId]
    );
  }
}

interface ValueRow {
  code: string; type: string; attribute_id: string;
  value_text: string | null; value_number: string | null; value_date: string | null; value_bool: boolean | null;
}

// Opgeslagen rij -> waarde volgens de soort van de definitie. Een rij die niet
// (meer) bij de soort past levert undefined op en wordt niet getoond.
function valueFromRow(def: AttributeDef, row: ValueRow): AttributeValue | undefined {
  switch (def.kind) {
    case 'text': return row.value_text ?? undefined;
    case 'choice': return row.value_text != null && (def.options ?? []).includes(row.value_text) ? row.value_text : undefined;
    case 'number': return row.value_number != null ? Number(row.value_number) : undefined;
    case 'date': return row.value_date ?? undefined;
    case 'boolean': return row.value_bool ?? undefined;
    default: return undefined;
  }
}

// Alle waarden van een boom (of van één element), gefilterd op de
// meegegeven definities: alleen kenmerken die bestaan én voor het type van
// het element gelden. Waarden van een kenmerk dat na een definitiewijziging
// niet meer voor dat type geldt blijven bewaard maar worden niet geleverd.
export async function getAttributeValues(
  doelenboomId: number | string,
  definitions: AttributeDef[],
  columns: ColumnDef[],
  elementId?: number
): Promise<AttributeValuesByElement> {
  if (!definitions.length) return {};
  const r = await pool.query(
    `select e.code, e.type, v.attribute_id, v.value_text, v.value_number::text as value_number,
            to_char(v.value_date, 'YYYY-MM-DD') as value_date, v.value_bool
     from element_attribute_values v join elements e on e.id = v.element_id
     where v.doelenboom_id = $1 and ($2::bigint is null or v.element_id = $2)
     order by e.code, v.attribute_id`,
    [doelenboomId, elementId ?? null]
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const out: AttributeValuesByElement = {};
  for (const row of r.rows as ValueRow[]) {
    const def = byId.get(row.attribute_id);
    if (!def || !attributeAppliesToType(def, row.type, columns)) continue;
    const value = valueFromRow(def, row);
    if (value === undefined) continue;
    (out[row.code] = out[row.code] ?? {})[row.attribute_id] = value;
  }
  return out;
}

// Aantallen ingevulde waarden per kenmerk en, bij keuzelijsten, per
// keuzelijstwaarde — voor de waarschuwing in de kenmerk-editor ("verwijderen
// wist ook n ingevulde waarden"). Alleen aantallen; de sleutels van byOption
// zijn uitsluitend keuzelijstwaarden uit de definities, nooit vrije
// tekstwaarden van elementen.
export interface AttributeValueCounts { total: number; byOption: Record<string, number> }

export async function countValuesPerAttribute(
  doelenboomId: number | string,
  definitions: AttributeDef[]
): Promise<Record<string, AttributeValueCounts>> {
  const r = await pool.query(
    `select attribute_id, value_text, count(*)::int as n
     from element_attribute_values where doelenboom_id = $1 group by attribute_id, value_text`,
    [doelenboomId]
  );
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const out: Record<string, AttributeValueCounts> = {};
  for (const row of r.rows as Array<{ attribute_id: string; value_text: string | null; n: number }>) {
    const def = byId.get(row.attribute_id);
    if (!def) continue;
    const entry = (out[row.attribute_id] = out[row.attribute_id] ?? { total: 0, byOption: {} });
    entry.total += row.n;
    if (def.kind === 'choice' && row.value_text != null && (def.options ?? []).includes(row.value_text)) {
      entry.byOption[row.value_text] = row.n;
    }
  }
  return out;
}

// Opruimen bij het opslaan van de definities van een boom, binnen de
// transactie van de aanroeper: waarden van kenmerken die niet meer bestaan,
// en waarden van keuzelijsten die niet meer in de lijst staan. Geeft het
// aantal verwijderde rijen terug (voor het audit-detail — alleen een aantal).
export async function deleteValuesForChangedDefinitions(
  client: PoolClient,
  doelenboomId: number | string,
  definitions: AttributeDef[]
): Promise<number> {
  const gone = await client.query(
    'delete from element_attribute_values where doelenboom_id = $1 and not (attribute_id = any($2::text[]))',
    [doelenboomId, definitions.map((d) => d.id)]
  );
  let removed = gone.rowCount ?? 0;
  for (const def of definitions) {
    if (def.kind !== 'choice') continue;
    const r = await client.query(
      `delete from element_attribute_values
       where doelenboom_id = $1 and attribute_id = $2 and not (value_text = any($3::text[]))`,
      [doelenboomId, def.id, def.options ?? []]
    );
    removed += r.rowCount ?? 0;
  }
  return removed;
}

// Excel-import publiceren vervangt alle elementen (delete + insert, zie
// routes/imports.ts): zonder deze twee stappen zou elke import alle
// kenmerkwaarden wissen via de cascade op element_id. Zelfde mechanisme als
// snapshotDeviations/restoreDeviations (controlRuleDeviations.ts): vooraf
// vastleggen op elementCODE, daarna terugzetten voor de codes die nog
// bestaan, met de oorspronkelijke door-wie/wanneer-velden.
export interface AttributeValueSnapshotRow {
  code: string; attribute_id: string;
  value_text: string | null; value_number: string | null; value_date: string | null; value_bool: boolean | null;
  updated_by: number | null; updated_at: Date;
}

export async function snapshotAttributeValues(client: PoolClient, doelenboomId: number | string): Promise<AttributeValueSnapshotRow[]> {
  const r = await client.query(
    `select e.code, v.attribute_id, v.value_text, v.value_number::text as value_number,
            to_char(v.value_date, 'YYYY-MM-DD') as value_date, v.value_bool, v.updated_by, v.updated_at
     from element_attribute_values v join elements e on e.id = v.element_id
     where v.doelenboom_id = $1`,
    [doelenboomId]
  );
  return r.rows;
}

export async function restoreAttributeValues(
  client: PoolClient,
  doelenboomId: number | string,
  snapshot: AttributeValueSnapshotRow[],
  elementIdByCode: Map<string, number>
): Promise<void> {
  for (const row of snapshot) {
    const elementId = elementIdByCode.get(row.code);
    if (!elementId) continue;
    await client.query(
      `insert into element_attribute_values
         (doelenboom_id, element_id, attribute_id, value_text, value_number, value_date, value_bool, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (element_id, attribute_id) do nothing`,
      [doelenboomId, elementId, row.attribute_id, row.value_text, row.value_number, row.value_date, row.value_bool, row.updated_by, row.updated_at]
    );
  }
}
