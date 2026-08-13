import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireTenantRoleForDoelenboomParam } from '../rbac.js';

// CRUD voor tags (fase 2 van de CRUD-uitbreiding, samen met org-units.ts). Koppelen
// van een tag aan een element (element_tags) hoort bij de relaties-fase en zit hier
// nog niet in — dit is puur de stamlijst.
export const tagsRouter = Router();
tagsRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
const requireAdmin = requireTenantRoleForDoelenboomParam('admin', 'id');

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const TAG_SELECT_FIELDS = 'code, name, categorie, omschrijving';

async function nextTagCode(doelenboomId: string): Promise<string> {
  const result = await pool.query('select code from tags where doelenboom_id = $1', [doelenboomId]);
  const used = new Set(result.rows.map((r) => r.code as string));
  let n = result.rows.length + 1;
  let candidate = 'T' + n;
  while (used.has(candidate)) {
    n += 1;
    candidate = 'T' + n;
  }
  return candidate;
}

function readTagBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    code: typeof b.code === 'string' ? b.code.trim() : '',
    name: typeof b.name === 'string' ? b.name.trim() : '',
    categorie: typeof b.categorie === 'string' ? b.categorie.trim() : '',
    omschrijving: typeof b.omschrijving === 'string' ? b.omschrijving.trim() : '',
  };
}

// POST /api/doelenbomen/:id/tags — code is optioneel; als leeg wordt hij automatisch
// gegenereerd (T1, T2, ...) zodat de gebruiker in de eenvoudige beheer-UI niet zelf
// een code hoeft te verzinnen.
tagsRouter.post('/doelenbomen/:id/tags', requireAdmin, async (req, res) => {
  const input = readTagBody(req.body);
  if (!input.name) return res.status(400).json({ error: 'Naam is verplicht.' });

  const doelenboomId = req.params.id;
  const code = input.code || (await nextTagCode(doelenboomId));

  try {
    const result = await pool.query(
      `insert into tags (doelenboom_id, code, name, categorie, omschrijving)
       values ($1,$2,$3,$4,$5) returning ${TAG_SELECT_FIELDS}`,
      [doelenboomId, code, input.name, input.categorie, input.omschrijving]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Tag met code "${code}" bestaat al in deze doelenboom.` });
    }
    res.status(500).json({ error: 'Aanmaken van tag mislukt', detail: (err as Error).message });
  }
});

tagsRouter.put('/doelenbomen/:id/tags/:code', requireAdmin, async (req, res) => {
  const input = readTagBody(req.body);
  if (!input.name) return res.status(400).json({ error: 'Naam is verplicht.' });
  const newCode = input.code || req.params.code;

  try {
    const result = await pool.query(
      `update tags set code = $1, name = $2, categorie = $3, omschrijving = $4
       where doelenboom_id = $5 and code = $6 returning ${TAG_SELECT_FIELDS}`,
      [newCode, input.name, input.categorie, input.omschrijving, req.params.id, req.params.code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tag niet gevonden.' });
    res.json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Tag met code "${newCode}" bestaat al in deze doelenboom.` });
    }
    res.status(500).json({ error: 'Bijwerken van tag mislukt', detail: (err as Error).message });
  }
});

// Cascade (db/init.sql) ruimt element_tags-koppelingen automatisch mee op.
tagsRouter.delete('/doelenbomen/:id/tags/:code', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'delete from tags where doelenboom_id = $1 and code = $2 returning id',
    [req.params.id, req.params.code]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Tag niet gevonden.' });
  res.status(204).send();
});
