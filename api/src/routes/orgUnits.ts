import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireTenantRoleForDoelenboomParam } from '../rbac.js';

// CRUD voor organisatieonderdelen (fase 2, samen met tags.ts). Koppelen aan een
// element (ob_org_relations) hoort bij de relaties-fase en zit hier nog niet in —
// dit is puur de stamlijst.
export const orgUnitsRouter = Router();
orgUnitsRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
const requireAdmin = requireTenantRoleForDoelenboomParam('admin', 'id');

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const ORG_UNIT_SELECT_FIELDS = 'code, name, omschrijving';

async function nextOrgUnitCode(doelenboomId: string): Promise<string> {
  const result = await pool.query('select code from org_units where doelenboom_id = $1', [doelenboomId]);
  const used = new Set(result.rows.map((r) => r.code as string));
  let n = result.rows.length + 1;
  let candidate = 'O' + n;
  while (used.has(candidate)) {
    n += 1;
    candidate = 'O' + n;
  }
  return candidate;
}

function readOrgUnitBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    code: typeof b.code === 'string' ? b.code.trim() : '',
    name: typeof b.name === 'string' ? b.name.trim() : '',
    omschrijving: typeof b.omschrijving === 'string' ? b.omschrijving.trim() : '',
  };
}

// POST /api/doelenbomen/:id/org-units — code optioneel, anders automatisch (O1, O2, ...).
orgUnitsRouter.post('/doelenbomen/:id/org-units', requireAdmin, async (req, res) => {
  const input = readOrgUnitBody(req.body);
  if (!input.name) return res.status(400).json({ error: 'Naam is verplicht.' });

  const doelenboomId = req.params.id;
  const code = input.code || (await nextOrgUnitCode(doelenboomId));

  try {
    const result = await pool.query(
      `insert into org_units (doelenboom_id, code, name, omschrijving)
       values ($1,$2,$3,$4) returning ${ORG_UNIT_SELECT_FIELDS}`,
      [doelenboomId, code, input.name, input.omschrijving]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Organisatieonderdeel met code "${code}" bestaat al in deze doelenboom.` });
    }
    res.status(500).json({ error: 'Aanmaken van organisatieonderdeel mislukt', detail: (err as Error).message });
  }
});

orgUnitsRouter.put('/doelenbomen/:id/org-units/:code', requireAdmin, async (req, res) => {
  const input = readOrgUnitBody(req.body);
  if (!input.name) return res.status(400).json({ error: 'Naam is verplicht.' });
  const newCode = input.code || req.params.code;

  try {
    const result = await pool.query(
      `update org_units set code = $1, name = $2, omschrijving = $3
       where doelenboom_id = $4 and code = $5 returning ${ORG_UNIT_SELECT_FIELDS}`,
      [newCode, input.name, input.omschrijving, req.params.id, req.params.code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organisatieonderdeel niet gevonden.' });
    res.json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Organisatieonderdeel met code "${newCode}" bestaat al in deze doelenboom.` });
    }
    res.status(500).json({ error: 'Bijwerken van organisatieonderdeel mislukt', detail: (err as Error).message });
  }
});

// Cascade (db/init.sql) ruimt ob_org_relations-koppelingen automatisch mee op.
orgUnitsRouter.delete('/doelenbomen/:id/org-units/:code', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'delete from org_units where doelenboom_id = $1 and code = $2 returning id',
    [req.params.id, req.params.code]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Organisatieonderdeel niet gevonden.' });
  res.status(204).send();
});
