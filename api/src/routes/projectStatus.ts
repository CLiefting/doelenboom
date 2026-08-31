import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireWritableDoelenboom, requireModule, requireTenantRoleForDoelenboomParam, getEffectiveRoleForDoelenboom } from '../rbac.js';

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
  'gerapporteerd_op as "gerapporteerdOp", cluster_ppt as "clusterPpt", updated_at as "updatedAt"';

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// Huidige (vóór deze wijziging) waarden ophalen t.b.v. de before/after-rij in
// project_status_history — null (geen rij) is bewust anders dan lege strings
// (een bewust ingevulde "leeg"-waarde), zie de toelichting in
// db/migrations/0021_project_status_history.sql.
type ProjectStatusFields = {
  projectstatus: string; rag: string; toelichting: string;
  gerapporteerdOp: string | null; clusterPpt: string;
} | null;

async function findCurrentStatus(client: { query: typeof pool.query }, elementId: number): Promise<ProjectStatusFields> {
  const r = await client.query(
    'select projectstatus, rag, toelichting, gerapporteerd_op as "gerapporteerdOp", cluster_ppt as "clusterPpt" ' +
    'from project_status where element_id = $1',
    [elementId]
  );
  return r.rows[0] ?? null;
}

async function insertHistoryRow(
  client: { query: typeof pool.query },
  elementId: number,
  userId: number,
  isTouch: boolean,
  prev: ProjectStatusFields,
  next: ProjectStatusFields
) {
  await client.query(
    `insert into project_status_history
       (element_id, changed_by, is_touch,
        prev_projectstatus, prev_rag, prev_toelichting, prev_gerapporteerd_op, prev_cluster_ppt,
        new_projectstatus, new_rag, new_toelichting, new_gerapporteerd_op, new_cluster_ppt)
     values ($1,$2,$3, $4,$5,$6,$7,$8, $9,$10,$11,$12,$13)`,
    [
      elementId, userId, isTouch,
      prev?.projectstatus ?? null, prev?.rag ?? null, prev?.toelichting ?? null, prev?.gerapporteerdOp ?? null, prev?.clusterPpt ?? null,
      next?.projectstatus ?? null, next?.rag ?? null, next?.toelichting ?? null, next?.gerapporteerdOp ?? null, next?.clusterPpt ?? null,
    ]
  );
}

// PUT /api/doelenbomen/:id/elements/:code/project-status — upsert.
projectStatusRouter.put('/doelenbomen/:id/elements/:code/project-status', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
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

  // Transactie: de upsert + de history-rij (before/after, zie
  // project_status_history) moeten samen slagen of samen mislukken — anders
  // kan de status wél wijzigen terwijl de historie het niet meekrijgt.
  const client = await pool.connect();
  try {
    await client.query('begin');
    const prev = await findCurrentStatus(client, elementId);
    // updated_at/updated_by: altijd gezet bij een opslag, zie de toelichting
    // bij project_status in db/init.sql — dit is het automatische
    // "wanneer/door wie" dat de 'verouderd'-markering voedt (isStale() in
    // tree.html), los van het vrij invoerbare gerapporteerd_op hierboven.
    const result = await client.query(
      `insert into project_status (element_id, projectstatus, rag, toelichting, gerapporteerd_op, cluster_ppt, updated_at, updated_by)
       values ($1,$2,$3,$4,$5,$6, now(), $7)
       on conflict (element_id) do update set
         projectstatus = excluded.projectstatus,
         rag = excluded.rag,
         toelichting = excluded.toelichting,
         gerapporteerd_op = excluded.gerapporteerd_op,
         cluster_ppt = excluded.cluster_ppt,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       returning ${PROJECT_STATUS_SELECT_FIELDS}`,
      [elementId, projectstatus, rag, toelichting, gerapporteerdOp, clusterPpt, req.user!.id]
    );
    await insertHistoryRow(client, elementId, req.user!.id, false, prev, {
      projectstatus, rag, toelichting, gerapporteerdOp, clusterPpt,
    });
    await client.query('commit');
    // Geen extra join/select nodig voor het e-mailadres: de opslaande
    // gebruiker ís de net gezette updated_by, dus req.user!.email is altijd
    // correct hier (in tegenstelling tot GET /tree, waar meerdere gebruikers
    // door elkaar voorkomen en er dus wél een join nodig is, zie routes/tree.ts).
    res.json({ ...result.rows[0], updatedByEmail: req.user!.email });
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/doelenbomen/:id/elements/:code/project-status/touch — "Markeer als
// gecontroleerd vandaag": zet alleen updated_at/updated_by, zonder de
// inhoudelijke velden te wijzigen. Voor het geval een project nog steeds
// klopt maar niemand iets hoefde aan te passen — zonder deze actie zou zo'n
// project na de 'verouderd'-drempel toch als verouderd blijven opvallen,
// terwijl het net gecontroleerd is. Upsert (net als de PUT hierboven): een
// project zonder project_status-rij krijgt er zo één met verder alleen de
// kolomdefaults.
projectStatusRouter.post('/doelenbomen/:id/elements/:code/project-status/touch', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const prev = await findCurrentStatus(client, elementId);
    const result = await client.query(
      `insert into project_status (element_id, updated_at, updated_by)
       values ($1, now(), $2)
       on conflict (element_id) do update set
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       returning ${PROJECT_STATUS_SELECT_FIELDS}`,
      [elementId, req.user!.id]
    );
    // is_touch=true, prev===new: inhoudelijk verandert er niets, zie de
    // toelichting bij project_status_history in db/init.sql — de rij dient
    // puur om "op deze datum gecontroleerd, niets gewijzigd" te kunnen tonen
    // in de historie (zie Charles' keuze in het interview).
    const contentFields = prev ?? { projectstatus: '', rag: '', toelichting: '', gerapporteerdOp: null, clusterPpt: '' };
    await insertHistoryRow(client, elementId, req.user!.id, true, contentFields, contentFields);
    await client.query('commit');
    res.json({ ...result.rows[0], updatedByEmail: req.user!.email });
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/doelenbomen/:id/elements/:code/project-status — status wissen
// (terug naar "nog geen status gerapporteerd").
projectStatusRouter.delete('/doelenbomen/:id/elements/:code/project-status', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const prev = await findCurrentStatus(client, elementId);
    await client.query('delete from project_status where element_id = $1', [elementId]);
    // Alleen loggen als er ook echt iets was om te wissen — anders (dubbele
    // DELETE, of nooit een status gehad) een lege/zinloze historie-rij.
    if (prev) {
      await insertHistoryRow(client, elementId, req.user!.id, false, prev, null);
    }
    await client.query('commit');
    res.status(204).send();
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/doelenbomen/:id/elements/:code/project-status/history — volledige
// wijzigingshistorie (before/after per veld, wie/wanneer, is_touch), nieuwste
// eerst. Alleen-lezen: elke rol met toegang tot deze doelenboom mag 'm zien
// ('bezoeker' incluis, zelfde ondergrens als GET .../tree) — maar 'wie' wordt
// net als bij GET .../tree gestript voor de rol 'bezoeker' (zie isEditorRole
// hieronder en de privacykeuze uit het eerdere interview: "wanneer"/"wat" mag
// iedereen zien, "door wie" alleen beheerders/editors).
projectStatusRouter.get(
  '/doelenbomen/:id/elements/:code/project-status/history',
  requireTenantRoleForDoelenboomParam('bezoeker', 'id'),
  requireProjectenModule,
  async (req: AuthedRequest, res) => {
    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    const result = await pool.query(
      `select h.id, h.changed_at as "changedAt", h.is_touch as "isTouch", u.email as "changedByEmail",
              h.prev_projectstatus as "prevProjectstatus", h.prev_rag as "prevRag",
              h.prev_toelichting as "prevToelichting", h.prev_gerapporteerd_op as "prevGerapporteerdOp",
              h.prev_cluster_ppt as "prevClusterPpt",
              h.new_projectstatus as "newProjectstatus", h.new_rag as "newRag",
              h.new_toelichting as "newToelichting", h.new_gerapporteerd_op as "newGerapporteerdOp",
              h.new_cluster_ppt as "newClusterPpt"
       from project_status_history h
       left join users u on u.id = h.changed_by
       where h.element_id = $1
       order by h.changed_at desc`,
      [elementId]
    );

    const isEditorRole = await getEffectiveRoleForDoelenboom(req.user!.id, req.params.id).then(
      (role) => role === 'admin' || role === 'gebruiker'
    );
    const rows = isEditorRole
      ? result.rows
      : result.rows.map(({ changedByEmail: _omit, ...rest }) => rest);
    res.json(rows);
  }
);
