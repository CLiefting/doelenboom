import { Router } from 'express';
import { pool } from '../db.js';
import { AuthedRequest, requireAuth } from '../auth.js';
import { requireWritableDoelenboom, tenantIdForDoelenboom } from '../rbac.js';
import { ColumnDef, getColumnsForDoelenboom, allValidTypeNames, columnForTypeName } from '../columnConfig.js';
import { attributesFromDb, findAttributesBrokenByColumns } from '../elementAttributes.js';
import { applyElementValueChanges, validateElementValuesInput, ParsedValue } from '../elementAttributeValues.js';
import { CONTROLE_REGELS_MODULE } from '../controlRules.js';
import { hasModule } from '../license.js';
import { logAuditEvent } from '../auditLog.js';
import { sendServerError } from '../errors.js';

// CRUD voor losse elementen (fase 1 van de CRUD-uitbreiding — zie ook de latere
// fases voor tags/organisatieonderdelen en relaties). Dit bestaat naast, en is
// onafhankelijk van, de Excel-import/publiceer-flow (routes/imports.ts): waar een
// import een volledige vervanging van de doelenboom is, is dit hier een directe,
// meteen zichtbare wijziging van één element — geen rapport/publiceer-stap nodig
// voor een enkele create/update/delete.
export const elementsRouter = Router();
elementsRouter.use(requireAuth);

// Alle schrijfacties hieronder (create/update/delete) vereisen minimaal de rol
// 'editor' (of hoger: admin/sysadmin) — elementen zijn "losse boom-inhoud",
// zie rbac.ts requireWritableDoelenboom. De doelenboom mag niet op read-only
// staan (zie rbac.ts) — lezen gebeurt via routes/tree.ts, dat zijn eigen
// (lichtere) check heeft. Let op: dit moet per route meegegeven worden (niet
// via router.use()), omdat :id op het moment van een path-loze .use() nog niet
// gevuld is.
const requireEditor = requireWritableDoelenboom('id', 'editor');

// Welke types geldig zijn, hangt sinds de configureerbare kolommen (zie
// docs/kolommen-configuratie-ontwerp.md) af van de columns-configuratie van
// déze doelenboom — niet meer van een vaste, globale lijst (de oude
// check-constraint op elements.type is daarom ook verwijderd, zie
// db/migrations/0001_column_configs.sql). Vandaar hier een async lookup i.p.v.
// een module-level constante. Sinds DOEL-56 telt een alias-type (zie
// columnConfig.ts) ook mee als geldig — allValidTypeNames() geeft kolommen én
// hun aliassen samen terug.
async function validTypeNames(doelenboomId: string): Promise<string[]> {
  const columns = await getColumnsForDoelenboom(doelenboomId);
  return allValidTypeNames(columns);
}

type ElementInput = {
  errors: string[];
  code: string;
  type: string;
  name: string;
  description: string;
  kpi: string;
  taakveld: string;
  subtaakveld: string;
};

function readElementBody(body: unknown, { requireCode = true }: { requireCode?: boolean } = {}): ElementInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  const type = typeof b.type === 'string' ? b.type.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';

  if (requireCode && !code) errors.push('Code is verplicht.');
  // Of dit type ook daadwerkelijk als kolom bestaat in déze doelenboom, wordt
  // hierna async gecontroleerd (zie validTypeNames) — hier alleen checken dat
  // er iets is ingevuld.
  if (!type) errors.push('Type is verplicht.');
  if (!name) errors.push('Naam is verplicht.');

  return {
    errors,
    code,
    type,
    name,
    description: typeof b.description === 'string' ? b.description : '',
    kpi: typeof b.kpi === 'string' ? b.kpi : '',
    taakveld: typeof b.taakveld === 'string' ? b.taakveld : '',
    subtaakveld: typeof b.subtaakveld === 'string' ? b.subtaakveld : '',
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const ELEMENT_SELECT_FIELDS =
  'code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order';

// POST /api/doelenbomen/:id/elements — nieuw element aanmaken.
//
// Plek in de kolom (DOEL-84): zonder expliciete sortOrder komt het nieuwe
// element op codevolgorde tussen de elementen van zijn kolom te staan (B3.3
// na B3.2, B10 na B9) in plaats van achteraan — zie insertIndexByCode
// onderaan dit bestand. Met een expliciete sortOrder (getal) in de body
// gebeurt er niets extra's: die waarde wordt opgeslagen zoals hij is.
elementsRouter.post('/doelenbomen/:id/elements', requireEditor, async (req, res) => {
  const input = readElementBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const doelenboomId = req.params.id;
  const columns = await getColumnsForDoelenboom(doelenboomId);
  const validTypes = allValidTypeNames(columns);
  if (!validTypes.includes(input.type)) {
    return res.status(400).json({ error: `Type moet één van de volgende zijn: ${validTypes.join(', ')}.` });
  }
  const requestedOrder = (req.body ?? {}) as { sortOrder?: unknown };
  const explicitOrder =
    typeof requestedOrder.sortOrder === 'number' && Number.isFinite(requestedOrder.sortOrder) ? requestedOrder.sortOrder : null;
  const insertSql = `insert into elements (doelenboom_id, code, type, name, description, kpi, taakveld, subtaakveld, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const insertValues = (sortOrder: number) =>
    [doelenboomId, input.code, input.type, input.name, input.description, input.kpi, input.taakveld, input.subtaakveld, sortOrder];
  const duplicate = () => res.status(409).json({ error: `Element met code "${input.code}" bestaat al in deze doelenboom.` });

  if (explicitOrder !== null) {
    try {
      const result = await pool.query(`${insertSql} returning ${ELEMENT_SELECT_FIELDS}`, insertValues(explicitOrder));
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return duplicate();
      return sendServerError(res, err, 'Aanmaken van element mislukt');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const all = await lockElementsInOrder(client, doelenboomId);
    const inserted = await client.query(`${insertSql} returning id`, insertValues(all.length + 1));
    const newRow: OrderedRow = { id: String(inserted.rows[0].id), code: input.code, type: input.type, sort_order: -1 };

    const columnKey = columnKeyOf(columns, input.type);
    const columnRows = all.filter((row) => columnKeyOf(columns, row.type) === columnKey);
    const at = insertIndexByCode(columnRows, input.code);
    // Plek in de totale volgorde: direct na de voorganger in de kolom, of —
    // als het nieuwe element vooraan komt — direct vóór het eerste element
    // van de kolom. Een lege kolom: achteraan.
    const globalIndex = !columnRows.length
      ? all.length
      : at > 0 ? all.indexOf(columnRows[at - 1]) + 1 : all.indexOf(columnRows[0]);
    await writeOrder(client, [...all.slice(0, globalIndex), newRow, ...all.slice(globalIndex)]);

    const result = await client.query(`select ${ELEMENT_SELECT_FIELDS} from elements where id = $1`, [newRow.id]);
    await client.query('commit');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('rollback');
    if (isUniqueViolation(err)) return duplicate();
    sendServerError(res, err, 'Aanmaken van element mislukt');
  } finally {
    client.release();
  }
});

// PUT /api/doelenbomen/:id/elements/:code — bestaand element bijwerken (code mag
// mee wijzigen; er wordt niets anders naar code verwezen dan puur tekstueel in
// parent_text, dus hernoemen is veilig t.o.v. edges/tags/producten die via het
// interne numerieke id gekoppeld zijn).
elementsRouter.put('/doelenbomen/:id/elements/:code', requireEditor, async (req, res) => {
  const input = readElementBody(req.body, { requireCode: false });
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });
  const newCode = input.code || req.params.code;

  const validTypes = await validTypeNames(req.params.id);
  if (!validTypes.includes(input.type)) {
    return res.status(400).json({ error: `Type moet één van de volgende zijn: ${validTypes.join(', ')}.` });
  }

  try {
    const result = await pool.query(
      `update elements
       set code = $1, type = $2, name = $3, description = $4, kpi = $5, taakveld = $6, subtaakveld = $7, updated_at = now()
       where doelenboom_id = $8 and code = $9
       returning ${ELEMENT_SELECT_FIELDS}`,
      [newCode, input.type, input.name, input.description, input.kpi, input.taakveld, input.subtaakveld, req.params.id, req.params.code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Element niet gevonden.' });
    res.json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Element met code "${newCode}" bestaat al in deze doelenboom.` });
    }
    sendServerError(res, err, 'Bijwerken van element mislukt');
  }
});

// DELETE /api/doelenbomen/:id/elements/:code — verwijdert het element en (via
// on delete cascade in db/init.sql) alles wat eraan hangt: relaties, projectstatus,
// producten, tag- en organisatie-koppelingen.
elementsRouter.delete('/doelenbomen/:id/elements/:code', requireEditor, async (req, res) => {
  const result = await pool.query(
    'delete from elements where doelenboom_id = $1 and code = $2 returning id',
    [req.params.id, req.params.code]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Element niet gevonden.' });
  res.status(204).send();
});

// ---- Bulkacties op een selectie van elementen (DOEL-81 bewerken, DOEL-82
// verwijderen) — de serverkant van de Selectiemodus in web/public/tree.html
// (DOEL-80). Uitgangspunten voor beide routes:
// - de elementen worden opgezocht op CODE binnen de boom uit het pad; een
//   code van een andere boom of tenant is dus onvindbaar (geen IDOR);
// - alles of niets: één transactie, en één onbekende code of ongeldige
//   waarde wijst het hele verzoek af zonder iets te wijzigen;
// - een vast maximum aan codes per verzoek;
// - alleen de hieronder genoemde velden worden gelezen; al het andere in de
//   body wordt genegeerd (code, naam, omschrijving en KPI zijn per element
//   uniek en horen niet in een bulkwijziging).
const BULK_MAX_CODES = 200;
const BULK_MAX_CODE_LENGTH = 200;
const BULK_MAX_LINK_CODES = 100;
const BULK_TEXT_MAX_LENGTH = 500;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Lijst met codes uit de body: niet-lege teksten, ontdubbeld, begrensd.
function readCodeList(raw: unknown, max: number, what: string): { error: string } | { codes: string[] } {
  if (!Array.isArray(raw)) return { error: `${what} moet een lijst met codes zijn.` };
  if (raw.length > max) return { error: `${what}: maximaal ${max} per verzoek.` };
  const codes = new Set<string>();
  for (const item of raw) {
    const code = typeof item === 'string' ? item.trim() : '';
    if (!code || code.length > BULK_MAX_CODE_LENGTH) return { error: `${what} bevat een ongeldige code.` };
    codes.add(code);
  }
  return { codes: [...codes] };
}

function readBulkElementCodes(body: Record<string, unknown>): { error: string } | { codes: string[] } {
  const result = readCodeList(body.codes, BULK_MAX_CODES, 'De selectie');
  if ('error' in result) return result;
  if (result.codes.length === 0) return { error: 'Selecteer minstens één element.' };
  return result;
}

// { add: [...], remove: [...] } voor tags of organisatieonderdelen.
function readLinkChanges(raw: unknown, what: string): { error: string } | { add: string[]; remove: string[] } {
  if (raw === undefined || raw === null) return { add: [], remove: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `${what}: ongeldige opgave.` };
  const r = raw as Record<string, unknown>;
  const add = readCodeList(r.add ?? [], BULK_MAX_LINK_CODES, `${what} (toevoegen)`);
  if ('error' in add) return add;
  const remove = readCodeList(r.remove ?? [], BULK_MAX_LINK_CODES, `${what} (verwijderen)`);
  if ('error' in remove) return remove;
  if (add.codes.some((c) => remove.codes.includes(c))) {
    return { error: `${what}: dezelfde code kan niet tegelijk worden toegevoegd en verwijderd.` };
  }
  return { add: add.codes, remove: remove.codes };
}

type BulkElementRow = { id: number; code: string; type: string };

// Zoekt de elementen op binnen déze boom en vergrendelt ze voor de duur van
// de transactie (op id gesorteerd, zodat twee gelijktijdige bulkacties niet
// kruislings op elkaar wachten). Geeft null als niet alle codes bestaan.
async function lockElementsByCode(
  client: import('pg').PoolClient,
  doelenboomId: string,
  codes: string[]
): Promise<BulkElementRow[] | null> {
  const r = await client.query(
    'select id, code, type from elements where doelenboom_id = $1 and code = any($2::text[]) order by id for update',
    [doelenboomId, codes]
  );
  return r.rows.length === codes.length ? (r.rows as BulkElementRow[]) : null;
}

function missingElementsMessage(what: string): string {
  return `Een of meer geselecteerde elementen bestaan niet (meer) in deze doelenboom; er is niets ${what}. Herlaad de boom en probeer het opnieuw.`;
}

// POST /api/doelenbomen/:id/elements/bulk-update (DOEL-81) — dezelfde
// wijziging op alle geselecteerde elementen. Body:
//   { codes: [...],
//     set: { type?, taakveld?, subtaakveld? },        // weglaten = ongewijzigd; '' = leegmaken (niet bij type)
//     tags: { add: [...], remove: [...] },            // tagcodes van deze boom
//     orgUnits: { add: [...], remove: [...] },        // codes van organisatieonderdelen van deze boom
//     attributes: { <kenmerk-id>: waarde | null } }   // null = wissen; vereist de module Controleregels
// Rechten als het bewerken van één element: editor of admin, schrijfbare boom.
// Bewust geen audit-event, net als bij het bewerken van één element (DOEL-76).
//
// Type wijzigen gedraagt zich als bij één element (PUT hierboven): het
// element verhuist naar de andere kolom; kenmerkwaarden die voor het nieuwe
// type niet gelden blijven bewaard maar worden niet meer getoond (zie
// getAttributeValues). Kenmerken in hetzelfde verzoek worden getoetst aan
// het type dat elk element ná deze wijziging heeft.
elementsRouter.post('/doelenbomen/:id/elements/bulk-update', requireEditor, async (req: AuthedRequest, res) => {
  const body = asRecord(req.body);
  const codes = readBulkElementCodes(body);
  if ('error' in codes) return res.status(400).json({ error: codes.error });

  const set = asRecord(body.set);
  const fields: Array<{ column: 'type' | 'taakveld' | 'subtaakveld'; value: string }> = [];
  let newType: string | null = null;
  if (set.type !== undefined) {
    if (typeof set.type !== 'string' || !set.type.trim()) return res.status(400).json({ error: 'Type mag niet leeg zijn.' });
    newType = set.type.trim();
    fields.push({ column: 'type', value: newType });
  }
  for (const column of ['taakveld', 'subtaakveld'] as const) {
    const raw = set[column];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return res.status(400).json({ error: `${column === 'taakveld' ? 'Taakveld' : 'Sub-taakveld'} moet tekst zijn.` });
    const value = raw.trim();
    if (value.length > BULK_TEXT_MAX_LENGTH) {
      return res.status(400).json({ error: `${column === 'taakveld' ? 'Taakveld' : 'Sub-taakveld'}: maximaal ${BULK_TEXT_MAX_LENGTH} tekens.` });
    }
    fields.push({ column, value });
  }

  const tags = readLinkChanges(body.tags, 'Tags');
  if ('error' in tags) return res.status(400).json({ error: tags.error });
  const orgUnits = readLinkChanges(body.orgUnits, 'Organisatieonderdelen');
  if ('error' in orgUnits) return res.status(400).json({ error: orgUnits.error });

  if (body.attributes !== undefined && (typeof body.attributes !== 'object' || body.attributes === null || Array.isArray(body.attributes))) {
    return res.status(400).json({ error: 'Kenmerkwaarden moeten als object { kenmerk-id: waarde } worden aangeleverd.' });
  }
  const hasAttributes = Object.keys(asRecord(body.attributes)).length > 0;

  if (!fields.length && !tags.add.length && !tags.remove.length && !orgUnits.add.length && !orgUnits.remove.length && !hasAttributes) {
    return res.status(400).json({ error: 'Geen wijziging opgegeven.' });
  }

  const doelenboomId = req.params.id;
  const columns = await getColumnsForDoelenboom(doelenboomId);
  if (newType !== null) {
    const validTypes = allValidTypeNames(columns);
    if (!validTypes.includes(newType)) {
      return res.status(400).json({ error: `Type moet één van de volgende zijn: ${validTypes.join(', ')}.` });
    }
  }
  if (hasAttributes) {
    // Zelfde eis als PUT .../elements/:code/attributes (requireModule).
    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null || !(await hasModule(tenantId, CONTROLE_REGELS_MODULE))) {
      return res.status(403).json({
        error: `Deze functie vereist de module "${CONTROLE_REGELS_MODULE}", die niet actief is voor de licentie van deze tenant.`,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const fail = async (status: number, error: string) => {
      await client.query('rollback');
      return res.status(status).json({ error });
    };

    const elements = await lockElementsByCode(client, doelenboomId, codes.codes);
    if (!elements) return await fail(404, missingElementsMessage('gewijzigd'));
    const elementIds = elements.map((e) => e.id);

    // Tags en organisatieonderdelen: alleen die van déze boom.
    const lookup = async (table: 'tags' | 'org_units', wanted: string[]): Promise<Map<string, number> | null> => {
      if (!wanted.length) return new Map();
      // De tabelnaam komt uit de vaste union hierboven, nooit uit invoer.
      const r = await client.query(`select id, code from ${table} where doelenboom_id = $1 and code = any($2::text[])`, [doelenboomId, wanted]);
      return r.rows.length === wanted.length ? new Map(r.rows.map((row) => [row.code as string, Number(row.id)])) : null;
    };
    const tagIds = await lookup('tags', [...tags.add, ...tags.remove]);
    if (!tagIds) return await fail(400, 'Een of meer tags bestaan niet in deze doelenboom; er is niets gewijzigd.');
    const orgIds = await lookup('org_units', [...orgUnits.add, ...orgUnits.remove]);
    if (!orgIds) return await fail(400, 'Een of meer organisatieonderdelen bestaan niet in deze doelenboom; er is niets gewijzigd.');

    // Kenmerken: toetsen tegen elk type dat in de selectie voorkomt (na een
    // eventuele typewijziging). De genormaliseerde waarden zijn voor elk type
    // gelijk; alleen "geldt dit kenmerk voor dit type" verschilt.
    let attributeChanges: Array<{ attributeId: string; parsed: ParsedValue }> = [];
    if (hasAttributes) {
      const cfg = await client.query(
        `select attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1 for share`,
        [doelenboomId]
      );
      const all = attributesFromDb(cfg.rows[0]?.attributes);
      const broken = new Set(findAttributesBrokenByColumns(all, columns));
      const definitions = all.filter((a) => !broken.has(a.id));
      const types = newType !== null ? [newType] : [...new Set(elements.map((e) => e.type))];
      const errors = new Set<string>();
      for (const type of types) {
        const result = validateElementValuesInput(body.attributes, definitions, type, columns);
        result.errors.forEach((e) => errors.add(e));
        attributeChanges = result.changes;
      }
      if (errors.size) return await fail(400, [...errors].join(' '));
    }

    if (fields.length) {
      // Kolomnamen komen uit de vaste union hierboven, nooit uit invoer.
      const assignments = fields.map((f, i) => `${f.column} = $${i + 2}`).join(', ');
      await client.query(
        `update elements set ${assignments}, updated_at = now() where id = any($1::bigint[])`,
        [elementIds, ...fields.map((f) => f.value)]
      );
    }
    if (tags.add.length) {
      await client.query(
        `insert into element_tags (element_id, tag_id, toelichting)
         select e, t, '' from unnest($1::bigint[]) as e cross join unnest($2::bigint[]) as t
         on conflict do nothing`,
        [elementIds, tags.add.map((c) => tagIds.get(c))]
      );
    }
    if (tags.remove.length) {
      await client.query(
        'delete from element_tags where element_id = any($1::bigint[]) and tag_id = any($2::bigint[])',
        [elementIds, tags.remove.map((c) => tagIds.get(c))]
      );
    }
    if (orgUnits.add.length) {
      // Zelfde standaardwaarden als het elementformulier in de boom; een
      // bestaande koppeling (met eigen relatietype/status) blijft ongemoeid.
      await client.query(
        `insert into ob_org_relations (element_id, org_unit_id, relatietype, toelichting, status)
         select e, o, 'Betrokken', '', 'Concept' from unnest($1::bigint[]) as e cross join unnest($2::bigint[]) as o
         on conflict do nothing`,
        [elementIds, orgUnits.add.map((c) => orgIds.get(c))]
      );
    }
    if (orgUnits.remove.length) {
      await client.query(
        'delete from ob_org_relations where element_id = any($1::bigint[]) and org_unit_id = any($2::bigint[])',
        [elementIds, orgUnits.remove.map((c) => orgIds.get(c))]
      );
    }
    if (attributeChanges.length) {
      for (const elementId of elementIds) {
        await applyElementValueChanges(client, doelenboomId, elementId, req.user!.id, attributeChanges);
      }
    }

    await client.query('commit');
    res.json({ updated: elements.length });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Bulk-bewerken van elementen mislukt');
  } finally {
    client.release();
  }
});

// POST /api/doelenbomen/:id/elements/bulk-delete (DOEL-82) — { codes: [...] }
// verwijdert alle geselecteerde elementen in één transactie, met (via on
// delete cascade) hun relaties, projectstatus, producten, activiteiten,
// tag- en organisatiekoppelingen, kenmerkwaarden en afwijkingen. Andere
// elementen blijven staan.
//
// Alleen admin (besluit Charles 5 oktober 2026): een editor kan elementen
// nog wel één voor één verwijderen (DELETE hierboven), maar niet in bulk.
// Er is (nog) geen prullenbak (DOEL-83), dus dit is definitief; daarom wél
// een audit-event, met het aantal en de codes — nooit namen of andere vrije
// tekst.
const requireAdminForBulkDelete = requireWritableDoelenboom('id', 'admin');

elementsRouter.post('/doelenbomen/:id/elements/bulk-delete', requireAdminForBulkDelete, async (req: AuthedRequest, res) => {
  const codes = readBulkElementCodes(asRecord(req.body));
  if ('error' in codes) return res.status(400).json({ error: codes.error });

  const doelenboomId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const elements = await lockElementsByCode(client, doelenboomId, codes.codes);
    if (!elements) {
      await client.query('rollback');
      return res.status(404).json({ error: missingElementsMessage('verwijderd') });
    }
    await client.query('delete from elements where id = any($1::bigint[])', [elements.map((e) => e.id)]);
    await client.query('commit');

    await logAuditEvent({
      eventType: 'elements_bulk_deleted',
      userId: req.user!.id,
      tenantId: await tenantIdForDoelenboom(doelenboomId),
      doelenboomId,
      detail: { count: elements.length, codes: elements.map((e) => e.code).sort() },
    });
    res.json({ deleted: elements.length });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Bulk-verwijderen van elementen mislukt');
  } finally {
    client.release();
  }
});

// ---- Volgorde van elementen binnen een kolom (DOEL-84 invoegen op code,
// DOEL-85 kolom sorteren, DOEL-86 handmatig verplaatsen) ----
//
// De volgorde is elements.sort_order en geldt voor de hele boom (routes/
// tree.ts: order by sort_order, code); de boomweergave verdeelt de elementen
// daarna over de kolommen. "De volgorde binnen een kolom" is dus de
// onderlinge volgorde van de elementen van die kolom (het basistype en zijn
// aliassen) in die ene lijst. Elke wijziging hieronder:
// - vergrendelt de volgorde van de boom voor de duur van de transactie
//   (advisory lock + for update), zodat twee gelijktijdige acties geen
//   dubbele of ontbrekende plekken opleveren;
// - herschikt alleen de elementen van één kolom: de plekken die de kolom in
//   de totale lijst inneemt blijven van die kolom, de onderlinge volgorde
//   van alle andere elementen blijft gelijk;
// - schrijft de volgorde daarna weg als 1..n (alleen de rijen die wijzigen).
// De volgorde is voor iedereen gelijk; exports volgen dezelfde sort_order.
const CODE_COLLATOR = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' });

// Natuurlijke codevolgorde: B9 vóór B10, B3.2 vóór B3.10. Bij gelijke
// uitkomst (bv. alleen verschil in hoofdletters) beslist de kale tekst, zodat
// de volgorde altijd vastligt.
export function compareElementCodes(a: string, b: string): number {
  return CODE_COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

type OrderedRow = { id: string; code: string; type: string; sort_order: number };

async function lockElementsInOrder(client: import('pg').PoolClient, doelenboomId: string): Promise<OrderedRow[]> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended('doelenboom-volgorde:' || $1::text, 0))`, [doelenboomId]);
  const r = await client.query(
    'select id, code, type, sort_order from elements where doelenboom_id = $1 order by sort_order, code, id for update',
    [doelenboomId]
  );
  return r.rows.map((row) => ({ id: String(row.id), code: row.code as string, type: row.type as string, sort_order: Number(row.sort_order) }));
}

// De kolom waarin een type getoond wordt: het basistype (een alias volgt
// zijn basistype). null = type dat in geen enkele kolom voorkomt.
function columnKeyOf(columns: ColumnDef[], type: string): string | null {
  return columnForTypeName(columns, type)?.typeName ?? null;
}

async function writeOrder(client: import('pg').PoolClient, ordered: OrderedRow[]): Promise<number> {
  const ids: string[] = [];
  const orders: number[] = [];
  ordered.forEach((row, i) => {
    if (row.sort_order !== i + 1) { ids.push(row.id); orders.push(i + 1); }
  });
  if (!ids.length) return 0;
  await client.query(
    `update elements e set sort_order = v.ord
     from unnest($1::bigint[], $2::int[]) as v(id, ord) where e.id = v.id`,
    [ids, orders]
  );
  return ids.length;
}

// Zet de elementen van één kolom in de nieuwe volgorde op de plekken die de
// kolom al innam; alle andere elementen blijven staan waar ze stonden.
function withColumnReordered(all: OrderedRow[], inColumn: (row: OrderedRow) => boolean, newColumnOrder: OrderedRow[]): OrderedRow[] {
  let i = 0;
  return all.map((row) => (inColumn(row) ? newColumnOrder[i++] : row));
}

// DOEL-84: waar hoort een nieuw element met deze code in de kolom? Direct na
// het element dat op code voorafgaat; is er geen voorganger, dan direct vóór
// zijn opvolger op code. Dat werkt ook in een kolom die niet (meer) op code
// staat: het nieuwe element komt dan naast zijn "buur op code" te staan.
export function insertIndexByCode(columnRows: Array<{ code: string }>, code: string): number {
  let pred = -1;
  let succ = -1;
  columnRows.forEach((row, i) => {
    const c = compareElementCodes(row.code, code);
    if (c < 0 && (pred === -1 || compareElementCodes(row.code, columnRows[pred].code) > 0)) pred = i;
    if (c > 0 && (succ === -1 || compareElementCodes(row.code, columnRows[succ].code) < 0)) succ = i;
  });
  if (pred !== -1) return pred + 1;
  if (succ !== -1) return succ;
  return columnRows.length;
}

// POST /api/doelenbomen/:id/elements/sort-column (DOEL-85) —
// { column: <type-naam van de kolom>, by: 'code' | 'parent' } zet één kolom in
// één keer op volgorde:
// - 'code':   natuurlijke codevolgorde;
// - 'parent': elementen met hetzelfde bovenliggende element bij elkaar, in
//   de volgorde waarin die bovenliggende elementen zelf staan; binnen één
//   ouder op code. De ouder is het doel van een uitgaande relatie (een
//   relatie loopt van kind naar ouder); bij meerdere ouders gaat een
//   primaire relatie voor, daarna de ouder die het eerst in de boom staat.
//   Elementen zonder ouder komen achteraan.
// Alleen admin: het is een ingreep op de hele kolom en een handmatige
// volgorde gaat erdoor verloren. De server rekent de volgorde uit; de
// browser stuurt alleen kolom en sorteerwijze.
const requireAdminForColumnSort = requireWritableDoelenboom('id', 'admin');
const COLUMN_SORT_MODES = ['code', 'parent'];

elementsRouter.post('/doelenbomen/:id/elements/sort-column', requireAdminForColumnSort, async (req, res) => {
  const body = asRecord(req.body);
  const columnName = typeof body.column === 'string' ? body.column.trim() : '';
  const by = typeof body.by === 'string' ? body.by : '';
  if (!COLUMN_SORT_MODES.includes(by)) return res.status(400).json({ error: 'Onbekende sorteerwijze.' });

  const doelenboomId = req.params.id;
  const columns = await getColumnsForDoelenboom(doelenboomId);
  const column = columns.find((c) => c.typeName === columnName);
  if (!columnName || !column) return res.status(400).json({ error: 'Onbekende kolom.' });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const all = await lockElementsInOrder(client, doelenboomId);
    const inColumn = (row: OrderedRow) => columnKeyOf(columns, row.type) === column.typeName;
    const columnRows = all.filter(inColumn);
    let sorted: OrderedRow[];
    if (by === 'code') {
      sorted = [...columnRows].sort((a, b) => compareElementCodes(a.code, b.code));
    } else {
      const edges = await client.query(
        'select source_element_id, target_element_id, weight from edges where doelenboom_id = $1',
        [doelenboomId]
      );
      const indexById = new Map(all.map((row, i) => [row.id, i]));
      // Rang van een ouder: [primaire relatie eerst, kolompositie, plek in de boom].
      const parentRank = new Map<string, [number, number, number]>();
      for (const e of edges.rows) {
        const source = String(e.source_element_id);
        const targetIndex = indexById.get(String(e.target_element_id));
        if (targetIndex === undefined) continue;
        const targetColumn = columnForTypeName(columns, all[targetIndex].type);
        const rank: [number, number, number] = [e.weight === 'primair' ? 0 : 1, targetColumn ? targetColumn.position : Number.MAX_SAFE_INTEGER, targetIndex];
        const current = parentRank.get(source);
        if (!current || rank[0] < current[0] || (rank[0] === current[0] && (rank[1] < current[1] || (rank[1] === current[1] && rank[2] < current[2])))) {
          parentRank.set(source, rank);
        }
      }
      sorted = [...columnRows].sort((a, b) => {
        const pa = parentRank.get(a.id);
        const pb = parentRank.get(b.id);
        if (!pa || !pb) return pa ? -1 : pb ? 1 : compareElementCodes(a.code, b.code);
        return pa[1] - pb[1] || pa[2] - pb[2] || compareElementCodes(a.code, b.code);
      });
    }
    const moved = sorted.filter((row, i) => row !== columnRows[i]).length;
    await writeOrder(client, withColumnReordered(all, inColumn, sorted));
    await client.query('commit');
    res.json({ sorted: columnRows.length, moved });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Sorteren van de kolom mislukt');
  } finally {
    client.release();
  }
});

// POST /api/doelenbomen/:id/elements/:code/move (DOEL-86) — één element
// binnen zijn kolom verplaatsen. Body: óf { direction: 'up' | 'down' } (één
// plek), óf { after: <code> } (direct na dat element) / { after: null }
// (bovenaan de kolom). Het doelelement moet in dezelfde kolom van dezelfde
// boom staan. Rechten als het bewerken van een element: editor of admin.
elementsRouter.post('/doelenbomen/:id/elements/:code/move', requireEditor, async (req, res) => {
  const body = asRecord(req.body);
  const hasDirection = body.direction !== undefined;
  const hasAfter = Object.prototype.hasOwnProperty.call(body, 'after');
  if (hasDirection === hasAfter) return res.status(400).json({ error: 'Geef óf een richting óf een element om na te plaatsen.' });
  if (hasDirection && body.direction !== 'up' && body.direction !== 'down') return res.status(400).json({ error: 'Onbekende richting.' });
  if (hasAfter && body.after !== null && (typeof body.after !== 'string' || !body.after.trim() || body.after.length > BULK_MAX_CODE_LENGTH)) {
    return res.status(400).json({ error: 'Ongeldig element om na te plaatsen.' });
  }

  const doelenboomId = req.params.id;
  const columns = await getColumnsForDoelenboom(doelenboomId);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const fail = async (status: number, error: string) => {
      await client.query('rollback');
      return res.status(status).json({ error });
    };
    const all = await lockElementsInOrder(client, doelenboomId);
    const element = all.find((row) => row.code === req.params.code);
    if (!element) return await fail(404, 'Element niet gevonden.');
    const columnKey = columnKeyOf(columns, element.type);
    const inColumn = (row: OrderedRow) => columnKeyOf(columns, row.type) === columnKey;
    const columnRows = all.filter(inColumn);
    const from = columnRows.indexOf(element);
    const rest = columnRows.filter((row) => row !== element);

    let to: number;
    if (hasDirection) {
      to = Math.min(Math.max(from + (body.direction === 'up' ? -1 : 1), 0), columnRows.length - 1);
    } else if (body.after === null) {
      to = 0;
    } else {
      const afterCode = (body.after as string).trim();
      if (afterCode === element.code) return await fail(400, 'Een element kan niet na zichzelf worden geplaatst.');
      const target = all.find((row) => row.code === afterCode);
      if (!target) return await fail(404, 'Het element om na te plaatsen bestaat niet in deze doelenboom.');
      if (!inColumn(target)) return await fail(400, 'Het element om na te plaatsen staat in een andere kolom.');
      to = rest.indexOf(target) + 1;
    }
    const reordered = [...rest.slice(0, to), element, ...rest.slice(to)];
    const moved = to !== from;
    if (moved) await writeOrder(client, withColumnReordered(all, inColumn, reordered));
    await client.query('commit');
    res.json({ moved, position: to + 1, of: columnRows.length });
  } catch (err) {
    await client.query('rollback');
    sendServerError(res, err, 'Verplaatsen van het element mislukt');
  } finally {
    client.release();
  }
});
