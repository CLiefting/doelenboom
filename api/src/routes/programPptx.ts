import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRoleForDoelenboomParam, requireModule, tenantIdForDoelenboom } from '../rbac.js';
import { logAuditEvent } from '../auditLog.js';
import { pool } from '../db.js';
import { fetchTree } from './tree.js';
import { buildProjectExportData } from './projectExcel.js';
import { columnForTypeName, ColumnDef } from '../columnConfig.js';
import { sendServerError } from '../errors.js';

// Programma-PowerPoint (DOEL-112): één presentatie voor meerdere projecten
// uit dezelfde doelenboom -- tijdlijnen, deliverables, bijdrage aan doelen en
// een voortgangsslide per project. De opmaak zit in
// excel-service/app/program_pptx.py; deze route kiest en controleert wat
// erin komt, en beheert de persoonlijke "opgeslagen selecties".
//
// Rechten: lezen van de boom (bezoeker) + module 'projecten', net als de
// PowerPoint van één project (routes/projectExcel.ts). Alle projectcodes
// worden vergeleken met de project-elementen van DEZE boom (fetchTree op het
// :id uit de URL), dus een code uit een andere boom of tenant bestaat hier
// eenvoudigweg niet (geen IDOR). Opgeslagen selecties zijn van één gebruiker
// in één boom; elke query filtert op allebei.

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const PROGRAM_MAX_PROJECTS = 50;
export const PROGRAM_WINDOW_MIN = 1;
export const PROGRAM_WINDOW_MAX = 12;
export const PROGRAM_WINDOW_DEFAULT = 3;
export const SELECTION_NAME_MAX = 80;
export const SELECTIONS_PER_USER_MAX = 50;
// Per project in "bijdrage aan doelen" hooguit zoveel namen per kolom; de
// slide toont toch niet meer.
const GOAL_NAMES_MAX = 25;

const requireViewer = requireTenantRoleForDoelenboomParam('bezoeker', 'id');
const requireProjectenModule = requireModule('projecten', 'id');

export const programPptxRouter = Router();
programPptxRouter.use(requireAuth);

type FetchedTree = NonNullable<Awaited<ReturnType<typeof fetchTree>>>;

// ---- validatie (pure functies, apart getest) -----------------------------

/** Codes van de project-elementen in deze boom, in boomvolgorde. */
export function projectCodesOf(tree: Pick<FetchedTree, 'elements' | 'columns'>): string[] {
  const out: string[] = [];
  for (const el of tree.elements as Array<Record<string, unknown>>) {
    const col = columnForTypeName(tree.columns, String(el.type ?? ''));
    if (col?.isProjectRole && typeof el.code === 'string' && !out.includes(el.code)) out.push(el.code);
  }
  return out;
}

/** Een lijst projectcodes: array van strings, 1..50, allemaal projecten van
 *  deze boom; ontdubbeld en in boomvolgorde. De foutmelding herhaalt nooit
 *  de invoer zelf. */
export function parseProjectCodes(value: unknown, known: string[]): { error: string } | { codes: string[] } {
  if (!Array.isArray(value)) return { error: 'projects moet een lijst van projectcodes zijn.' };
  if (value.length === 0) return { error: 'Kies minstens één project.' };
  if (value.length > PROGRAM_MAX_PROJECTS * 2) return { error: `Kies hooguit ${PROGRAM_MAX_PROJECTS} projecten.` };
  const knownSet = new Set(known);
  const picked = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string' || !knownSet.has(v)) return { error: 'De selectie bevat een onbekend project.' };
    picked.add(v);
  }
  if (picked.size > PROGRAM_MAX_PROJECTS) return { error: `Kies hooguit ${PROGRAM_MAX_PROJECTS} projecten.` };
  return { codes: known.filter((c) => picked.has(c)) };
}

export function parseWindowMonths(value: unknown): { error: string } | { months: number } {
  if (value === undefined) return { months: PROGRAM_WINDOW_DEFAULT };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < PROGRAM_WINDOW_MIN || value > PROGRAM_WINDOW_MAX) {
    return { error: `Het venster moet een heel aantal maanden tussen ${PROGRAM_WINDOW_MIN} en ${PROGRAM_WINDOW_MAX} zijn.` };
  }
  return { months: value };
}

/** 'JJJJ-MM-DD' en een bestaande datum tussen 2000 en 2100; weglaten mag. */
export function parseReferenceDate(value: unknown): { error: string } | { date: string | null } {
  if (value === undefined || value === null || value === '') return { date: null };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: 'De peildatum moet de vorm JJJJ-MM-DD hebben.' };
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: 'De peildatum is geen geldige datum.' };
  }
  return { date: value };
}

export function parseSelectionName(value: unknown): { error: string } | { name: string } {
  if (typeof value !== 'string') return { error: 'Geef de selectie een naam.' };
  // Besturingstekens eruit, witruimte aan de randen weg.
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) return { error: 'Geef de selectie een naam.' };
  if (name.length > SELECTION_NAME_MAX) return { error: `De naam mag hooguit ${SELECTION_NAME_MAX} tekens lang zijn.` };
  return { name };
}

// ---- bijdrage aan doelen ---------------------------------------------------

/** Kolommen voor de slide "Bijdrage aan doelen": de kolom direct boven de
 *  projectkolom, en de één-na-bovenste kolom (bij de standaardindeling
 *  "Strategisch doel"; de bovenste is meestal één missie). Die laatste
 *  alleen als hij hoger ligt dan de directe kolom. */
export function goalColumnsOf(columns: ColumnDef[]): { direct: ColumnDef | null; top: ColumnDef | null } {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  const projectIdx = sorted.findIndex((c) => c.isProjectRole);
  if (projectIdx < 0) return { direct: null, top: null };
  const direct = sorted[projectIdx + 1] ?? null;
  const topIdx = sorted.length - 2;
  const top = direct && topIdx > projectIdx + 1 ? sorted[topIdx] : null;
  return { direct, top };
}

/** Per project de namen van de elementen waaraan het direct bijdraagt (één
 *  relatie omhoog) en van de elementen in de doelkolom die het via de keten
 *  bereikt. Iteratief en met een bezocht-set: een cyclische boom kan de
 *  route niet laten vastlopen. */
export function goalsFor(
  tree: Pick<FetchedTree, 'elements' | 'edges' | 'columns'>, code: string,
  cols: { direct: ColumnDef | null; top: ColumnDef | null },
): { direct: string[]; top: string[] } {
  const elements = tree.elements as Array<Record<string, unknown>>;
  const byCode = new Map(elements.map((e) => [String(e.code ?? ''), e]));
  const up = new Map<string, string[]>();
  for (const e of tree.edges as Array<{ source: string; target: string }>) {
    if (!up.has(e.source)) up.set(e.source, []);
    up.get(e.source)!.push(e.target);
  }
  const colOf = (c: string) => columnForTypeName(tree.columns, String(byCode.get(c)?.type ?? ''));
  const nameOf = (c: string) => String(byCode.get(c)?.name ?? c);

  const direct = (up.get(code) ?? []).filter((c) => byCode.has(c));
  const top: string[] = [];
  if (cols.top) {
    const seen = new Set<string>([code]);
    const stack = [...direct];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (colOf(c)?.typeName === cols.top.typeName) top.push(c);
      for (const t of up.get(c) ?? []) if (!seen.has(t) && byCode.has(t)) stack.push(t);
    }
  }
  const order = new Map(elements.map((e, i) => [String(e.code ?? ''), i]));
  const names = (codes: string[]) =>
    [...new Set(codes)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).slice(0, GOAL_NAMES_MAX).map(nameOf);
  return { direct: names(direct), top: names(top) };
}

// ---- export ------------------------------------------------------------------

// POST /api/doelenbomen/:id/program-pptx
//   { projects: string[], referenceDate?: 'JJJJ-MM-DD', windowMonths?: 1..12 }
// POST omdat de keuzes als JSON-body meekomen; de route wijzigt niets.
programPptxRouter.post('/doelenbomen/:id/program-pptx', requireViewer, requireProjectenModule, async (req: AuthedRequest, res) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const tree = await fetchTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });

  const codes = parseProjectCodes(body.projects, projectCodesOf(tree));
  if ('error' in codes) return res.status(400).json({ error: codes.error });
  const window = parseWindowMonths(body.windowMonths);
  if ('error' in window) return res.status(400).json({ error: window.error });
  const ref = parseReferenceDate(body.referenceDate);
  if ('error' in ref) return res.status(400).json({ error: ref.error });

  const cols = goalColumnsOf(tree.columns);
  const projects = codes.codes.map((code) => ({
    ...buildProjectExportData(tree, code)!,
    goals: goalsFor(tree, code, cols),
  }));
  const exportedAt = new Date();
  const data = {
    projects,
    goalColumns: {
      direct: cols.direct ? (cols.direct.title || cols.direct.typeName) : null,
      top: cols.top ? (cols.top.title || cols.top.typeName) : null,
    },
  };
  const options = { referenceDate: ref.date ?? undefined, windowMonths: window.months };
  const meta = {
    doelenboom: tree.doelenboom.name,
    tenant: tree.doelenboom.tenant.name,
    exportedAt: exportedAt.toISOString(),
    exportedBy: req.user?.email ?? 'onbekend',
    showPlannedForDelivered: true,
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${EXCEL_SERVICE_URL}/program-pptx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, options, meta }),
    });
  } catch (err) {
    return sendServerError(res, err, 'Excel-service niet bereikbaar', 502);
  }
  if (upstream.status === 422) {
    // Leesbare keuze-fout van de excel-service (bv. te veel slides); alleen
    // het error-veld doorgeven, als string.
    const json = (await upstream.json().catch(() => ({}))) as { error?: unknown };
    return res.status(422).json({ error: typeof json.error === 'string' ? json.error : 'Deze keuze kan niet worden geëxporteerd.' });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return sendServerError(res, text, 'Excel-service gaf een fout terug', 502);
  }
  const arrayBuffer = await upstream.arrayBuffer();

  // DOEL-29: elke export met inhoud komt in het auditlog.
  await logAuditEvent({
    eventType: 'doelenboom_exported',
    userId: req.user!.id,
    tenantId: await tenantIdForDoelenboom(req.params.id),
    doelenboomId: req.params.id,
    detail: { kind: 'programma-pptx', format: 'pptx', projects: codes.codes, windowMonths: window.months, ...(ref.date ? { referenceDate: ref.date } : {}) },
  });

  const sanitizeForFilename = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const jjmmdd =
    String(exportedAt.getFullYear() % 100).padStart(2, '0') +
    String(exportedAt.getMonth() + 1).padStart(2, '0') +
    String(exportedAt.getDate()).padStart(2, '0');
  const filename = `Programma_${sanitizeForFilename(tree.doelenboom.tenant.name)}_${sanitizeForFilename(tree.doelenboom.name)}_${jjmmdd}.pptx`;
  res.setHeader('Content-Type', PPTX_MEDIA_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Binaire pptx-download: vaste Content-Type, Content-Disposition: attachment en een
  // gesaneerde bestandsnaam; geen HTML, dus geen XSS-pad (Semgrep-vals-positief, DOEL-41).
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  res.send(Buffer.from(arrayBuffer));
});

// ---- opgeslagen selecties ------------------------------------------------------
// Persoonlijk: elke query filtert op doelenboom_id = :id EN user_id = de
// ingelogde gebruiker. Een selectie van iemand anders (of uit een andere
// boom) geeft dus 404, niet 403 -- er wordt niet verraden dat hij bestaat.

const SELECTION_COLUMNS =
  'id, name, project_codes as "projectCodes", window_months as "windowMonths", created_at as "createdAt", updated_at as "updatedAt"';

function parseSelectionId(value: string): number | null {
  return /^[1-9]\d{0,15}$/.test(value) ? Number(value) : null;
}

programPptxRouter.get('/doelenbomen/:id/program-selections', requireViewer, requireProjectenModule, async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    `select ${SELECTION_COLUMNS} from program_selections
     where doelenboom_id = $1 and user_id = $2 order by lower(name), id`,
    [req.params.id, req.user!.id]
  );
  res.json(rows);
});

async function validateSelectionBody(req: AuthedRequest, partial: boolean) {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const out: { name?: string; codes?: string[]; months?: number } = {};
  if (!partial || body.name !== undefined) {
    const n = parseSelectionName(body.name);
    if ('error' in n) return { error: n.error };
    out.name = n.name;
  }
  if (!partial || body.projects !== undefined) {
    const tree = await fetchTree(req.params.id);
    if (!tree) return { error: 'Doelenboom niet gevonden', status: 404 };
    const c = parseProjectCodes(body.projects, projectCodesOf(tree));
    if ('error' in c) return { error: c.error };
    out.codes = c.codes;
  }
  if (!partial || body.windowMonths !== undefined) {
    const w = parseWindowMonths(body.windowMonths);
    if ('error' in w) return { error: w.error };
    out.months = w.months;
  }
  return { value: out };
}

programPptxRouter.post('/doelenbomen/:id/program-selections', requireViewer, requireProjectenModule, async (req: AuthedRequest, res) => {
  const parsed = await validateSelectionBody(req, false);
  if ('error' in parsed) return res.status(parsed.status ?? 400).json({ error: parsed.error });
  const { name, codes, months } = parsed.value;
  const count = await pool.query(
    'select count(*)::int as n from program_selections where doelenboom_id = $1 and user_id = $2',
    [req.params.id, req.user!.id]
  );
  if (count.rows[0].n >= SELECTIONS_PER_USER_MAX) {
    return res.status(409).json({ error: `Je kunt hooguit ${SELECTIONS_PER_USER_MAX} selecties bewaren in deze doelenboom.` });
  }
  try {
    const { rows } = await pool.query(
      `insert into program_selections (doelenboom_id, user_id, name, project_codes, window_months)
       values ($1, $2, $3, $4, $5) returning ${SELECTION_COLUMNS}`,
      [req.params.id, req.user!.id, name, codes, months]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Je hebt al een selectie met deze naam.' });
    }
    throw err;
  }
});

programPptxRouter.put('/doelenbomen/:id/program-selections/:selectionId', requireViewer, requireProjectenModule, async (req: AuthedRequest, res) => {
  const selectionId = parseSelectionId(req.params.selectionId);
  if (selectionId === null) return res.status(404).json({ error: 'Selectie niet gevonden' });
  const parsed = await validateSelectionBody(req, true);
  if ('error' in parsed) return res.status(parsed.status ?? 400).json({ error: parsed.error });
  const { name, codes, months } = parsed.value;
  if (name === undefined && codes === undefined && months === undefined) {
    return res.status(400).json({ error: 'Er is niets om te wijzigen.' });
  }
  try {
    const { rows } = await pool.query(
      `update program_selections
         set name = coalesce($4, name),
             project_codes = coalesce($5, project_codes),
             window_months = coalesce($6, window_months),
             updated_at = now()
       where id = $1 and doelenboom_id = $2 and user_id = $3
       returning ${SELECTION_COLUMNS}`,
      [selectionId, req.params.id, req.user!.id, name ?? null, codes ?? null, months ?? null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Selectie niet gevonden' });
    res.json(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Je hebt al een selectie met deze naam.' });
    }
    throw err;
  }
});

programPptxRouter.delete('/doelenbomen/:id/program-selections/:selectionId', requireViewer, requireProjectenModule, async (req: AuthedRequest, res) => {
  const selectionId = parseSelectionId(req.params.selectionId);
  if (selectionId === null) return res.status(404).json({ error: 'Selectie niet gevonden' });
  const { rowCount } = await pool.query(
    'delete from program_selections where id = $1 and doelenboom_id = $2 and user_id = $3',
    [selectionId, req.params.id, req.user!.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Selectie niet gevonden' });
  res.status(204).end();
});
