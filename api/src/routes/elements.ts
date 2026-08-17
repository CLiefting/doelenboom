import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom } from '../rbac.js';

// CRUD voor losse elementen (fase 1 van de CRUD-uitbreiding — zie ook de latere
// fases voor tags/organisatieonderdelen en relaties). Dit bestaat naast, en is
// onafhankelijk van, de Excel-import/publiceer-flow (routes/imports.ts): waar een
// import een volledige vervanging van de doelenboom is, is dit hier een directe,
// meteen zichtbare wijziging van één element — geen rapport/publiceer-stap nodig
// voor een enkele create/update/delete.
export const elementsRouter = Router();
elementsRouter.use(requireAuth);

// Alle schrijfacties hieronder (create/update/delete) vereisen tenant-admin (of
// sysadmin), én mag de doelenboom niet op read-only staan (zie rbac.ts) — lezen
// gebeurt via routes/tree.ts, dat zijn eigen (lichtere) check heeft. Let op: dit
// moet per route meegegeven worden (niet via router.use()), omdat :id op het
// moment van een path-loze .use() nog niet gevuld is.
const requireAdmin = requireWritableDoelenboom('id');

// Canonieke set — dezelfde als de check-constraint op elements.type in db/init.sql.
const ELEMENT_TYPES = [
  'Project', 'Capability', 'Operationele benefit', 'Sub-benefit',
  'Programmabaat', 'Strategische benefit', 'Strategisch doel', 'Missie',
];

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
  if (!type || !ELEMENT_TYPES.includes(type)) {
    errors.push(`Type moet één van de volgende zijn: ${ELEMENT_TYPES.join(', ')}.`);
  }
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
elementsRouter.post('/doelenbomen/:id/elements', requireAdmin, async (req, res) => {
  const input = readElementBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const doelenboomId = req.params.id;
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
    res.status(500).json({ error: 'Aanmaken van element mislukt', detail: (err as Error).message });
  }
});

// PUT /api/doelenbomen/:id/elements/:code — bestaand element bijwerken (code mag
// mee wijzigen; er wordt niets anders naar code verwezen dan puur tekstueel in
// parent_text, dus hernoemen is veilig t.o.v. edges/tags/producten die via het
// interne numerieke id gekoppeld zijn).
elementsRouter.put('/doelenbomen/:id/elements/:code', requireAdmin, async (req, res) => {
  const input = readElementBody(req.body, { requireCode: false });
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });
  const newCode = input.code || req.params.code;

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
    res.status(500).json({ error: 'Bijwerken van element mislukt', detail: (err as Error).message });
  }
});

// DELETE /api/doelenbomen/:id/elements/:code — verwijdert het element en (via
// on delete cascade in db/init.sql) alles wat eraan hangt: relaties, projectstatus,
// producten, tag- en organisatie-koppelingen.
elementsRouter.delete('/doelenbomen/:id/elements/:code', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'delete from elements where doelenboom_id = $1 and code = $2 returning id',
    [req.params.id, req.params.code]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Element niet gevonden.' });
  res.status(204).send();
});
