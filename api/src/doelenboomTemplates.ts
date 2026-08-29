import { PoolClient } from 'pg';
import { pool } from './db.js';
import { insertColumns, ColumnDef } from './columnConfig.js';

// Doelenboom-sjablonen: zie db/migrations/0014_doelenboom_templates.sql voor
// het datamodel-ontwerp. Dit bestand bundelt alle databasetoegang tot
// doelenboom_templates, gebruikt door routes/doelenboomTemplates.ts (lijst
// opvragen / opslaan / verwijderen) en routes/doelenbomen.ts (toepassen bij
// het aanmaken van een nieuwe doelenboom).

export interface DoelenboomTemplateSummary {
  id: number;
  tenantId: number | null;
  name: string;
  description: string;
  createdAt: string;
}

const TEMPLATE_SUMMARY_FIELDS =
  'id, tenant_id as "tenantId", name, description, created_at as "createdAt"';

// De vorm van de drie JSONB-snapshotvelden — zie de tabeltoelichting in de
// migratie. columns_snapshot volgt exact ColumnDef (minus id/originele
// column_config_id); elements/edges verwijzen naar elkaar via "code" i.p.v.
// database-id's, zodat een snapshot zelfstandig herbruikbaar is.
type ColumnSnapshot = Omit<ColumnDef, 'id'>;
interface ElementSnapshot {
  code: string;
  type: string;
  name: string;
  description: string;
  parentText: string;
  kpi: string;
  taakveld: string;
  subtaakveld: string;
  sortOrder: number;
}
interface EdgeSnapshot {
  sourceCode: string;
  targetCode: string;
  weight: string | null;
  toelichting: string;
}

// Sjablonen die een tenant mag zien/gebruiken: systeembreed (tenant_id is
// null) + de eigen sjablonen van die tenant. Systeembreed eerst (nulls
// first), dan op naam — zodat "Batenboom" en andere systeembrede sjablonen
// bovenaan de kiezer staan.
export async function listTemplatesForTenant(tenantId: number): Promise<DoelenboomTemplateSummary[]> {
  const result = await pool.query(
    `select ${TEMPLATE_SUMMARY_FIELDS} from doelenboom_templates
     where tenant_id is null or tenant_id = $1
     order by tenant_id nulls first, name`,
    [tenantId]
  );
  return result.rows;
}

// "Opslaan als sjabloon" — snapshot van de huidige kolommen + elementen +
// relaties van een bestaande doelenboom, als nieuw, los sjabloon. Geen
// project_status/producten/tags/organisatieonderdelen: sjablonen zijn puur
// de structurele boom-opzet (kolommen + voorbeeldpad), geen echte
// boominhoud — zie het gesprek waarin dit is afgesproken.
export async function saveDoelenboomAsTemplate(
  doelenboomId: number,
  opts: { name: string; description: string; tenantId: number | null }
): Promise<DoelenboomTemplateSummary> {
  const columnsResult = await pool.query(
    `select position, type_name as "typeName", title, subtitle, color, is_narrow as "isNarrow",
            node_font_size as "nodeFontSize", is_project_role as "isProjectRole",
            relation_label_to_next as "relationLabelToNext"
     from columns
     where column_config_id = (select id from column_configs where scope = 'doelenboom' and doelenboom_id = $1)
     order by position`,
    [doelenboomId]
  );

  const elementsResult = await pool.query(
    `select code, type, name, description, parent_text as "parentText", kpi, taakveld, subtaakveld,
            sort_order as "sortOrder"
     from elements where doelenboom_id = $1 order by sort_order, id`,
    [doelenboomId]
  );

  const edgesResult = await pool.query(
    `select src.code as "sourceCode", tgt.code as "targetCode", e.weight, e.toelichting
     from edges e
     join elements src on src.id = e.source_element_id
     join elements tgt on tgt.id = e.target_element_id
     where e.doelenboom_id = $1`,
    [doelenboomId]
  );

  const result = await pool.query(
    `insert into doelenboom_templates (tenant_id, name, description, columns_snapshot, elements_snapshot, edges_snapshot)
     values ($1,$2,$3,$4,$5,$6) returning ${TEMPLATE_SUMMARY_FIELDS}`,
    [
      opts.tenantId,
      opts.name,
      opts.description,
      JSON.stringify(columnsResult.rows),
      JSON.stringify(elementsResult.rows),
      JSON.stringify(edgesResult.rows),
    ]
  );
  return result.rows[0];
}

// Sjabloon toepassen op een net aangemaakte, nog lege doelenboom — binnen
// dezelfde transactie als het aanmaken zelf (zie routes/doelenbomen.ts POST
// /tenants/:tenantId/doelenbomen), dus vóór er iets anders in kan staan.
// Geeft false terug als het sjabloon niet bestaat of niet zichtbaar is voor
// deze tenant (niet systeembreed, en niet van déze tenant) — de aanroeper
// rolt dan de hele transactie terug.
export async function applyTemplateToNewDoelenboom(
  client: PoolClient,
  templateId: number,
  tenantId: number,
  doelenboomId: number
): Promise<boolean> {
  const tmpl = await client.query(
    `select columns_snapshot, elements_snapshot, edges_snapshot from doelenboom_templates
     where id = $1 and (tenant_id is null or tenant_id = $2)`,
    [templateId, tenantId]
  );
  if (!tmpl.rows[0]) return false;

  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', $1, $2) returning id`,
    [tenantId, doelenboomId]
  );
  const columns = tmpl.rows[0].columns_snapshot as ColumnSnapshot[];
  await insertColumns(client, cfg.rows[0].id, columns);

  const elements = tmpl.rows[0].elements_snapshot as ElementSnapshot[];
  const codeToId = new Map<string, number>();
  for (const el of elements) {
    const r = await client.query(
      `insert into elements
         (doelenboom_id, code, type, name, description, parent_text, kpi, taakveld, subtaakveld, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        doelenboomId, el.code, el.type, el.name, el.description ?? '',
        el.parentText ?? '', el.kpi ?? '', el.taakveld ?? '', el.subtaakveld ?? '', el.sortOrder ?? 0,
      ]
    );
    codeToId.set(el.code, r.rows[0].id);
  }

  const edges = tmpl.rows[0].edges_snapshot as EdgeSnapshot[];
  for (const e of edges) {
    const sourceId = codeToId.get(e.sourceCode);
    const targetId = codeToId.get(e.targetCode);
    if (!sourceId || !targetId) continue; // defensief; kan niet voorkomen bij een via saveDoelenboomAsTemplate gemaakt sjabloon
    await client.query(
      `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting)
       values ($1,$2,$3,$4,$5)`,
      [doelenboomId, sourceId, targetId, e.weight, e.toelichting ?? '']
    );
  }

  return true;
}

// Voor de verwijder-route (routes/doelenboomTemplates.ts): tenant_id van het
// sjabloon zelf, om te bepalen of dit een systeembreed (null) of
// tenant-eigen sjabloon is — bepaalt daar wie het mag verwijderen.
export async function getTemplateTenantId(templateId: number): Promise<{ found: boolean; tenantId: number | null }> {
  const result = await pool.query('select tenant_id from doelenboom_templates where id = $1', [templateId]);
  if (!result.rows[0]) return { found: false, tenantId: null };
  return { found: true, tenantId: result.rows[0].tenant_id };
}

export async function deleteTemplateById(templateId: number): Promise<boolean> {
  const result = await pool.query('delete from doelenboom_templates where id = $1', [templateId]);
  return (result.rowCount ?? 0) > 0;
}
