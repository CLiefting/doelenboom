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

projectExcelRouter.get(
  '/doelenbomen/:id/elements/:code/project-export',
  requireViewer,
  requireProjectenModule,
  async (req: AuthedRequest, res) => {
    const tree = await fetchTree(req.params.id);
    if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });

    const data = buildProjectExportData(tree, req.params.code);
    if (!data) return res.status(404).json({ error: 'Project niet gevonden' });

    const exportedAt = new Date();
    const meta = {
      doelenboom: tree.doelenboom.name,
      tenant: tree.doelenboom.tenant.name,
      exportedAt: exportedAt.toISOString(),
      exportedBy: req.user?.email ?? 'onbekend',
    };

    let upstream: Response;
    try {
      upstream = await fetch(`${EXCEL_SERVICE_URL}/project-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, meta }),
      });
    } catch (err) {
      return res.status(502).json({ error: 'Excel-service niet bereikbaar', detail: (err as Error).message });
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(502).json({ error: 'Excel-service gaf een fout terug', detail: text });
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const jjmmdd =
      String(exportedAt.getFullYear() % 100).padStart(2, '0') +
      String(exportedAt.getMonth() + 1).padStart(2, '0') +
      String(exportedAt.getDate()).padStart(2, '0');
    const filename = `Project_${sanitizeForFilename(req.params.code)}_${jjmmdd}.xlsx`;
    res.setHeader('Content-Type', XLSX_MEDIA_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(arrayBuffer));
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
