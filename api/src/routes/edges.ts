import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom } from '../rbac.js';

// CRUD voor relaties (edges) tussen elementen — fase 3 van de CRUD-uitbreiding.
// Edges worden geïdentificeerd door hun (source-code, target-code)-paar i.p.v. een
// numeriek id, zodat de boomweergave (die alleen codes kent, geen interne id's)
// hier direct mee kan werken. Bron/doel wijzigen op een bestaande relatie is niet
// ondersteund (dat is feitelijk een nieuwe relatie) — PUT past alleen relatietype
// en toelichting aan.
export const edgesRouter = Router();
edgesRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
// requireWritableDoelenboom i.p.v. requireTenantRoleForDoelenboomParam: blokkeert
// ook tenant-admins zodra de doelenboom op read-only staat (zie rbac.ts).
// minRole='gebruiker': relaties zijn, net als elementen, "losse boom-inhoud" —
// niet alleen admin.
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');

const WEIGHTS = ['primair', 'ondersteunend'];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

function readWeight(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = typeof b.weight === 'string' ? b.weight.trim().toLowerCase() : '';
  return WEIGHTS.includes(raw) ? raw : null;
}

function readToelichting(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.toelichting === 'string' ? b.toelichting.trim() : '';
}

// POST /api/doelenbomen/:id/edges — { source, target, weight, toelichting }
edgesRouter.post('/doelenbomen/:id/edges', requireEditor, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const source = typeof b.source === 'string' ? b.source.trim() : '';
  const target = typeof b.target === 'string' ? b.target.trim() : '';
  if (!source || !target) return res.status(400).json({ error: 'Bron- en doelelement zijn verplicht.' });
  if (source === target) return res.status(400).json({ error: 'Bron en doel mogen niet hetzelfde element zijn.' });

  const doelenboomId = req.params.id;
  const weight = readWeight(req.body);
  const toelichting = readToelichting(req.body);

  const sourceId = await findElementId(doelenboomId, source);
  if (!sourceId) return res.status(404).json({ error: `Bronelement "${source}" niet gevonden.` });
  const targetId = await findElementId(doelenboomId, target);
  if (!targetId) return res.status(404).json({ error: `Doelelement "${target}" niet gevonden.` });

  try {
    await pool.query(
      `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
       values ($1,$2,$3,$4,$5)`,
      [doelenboomId, sourceId, targetId, weight, toelichting]
    );
    res.status(201).json({ source, target, weight, toelichting });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Relatie ${source} → ${target} bestaat al.` });
    }
    res.status(500).json({ error: 'Aanmaken van relatie mislukt', detail: (err as Error).message });
  }
});

// PUT /api/doelenbomen/:id/edges/:source/:target — alleen weight/toelichting.
edgesRouter.put('/doelenbomen/:id/edges/:source/:target', requireEditor, async (req, res) => {
  const weight = readWeight(req.body);
  const toelichting = readToelichting(req.body);
  const result = await pool.query(
    `update edges set weight = $1, toelichting = $2
     where doelenboom_id = $3
       and source_element_id = (select id from elements where doelenboom_id = $3 and code = $4)
       and target_element_id = (select id from elements where doelenboom_id = $3 and code = $5)
     returning id`,
    [weight, toelichting, req.params.id, req.params.source, req.params.target]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Relatie niet gevonden.' });
  res.json({ source: req.params.source, target: req.params.target, weight, toelichting });
});

// DELETE /api/doelenbomen/:id/edges/:source/:target
edgesRouter.delete('/doelenbomen/:id/edges/:source/:target', requireEditor, async (req, res) => {
  const result = await pool.query(
    `delete from edges
     where doelenboom_id = $1
       and source_element_id = (select id from elements where doelenboom_id = $1 and code = $2)
       and target_element_id = (select id from elements where doelenboom_id = $1 and code = $3)
     returning id`,
    [req.params.id, req.params.source, req.params.target]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Relatie niet gevonden.' });
  res.status(204).send();
});
