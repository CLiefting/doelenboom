import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireTenantRoleForDoelenboomParam } from '../rbac.js';

export const treeRouter = Router();
treeRouter.use(requireAuth);

// Bouwt de complete boom in een vorm die dicht bij de datastructuren van de
// oorspronkelijke doelenboom.html ligt (DETAILS/EDGES/PROJECT_STATUS/PRODUCTS/TAGS/
// ELEMENT_TAGS/ORGS/OB_ORG), maar dan dynamisch uit de database. Wordt zowel door
// GET /:id/tree (boomweergave) als door de Excel-export (routes/exports.ts) gebruikt,
// zodat beide altijd exact dezelfde data tonen/exporteren.
export async function fetchTree(doelenboomId: string) {
  const doelenboomResult = await pool.query(
    `select d.id, d.slug, d.name, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
     from doelenbomen d join tenants t on t.id = d.tenant_id
     where d.id = $1`,
    [doelenboomId]
  );
  if (doelenboomResult.rows.length === 0) {
    return null;
  }

  const elementsResult = await pool.query(
    `select code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order
     from elements where doelenboom_id = $1 order by sort_order, code`,
    [doelenboomId]
  );

  const edgesResult = await pool.query(
    `select se.code as source_code, te.code as target_code, e.weight, e.toelichting
     from edges e
     join elements se on se.id = e.source_element_id
     join elements te on te.id = e.target_element_id
     where e.doelenboom_id = $1`,
    [doelenboomId]
  );

  const projectStatusResult = await pool.query(
    `select el.code, ps.projectstatus, ps.rag, ps.toelichting, ps.gerapporteerd_op, ps.cluster_ppt
     from project_status ps join elements el on el.id = ps.element_id
     where el.doelenboom_id = $1`,
    [doelenboomId]
  );

  const productsResult = await pool.query(
    `select el.code as element_code, p.code, p.name, p.omschrijving, p.pct_gereed,
            p.verwachte_datum, p.werkelijke_datum, p.opmerking
     from products p join elements el on el.id = p.element_id
     where el.doelenboom_id = $1
     order by p.id`,
    [doelenboomId]
  );

  const tagsResult = await pool.query(
    'select code, name, categorie, omschrijving from tags where doelenboom_id = $1 order by code',
    [doelenboomId]
  );

  const elementTagsResult = await pool.query(
    `select el.code as element_code, tg.code as tag_code, et.toelichting
     from element_tags et
     join elements el on el.id = et.element_id
     join tags tg on tg.id = et.tag_id
     where el.doelenboom_id = $1`,
    [doelenboomId]
  );

  const orgUnitsResult = await pool.query(
    'select code, name, omschrijving from org_units where doelenboom_id = $1 order by code',
    [doelenboomId]
  );

  const obOrgResult = await pool.query(
    `select el.code as element_code, ou.code as org_code, r.relatietype, r.toelichting, r.status
     from ob_org_relations r
     join elements el on el.id = r.element_id
     join org_units ou on ou.id = r.org_unit_id
     where el.doelenboom_id = $1`,
    [doelenboomId]
  );

  const projectStatus: Record<string, unknown> = {};
  for (const row of projectStatusResult.rows) {
    projectStatus[row.code] = {
      projectstatus: row.projectstatus,
      rag: row.rag,
      toelichting: row.toelichting,
      gerapporteerdOp: row.gerapporteerd_op,
      clusterPpt: row.cluster_ppt,
    };
  }

  const products: Record<string, unknown[]> = {};
  for (const row of productsResult.rows) {
    (products[row.element_code] ??= []).push({
      code: row.code,
      name: row.name,
      omschrijving: row.omschrijving,
      pctGereed: row.pct_gereed,
      verwachteDatum: row.verwachte_datum,
      werkelijkeDatum: row.werkelijke_datum,
      opmerking: row.opmerking,
    });
  }

  const elementTags: Record<string, string[]> = {};
  for (const row of elementTagsResult.rows) {
    (elementTags[row.element_code] ??= []).push(row.tag_code);
  }

  const obOrg: Record<string, unknown[]> = {};
  for (const row of obOrgResult.rows) {
    (obOrg[row.element_code] ??= []).push({
      org: row.org_code,
      relatietype: row.relatietype,
      toelichting: row.toelichting,
      status: row.status,
    });
  }

  return {
    doelenboom: {
      id: doelenboomResult.rows[0].id,
      slug: doelenboomResult.rows[0].slug,
      name: doelenboomResult.rows[0].name,
      tenant: {
        id: doelenboomResult.rows[0].tenant_id,
        slug: doelenboomResult.rows[0].tenant_slug,
        name: doelenboomResult.rows[0].tenant_name,
      },
    },
    elements: elementsResult.rows,
    edges: edgesResult.rows.map((r) => ({
      source: r.source_code,
      target: r.target_code,
      weight: r.weight,
      toelichting: r.toelichting,
    })),
    projectStatus,
    products,
    tags: tagsResult.rows,
    elementTags,
    orgUnits: orgUnitsResult.rows,
    obOrg,
  };
}

// GET /api/doelenbomen/:id/tree
treeRouter.get('/:id/tree', requireTenantRoleForDoelenboomParam('gebruiker', 'id'), async (req, res) => {
  const tree = await fetchTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });
  res.json(tree);
});
