import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRoleForDoelenboomParam, tenantIdForDoelenboom } from '../rbac.js';
import { logAuditEvent } from '../auditLog.js';
import { fetchTree } from './tree.js';
import { columnForTypeName, isStandardColumns } from '../columnConfig.js';
import { sendServerError } from '../errors.js';

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const exportsRouter = Router();
exportsRouter.use(requireAuth);

// GET /api/doelenbomen/:id/export?format=oud|nieuw&mode=template|data
// Vraagt excel-service om een .xlsx te bouwen en geeft die direct als download terug.
// format=oud: huidige productiestructuur. format=nieuw: het voorstel uit
// voorstel_excel_structuur_v2.md (unified Relaties-tab, opgeschoonde Referentietabel,
// dropdown-validatie). mode=template: lege 9-tabbladen-structuur. mode=data (default):
// gevuld met de huidige inhoud van deze doelenboom. We halen de boom altijd op (ook bij
// mode=template) omdat de Configuratie-tab sowieso weet moet hebben van welke
// doelenboom/tenant het bestand afkomstig is.
exportsRouter.get('/doelenbomen/:id/export', requireTenantRoleForDoelenboomParam('bezoeker', 'id'), async (req: AuthedRequest, res) => {
  const format = req.query.format === 'nieuw' ? 'nieuw' : 'oud';
  const mode = req.query.mode === 'template' ? 'template' : 'data';

  const tree = await fetchTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });

  // Het "oud" Excel-formaat hardcodeert Capability-OB/Project-Capability als
  // aparte tabbladen (zie exporter.py::_fill_oud) — dat klopt alleen nog als
  // deze doelenboom exact de 8 standaardkolommen heeft (zie
  // docs/kolommen-configuratie-ontwerp.md). Dit hier voorkomt een onnodige
  // round-trip naar excel-service (die dezelfde check ook nog een keer doet,
  // defense-in-depth voor het geval /export ooit rechtstreeks aangeroepen wordt).
  if (format === 'oud' && !isStandardColumns(tree.columns)) {
    return res.status(409).json({
      error:
        'Het "oud" Excel-formaat werkt alleen zolang de kolommen van deze doelenboom nog exact de 8 ' +
        'standaardkolommen zijn. Deze doelenboom heeft een aangepaste kolomconfiguratie — gebruik het ' +
        '"nieuw" formaat.',
    });
  }

  const exportedAt = new Date();
  const meta = {
    doelenboom: tree.doelenboom.name,
    tenant: tree.doelenboom.tenant.name,
    exportedAt: exportedAt.toISOString(),
    exportedBy: req.user?.email ?? 'onbekend',
  };

  // columns altijd apart meesturen (ook al zit 'ie ook al in tree.columns bij
  // mode=data): bij mode=template is tree null, maar excel-service heeft de
  // kolomconfiguratie alsnog nodig voor de dynamische Type-dropdown/
  // validatielijst in het 'nieuw' formaat (zie exporter.py).
  // DOEL-64: motivaties van afwijkingen horen niet in de Excel-export en gaan
  // dus ook niet naar de excel-service (undefined valt weg bij JSON.stringify).
  // DOEL-76: kenmerken in Excel zijn buiten scope (DOEL-66), dus definities en
  // waarden gaan evenmin naar de excel-service.
  const exportTree = { ...tree, controlRuleDeviations: undefined, attributes: undefined, attributeValues: undefined };
  const body = JSON.stringify({ tree: mode === 'data' ? exportTree : null, columns: tree.columns, meta });
  // Bestandsnaam: Doelenboom_<Tenant>_<Doelenboomnaam>_<JJMMDD> — tenant- en
  // doelenboomnaam gesaneerd voor gebruik in een bestandsnaam (spaties/
  // leestekens -> underscore). Bewust de leesbare naam i.p.v. de slug, zodat
  // een los rondgestuurd bestand meteen herkenbaar is.
  const sanitizeForFilename = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const safeTenant = sanitizeForFilename(tree.doelenboom.tenant.name);
  const safeDoelenboom = sanitizeForFilename(tree.doelenboom.name);
  const jjmmdd =
    String(exportedAt.getFullYear() % 100).padStart(2, '0') +
    String(exportedAt.getMonth() + 1).padStart(2, '0') +
    String(exportedAt.getDate()).padStart(2, '0');
  const filename = `Doelenboom_${safeTenant}_${safeDoelenboom}_${jjmmdd}.xlsx`;

  let upstream: Response;
  try {
    upstream = await fetch(`${EXCEL_SERVICE_URL}/export?format=${format}&mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    return sendServerError(res, err, 'Excel-service niet bereikbaar', 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return sendServerError(res, text, 'Excel-service gaf een fout terug', 502);
  }

  const arrayBuffer = await upstream.arrayBuffer();
  // DOEL-29: een export is de manier om data uit de applicatie te halen
  // (data-exfiltratie) — wie/welke boom/welk formaat komt in het auditlog.
  // Een lege sjabloon-export (mode=template) bevat geen data en wordt niet gelogd.
  if (mode === 'data') {
    await logAuditEvent({
      eventType: 'doelenboom_exported',
      userId: req.user!.id,
      tenantId: await tenantIdForDoelenboom(req.params.id),
      doelenboomId: req.params.id,
      detail: { kind: 'doelenboom-xlsx', format },
    });
  }
  res.setHeader('Content-Type', XLSX_MEDIA_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(arrayBuffer));
});

// ---- PowerPoint van de hele doelenboom (DOEL-88) -------------------------

// Zelfde grenzen als excel-service/app/tree_pptx.py (MAX_SLIDES, PER_ROW_*,
// SNOER_MAX_ROWS) en het dialoogvenster in web/public/tree.html.
export const PPTX_MAX_SLIDES = 300;
const PPTX_PER_ROW_MIN = 2;
const PPTX_PER_ROW_MAX = 6;
const PPTX_PER_ROW_DEFAULT = 4;
const PPTX_SNOER_MAX_ROWS = 4;

type PptxOptions = { visibleColumns: string[]; slideColumns: string[]; perRow: number };

// Valideert de keuzes uit het dialoogvenster tegen de kolommen van DEZE
// doelenboom: alleen bestaande kolomnamen (geen aliassen, geen vrije tekst)
// komen erdoor. Onbekende namen worden geweigerd in plaats van stil genegeerd,
// zodat een verouderd scherm (kolommen intussen gewijzigd) een duidelijke
// melding krijgt.
export function parsePptxOptions(body: unknown, columnNames: string[]): { error: string } | { options: PptxOptions } {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const known = new Set(columnNames);

  const readNames = (value: unknown, field: string): { error: string } | string[] => {
    if (!Array.isArray(value)) return { error: `${field} moet een lijst van kolomnamen zijn.` };
    if (value.length > columnNames.length) return { error: `${field} bevat meer namen dan er kolommen zijn.` };
    const out: string[] = [];
    for (const v of value) {
      if (typeof v !== 'string' || !known.has(v)) return { error: `${field} bevat een onbekende kolom.` };
      if (!out.includes(v)) out.push(v);
    }
    return out;
  };

  // visibleColumns weglaten = alle kolommen zichtbaar.
  const visible = input.visibleColumns === undefined ? [...columnNames] : readNames(input.visibleColumns, 'visibleColumns');
  if (!Array.isArray(visible)) return visible;
  if (visible.length === 0) return { error: 'Er is geen enkele zichtbare kolom om te exporteren.' };

  const slides = input.slideColumns === undefined ? [] : readNames(input.slideColumns, 'slideColumns');
  if (!Array.isArray(slides)) return slides;
  if (slides.some((name) => !visible.includes(name))) {
    return { error: 'slideColumns bevat een kolom die niet zichtbaar is.' };
  }

  let perRow = PPTX_PER_ROW_DEFAULT;
  if (input.perRow !== undefined) {
    const n = input.perRow;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < PPTX_PER_ROW_MIN || n > PPTX_PER_ROW_MAX) {
      return { error: `perRow moet een geheel getal van ${PPTX_PER_ROW_MIN} tot en met ${PPTX_PER_ROW_MAX} zijn.` };
    }
    perRow = n;
  }

  // In kolomvolgorde, zodat de volgorde in de body er niet toe doet.
  return {
    options: {
      visibleColumns: columnNames.filter((n) => visible.includes(n)),
      slideColumns: columnNames.filter((n) => slides.includes(n)),
      perRow,
    },
  };
}

// POST /api/doelenbomen/:id/export-pptx  { visibleColumns?, slideColumns?, perRow? }
// Bouwt (via excel-service /tree-pptx) een presentatie van de doelenboom: de
// kolommen als snoer en per gekozen kolom een slide per element met de keten
// van dat element. POST omdat de keuzes als JSON-body meekomen; de route
// wijzigt niets. Rechten: wie de boom mag bekijken (bezoeker), net als de
// Excel-export hierboven -- en dus ook hier geen sysadmin zonder eigen
// lidmaatschap. Kolommen die de gebruiker op het scherm verborgen heeft
// (visibleColumns) komen nergens in de presentatie voor.
exportsRouter.post('/doelenbomen/:id/export-pptx', requireTenantRoleForDoelenboomParam('bezoeker', 'id'), async (req: AuthedRequest, res) => {
  const tree = await fetchTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });

  const columnNames = tree.columns.map((c) => c.typeName);
  const parsed = parsePptxOptions(req.body, columnNames);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const { options } = parsed;

  // Aantal slides vooraf begrenzen (zelfde telling als in tree_pptx.py en het
  // dialoogvenster): snoer + per gekozen kolom een tussenslide en een slide
  // per element. Voorkomt dat één verzoek de excel-service lang bezighoudt.
  const elements = tree.elements as Array<Record<string, unknown>>;
  const perColumn = new Map<string, number>();
  for (const el of elements) {
    const column = columnForTypeName(tree.columns, String(el.type ?? ''));
    if (column) perColumn.set(column.typeName, (perColumn.get(column.typeName) ?? 0) + 1);
  }
  const snoerSlides = Math.max(1, Math.ceil(Math.ceil(options.visibleColumns.length / options.perRow) / PPTX_SNOER_MAX_ROWS));
  const slideCount = options.slideColumns.reduce((sum, name) => sum + 1 + (perColumn.get(name) ?? 0), snoerSlides);
  if (slideCount > PPTX_MAX_SLIDES) {
    return res.status(422).json({
      error:
        `Deze keuze levert ${slideCount} slides op; het maximum is ${PPTX_MAX_SLIDES}. ` +
        'Kies minder kolommen om per element uit te werken.',
    });
  }

  const exportedAt = new Date();
  // Alleen wat de presentatie toont gaat naar de excel-service: geen
  // toelichting bij relaties, geen kenmerken, geen motivaties van afwijkingen
  // en geen projectgegevens (status, producten, activiteiten).
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const data = {
    columns: tree.columns.map((c) => ({
      position: c.position,
      typeName: c.typeName,
      title: c.title,
      subtitle: c.subtitle,
      color: c.color,
      relationLabelToNext: c.relationLabelToNext,
      aliases: c.aliases,
    })),
    elements: elements.map((el) => ({
      code: str(el.code),
      type: str(el.type),
      name: str(el.name),
      description: str(el.description),
      kpi: str(el.kpi),
      taakveld: str(el.taakveld),
      subtaakveld: str(el.subtaakveld),
    })),
    edges: tree.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight })),
    tags: (tree.tags as Array<Record<string, unknown>>).map((t) => ({ code: str(t.code), name: str(t.name) })),
    elementTags: tree.elementTags,
    orgUnits: (tree.orgUnits as Array<Record<string, unknown>>).map((o) => ({ code: str(o.code), name: str(o.name) })),
    obOrg: Object.fromEntries(
      Object.entries(tree.obOrg as Record<string, Array<Record<string, unknown>>>).map(([code, rels]) => [
        code,
        rels.map((r) => ({ org: str(r.org), relatietype: str(r.relatietype) })),
      ])
    ),
  };
  const meta = {
    doelenboom: tree.doelenboom.name,
    tenant: tree.doelenboom.tenant.name,
    exportedAt: exportedAt.toISOString(),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${EXCEL_SERVICE_URL}/tree-pptx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, options, meta }),
    });
  } catch (err) {
    return sendServerError(res, err, 'Excel-service niet bereikbaar', 502);
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return sendServerError(res, text, 'Excel-service gaf een fout terug', 502);
  }
  const arrayBuffer = await upstream.arrayBuffer();

  // DOEL-29: elke export met inhoud komt in het auditlog (wie, welke boom,
  // welk formaat en welke kolommen zijn uitgewerkt).
  await logAuditEvent({
    eventType: 'doelenboom_exported',
    userId: req.user!.id,
    tenantId: await tenantIdForDoelenboom(req.params.id),
    doelenboomId: req.params.id,
    detail: { kind: 'doelenboom-pptx', format: 'pptx', slideColumns: options.slideColumns, slides: slideCount },
  });

  // Zelfde naamgeving als de Excel-export: Doelenboom_<Tenant>_<Naam>_<JJMMDD>.
  const sanitizeForFilename = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const jjmmdd =
    String(exportedAt.getFullYear() % 100).padStart(2, '0') +
    String(exportedAt.getMonth() + 1).padStart(2, '0') +
    String(exportedAt.getDate()).padStart(2, '0');
  const filename = `Doelenboom_${sanitizeForFilename(tree.doelenboom.tenant.name)}_${sanitizeForFilename(tree.doelenboom.name)}_${jjmmdd}.pptx`;
  res.setHeader('Content-Type', PPTX_MEDIA_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Binaire pptx-download: vaste Content-Type, Content-Disposition: attachment en een
  // gesaneerde bestandsnaam; geen HTML, dus geen XSS-pad (Semgrep-vals-positief, DOEL-41).
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  res.send(Buffer.from(arrayBuffer));
});
