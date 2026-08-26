import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom } from '../rbac.js';

// CRUD voor organisatieonderdelen (fase 2, samen met tags.ts), plus (fase 4) het
// koppelen/bewerken/ontkoppelen van een organisatieonderdeel aan een specifiek
// element (ob_org_relations) — de stamlijst hierboven blijft gescheiden van deze
// koppel-routes onderaan het bestand.
export const orgUnitsRouter = Router();
orgUnitsRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
// requireWritableDoelenboom i.p.v. requireTenantRoleForDoelenboomParam: blokkeert
// ook tenant-admins zodra de doelenboom op read-only staat (zie rbac.ts).
// Twee niveaus, zelfde opzet als tags.ts: de org-unit-CATALOGUS zelf blijft
// admin-only, een org-unit aan een element KOPPELEN (ob_org_relations,
// onderaan dit bestand) mag ook door de rol 'gebruiker'.
const requireAdmin = requireWritableDoelenboom('id');
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');

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

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

async function findOrgUnitId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from org_units where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// Zelfde toegestane waarden als de check-constraints op ob_org_relations (db/init.sql).
const RELATIETYPES = ['Primair', 'Ondersteunend', 'Betrokken'];
const STATUSSEN = ['Concept', 'Gevalideerd', 'Vervallen'];

function readRelationBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const orgCode = typeof b.orgCode === 'string' ? b.orgCode.trim() : '';
  const relatietypeRaw = typeof b.relatietype === 'string' ? b.relatietype.trim() : '';
  const relatietype = RELATIETYPES.includes(relatietypeRaw) ? relatietypeRaw : 'Betrokken';
  const toelichting = typeof b.toelichting === 'string' ? b.toelichting.trim() : '';
  const statusRaw = typeof b.status === 'string' ? b.status.trim() : '';
  const status = STATUSSEN.includes(statusRaw) ? statusRaw : 'Concept';
  return { orgCode, relatietype, toelichting, status };
}

// POST /api/doelenbomen/:id/elements/:code/org-units — { orgCode, relatietype, toelichting, status }
// koppelt een bestaand organisatieonderdeel aan een element. Voor het aanmaken van het
// organisatieonderdeel zelf, zie POST /doelenbomen/:id/org-units hierboven.
orgUnitsRouter.post('/doelenbomen/:id/elements/:code/org-units', requireEditor, async (req, res) => {
  const input = readRelationBody(req.body);
  if (!input.orgCode) return res.status(400).json({ error: 'Organisatieonderdeel is verplicht.' });

  const doelenboomId = req.params.id;
  const elementId = await findElementId(doelenboomId, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });
  const orgUnitId = await findOrgUnitId(doelenboomId, input.orgCode);
  if (!orgUnitId) return res.status(404).json({ error: `Organisatieonderdeel "${input.orgCode}" niet gevonden.` });

  try {
    await pool.query(
      `insert into ob_org_relations (element_id, org_unit_id, relatietype, toelichting, status)
       values ($1,$2,$3,$4,$5)`,
      [elementId, orgUnitId, input.relatietype, input.toelichting, input.status]
    );
    res.status(201).json({
      elementCode: req.params.code, org: input.orgCode,
      relatietype: input.relatietype, toelichting: input.toelichting, status: input.status,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Organisatieonderdeel "${input.orgCode}" is al gekoppeld aan dit element.` });
    }
    res.status(500).json({ error: 'Koppelen van organisatieonderdeel mislukt', detail: (err as Error).message });
  }
});

// PUT /api/doelenbomen/:id/elements/:code/org-units/:orgCode — alleen relatietype/
// toelichting/status; welk organisatieonderdeel gekoppeld is, wijzig je door de
// koppeling te verwijderen en opnieuw aan te maken (zelfde aanpak als bij edges.ts).
orgUnitsRouter.put('/doelenbomen/:id/elements/:code/org-units/:orgCode', requireEditor, async (req, res) => {
  const input = readRelationBody({ ...(req.body as Record<string, unknown>), orgCode: req.params.orgCode });
  const result = await pool.query(
    `update ob_org_relations set relatietype = $1, toelichting = $2, status = $3
     where element_id = (select id from elements where doelenboom_id = $4 and code = $5)
       and org_unit_id = (select id from org_units where doelenboom_id = $4 and code = $6)
     returning id`,
    [input.relatietype, input.toelichting, input.status, req.params.id, req.params.code, req.params.orgCode]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Koppeling niet gevonden.' });
  res.json({
    elementCode: req.params.code, org: req.params.orgCode,
    relatietype: input.relatietype, toelichting: input.toelichting, status: input.status,
  });
});

// DELETE /api/doelenbomen/:id/elements/:code/org-units/:orgCode
orgUnitsRouter.delete('/doelenbomen/:id/elements/:code/org-units/:orgCode', requireEditor, async (req, res) => {
  const result = await pool.query(
    `delete from ob_org_relations
     where element_id = (select id from elements where doelenboom_id = $1 and code = $2)
       and org_unit_id = (select id from org_units where doelenboom_id = $1 and code = $3)
     returning id`,
    [req.params.id, req.params.code, req.params.orgCode]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Koppeling niet gevonden.' });
  res.status(204).send();
});
