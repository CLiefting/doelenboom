import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import {
  requireTenantRole,
  requireTenantRoleForDoelenboomParam,
  requireWritableDoelenboom,
  tenantIdForDoelenboom,
} from '../rbac.js';
import { getColumnsForDoelenboom } from '../columnConfig.js';

// Voor routes met :id = import-id (niet doelenboom-id): eerst de doelenboom van
// deze import opzoeken, dan pas de tenant daarvan.
async function doelenboomIdForImport(importId: string): Promise<number | null> {
  const result = await pool.query('select doelenboom_id from excel_imports where id = $1', [importId]);
  return result.rows[0]?.doelenboom_id ?? null;
}

async function tenantIdForImport(importId: string): Promise<number | null> {
  const doelenboomId = await doelenboomIdForImport(importId);
  return doelenboomId == null ? null : tenantIdForDoelenboom(doelenboomId);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';

export const importsRouter = Router();
importsRouter.use(requireAuth);

// Upload + parse + valideer. Schrijft NIETS naar elements/edges e.d. — dat gebeurt
// pas expliciet via POST /api/imports/:id/publish, zodat er altijd een menselijke
// bevestiging tussen "geïmporteerd" en "live in de boom" zit (zie architectuurdoc §4).
importsRouter.post(
  '/doelenbomen/:doelenboomId/imports',
  requireWritableDoelenboom('doelenboomId'),
  upload.single('file'),
  async (req: AuthedRequest, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Geen bestand meegestuurd (veld "file")' });
    }

    const form = new FormData();
    const arrayBuffer = new ArrayBuffer(req.file.buffer.byteLength);
    new Uint8Array(arrayBuffer).set(req.file.buffer);
    form.append('file', new Blob([arrayBuffer]), req.file.originalname);

    // De geldige Type-waarden voor déze doelenboom (zie
    // docs/kolommen-configuratie-ontwerp.md) — zonder dit zou excel-service
    // terugvallen op de vaste 8 standaardtypes en elementen met een eigen,
    // niet-standaard type altijd als "onbekend Type-label" overslaan.
    const validTypes = (await getColumnsForDoelenboom(req.params.doelenboomId)).map((c) => c.typeName);
    const parseQuery = validTypes.map((t) => `valid_types=${encodeURIComponent(t)}`).join('&');

    let parseResult: { status: string; report: unknown; parsed: unknown };
    try {
      const upstream = await fetch(`${EXCEL_SERVICE_URL}/parse?${parseQuery}`, { method: 'POST', body: form });
      if (!upstream.ok) {
        const text = await upstream.text();
        return res.status(502).json({ error: 'Excel-service gaf een fout terug', detail: text });
      }
      parseResult = (await upstream.json()) as typeof parseResult;
    } catch (err) {
      return res.status(502).json({ error: 'Excel-service niet bereikbaar', detail: (err as Error).message });
    }

    const insertResult = await pool.query(
      `insert into excel_imports (doelenboom_id, uploaded_by, filename, status, report_json, parsed_json)
       values ($1, $2, $3, $4, $5, $6)
       returning id, filename, uploaded_at, status, report_json`,
      [
        req.params.doelenboomId,
        req.user!.id,
        req.file.originalname,
        parseResult.status,
        JSON.stringify(parseResult.report),
        JSON.stringify(parseResult.parsed),
      ]
    );

    res.status(201).json(insertResult.rows[0]);
  }
);

importsRouter.get(
  '/doelenbomen/:doelenboomId/imports',
  requireTenantRoleForDoelenboomParam('gebruiker', 'doelenboomId'),
  async (req, res) => {
  const result = await pool.query(
    `select id, filename, uploaded_at, status, published_at
     from excel_imports where doelenboom_id = $1 order by uploaded_at desc`,
    [req.params.doelenboomId]
  );
  res.json(result.rows);
});

importsRouter.get(
  '/imports/:id',
  requireTenantRole('gebruiker', (req) => tenantIdForImport(req.params.id)),
  async (req, res) => {
    const result = await pool.query(
      `select id, doelenboom_id, filename, uploaded_at, status, report_json, published_at
       from excel_imports where id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(result.rows[0]);
  }
);

// Zet de geparste data van een import daadwerkelijk in elements/edges/etc. — een
// volledige vervanging van de inhoud van deze doelenboom, dezelfde aanpak als
// tijdens dit project handmatig is gehanteerd bij elke nieuwe Excel-versie.
importsRouter.post(
  '/imports/:id/publish',
  requireWritableDoelenboom((req) => doelenboomIdForImport(req.params.id)),
  async (req, res) => {
  const importRow = await pool.query(
    'select id, doelenboom_id, status, parsed_json, published_at from excel_imports where id = $1',
    [req.params.id]
  );
  const imp = importRow.rows[0];
  if (!imp) return res.status(404).json({ error: 'Niet gevonden' });
  if (imp.published_at) return res.status(409).json({ error: 'Deze import is al gepubliceerd' });
  if (imp.status === 'failed') {
    return res.status(400).json({ error: 'Deze import is mislukt en kan niet gepubliceerd worden' });
  }

  const parsed = imp.parsed_json as {
    elements: Array<{
      code: string; type: string; name: string; description: string;
      parentText: string; kpi: string; taakveld: string; subtaakveld: string; sortOrder: number;
    }>;
    edges: Array<{ source: string; target: string; weight: string | null; toelichting: string }>;
    projectStatus: Record<string, { projectstatus: string; rag: string; toelichting: string; gerapporteerdOp: string | null; clusterPpt?: string }>;
    products: Record<string, Array<{ code: string; name: string; type?: string; omschrijving: string; pctGereed: number; verwachteDatum: string | null; werkelijkeDatum: string | null; opmerking: string }>>;
    tags: Array<{ code: string; name: string; categorie: string; omschrijving: string }>;
    elementTags: Record<string, string[]>;
    orgUnits: Array<{ code: string; name: string; omschrijving: string }>;
    obOrg: Record<string, Array<{ org: string; relatietype: string; toelichting: string; status: string }>>;
  };

  const client = await pool.connect();
  try {
    await client.query('begin');
    const doelenboomId = imp.doelenboom_id;

    // Volledige vervanging: eerst alles weg wat aan deze doelenboom hangt.
    await client.query('delete from elements where doelenboom_id = $1', [doelenboomId]); // cascade → edges/project_status/products/element_tags/ob_org_relations
    await client.query('delete from tags where doelenboom_id = $1', [doelenboomId]); // cascade → element_tags
    await client.query('delete from org_units where doelenboom_id = $1', [doelenboomId]); // cascade → ob_org_relations

    const elementIdByCode = new Map<string, number>();
    for (const el of parsed.elements) {
      const r = await client.query(
        `insert into elements (doelenboom_id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [doelenboomId, el.code, el.type, el.name, el.description ?? '', el.parentText ?? '', el.kpi ?? '', el.taakveld ?? '', el.subtaakveld ?? '', el.sortOrder ?? 0]
      );
      elementIdByCode.set(el.code, r.rows[0].id);
    }

    for (const e of parsed.edges) {
      const sourceId = elementIdByCode.get(e.source);
      const targetId = elementIdByCode.get(e.target);
      if (!sourceId || !targetId) continue; // defensief: excel-service filtert dit al, maar niet vertrouwen
      await client.query(
        `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
         values ($1,$2,$3,$4,$5) on conflict (source_element_id, target_element_id) do nothing`,
        [doelenboomId, sourceId, targetId, e.weight, e.toelichting ?? '']
      );
    }

    for (const [code, ps] of Object.entries(parsed.projectStatus ?? {})) {
      const elementId = elementIdByCode.get(code);
      if (!elementId) continue;
      await client.query(
        `insert into project_status (element_id, projectstatus, rag, toelichting, gerapporteerd_op, cluster_ppt)
         values ($1,$2,$3,$4,$5,$6)`,
        [elementId, ps.projectstatus ?? '', ps.rag ?? '', ps.toelichting ?? '', ps.gerapporteerdOp || null, ps.clusterPpt ?? '']
      );
    }

    for (const [code, prods] of Object.entries(parsed.products ?? {})) {
      const elementId = elementIdByCode.get(code);
      if (!elementId) continue;
      for (const p of prods) {
        await client.query(
          `insert into products (element_id, code, name, type, omschrijving, pct_gereed, verwachte_datum, werkelijke_datum, opmerking)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [elementId, p.code ?? '', p.name, p.type ?? 'deliverable', p.omschrijving ?? '', p.pctGereed ?? 0, p.verwachteDatum || null, p.werkelijkeDatum || null, p.opmerking ?? '']
        );
      }
    }

    const tagIdByCode = new Map<string, number>();
    for (const t of parsed.tags ?? []) {
      const r = await client.query(
        `insert into tags (doelenboom_id, code, name, categorie, omschrijving) values ($1,$2,$3,$4,$5) returning id`,
        [doelenboomId, t.code, t.name, t.categorie ?? '', t.omschrijving ?? '']
      );
      tagIdByCode.set(t.code, r.rows[0].id);
    }

    for (const [code, tagCodes] of Object.entries(parsed.elementTags ?? {})) {
      const elementId = elementIdByCode.get(code);
      if (!elementId) continue;
      for (const tagCode of tagCodes) {
        const tagId = tagIdByCode.get(tagCode);
        if (!tagId) continue;
        await client.query(
          'insert into element_tags (element_id, tag_id) values ($1,$2) on conflict do nothing',
          [elementId, tagId]
        );
      }
    }

    const orgIdByCode = new Map<string, number>();
    for (const o of parsed.orgUnits ?? []) {
      const r = await client.query(
        `insert into org_units (doelenboom_id, code, name, omschrijving) values ($1,$2,$3,$4) returning id`,
        [doelenboomId, o.code, o.name, o.omschrijving ?? '']
      );
      orgIdByCode.set(o.code, r.rows[0].id);
    }

    for (const [code, rels] of Object.entries(parsed.obOrg ?? {})) {
      const elementId = elementIdByCode.get(code);
      if (!elementId) continue;
      for (const rel of rels) {
        const orgId = orgIdByCode.get(rel.org);
        if (!orgId) continue;
        await client.query(
          `insert into ob_org_relations (element_id, org_unit_id, relatietype, toelichting, status)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
          [elementId, orgId, rel.relatietype, rel.toelichting ?? '', rel.status || 'Concept']
        );
      }
    }

    await client.query(
      `update excel_imports set status = 'published', published_at = now() where id = $1`,
      [req.params.id]
    );

    await client.query('commit');
    res.json({ status: 'published', elementCount: parsed.elements.length, edgeCount: parsed.edges.length });
  } catch (err) {
    await client.query('rollback');
    res.status(500).json({ error: 'Publiceren mislukt', detail: (err as Error).message });
  } finally {
    client.release();
  }
});
