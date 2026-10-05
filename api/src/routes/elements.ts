import { Router } from 'express';
import { pool } from '../db.js';
import { AuthedRequest, requireAuth } from '../auth.js';
import { requireWritableDoelenboom, tenantIdForDoelenboom } from '../rbac.js';
import { getColumnsForDoelenboom, allValidTypeNames } from '../columnConfig.js';
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
elementsRouter.post('/doelenbomen/:id/elements', requireEditor, async (req, res) => {
  const input = readElementBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const doelenboomId = req.params.id;
  const validTypes = await validTypeNames(doelenboomId);
  if (!validTypes.includes(input.type)) {
    return res.status(400).json({ error: `Type moet één van de volgende zijn: ${validTypes.join(', ')}.` });
  }
  try {
    const maxOrder = await pool.query(
      'select coalesce(max(sort_order), 0) as max_order from elements where doelenboom_id = $1',
      [doelenboomId]
    );
    const requestedOrder = (req.body ?? {}) as { sortOrder?: unknown };
    const sortOrder =
      typeof requestedOrder.sortOrder === 'number' && Number.isFinite(requestedOrder.sortOrder)
        ? requestedOrder.sortOrder
        : Number(maxOrder.rows[0].max_order) + 1;

    const result = await pool.query(
      `insert into elements (doelenboom_id, code, type, name, description, kpi, taakveld, subtaakveld, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning ${ELEMENT_SELECT_FIELDS}`,
      [doelenboomId, input.code, input.type, input.name, input.description, input.kpi, input.taakveld, input.subtaakveld, sortOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Element met code "${input.code}" bestaat al in deze doelenboom.` });
    }
    sendServerError(res, err, 'Aanmaken van element mislukt');
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
