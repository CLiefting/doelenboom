import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';

// CRUD voor de projectstatus van een element (project_status, 1-op-1 via
// element_id als primary key — zie db/init.sql). Tot nu toe alleen te vullen
// via Excel-import; dit hier is de directe variant vanuit het projectpaneel
// (tree.html), zelfde opzet als elements.ts/products.ts. Een PUT doet altijd
// een upsert: er is nooit een aparte "aanmaken"-stap nodig, want zolang er
// geen rij is toont de UI gewoon een lege status (zie projectSectionHtml).
export const projectStatusRouter = Router();
projectStatusRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
// minRole='gebruiker': projectstatus is "losse boom-inhoud" bij een element,
// net als elementen/relaties/tags-koppelingen/producten.
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');
// Projectstatus hoort bij de "Projecten"-module — zie de toelichting bij
// requireProjectenModule in routes/products.ts.
const requireProjectenModule = requireModule('projecten', 'id');

// Lege string is een geldige "nog niet gezet"-waarde (zelfde als het db-default
// en wat de Excel-parser gebruikt) — vandaar in beide lijsten.
const PROJECTSTATUS_VALUES = ['', 'Backlog', 'Actief', 'On-hold', 'Gereed', 'Vervallen'];
const RAG_VALUES = ['', 'Rood', 'Oranje', 'Groen'];

const PROJECT_STATUS_SELECT_FIELDS =
  'element_id as "elementId", projectstatus, rag, toelichting, ' +
  'gerapporteerd_op as "gerapporteerdOp", cluster_ppt as "clusterPpt"';

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// PUT /api/doelenbomen/:id/elements/:code/project-status — upsert.
projectStatusRouter.put('/doelenbomen/:id/elements/:code/project-status', requireEditor, requireProjectenModule, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const projectstatus = typeof b.projectstatus === 'string' ? b.projectstatus : '';
  const rag = typeof b.rag === 'string' ? b.rag : '';
  const toelichting = typeof b.toelichting === 'string' ? b.toelichting : '';
  const gerapporteerdOp = typeof b.gerapporteerdOp === 'string' && b.gerapporteerdOp ? b.gerapporteerdOp : null;
  const clusterPpt = typeof b.clusterPpt === 'string' ? b.clusterPpt : '';

  const errors: string[] = [];
  if (!PROJECTSTATUS_VALUES.includes(projectstatus)) {
    errors.push(`Projectstatus moet leeg zijn of één van: ${PROJECTSTATUS_VALUES.filter(Boolean).join(', ')}.`);
  }
  if (!RAG_VALUES.includes(rag)) {
    errors.push(`RAG-status moet leeg zijn of één van: ${RAG_VALUES.filter(Boolean).join(', ')}.`);
  }
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query(
    `insert into project_status (element_id, projectstatus, rag, toelichting, gerapporteerd_op, cluster_ppt)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (element_id) do update set
       projectstatus = excluded.projectstatus,
       rag = excluded.rag,
       toelichting = excluded.toelichting,
       gerapporteerd_op = excluded.gerapporteerd_op,
       cluster_ppt = excluded.cluster_ppt
     returning ${PROJECT_STATUS_SELECT_FIELDS}`,
    [elementId, projectstatus, rag, toelichting, gerapporteerdOp, clusterPpt]
  );
  res.json(result.rows[0]);
});

// DELETE /api/doelenbomen/:id/elements/:code/project-status — status wissen
// (terug naar "nog geen status gerapporteerd").
projectStatusRouter.delete('/doelenbomen/:id/elements/:code/project-status', requireEditor, requireProjectenModule, async (req, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  await pool.query('delete from project_status where element_id = $1', [elementId]);
  res.status(204).send();
});
