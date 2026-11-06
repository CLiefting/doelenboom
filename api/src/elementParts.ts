// Samengestelde elementen (DOEL-140): de regels rond element_parts op één
// plek, zodat alle routes (samenvoegen, "Onderdeel van" in het bewerkvenster,
// typewissel, verwijderen, bulkacties, dupliceren, sjablonen, Excel-import)
// precies hetzelfde toetsen.
//
// Regels (zie db/migrations/0054_element_parts.sql en het ontwerp van
// 6 november 2026):
// - geheel en deel staan in dezelfde doelenboom (ook bewaakt door de trigger);
// - geheel en deel staan in dezelfde KOLOM (alleen hier: de kolom volgt uit
//   elements.type en de kolomconfiguratie van de boom);
// - een element is deel van hooguit één geheel (unique in de database);
// - één niveau: een geheel is zelf geen deel, een deel heeft zelf geen delen;
// - het type mag verschillen (basistype en aliassen door elkaar).
import type { PoolClient } from 'pg';
import { ColumnDef, columnForTypeName } from './columnConfig.js';

export type PartRow = { id: number | string; code: string; type: string };

export const PART_ACTIONS = ['detach', 'delete'] as const;
export type PartAction = (typeof PART_ACTIONS)[number];

export function readPartAction(raw: unknown): PartAction | null {
  if (raw === undefined || raw === null || raw === '') return 'detach';
  return typeof raw === 'string' && (PART_ACTIONS as readonly string[]).includes(raw) ? (raw as PartAction) : null;
}

function columnOf(columns: ColumnDef[], type: string): string | null {
  return columnForTypeName(columns, type)?.typeName ?? null;
}

export function sameColumn(columns: ColumnDef[], a: string, b: string): boolean {
  const ca = columnOf(columns, a);
  return ca !== null && ca === columnOf(columns, b);
}

// Huidige koppelingen rond een set elementen: wie is deel van wie, en wie
// heeft delen. Leest binnen de transactie van de aanroeper.
export async function partLinksFor(client: PoolClient, elementIds: Array<number | string>) {
  const r = await client.query(
    `select ep.whole_element_id, ep.part_element_id, w.code as whole_code, p.code as part_code
     from element_parts ep
     join elements w on w.id = ep.whole_element_id
     join elements p on p.id = ep.part_element_id
     where ep.whole_element_id = any($1::bigint[]) or ep.part_element_id = any($1::bigint[])`,
    [elementIds.map(String)]
  );
  const wholeOf = new Map<string, { id: string; code: string }>();
  const partsOf = new Map<string, Array<{ id: string; code: string }>>();
  for (const row of r.rows) {
    const whole = { id: String(row.whole_element_id), code: row.whole_code as string };
    const part = { id: String(row.part_element_id), code: row.part_code as string };
    wholeOf.set(part.id, whole);
    const list = partsOf.get(whole.id) ?? [];
    list.push(part);
    partsOf.set(whole.id, list);
  }
  return { wholeOf, partsOf };
}

// Toetst of `parts` deel mogen worden van `whole`. Geeft een Nederlandse
// foutmelding (zonder interne details) of null. Een deel dat al bij
// ditzelfde geheel hoort is geen fout (idempotent).
export async function validateCompose(
  client: PoolClient,
  columns: ColumnDef[],
  whole: PartRow,
  parts: PartRow[]
): Promise<string | null> {
  if (!parts.length) return 'Kies minstens één deelelement.';
  if (parts.some((p) => String(p.id) === String(whole.id))) return 'Een element kan geen deel van zichzelf zijn.';
  const other = parts.find((p) => !sameColumn(columns, whole.type, p.type));
  if (other) return `Element ${other.code} staat in een andere kolom dan ${whole.code}; geheel en delen staan in dezelfde kolom.`;

  const { wholeOf, partsOf } = await partLinksFor(client, [whole.id, ...parts.map((p) => p.id)]);
  const wholeParent = wholeOf.get(String(whole.id));
  if (wholeParent) return `${whole.code} is zelf een deelelement van ${wholeParent.code}; een samengesteld element kan maar één niveau diep zijn.`;
  for (const p of parts) {
    if ((partsOf.get(String(p.id)) ?? []).length) {
      return `${p.code} heeft zelf deelelementen; een samengesteld element kan maar één niveau diep zijn.`;
    }
    const current = wholeOf.get(String(p.id));
    if (current && current.id !== String(whole.id)) {
      return `${p.code} is al deel van ${current.code}; maak het daar eerst los.`;
    }
  }
  return null;
}

export async function insertParts(client: PoolClient, doelenboomId: number | string, wholeId: number | string, partIds: Array<number | string>) {
  if (!partIds.length) return;
  await client.query(
    `insert into element_parts (doelenboom_id, whole_element_id, part_element_id)
     select $1, $2, p from unnest($3::bigint[]) as p
     on conflict (part_element_id) do nothing`,
    [doelenboomId, wholeId, partIds.map(String)]
  );
}

// Na een typewissel: staat het element in een andere kolom dan zijn geheel
// of zijn delen, dan vervallen die koppelingen (ontwerp, punt 5: melding
// vooraf in de boom). Geeft de losgemaakte koppelingen terug (codes).
export async function detachAfterTypeChange(
  client: PoolClient,
  columns: ColumnDef[],
  elementIds: Array<number | string>
): Promise<Array<{ whole: string; part: string }>> {
  if (!elementIds.length) return [];
  const r = await client.query(
    `select ep.id, w.code as whole_code, w.type as whole_type, p.code as part_code, p.type as part_type
     from element_parts ep
     join elements w on w.id = ep.whole_element_id
     join elements p on p.id = ep.part_element_id
     where ep.whole_element_id = any($1::bigint[]) or ep.part_element_id = any($1::bigint[])`,
    [elementIds.map(String)]
  );
  const broken = r.rows.filter((row) => !sameColumn(columns, row.whole_type, row.part_type));
  if (!broken.length) return [];
  await client.query('delete from element_parts where id = any($1::bigint[])', [broken.map((b) => String(b.id))]);
  return broken.map((b) => ({ whole: b.whole_code as string, part: b.part_code as string }));
}

// Kopieert de koppelingen van de ene boom naar de andere (dupliceren),
// met een vertaaltabel oud element-id -> nieuw element-id.
export async function copyElementParts(
  client: PoolClient,
  fromDoelenboomId: number | string,
  toDoelenboomId: number | string,
  idMap: Map<number | string, number | string>
) {
  const r = await client.query(
    'select whole_element_id, part_element_id from element_parts where doelenboom_id = $1 order by id',
    [fromDoelenboomId]
  );
  const lookup = (id: unknown) => idMap.get(id as number) ?? idMap.get(String(id)) ?? idMap.get(Number(id));
  for (const row of r.rows) {
    const whole = lookup(row.whole_element_id);
    const part = lookup(row.part_element_id);
    if (whole == null || part == null) continue;
    await insertParts(client, toDoelenboomId, whole, [part]);
  }
}

// Legt koppelingen op code (sjablonen, Excel-import): { partCode: wholeCode }.
// Ongeldige koppelingen worden overgeslagen en teruggegeven als melding, zodat
// een import nooit halverwege stukloopt op een samengesteld element.
export async function linkPartsByCode(
  client: PoolClient,
  doelenboomId: number | string,
  columns: ColumnDef[],
  partOf: Array<{ part: string; whole: string }>,
  idByCode: Map<string, number | string>,
  typeByCode: Map<string, string>
): Promise<string[]> {
  const warnings: string[] = [];
  const wholes = new Set(partOf.map((l) => l.whole));
  const parts = new Set<string>();
  for (const { part, whole } of partOf) {
    const partId = idByCode.get(part);
    const wholeId = idByCode.get(whole);
    if (partId == null || wholeId == null) {
      warnings.push(`${part}: "Onderdeel van" verwijst naar onbekend element ${whole}; koppeling overgeslagen.`);
      continue;
    }
    if (part === whole) { warnings.push(`${part}: een element kan geen deel van zichzelf zijn; koppeling overgeslagen.`); continue; }
    if (!sameColumn(columns, typeByCode.get(part) ?? '', typeByCode.get(whole) ?? '')) {
      warnings.push(`${part}: ${whole} staat in een andere kolom; koppeling overgeslagen.`);
      continue;
    }
    if (wholes.has(part)) { warnings.push(`${part}: heeft zelf delen en kan geen deelelement zijn (één niveau); koppeling overgeslagen.`); continue; }
    if (parts.has(part)) { warnings.push(`${part}: hoort al bij een ander geheel; koppeling overgeslagen.`); continue; }
    parts.add(part);
    await insertParts(client, doelenboomId, wholeId, [partId]);
  }
  return warnings;
}

// Een trigger-overtreding (zie de migratie) als 400 i.p.v. 500.
export function isPartRuleViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return !!e && e.code === '23514' && typeof e.message === 'string' && e.message.startsWith('element_parts:');
}
