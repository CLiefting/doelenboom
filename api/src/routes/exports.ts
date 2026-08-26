import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRoleForDoelenboomParam } from '../rbac.js';
import { fetchTree } from './tree.js';
import { isStandardColumns } from '../columnConfig.js';

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
  const body = JSON.stringify({ tree: mode === 'data' ? tree : null, columns: tree.columns, meta });
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
    return res.status(502).json({ error: 'Excel-service niet bereikbaar', detail: (err as Error).message });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return res.status(502).json({ error: 'Excel-service gaf een fout terug', detail: text });
  }

  const arrayBuffer = await upstream.arrayBuffer();
  res.setHeader('Content-Type', XLSX_MEDIA_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(arrayBuffer));
});
