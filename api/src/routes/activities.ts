import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';

// CRUD voor de activiteiten-planning van een project-element — zelfde opzet
// als products.ts, maar een activiteit beslaat een PERIODE (start- en
// einddatum, zie db/init.sql bij activities) i.p.v. één los moment. Getoond
// als inklapbare Gantt-achtige sectie onder de tijdlijn in het projectpaneel
// (tree.html, activitiesSectionHtml/activityGanttHtml).
export const activitiesRouter = Router();
activitiesRouter.use(requireAuth);
// Per route meegeven (niet via router.use()) — zie toelichting in elements.ts.
// minRole='gebruiker': activiteiten zijn "losse boom-inhoud" bij een element,
// net als elementen/relaties/tags-koppelingen/producten.
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');
// Activiteiten horen bij de "Projecten"-module (zie doelenboom_licentiemodel.md
// §3), net als products.ts — GET .../tree levert al lege data als de module
// ontbreekt (routes/tree.ts), dit hier blokkeert daarnaast expliciet de
// schrijfkant met een duidelijke foutmelding i.p.v. een stille no-op.
const requireProjectenModule = requireModule('projecten', 'id');

// SQL-aliassen zodat de kolomnamen 1-op-1 matchen met wat tree.ts/de frontend
// al verwacht (camelCase), zonder dat de aanroeper zelf hoeft te mappen.
const ACTIVITY_SELECT_FIELDS =
  'id, name, start_date as "startDate", end_date as "endDate", omschrijving';

type ActivityInput = {
  errors: string[];
  name: string;
  startDate: string | null;
  endDate: string | null;
  omschrijving: string;
};

// "YYYY-MM-DD" — zelfde eenvoudige check als elders in de codebase voor
// date-only velden (geen tijdzone-gedoe, <input type="date"> levert dit al
// exact zo aan).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readActivityBody(body: unknown): ActivityInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const startDate = typeof b.startDate === 'string' && b.startDate ? b.startDate : null;
  const endDate = typeof b.endDate === 'string' && b.endDate ? b.endDate : null;

  if (!name) errors.push('Naam is verplicht.');
  if (!startDate || !DATE_RE.test(startDate)) errors.push('Startdatum is verplicht (YYYY-MM-DD).');
  if (!endDate || !DATE_RE.test(endDate)) errors.push('Einddatum is verplicht (YYYY-MM-DD).');
  if (startDate && endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate) && endDate < startDate) {
    errors.push('Einddatum mag niet vóór de startdatum liggen.');
  }

  return {
    errors,
    name,
    startDate,
    endDate,
    omschrijving: typeof b.omschrijving === 'string' ? b.omschrijving : '',
  };
}

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// POST /api/doelenbomen/:id/elements/:code/activities — nieuwe activiteit.
activitiesRouter.post('/doelenbomen/:id/elements/:code/activities', requireEditor, requireProjectenModule, async (req, res) => {
  const input = readActivityBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query(
    `insert into activities (element_id, name, start_date, end_date, omschrijving)
     values ($1,$2,$3,$4,$5)
     returning ${ACTIVITY_SELECT_FIELDS}`,
    [elementId, input.name, input.startDate, input.endDate, input.omschrijving]
  );
  res.status(201).json(result.rows[0]);
});

// PUT /api/doelenbomen/:id/elements/:code/activities/:activityId — bijwerken.
activitiesRouter.put('/doelenbomen/:id/elements/:code/activities/:activityId', requireEditor, requireProjectenModule, async (req, res) => {
  const input = readActivityBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query(
    `update activities
     set name = $1, start_date = $2, end_date = $3, omschrijving = $4
     where id = $5 and element_id = $6
     returning ${ACTIVITY_SELECT_FIELDS}`,
    [input.name, input.startDate, input.endDate, input.omschrijving, req.params.activityId, elementId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Activiteit niet gevonden.' });
  res.json(result.rows[0]);
});

// DELETE /api/doelenbomen/:id/elements/:code/activities/:activityId
activitiesRouter.delete('/doelenbomen/:id/elements/:code/activities/:activityId', requireEditor, requireProjectenModule, async (req, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const result = await pool.query('delete from activities where id = $1 and element_id = $2 returning id', [
    req.params.activityId,
    elementId,
  ]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Activiteit niet gevonden.' });
  res.status(204).send();
});
