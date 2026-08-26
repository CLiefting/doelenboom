import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRoleForDoelenboomParam, getEffectiveRoleForDoelenboom } from '../rbac.js';
import { getColumnsForDoelenboom } from '../columnConfig.js';
import { getActiveModuleKeys, isLicenseExpired } from '../license.js';

export const treeRouter = Router();
treeRouter.use(requireAuth);

// Bouwt de complete boom in een vorm die dicht bij de datastructuren van de
// oorspronkelijke doelenboom.html ligt (DETAILS/EDGES/PROJECT_STATUS/PRODUCTS/
// ACTIVITIES/TAGS/ELEMENT_TAGS/ORGS/OB_ORG), maar dan dynamisch uit de database. Wordt zowel door
// GET /:id/tree (boomweergave) als door de Excel-export (routes/exports.ts) gebruikt,
// zodat beide altijd exact dezelfde data tonen/exporteren.
export async function fetchTree(doelenboomId: string) {
  const doelenboomResult = await pool.query(
    `select d.id, d.slug, d.name, d.read_only, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
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
    `select el.code as element_code, p.id, p.code, p.name, p.type, p.omschrijving, p.pct_gereed,
            p.verwachte_datum, p.werkelijke_datum, p.opmerking
     from products p join elements el on el.id = p.element_id
     where el.doelenboom_id = $1
     order by p.id`,
    [doelenboomId]
  );

  const activitiesResult = await pool.query(
    `select el.code as element_code, a.id, a.name, a.start_date, a.end_date, a.omschrijving, a.mpp_uid, a.is_milestone
     from activities a join elements el on el.id = a.element_id
     where el.doelenboom_id = $1
     order by a.start_date, a.id`,
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
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      omschrijving: row.omschrijving,
      pctGereed: row.pct_gereed,
      verwachteDatum: row.verwachte_datum,
      werkelijkeDatum: row.werkelijke_datum,
      opmerking: row.opmerking,
    });
  }

  const activities: Record<string, unknown[]> = {};
  for (const row of activitiesResult.rows) {
    (activities[row.element_code] ??= []).push({
      id: row.id,
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
      omschrijving: row.omschrijving,
      // Alleen gezet voor via MS Project geïmporteerde activiteiten — zie
      // computeMppImportPlan (tree.html) en het kolomcommentaar in db/init.sql.
      mppUid: row.mpp_uid,
      isMilestone: row.is_milestone,
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

  const columns = await getColumnsForDoelenboom(doelenboomId);

  // Licentiegating van de "Projecten"-module (status/RAG/producten/planning
  // — zie doelenboom_licentiemodel.md §3): zonder de module levert dit hier
  // gewoon lege objecten op, i.p.v. dat de frontend zelf per veld moet
  // filteren. Eén enforcement-punt dat automatisch ook de Excel-export dekt
  // (routes/exports.ts roept fetchTree() rechtstreeks aan). De Project-node
  // zelf (elements/edges) blijft altijd intact — alleen de verdiepende laag
  // wordt hier weggelaten. activeModules gaat wél altijd mee, ook leeg, zodat
  // de frontend (tree.html) daarop de "+ Product"/"Bewerken"-knoppen kan
  // verbergen i.p.v. tonen-maar-laten-mislukken (zie ook requireModule in
  // routes/products.ts / routes/projectStatus.ts voor de schrijfkant).
  const activeModules = await getActiveModuleKeys(doelenboomResult.rows[0].tenant_id);
  const projectenActive = activeModules.includes('projecten');
  // Licentie-einddatum (zie license.ts isLicenseExpired,
  // doelenboom_licentiemodel.md) — gaat mee zodat tree.html een watermerk kan
  // tonen ("Licentie verlopen voor {tenant}") en de writability van de
  // ingelogde gebruiker er hieronder al rekening mee houdt.
  const licenseExpired = await isLicenseExpired(doelenboomResult.rows[0].tenant_id);

  return {
    columns,
    doelenboom: {
      id: doelenboomResult.rows[0].id,
      slug: doelenboomResult.rows[0].slug,
      name: doelenboomResult.rows[0].name,
      readOnly: doelenboomResult.rows[0].read_only,
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
    projectStatus: projectenActive ? projectStatus : {},
    products: projectenActive ? products : {},
    activities: projectenActive ? activities : {},
    tags: tagsResult.rows,
    elementTags,
    orgUnits: orgUnitsResult.rows,
    obOrg,
    activeModules,
    licenseExpired,
  };
}

// GET /api/doelenbomen/:id/tree — geeft naast de boom ook de effectieve rol en
// schrijfbaarheid van de ingelogde gebruiker mee, zodat de frontend niet zelf
// (met kans op afwijkende logica) hoeft te herleiden uit tenantRoles + read_only
// + een eventuele per-doelenboom rol-override (zie getEffectiveRoleForDoelenboom).
// minRole='bezoeker' hier, GEEN sysadmin-bypass (zie rbac.ts rolmodel-comment):
// lezen mag iedereen die zelf lid is van de tenant, ook de laagste rol — een
// sysadmin zonder eigen koppeling komt hier dus nooit binnen (403 via de
// middleware, privacy). De rol zelf (effectiveRole/canWrite/canWriteContent
// hieronder) bepaalt vervolgens wat de frontend aan schrijf-UI toont.
treeRouter.get('/:id/tree', requireTenantRoleForDoelenboomParam('bezoeker', 'id'), async (req: AuthedRequest, res) => {
  const tree = await fetchTree(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Doelenboom niet gevonden' });

  // De middleware hierboven garandeert al een niet-lege effectieve rol (anders
  // was de request al met 403 afgekapt) — de ?? 'bezoeker' hier is puur voor
  // TypeScript, geen echte fallback in de praktijk.
  const effectiveRole = (await getEffectiveRoleForDoelenboom(req.user!.id, req.params.id)) ?? 'bezoeker';
  // "Geblokkeerd": read-only-vlag of verlopen licentie zet iedereen terug naar
  // puur lezen, ongeacht effectiveRole (zie ook requireWritableDoelenboom in
  // rbac.ts, dezelfde regel server-side) — geen uitzondering meer voor
  // sysadmin, die moet net als ieder ander via de instellingen-route read-only
  // uitzetten.
  const blocked = tree.doelenboom.readOnly || tree.licenseExpired;
  // canWrite: mag de "instellingen"-laag (kolommen, doelenboom-instellingen,
  // Excel-import, tag-/org-catalogus) wijzigen — ongewijzigde betekenis t.o.v.
  // vóór de bezoeker-rol, puur admin.
  const canWrite = effectiveRole === 'admin' && !blocked;
  // canWriteContent: mag de "losse boom-inhoud" wijzigen (elementen, relaties,
  // tags/org-koppelingen op een element, projectstatus/producten) — nieuw,
  // ook waar voor de rol 'gebruiker'. Elke canWrite-gebruiker kan ook dit.
  const canWriteContent = (effectiveRole === 'admin' || effectiveRole === 'gebruiker') && !blocked;

  res.json({ ...tree, doelenboom: { ...tree.doelenboom, effectiveRole, canWrite, canWriteContent } });
});
