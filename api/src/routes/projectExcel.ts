import { Router } from 'express';
import multer from 'multer';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRoleForDoelenboomParam, requireWritableDoelenboom, requireModule } from '../rbac.js';
import { fetchTree } from './tree.js';

// Export/import van de VOLLEDIGE gegevens van één project (Producten,
// Activiteiten, projectstatus, tags en organisatieonderdelen) als Excel-
// bestand — zie excel-service/app/project_workbook.py voor het tabbladformaat.
// Dit is een ander, veel kleiner formaat dan de hele-doelenboom export/import
// in routes/exports.ts/routes/imports.ts: dit gaat over precies één project
// (bv. "Sweepen"), niet over de hele boom, en werkt puur additief/diff-based
// (nooit een volledige vervanging zoals imports.ts::/imports/:id/publish).
//
// Deze router doet zelf GEEN create/update/delete in de database — export
// leest alleen (via fetchTree, dezelfde bron als de boomweergave en de
// hele-doelenboom-export), en de import-parse-route hieronder geeft alleen de
// rauwe, geparste rijen terug. Het "wijzigingsoverzicht" (welke producten/
// activiteiten nieuw/gewijzigd/te verwijderen zijn, en welke afhankelijkheden
// erbij/eraf moeten) wordt client-side bepaald (tree.html:
// computeProjectImportPlan) tegen de al geladen PRODUCTS/ACTIVITIES/
// PROJECT_STATUS van dit project — en pas ná bevestiging door de gebruiker
// toegepast via de al bestaande, los te gebruiken CRUD-routes (products.ts/
// activities.ts/projectStatus.ts/tags.ts/orgUnits.ts), rij voor rij, exact
// zoals de bestaande MS Project-import (activities.ts) dat al doet.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Lezen mag iedereen die toegang heeft tot de doelenboom (bezoeker); uploaden
// (een stap richting schrijven, ook al schrijft déze route zelf niets) vereist
// dezelfde editor-rol als de routes die de import straks daadwerkelijk
// toepassen (products.ts/activities.ts: requireWritableDoelenboom('id', 'gebruiker')).
const requireViewer = requireTenantRoleForDoelenboomParam('bezoeker', 'id');
const requireEditor = requireWritableDoelenboom('id', 'gebruiker');
const requireProjectenModule = requireModule('projecten', 'id');

export const projectExcelRouter = Router();
projectExcelRouter.use(requireAuth);

type FetchedTree = NonNullable<Awaited<ReturnType<typeof fetchTree>>>;

// Filtert de al opgehaalde volledige boom (fetchTree) terug tot de gegevens
// van precies één project-element — geen aparte DB-queries nodig, dezelfde
// aanpak als exports.ts voor de hele-doelenboom-export.
function buildProjectExportData(tree: FetchedTree, code: string) {
  const el = (tree.elements as Array<Record<string, unknown>>).find((e) => e.code === code);
  if (!el) return null;

  const tagCodes = (tree.elementTags as Record<string, string[]>)[code] || [];
  const tagsByCode = new Map(
    (tree.tags as Array<{ code: string; name: string }>).map((t) => [t.code, t.name])
  );
  const tagNames = tagCodes.map((tc) => tagsByCode.get(tc)).filter((n): n is string => !!n);

  const orgUnitsByCode = new Map(
    (tree.orgUnits as Array<{ code: string; name: string }>).map((o) => [o.code, o.name])
  );
  const orgRels = ((tree.obOrg as Record<string, Array<{ org: string; relatietype: string }>>)[code] || []).map(
    (r) => ({ name: orgUnitsByCode.get(r.org) || r.org, relatietype: r.relatietype })
  );

  return {
    project: {
      code: el.code,
      name: el.name,
      description: el.description,
      status: (tree.projectStatus as Record<string, unknown>)[code] || null,
      tags: tagNames,
      orgs: orgRels,
    },
    products: (tree.products as Record<string, unknown[]>)[code] || [],
    productDependencies: (tree.productDependencies as Record<string, unknown[]>)[code] || [],
    activities: (tree.activities as Record<string, unknown[]>)[code] || [],
    activityDependencies: (tree.dependencies as Record<string, unknown[]>)[code] || [],
  };
}

const sanitizeForFilename = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Gedeeld door de project-export- (.xlsx) en project-pptx-route (.pptx)
// hieronder: beide bouwen dezelfde 'data' (buildProjectExportData) + 'meta',
// posten die naar een excel-service-endpoint, en sturen het resultaat terug
// als download — alleen het upstream-pad/mediatype/extensie verschilt.
async function downloadProjectDocument(
  req: AuthedRequest,
  res: import('express').Response,
  opts: { upstreamPath: string; mediaType: string; extension: string }
): Promise<void> {
  const tree = await fetchTree(req.params.id);
  if (!tree) return void res.status(404).json({ error: 'Doelenboom niet gevonden' });

  const data = buildProjectExportData(tree, req.params.code);
  if (!data) return void res.status(404).json({ error: 'Project niet gevonden' });

  const exportedAt = new Date();
  const meta = {
    doelenboom: tree.doelenboom.name,
    tenant: tree.doelenboom.tenant.name,
    exportedAt: exportedAt.toISOString(),
    exportedBy: req.user?.email ?? 'onbekend',
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${EXCEL_SERVICE_URL}${opts.upstreamPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, meta }),
    });
  } catch (err) {
    return void res.status(502).json({ error: 'Excel-service niet bereikbaar', detail: (err as Error).message });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return void res.status(502).json({ error: 'Excel-service gaf een fout terug', detail: text });
  }

  const arrayBuffer = await upstream.arrayBuffer();
  // Bestandsnaam: code + titel (projectnaam) + datum, bv.
  // "Project_NP37_Sweepen_2026-08-27.xlsx" — leesbaar in Downloads/e-mail,
  // in tegenstelling tot de eerdere kale "Project_NP37_260827.xlsx".
  const isoDate =
    String(exportedAt.getFullYear()) + '-' +
    String(exportedAt.getMonth() + 1).padStart(2, '0') + '-' +
    String(exportedAt.getDate()).padStart(2, '0');
  const titlePart = sanitizeForFilename(String(data.project.name || ''));
  const filename = `Project_${sanitizeForFilename(req.params.code)}` +
    (titlePart ? `_${titlePart}` : '') + `_${isoDate}.${opts.extension}`;
  res.setHeader('Content-Type', opts.mediaType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(arrayBuffer));
}

projectExcelRouter.get(
  '/doelenbomen/:id/elements/:code/project-export',
  requireViewer,
  requireProjectenModule,
  async (req: AuthedRequest, res) => {
    await downloadProjectDocument(req, res, {
      upstreamPath: '/project-export', mediaType: XLSX_MEDIA_TYPE, extension: 'xlsx',
    });
  }
);

// PowerPoint-rapportage van één project (status/RAG, voortgang/deliverables,
// activiteiten, aandachtspunten) — zie excel-service/app/project_pptx.py
// voor de opmaak van de 4 slides. Puur export, geen import (in tegenstelling
// tot project-export hierboven): dit is een kant-en-klaar eindresultaat voor
// buiten de applicatie (bv. een klant/stakeholder), geen brondocument.
projectExcelRouter.get(
  '/doelenbomen/:id/elements/:code/project-pptx',
  requireViewer,
  requireProjectenModule,
  async (req: AuthedRequest, res) => {
    await downloadProjectDocument(req, res, {
      upstreamPath: '/project-pptx', mediaType: PPTX_MEDIA_TYPE, extension: 'pptx',
    });
  }
);

projectExcelRouter.post(
  '/doelenbomen/:id/elements/:code/project-import-parse',
  requireEditor,
  requireProjectenModule,
  upload.single('file'),
  async (req: AuthedRequest, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Geen bestand meegestuurd (veld "file")' });
    }

    const form = new FormData();
    const arrayBuffer = new ArrayBuffer(req.file.buffer.byteLength);
    new Uint8Array(arrayBuffer).set(req.file.buffer);
    form.append('file', new Blob([arrayBuffer]), req.file.originalname);

    let upstream: Response;
    try {
      upstream = await fetch(`${EXCEL_SERVICE_URL}/project-parse`, { method: 'POST', body: form });
    } catch (err) {
      return res.status(502).json({ error: 'Excel-service niet bereikbaar', detail: (err as Error).message });
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(502).json({ error: 'Excel-service gaf een fout terug', detail: text });
    }

    const result = await upstream.json();
    res.json(result);
  }
);
