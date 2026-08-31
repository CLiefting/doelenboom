import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireWritableDoelenboom, requireModule } from '../rbac.js';
import { diffFields, logProjectHistory, touchProjectStatusUpdated } from '../projectHistory.js';

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
  'id, name, start_date as "startDate", end_date as "endDate", omschrijving, mpp_uid as "mppUid", ' +
  'is_milestone as "isMilestone", wbs, is_summary as "isSummary"';

type ActivityInput = {
  errors: string[];
  name: string;
  startDate: string | null;
  endDate: string | null;
  omschrijving: string;
  mppUid: string | null;
  isMilestone: boolean;
  wbs: string | null;
  isSummary: boolean;
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
    // Anders dan mppUid hierboven: dit veld wordt door ALLE aanroepers altijd
    // meegestuurd (het formulier heeft een eigen checkbox, de import stuurt
    // task.milestone mee) — dus gewoon een gewoon boolean-veld, geen coalesce
    // nodig in de PUT hieronder.
    isMilestone: b.isMilestone === true,
    // wbs: zelfde behandeling als mppUid — alleen de import stuurt dit mee,
    // dus coalesce bij PUT (zie hieronder) om het niet te wissen bij een
    // gewone handmatige bewerking.
    wbs: typeof b.wbs === 'string' && b.wbs ? b.wbs : null,
    // isSummary: zelfde behandeling als isMilestone — het formulier heeft een
    // eigen checkbox, dus altijd meegestuurd, geen coalesce nodig.
    isSummary: b.isSummary === true,
  };
}

async function findElementId(doelenboomId: string, code: string): Promise<number | null> {
  const r = await pool.query('select id from elements where doelenboom_id = $1 and code = $2', [doelenboomId, code]);
  return r.rows[0]?.id ?? null;
}

// id en mppUid uit een geselecteerde/geretourneerde rij weglaten vóór het
// diffen: id verandert per definitie nooit tussen before/after bij een
// update (dus zou daar toch nooit als wijziging verschijnen), maar bij een
// create (before=null) of delete (after={}) komt het wél als "veld" in de
// diff terecht — een zinloze "id: 26 → gewist"-regel in de historie. mppUid
// is interne boekhouding voor de MS Project-koppeling (zie de toelichting
// bij readActivityBody), geen gebruikersgerichte wijziging die in de
// historie hoort — zonder dit zou elke import-run (die mpp_uid meestuurt)
// een storende technische regel in de tijdlijn zetten.
function omitFromHistory<T extends Record<string, unknown>>(row: T): Omit<T, 'id' | 'mppUid'> {
  const { id: _omitId, mppUid: _omitMppUid, ...rest } = row;
  return rest;
}

// POST /api/doelenbomen/:id/elements/:code/activities — nieuwe activiteit.
// Transactie: de insert + de "verouderd"-touch van het project + de
// history-rij moeten samen slagen of samen mislukken — zie de toelichting in
// api/src/projectHistory.ts.
activitiesRouter.post('/doelenbomen/:id/elements/:code/activities', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const input = readActivityBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `insert into activities (element_id, name, start_date, end_date, omschrijving, mpp_uid, is_milestone, wbs, is_summary)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning ${ACTIVITY_SELECT_FIELDS}`,
      [
        elementId, input.name, input.startDate, input.endDate, input.omschrijving,
        input.mppUid, input.isMilestone, input.wbs, input.isSummary,
      ]
    );
    const row = result.rows[0];
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'activity',
      action: 'create',
      label: row.name,
      changes: diffFields(null, omitFromHistory(row)),
    });
    await client.query('commit');
    res.status(201).json(row);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/doelenbomen/:id/elements/:code/activities/:activityId — bijwerken.
activitiesRouter.put('/doelenbomen/:id/elements/:code/activities/:activityId', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const input = readActivityBody(req.body);
  if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${ACTIVITY_SELECT_FIELDS} from activities where id = $1 and element_id = $2`, [
      req.params.activityId,
      elementId,
    ]);
    if (before.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Activiteit niet gevonden.' });
    }
    // coalesce: een gewone edit via het formulier (tree.html: openActivityModal)
    // stuurt geen mppUid mee — dat mag het bestaande mpp_uid (indien aanwezig,
    // dus door MS Project geïmporteerd) niet wissen, anders verliest een
    // handmatig bewerkte, ooit geïmporteerde activiteit haar koppeling en zou
    // een volgende herimport 'm ten onrechte als "niet meer in het plan"
    // (dus te verwijderen) aanmerken. Alleen de import-flow zelf stuurt hier
    // bewust een waarde voor mee. Voor de diff hieronder wordt daarom niet het
    // ruwe input.wbs gebruikt, maar de daadwerkelijk opgeslagen (na-coalesce)
    // waarde uit de teruggegeven rij.
    const result = await client.query(
      `update activities
       set name = $1, start_date = $2, end_date = $3, omschrijving = $4, mpp_uid = coalesce($5, mpp_uid),
           is_milestone = $6, wbs = coalesce($7, wbs), is_summary = $8
       where id = $9 and element_id = $10
       returning ${ACTIVITY_SELECT_FIELDS}`,
      [
        input.name, input.startDate, input.endDate, input.omschrijving, input.mppUid,
        input.isMilestone, input.wbs, input.isSummary, req.params.activityId, elementId,
      ]
    );
    const row = result.rows[0];
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'activity',
      action: 'update',
      label: row.name,
      changes: diffFields(omitFromHistory(before.rows[0]), omitFromHistory(row)),
    });
    await client.query('commit');
    res.json(row);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/doelenbomen/:id/elements/:code/activities/:activityId
activitiesRouter.delete('/doelenbomen/:id/elements/:code/activities/:activityId', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${ACTIVITY_SELECT_FIELDS} from activities where id = $1 and element_id = $2`, [
      req.params.activityId,
      elementId,
    ]);
    if (before.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Activiteit niet gevonden.' });
    }
    await client.query('delete from activities where id = $1 and element_id = $2', [req.params.activityId, elementId]);
    await touchProjectStatusUpdated(client, elementId, req.user!.id);
    await logProjectHistory(client, {
      elementId,
      userId: req.user!.id,
      kind: 'activity',
      action: 'delete',
      label: before.rows[0].name,
      changes: diffFields(omitFromHistory(before.rows[0]), {}),
    });
    await client.query('commit');
    res.status(204).send();
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/doelenbomen/:id/elements/:code/activities — wist in één keer ALLE
// activiteiten van dit project-element (zowel handmatig aangemaakte als eerder
// uit MS Project geïmporteerde, mpp_uid of niet). Eén atomaire query i.p.v. de
// frontend één voor één te laten verwijderen (tree.html: deleteAllActivities
// + de "Alles wissen"-knop in activitiesSectionHtml) — geeft ook meteen een
// betrouwbaar aantal terug voor de bevestigingsmelding, en voorkomt een
// gedeeltelijk resultaat als één los verzoek zou mislukken. Per verwijderde
// activiteit één history-rij (i.p.v. één samengevatte rij) — zo blijft de
// tijdlijn per activiteit consistent met een losse DELETE hierboven.
activitiesRouter.delete('/doelenbomen/:id/elements/:code/activities', requireEditor, requireProjectenModule, async (req: AuthedRequest, res) => {
  const elementId = await findElementId(req.params.id, req.params.code);
  if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${ACTIVITY_SELECT_FIELDS} from activities where element_id = $1`, [elementId]);
    await client.query('delete from activities where element_id = $1', [elementId]);
    if (before.rows.length > 0) {
      await touchProjectStatusUpdated(client, elementId, req.user!.id);
      for (const row of before.rows) {
        await logProjectHistory(client, {
          elementId,
          userId: req.user!.id,
          kind: 'activity',
          action: 'delete',
          label: row.name,
          changes: diffFields(omitFromHistory(row), {}),
        });
      }
    }
    await client.query('commit');
    res.json({ deletedCount: before.rows.length });
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
});

// ---- Afhankelijkheden tussen activiteiten (dependencies) ----
// Denk aan MS Project: de opvolger (successorId) hangt af van de voorganger
// (predecessorId) volgens 'type' — FS (Finish-Start, de default: opvolger
// start pas ná afloop van de voorganger) is verreweg het gebruikelijkste,
// SS/FF/SF bestaan voor volledigheid. Puur informatief/visueel (zie
// tree.html: activityGanttHtml tekent de pijl, computeDependencyLayout
// bepaalt de rij-posities) — er is geen scheduling-engine die datums
// automatisch herberekent op basis van een afhankelijkheid.
//
// Beide activiteiten moeten bij hetzelfde project-element (:code) horen —
// afgedwongen hieronder vóór het inserten, niet in het databaseschema (dat
// zou een extra join in een check-constraint vereisen, wat Postgres niet
// simpel ondersteunt). Bij verwijderen van een activiteit (los, of via
// "Alles wissen" hierboven) verdwijnen bijbehorende afhankelijkheden vanzelf
// (on delete cascade, zie db/init.sql).
const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'];
const DEPENDENCY_SELECT_FIELDS =
  'id, predecessor_id as "predecessorId", successor_id as "successorId", type, lag_days as "lagDays"';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

type DependencyInput = {
  errors: string[];
  predecessorId: number;
  successorId: number;
  type: string;
  lagDays: number;
};

function readDependencyBody(body: unknown): DependencyInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const predecessorId = Number(b.predecessorId);
  const successorId = Number(b.successorId);
  if (!Number.isInteger(predecessorId) || predecessorId <= 0) errors.push('Voorganger is verplicht.');
  if (!Number.isInteger(successorId) || successorId <= 0) errors.push('Opvolger is verplicht.');
  if (Number.isInteger(predecessorId) && Number.isInteger(successorId) && predecessorId === successorId) {
    errors.push('Een activiteit kan niet van zichzelf afhangen.');
  }
  const rawType = typeof b.type === 'string' ? b.type.trim().toUpperCase() : 'FS';
  const type = DEPENDENCY_TYPES.includes(rawType) ? rawType : '';
  if (!type) errors.push('Ongeldig afhankelijkheidstype.');

  let lagDays = 0;
  if (b.lagDays !== undefined && b.lagDays !== null && b.lagDays !== '') {
    const n = Number(b.lagDays);
    if (!Number.isFinite(n) || !Number.isInteger(n)) errors.push('Vertraging moet een geheel getal zijn (dagen).');
    else lagDays = n;
  }

  return { errors, predecessorId, successorId, type: type || 'FS', lagDays };
}

// POST .../activities/dependencies — { predecessorId, successorId, type, lagDays }
activitiesRouter.post(
  '/doelenbomen/:id/elements/:code/activities/dependencies',
  requireEditor,
  requireProjectenModule,
  async (req, res) => {
    const input = readDependencyBody(req.body);
    if (input.errors.length) return res.status(400).json({ error: input.errors.join(' ') });

    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    // Allebei moeten bij dit project-element horen — anders zou een
    // afhankelijkheid dwars door twee verschillende projecten heen kunnen
    // lopen, wat de Gantt (per project getekend) niet kan tonen.
    const activityRows = await pool.query('select id from activities where element_id = $1 and id = any($2::bigint[])', [
      elementId,
      [input.predecessorId, input.successorId],
    ]);
    const foundIds = new Set(activityRows.rows.map((r) => Number(r.id)));
    if (!foundIds.has(input.predecessorId) || !foundIds.has(input.successorId)) {
      return res.status(404).json({ error: 'Voorganger en/of opvolger niet gevonden bij dit project.' });
    }

    try {
      const result = await pool.query(
        `insert into activity_dependencies (predecessor_id, successor_id, type, lag_days)
         values ($1,$2,$3,$4)
         returning ${DEPENDENCY_SELECT_FIELDS}`,
        [input.predecessorId, input.successorId, input.type, input.lagDays]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Deze afhankelijkheid bestaat al.' });
      throw err;
    }
  }
);

// PUT .../activities/dependencies/:dependencyId — alleen type/lagDays (zoals
// edges.ts: bron/opvolger wijzigen is niet ondersteund, dat is feitelijk een
// nieuwe afhankelijkheid — verwijderen + opnieuw aanmaken).
activitiesRouter.put(
  '/doelenbomen/:id/elements/:code/activities/dependencies/:dependencyId',
  requireEditor,
  requireProjectenModule,
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rawType = typeof b.type === 'string' ? b.type.trim().toUpperCase() : '';
    const type = DEPENDENCY_TYPES.includes(rawType) ? rawType : '';
    if (!type) return res.status(400).json({ error: 'Ongeldig afhankelijkheidstype.' });
    let lagDays = 0;
    if (b.lagDays !== undefined && b.lagDays !== null && b.lagDays !== '') {
      const n = Number(b.lagDays);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return res.status(400).json({ error: 'Vertraging moet een geheel getal zijn (dagen).' });
      }
      lagDays = n;
    }

    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    const result = await pool.query(
      `update activity_dependencies set type = $1, lag_days = $2
       where id = $3 and predecessor_id in (select id from activities where element_id = $4)
       returning ${DEPENDENCY_SELECT_FIELDS}`,
      [type, lagDays, req.params.dependencyId, elementId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Afhankelijkheid niet gevonden.' });
    res.json(result.rows[0]);
  }
);

// DELETE .../activities/dependencies/:dependencyId
activitiesRouter.delete(
  '/doelenbomen/:id/elements/:code/activities/dependencies/:dependencyId',
  requireEditor,
  requireProjectenModule,
  async (req, res) => {
    const elementId = await findElementId(req.params.id, req.params.code);
    if (!elementId) return res.status(404).json({ error: `Element "${req.params.code}" niet gevonden.` });

    const result = await pool.query(
      `delete from activity_dependencies
       where id = $1 and predecessor_id in (select id from activities where element_id = $2)
       returning id`,
      [req.params.dependencyId, elementId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Afhankelijkheid niet gevonden.' });
    res.status(204).send();
  }
);

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
