import { PoolClient } from 'pg';
import { pool } from './db.js';
import { insertColumns, validateColumnsInput, ColumnDef, allValidTypeNames } from './columnConfig.js';
import {
  ControlRule, brokenRulesByAttributesMessage, brokenRulesMessage, findRulesBrokenByAttributes, findRulesBrokenByColumns,
  rulesFromDb, validateControlRulesInput,
} from './controlRules.js';
import {
  AttributeDef, attributesFromDb, brokenAttributesMessage, findAttributesBrokenByColumns, validateAttributeDefsInput,
} from './elementAttributes.js';

// Doelenboom-sjablonen: zie db/migrations/0014_doelenboom_templates.sql voor
// het datamodel-ontwerp. Dit bestand bundelt alle databasetoegang tot
// doelenboom_templates, gebruikt door routes/doelenboomTemplates.ts (lijst
// opvragen / opslaan / bewerken / verwijderen) en routes/doelenbomen.ts
// (toepassen bij het aanmaken van een nieuwe doelenboom).

export interface DoelenboomTemplateSummary {
  id: number;
  tenantId: number | null;
  name: string;
  description: string;
  createdAt: string;
}

export interface DoelenboomTemplateSummaryWithTenant extends DoelenboomTemplateSummary {
  tenantName: string | null;
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

// Sjablonen die zijn opgeslagen/vernieuwd vóór DOEL-56 (aliassen) hebben nog
// geen "aliases"-veld in hun columns_snapshot — die op de tabel (`columns`)
// zelf staat wél altijd '[]'::jsonb als default, maar dat geldt niet met
// terugwerkende kracht voor JSONB die al eerder als snapshot is weggeschreven.
// Zonder deze fallback zou insertColumns() (die aliases verplicht stelt) op
// zo'n ouder sjabloon stuklopen. Gebruikt door alles wat een snapshot uit de
// database leest, vóór het bij insertColumns of de editor terechtkomt.
function withAliasesDefault(columns: ColumnSnapshot[]): ColumnSnapshot[] {
  return columns.map((c) => ({ ...c, aliases: c.aliases ?? [] }));
}

// Sjablonen die een tenant mag zien/gebruiken bij het aanmaken van een
// nieuwe doelenboom: systeembreed (tenant_id is null) + de eigen sjablonen
// van die tenant. Systeembreed eerst (nulls first), dan op naam — zodat
// "Batenboom" en andere systeembrede sjablonen bovenaan de kiezer staan.
export async function listTemplatesForTenant(tenantId: number): Promise<DoelenboomTemplateSummary[]> {
  const result = await pool.query(
    `select ${TEMPLATE_SUMMARY_FIELDS} from doelenboom_templates
     where tenant_id is null or tenant_id = $1
     order by tenant_id nulls first, name`,
    [tenantId]
  );
  return result.rows;
}

// Alle sjablonen die deze gebruiker mag BEHEREN (het aparte Sjablonenbeheer-
// scherm) — sysadmin ziet alles, een tenant-admin ziet systeembreed +
// sjablonen van elke tenant waar hij/zij admin van is (inclusief via
// open_access_role='admin', zelfde fallback als getTenantRole in rbac.ts).
// Inclusief tenantName, zodat het scherm — dat sjablonen van meerdere
// tenants tegelijk toont — kan laten zien van welke tenant elk sjabloon is.
export async function listAllTemplatesForUser(
  userId: number,
  isSysadmin: boolean
): Promise<DoelenboomTemplateSummaryWithTenant[]> {
  if (isSysadmin) {
    const result = await pool.query(
      `select dt.id, dt.tenant_id as "tenantId", t.name as "tenantName", dt.name, dt.description,
              dt.created_at as "createdAt"
       from doelenboom_templates dt
       left join tenants t on t.id = dt.tenant_id
       order by dt.tenant_id nulls first, dt.name`
    );
    return result.rows;
  }
  const result = await pool.query(
    `select dt.id, dt.tenant_id as "tenantId", t.name as "tenantName", dt.name, dt.description,
            dt.created_at as "createdAt"
     from doelenboom_templates dt
     left join tenants t on t.id = dt.tenant_id
     where dt.tenant_id is null
        or dt.tenant_id in (
          select tu.tenant_id from tenant_users tu where tu.user_id = $1 and tu.role = 'admin'
          union
          select tt.id from tenants tt where tt.open_access_role = 'admin'
        )
     order by dt.tenant_id nulls first, dt.name`,
    [userId]
  );
  return result.rows;
}

// Bouwt de drie snapshotarrays op vanuit een bestaande doelenboom — gedeeld
// tussen saveDoelenboomAsTemplate (nieuw sjabloon) en
// refreshTemplateFromDoelenboom (bestaand sjabloon overschrijven).
async function buildSnapshotFromDoelenboom(
  doelenboomId: number
): Promise<{ columns: ColumnSnapshot[]; elements: ElementSnapshot[]; edges: EdgeSnapshot[]; rules: ControlRule[]; attributes: AttributeDef[] }> {
  const columnsResult = await pool.query(
    `select position, type_name as "typeName", title, subtitle, color, is_narrow as "isNarrow",
            node_font_size as "nodeFontSize", is_project_role as "isProjectRole",
            relation_label_to_next as "relationLabelToNext", aliases
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

  // Controleregels (DOEL-62) gaan mee in het sjabloon (rules_snapshot) — ze
  // zijn per definitie geldig t.o.v. de kolommen hierboven (zelfde config).
  // Kenmerkdefinities (DOEL-75) idem (attributes_snapshot) — alleen de
  // definities; een sjabloon bevat geen kenmerkwaarden.
  const rulesResult = await pool.query(
    `select rules, attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1`,
    [doelenboomId]
  );

  return {
    columns: columnsResult.rows,
    elements: elementsResult.rows,
    edges: edgesResult.rows,
    rules: rulesFromDb(rulesResult.rows[0]?.rules),
    attributes: attributesFromDb(rulesResult.rows[0]?.attributes),
  };
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
  const snapshot = await buildSnapshotFromDoelenboom(doelenboomId);
  const result = await pool.query(
    `insert into doelenboom_templates (tenant_id, name, description, columns_snapshot, elements_snapshot, edges_snapshot, rules_snapshot, attributes_snapshot)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${TEMPLATE_SUMMARY_FIELDS}`,
    [
      opts.tenantId,
      opts.name,
      opts.description,
      JSON.stringify(snapshot.columns),
      JSON.stringify(snapshot.elements),
      JSON.stringify(snapshot.edges),
      JSON.stringify(snapshot.rules),
      JSON.stringify(snapshot.attributes),
    ]
  );
  return result.rows[0];
}

// "Inhoud vervangen vanuit een boom" (Sjablonenbeheer-scherm) — overschrijft
// de drie snapshotvelden van een BESTAAND sjabloon met de huidige structuur
// van de gekozen doelenboom, i.p.v. een nieuwe rij aan te maken. Naam/
// omschrijving blijven ongewijzigd (los aan te passen, zie updateTemplateMeta).
export async function refreshTemplateFromDoelenboom(templateId: number, doelenboomId: number): Promise<boolean> {
  const snapshot = await buildSnapshotFromDoelenboom(doelenboomId);
  const result = await pool.query(
    `update doelenboom_templates
     set columns_snapshot = $1, elements_snapshot = $2, edges_snapshot = $3, rules_snapshot = $4,
         attributes_snapshot = $5
     where id = $6`,
    [
      JSON.stringify(snapshot.columns), JSON.stringify(snapshot.elements), JSON.stringify(snapshot.edges),
      JSON.stringify(snapshot.rules), JSON.stringify(snapshot.attributes), templateId,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

// Naam/omschrijving van een sjabloon los aanpassen — beide optioneel
// (undefined = ongemoeid laten), zelfde tri-state-achtige aanpak als bv. PUT
// /api/tenants/:id (open_access_role). Kolommen zitten bewust NIET in deze
// functie (zie updateTemplateColumns hieronder) — twee aparte, kleinere
// operaties i.p.v. één die alles tegelijk doet.
export async function updateTemplateMeta(
  templateId: number,
  patch: { name?: string; description?: string }
): Promise<DoelenboomTemplateSummary | null> {
  const result = await pool.query(
    `update doelenboom_templates
     set name = coalesce($1, name), description = coalesce($2, description)
     where id = $3
     returning ${TEMPLATE_SUMMARY_FIELDS}`,
    [patch.name ?? null, patch.description ?? null, templateId]
  );
  return result.rows[0] ?? null;
}

// Sjabloon toepassen op een net aangemaakte, nog lege doelenboom — binnen
// dezelfde transactie als het aanmaken zelf (zie routes/doelenbomen.ts POST
// /tenants/:tenantId/doelenbomen), dus vóór er iets anders in kan staan.
// Geeft { ok: false } terug als het sjabloon niet bestaat of niet zichtbaar
// is voor deze tenant (niet systeembreed, en niet van déze tenant), of als de
// controleregels van het sjabloon niet (meer) kloppen met de sjabloonkolommen
// (DOEL-62: bij toepassen valideren) — de aanroeper rolt dan de hele
// transactie terug en toont `error`.
export async function applyTemplateToNewDoelenboom(
  client: PoolClient,
  templateId: number,
  tenantId: number,
  doelenboomId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tmpl = await client.query(
    `select columns_snapshot, elements_snapshot, edges_snapshot, rules_snapshot, attributes_snapshot from doelenboom_templates
     where id = $1 and (tenant_id is null or tenant_id = $2)`,
    [templateId, tenantId]
  );
  if (!tmpl.rows[0]) return { ok: false, error: 'Sjabloon niet gevonden of niet beschikbaar voor deze tenant.' };

  const columns = withAliasesDefault(tmpl.rows[0].columns_snapshot as ColumnSnapshot[]);
  // Fallback voor sjablonen van vóór DOEL-62: rules_snapshot is dan '[]'
  // (kolomdefault), rulesFromDb vangt ook een onverhoopt ontbrekende waarde af.

  // Kenmerkdefinities (DOEL-75): zelfde validatie bij toepassen. `existing`
  // is leeg — de nieuwe boom heeft nog geen kenmerken waarvan de soort vastligt.
  const { errors: attributeErrors, attributes } = validateAttributeDefsInput(
    attributesFromDb(tmpl.rows[0].attributes_snapshot),
    allValidTypeNames(columns as ColumnDef[]),
    []
  );
  if (attributeErrors.length) {
    return { ok: false, error: 'De kenmerken van dit sjabloon passen niet bij de sjabloonkolommen; laat het sjabloon eerst corrigeren.' };
  }

  // De regels ná de kenmerken: een kenmerkregel (DOEL-77) wordt tegen de
  // zojuist gevalideerde definities gecontroleerd.
  const { errors: ruleErrors, rules } = validateControlRulesInput(
    rulesFromDb(tmpl.rows[0].rules_snapshot),
    allValidTypeNames(columns as ColumnDef[]),
    { attributes, columns: columns as ColumnDef[] }
  );
  if (ruleErrors.length) {
    return { ok: false, error: 'De controleregels van dit sjabloon passen niet bij de sjabloonkolommen; laat het sjabloon eerst corrigeren.' };
  }

  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id, doelenboom_id, rules, attributes) values ('doelenboom', $1, $2, $3, $4) returning id`,
    [tenantId, doelenboomId, JSON.stringify(rules), JSON.stringify(attributes)]
  );
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

  return { ok: true };
}

// Kolommen van een sjabloon opvragen voor de editor (Sjablonenbeheer-scherm
// hergebruikt hiervoor gewoon <ColumnConfigEditor>, dezelfde component als
// bij de tenant-default/doelenboom-kolommen). ColumnDef vereist een 'id'-veld
// (React-key/type-compatibiliteit), maar een sjabloon-snapshot heeft geen
// eigen database-id's per kolom — de editor zelf leest 'id' nergens uit, dus
// de positie is hier een prima, altijd-unieke placeholder.
export async function getTemplateColumnsWithIds(templateId: number): Promise<ColumnDef[] | null> {
  const result = await pool.query('select columns_snapshot from doelenboom_templates where id = $1', [templateId]);
  if (!result.rows[0]) return null;
  const columns = withAliasesDefault(result.rows[0].columns_snapshot as ColumnSnapshot[]);
  return columns.map((c, i) => ({ ...c, id: i }));
}

// Validatie bij het rechtstreeks bewerken van sjabloonkolommen: net als
// replaceColumns in columnConfig.ts (die tegen een échte doelenboom's
// elements-tabel checkt), maar hier tegen de elementen die al IN het
// sjabloon zelf zitten (elements_snapshot) — een kolomtype verwijderen
// terwijl er nog voorbeeldelementen van dat type in het sjabloon staan zou
// het sjabloon intern inconsistent maken (elementen zonder bijpassende
// kolom bij een volgende "toepassen").
function findRemovedTypesStillInUse(elements: ElementSnapshot[], newColumns: Omit<ColumnDef, 'id'>[]): string[] {
  const newTypeNames = new Set(newColumns.flatMap((c) => [c.typeName, ...c.aliases.map((a) => a.typeName)]));
  const counts = new Map<string, number>();
  for (const el of elements) {
    if (!newTypeNames.has(el.type)) {
      counts.set(el.type, (counts.get(el.type) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return [];
  const detail = Array.from(counts.entries())
    .map(([type, n]) => `"${type}" (${n} voorbeeldelement(en))`)
    .join(', ');
  return [
    `Kan deze kolom(men) niet verwijderen/hernoemen: er staan nog voorbeeldelementen van dat type in dit ` +
      `sjabloon: ${detail}. Vervang eerst de inhoud vanuit een boom zonder dat type, of laat de kolom staan.`,
  ];
}

export async function updateTemplateColumns(
  templateId: number,
  columnsInput: unknown
): Promise<{ errors: string[]; columns?: ColumnDef[] }> {
  const { errors: inputErrors, columns } = validateColumnsInput(columnsInput);
  if (inputErrors.length) return { errors: inputErrors };

  const existing = await pool.query('select elements_snapshot from doelenboom_templates where id = $1', [templateId]);
  if (!existing.rows[0]) return { errors: ['Sjabloon niet gevonden.'] };
  const elements = existing.rows[0].elements_snapshot as ElementSnapshot[];

  const removalErrors = findRemovedTypesStillInUse(elements, columns);
  if (removalErrors.length) return { errors: removalErrors };

  // Controleregels van het sjabloon (DOEL-62): zelfde weigering als bij een
  // doelenboom — geen stille verwijdering, regel-id's in de melding.
  const rulesRow = await pool.query('select rules_snapshot, attributes_snapshot from doelenboom_templates where id = $1', [templateId]);
  const brokenRuleIds = findRulesBrokenByColumns(rulesFromDb(rulesRow.rows[0]?.rules_snapshot), columns);
  if (brokenRuleIds.length) return { errors: [brokenRulesMessage(brokenRuleIds)] };
  // Kenmerkdefinities (DOEL-75): idem.
  const brokenAttributeIds = findAttributesBrokenByColumns(attributesFromDb(rulesRow.rows[0]?.attributes_snapshot), columns);
  if (brokenAttributeIds.length) return { errors: [brokenAttributesMessage(brokenAttributeIds)] };

  await pool.query('update doelenboom_templates set columns_snapshot = $1 where id = $2', [
    JSON.stringify(columns),
    templateId,
  ]);
  const fresh = await getTemplateColumnsWithIds(templateId);
  return { errors: [], columns: fresh ?? [] };
}

// Controleregels van een sjabloon (DOEL-62) opvragen/vervangen —
// Sjablonenbeheer-scherm. Validatie tegen de kolommen uit het sjabloon zelf.
export async function getTemplateRules(
  templateId: number
): Promise<{ rules: ControlRule[]; validTypeNames: string[]; attributes: AttributeDef[]; columns: ColumnDef[] } | null> {
  const r = await pool.query(
    'select columns_snapshot, rules_snapshot, attributes_snapshot from doelenboom_templates where id = $1',
    [templateId]
  );
  if (!r.rows[0]) return null;
  const columns = withAliasesDefault(r.rows[0].columns_snapshot as ColumnSnapshot[]) as ColumnDef[];
  return {
    rules: rulesFromDb(r.rows[0].rules_snapshot),
    validTypeNames: allValidTypeNames(columns),
    // DOEL-77: voor kenmerkregels.
    attributes: attributesFromDb(r.rows[0].attributes_snapshot),
    columns,
  };
}

export async function updateTemplateRules(
  templateId: number,
  input: unknown
): Promise<{ notFound?: boolean; errors: string[]; rules?: ControlRule[] }> {
  const current = await getTemplateRules(templateId);
  if (!current) return { notFound: true, errors: [] };
  const { errors, rules } = validateControlRulesInput(input, current.validTypeNames, { attributes: current.attributes, columns: current.columns });
  if (errors.length) return { errors };
  await pool.query('update doelenboom_templates set rules_snapshot = $1 where id = $2', [JSON.stringify(rules), templateId]);
  return { errors: [], rules };
}

// Kenmerkdefinities van een sjabloon (DOEL-75) opvragen/vervangen —
// Sjablonenbeheer-scherm. Validatie tegen de kolommen uit het sjabloon zelf
// en tegen de al opgeslagen definities (soort ligt vast).
export async function getTemplateAttributes(
  templateId: number
): Promise<{ attributes: AttributeDef[]; validTypeNames: string[] } | null> {
  const r = await pool.query('select columns_snapshot, attributes_snapshot from doelenboom_templates where id = $1', [templateId]);
  if (!r.rows[0]) return null;
  const columns = withAliasesDefault(r.rows[0].columns_snapshot as ColumnSnapshot[]);
  return {
    attributes: attributesFromDb(r.rows[0].attributes_snapshot),
    validTypeNames: allValidTypeNames(columns as ColumnDef[]),
  };
}

export async function updateTemplateAttributes(
  templateId: number,
  input: unknown
): Promise<{ notFound?: boolean; conflict?: boolean; errors: string[]; attributes?: AttributeDef[] }> {
  const current = await getTemplateAttributes(templateId);
  if (!current) return { notFound: true, errors: [] };
  const { errors, attributes } = validateAttributeDefsInput(input, current.validTypeNames, current.attributes);
  if (errors.length) return { errors };
  // DOEL-77: een kenmerk dat nog in een sjabloonregel wordt gebruikt kan niet weg.
  const ruleCtx = await getTemplateRules(templateId);
  if (ruleCtx) {
    const brokenRuleIds = findRulesBrokenByAttributes(ruleCtx.rules, { attributes, columns: ruleCtx.columns });
    if (brokenRuleIds.length) return { errors: [brokenRulesByAttributesMessage(brokenRuleIds)], conflict: true };
  }
  await pool.query('update doelenboom_templates set attributes_snapshot = $1 where id = $2', [JSON.stringify(attributes), templateId]);
  return { errors: [], attributes };
}

// Voor de beheerroutes (routes/doelenboomTemplates.ts): tenant_id van het
// sjabloon zelf, om te bepalen of dit een systeembreed (null) of
// tenant-eigen sjabloon is — bepaalt daar wie het mag beheren/verwijderen.
export async function getTemplateTenantId(templateId: number): Promise<{ found: boolean; tenantId: number | null }> {
  const result = await pool.query('select tenant_id from doelenboom_templates where id = $1', [templateId]);
  if (!result.rows[0]) return { found: false, tenantId: null };
  return { found: true, tenantId: result.rows[0].tenant_id };
}

export async function deleteTemplateById(templateId: number): Promise<boolean> {
  const result = await pool.query('delete from doelenboom_templates where id = $1', [templateId]);
  return (result.rowCount ?? 0) > 0;
}
