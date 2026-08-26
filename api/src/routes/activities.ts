import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';

// CRUD voor de activiteiten-planning van een project-element — zelfde opzet
// als products.ts, maar een activiteit beslaat een PERIODE (start- en
// einddatum, zie db/init.sql bij activities) i.p.v. één los moment. Getoond
// als inklapbare Gantt-achtige sectie onder de tijdlijn in het projectpaneel
// (tree.html, activitiesSectionHtml/activityGanttHtml).
//
// Bulk-importeren vanuit MS Project (zie /import-mpp onderaan): tree.html
// parseert een MS Project XML-export (rechtstreeks aangeleverd, of via
// /import-mpp uit een .mpp-bestand omgezet — zie hieronder) volledig
// client-side met DOMParser (parseMppProjectXml) en bouwt daaruit een
// synchronisatieplan (computeMppImportPlan): nieuwe taken -> POST hieronder,
// eerder geïmporteerde taken die gewijzigd zijn -> PUT, eerder geïmporteerde
// taken die niet meer in het plan voorkomen -> DELETE. Matching gebeurt op
// mpp_uid (de stabiele Task-UID uit MS Project, zie het kolomcommentaar in
// db/init.sql) — zo hoeft een herimport van hetzelfde (bijgewerkte) plan niet
// telkens dubbele activiteiten aan te maken. Handmatig aangemaakte activiteiten
// (mpp_uid = null) worden door een import nooit aangeraakt. Zo bestaat de
// WBS-niveau-/mijlpaal-/fase-/diff-logica maar op één plek (JavaScript, in de
// browser) voor beide bestandstypen.
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
  'id, name, start_date as "startDate", end_date as "endDate", omschrijving, mpp_uid as "mppUid"';

type ActivityInput = {
  errors: string[];
  name: string;
  startDate: string | null;
  endDate: string | null;
  omschrijving: string;
  mppUid: string | null;
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
    // Alleen gezet door de MS Project-import (computeMppImportPlan in
    // tree.html) — bij een gewone create/edit via het formulier ontbreekt dit
    // veld, en blijft de activiteit dus terecht "handmatig" (mpp_uid = null).
    mppUid: typeof b.mppUid === 'string' && b.mppUid ? b.mppUid : null,
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
    `insert into activities (element_id, name, start_date, end_date, omschrijving, mpp_uid)
     values ($1,$2,$3,$4,$5,$6)
     returning ${ACTIVITY_SELECT_FIELDS}`,
    [elementId, input.name, input.startDate, input.endDate, input.omschrijving, input.mppUid]
  );
  res.status(201).json(result.rows[0]);
});

// PUT /api/doelenbomen/:id/elements/:code/activities/:activityId — bijwerken.
activitiesRouter.put('/doelenbomen/:id/elements/:code/activities/:activityId', requireEditor, requireProjectenModule, async (req, res) => {
  const input = readActivityBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  // coalesce: een gewone edit via het formulier (tree.html: openActivityModal)
  // stuurt geen mppUid mee — dat mag het bestaande mpp_uid (indien aanwezig,
  // dus door MS Project geïmporteerd) niet wissen, anders verliest een
  // handmatig bewerkte, ooit geïmporteerde activiteit haar koppeling en zou
  // een volgende herimport 'm ten onrechte als "niet meer in het plan"
  // (dus te verwijderen) aanmerken. Alleen de import-flow zelf stuurt hier
  // bewust een waarde voor mee.
  const result = await pool.query(
    `update activities
     set name = $1, start_date = $2, end_date = $3, omschrijving = $4, mpp_uid = coalesce($5, mpp_uid)
     where id = $6 and element_id = $7
     returning ${ACTIVITY_SELECT_FIELDS}`,
    [input.name, input.startDate, input.endDate, input.omschrijving, input.mppUid, req.params.activityId, elementId]
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

// ---- .mpp-import: omzetten naar MS Project XML via excel-service ----
// Het binaire .mpp-formaat zelf kan niet in de browser gelezen worden (geen
// bruikbare JS-library) en op de Node-API zou dat een JVM + MPXJ vereisen —
// diezelfde afhankelijkheid heeft excel-service (Python/FastAPI) al nodig voor
// dit ene doel, dus die conversie hoort daar (zie excel-service/app/
// mpp_converter.py), niet in deze Node-container. Dit endpoint is dan ook
// een dunne doorgeefluik: uploaden -> forwarden naar excel-service -> de
// terugontvangen MS Project XML ongewijzigd teruggeven. Er wordt hier NIETS
// naar de database geschreven — dat gebeurt pas als de gebruiker in de
// aanvink-lijst (tree.html) taken selecteert en die alsnog los via de gewone
// POST hierboven aanmaakt.
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';

activitiesRouter.post(
  '/doelenbomen/:id/elements/:code/activities/import-mpp',
  requireEditor,
  requireProjectenModule,
  importUpload.single('file'),
  async (req: AuthedRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'Geen bestand meegestuurd (veld "file").' });

    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    const form = new FormData();
    const arrayBuffer = new ArrayBuffer(req.file.buffer.byteLength);
    new Uint8Array(arrayBuffer).set(req.file.buffer);
    form.append('file', new Blob([arrayBuffer]), req.file.originalname);

    try {
      const upstream = await fetch(`${EXCEL_SERVICE_URL}/parse-mpp`, { method: 'POST', body: form });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return res.status(upstream.status === 400 ? 400 : 502).json({
          error: 'Kon het .mpp-bestand niet verwerken.',
          detail,
        });
      }
      const xml = await upstream.text();
      res.type('application/xml').send(xml);
    } catch (err) {
      res.status(502).json({ error: 'MS Project-conversieservice niet bereikbaar.', detail: (err as Error).message });
    }
  }
);
