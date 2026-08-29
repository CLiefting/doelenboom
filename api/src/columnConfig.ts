import { PoolClient } from 'pg';
import { pool } from './db.js';

// Configureerbare kolommen (zie docs/kolommen-configuratie-ontwerp.md en
// db/migrations/0001_column_configs.sql). Een "column_config" is een complete
// kolommenset: ofwel de tenant-default (scope='tenant_default', één per
// tenant — het sjabloon waarmee een nieuwe doelenboom start), ofwel de eigen,
// onafhankelijke config van één specifieke doelenboom (scope='doelenboom').
// Dit bestand bundelt alle databasetoegang tot die twee tabellen, gebruikt
// door routes/columnConfig.ts, routes/tenants.ts (nieuwe tenant), en
// routes/doelenbomen.ts (nieuwe/gedupliceerde doelenboom).

export interface ColumnDef {
  id: number;
  position: number;
  typeName: string;
  title: string;
  subtitle: string;
  color: string;
  isNarrow: boolean;
  nodeFontSize: number | null;
  isProjectRole: boolean;
  relationLabelToNext: string | null;
}

const COLUMN_SELECT_FIELDS =
  'id, position, type_name as "typeName", title, subtitle, color, is_narrow as "isNarrow", ' +
  'node_font_size as "nodeFontSize", is_project_role as "isProjectRole", relation_label_to_next as "relationLabelToNext"';

// De 8 kolommen die tot nu toe hardcoded in web/public/tree.html stonden
// (COL_LABELS/COL_COLORS/COL_ARROWS/COLUMN_HINTS/TYPE_TO_COLKEY/NARROW_COLS)
// — gebruikt als startpunt voor een gloednieuwe tenant (zie routes/tenants.ts)
// en als noodfallback als een tenant onverhoopt nog geen tenant-default
// heeft. Zelfde data als db/migrations/0001_column_configs.sql zaait voor
// bestaande tenants (bewust twee keer uitgeschreven — SQL-migratie versus
// TS-runtime-code raken elkaar niet, geen gedeeld pad zonder dat een van
// beide de ander als afhankelijkheid zou moeten inladen).
export function standardColumns(tenantName: string): Omit<ColumnDef, 'id'>[] {
  return [
    { position: 0, typeName: 'Project', title: 'Project', subtitle: 'Welke projecten ontwikkelen deze capability?', color: '#3E6FA6', isNarrow: true, nodeFontSize: null, isProjectRole: true, relationLabelToNext: 'ontwikkelt' },
    { position: 1, typeName: 'Capability', title: 'Capability', subtitle: 'Welk vermogen wordt hiermee opgebouwd?', color: '#6B4C8A', isNarrow: true, nodeFontSize: null, isProjectRole: false, relationLabelToNext: 'ondersteunt' },
    { position: 2, typeName: 'Operationele benefit', title: 'Operationele benefit', subtitle: 'Welke operationele verbetering levert dit op? Wat verandert er in de dagelijkse uitvoering?', color: '#C05A2C', isNarrow: false, nodeFontSize: null, isProjectRole: false, relationLabelToNext: 'realiseert' },
    { position: 3, typeName: 'Sub-benefit', title: `Sub-benefit ${tenantName}`, subtitle: 'Welk direct effect ontstaat hierdoor?', color: '#B8862E', isNarrow: false, nodeFontSize: null, isProjectRole: false, relationLabelToNext: 'versterkt' },
    { position: 4, typeName: 'Programmabaat', title: `Programmabaat ${tenantName}`, subtitle: `Welke waarde levert dit aan ${tenantName}?`, color: '#2E7D5B', isNarrow: false, nodeFontSize: null, isProjectRole: false, relationLabelToNext: 'draagt bij aan' },
    { position: 5, typeName: 'Strategische benefit', title: `Strategisch benefit ${tenantName}`, subtitle: `Wat betekent dit voor ${tenantName}?`, color: '#8FAADC', isNarrow: false, nodeFontSize: 10, isProjectRole: false, relationLabelToNext: 'ondersteunt' },
    { position: 6, typeName: 'Strategisch doel', title: 'Strategisch doel', subtitle: 'Welk doel ondersteunt dit?', color: '#2F5597', isNarrow: false, nodeFontSize: 12, isProjectRole: false, relationLabelToNext: 'geeft invulling aan' },
    { position: 7, typeName: 'Missie', title: `Missie ${tenantName}`, subtitle: 'Waarom doen we dit uiteindelijk?', color: '#203864', isNarrow: false, nodeFontSize: 10, isProjectRole: false, relationLabelToNext: null },
  ];
}

// Geëxporteerd (i.p.v. module-lokaal) zodat doelenboomTemplates.ts 'm ook kan
// gebruiken bij het toepassen van een sjabloon op een net aangemaakte
// doelenboom — zelfde insert-logica, alleen de herkomst van de kolommenlijst
// verschilt (tenant-default versus een sjabloon-snapshot).
export async function insertColumns(client: PoolClient, columnConfigId: number, columns: Omit<ColumnDef, 'id'>[]) {
  for (const c of columns) {
    await client.query(
      `insert into columns
         (column_config_id, position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [columnConfigId, c.position, c.typeName, c.title, c.subtitle, c.color, c.isNarrow, c.nodeFontSize, c.isProjectRole, c.relationLabelToNext]
    );
  }
}

async function copyColumnsBetweenConfigs(client: PoolClient, sourceConfigId: number, targetConfigId: number) {
  const source = await client.query(
    `select position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next
     from columns where column_config_id = $1 order by position`,
    [sourceConfigId]
  );
  for (const r of source.rows) {
    await client.query(
      `insert into columns
         (column_config_id, position, type_name, title, subtitle, color, is_narrow, node_font_size, is_project_role, relation_label_to_next)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        targetConfigId, r.position, r.type_name, r.title, r.subtitle, r.color,
        r.is_narrow, r.node_font_size, r.is_project_role, r.relation_label_to_next,
      ]
    );
  }
}

// Nieuwe tenant (routes/tenants.ts POST /): eigen tenant-default-config met
// de standaardkolommen.
export async function createTenantDefaultConfig(client: PoolClient, tenantId: number, tenantName: string) {
  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id) values ('tenant_default', $1) returning id`,
    [tenantId]
  );
  await insertColumns(client, cfg.rows[0].id, standardColumns(tenantName));
}

// Nieuwe doelenboom (routes/doelenbomen.ts POST .../doelenbomen): eigen,
// onafhankelijke kopie van de op dat moment geldende tenant-default van die
// tenant — geen levende verwijzing (wijzig je de tenant-default later, dan
// verandert een al-bestaande doelenboom dus niet automatisch mee).
export async function createDoelenboomConfigFromTenantDefault(
  client: PoolClient,
  tenantId: number,
  tenantName: string,
  doelenboomId: number
) {
  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', $1, $2) returning id`,
    [tenantId, doelenboomId]
  );
  const sourceConfig = await client.query(
    `select id from column_configs where scope = 'tenant_default' and tenant_id = $1`,
    [tenantId]
  );
  if (sourceConfig.rows[0]) {
    await copyColumnsBetweenConfigs(client, sourceConfig.rows[0].id, cfg.rows[0].id);
  } else {
    // Noodfallback: zou niet moeten voorkomen (elke tenant krijgt een
    // tenant-default bij aanmaken, zie createTenantDefaultConfig hierboven,
    // en bestaande tenants zijn gemigreerd), maar zonder dit zou een
    // doelenboom-aanmaak stuklopen op een inconsistente databasestand.
    await insertColumns(client, cfg.rows[0].id, standardColumns(tenantName));
  }
}

// Dupliceren van een doelenboom (routes/doelenbomen.ts POST .../duplicate):
// kopieert de EIGEN config van de bron-doelenboom (niet de tenant-default —
// de bron kan immers zelf al een aangepaste config hebben).
export async function copyDoelenboomConfig(
  client: PoolClient,
  sourceDoelenboomId: number,
  targetTenantId: number,
  targetDoelenboomId: number
) {
  const sourceConfig = await client.query(
    `select id from column_configs where scope = 'doelenboom' and doelenboom_id = $1`,
    [sourceDoelenboomId]
  );
  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', $1, $2) returning id`,
    [targetTenantId, targetDoelenboomId]
  );
  if (sourceConfig.rows[0]) {
    await copyColumnsBetweenConfigs(client, sourceConfig.rows[0].id, cfg.rows[0].id);
  }
}

export async function getColumnsForDoelenboom(doelenboomId: number | string): Promise<ColumnDef[]> {
  const result = await pool.query(
    `select ${COLUMN_SELECT_FIELDS} from columns
     where column_config_id = (select id from column_configs where scope = 'doelenboom' and doelenboom_id = $1)
     order by position`,
    [doelenboomId]
  );
  return result.rows;
}

// De 8 standaardtypes, in hun oorspronkelijke volgorde — zie ook
// STANDARD_TYPE_NAMES in excel-service/app/exporter.py (bewust twee keer
// uitgeschreven, zelfde reden als bij standardColumns() hierboven). Gebruikt
// om het "oud" Excel-exportformaat te beperken tot doelenbomen die nog exact
// deze standaardconfig hebben (zie routes/exports.ts en
// docs/kolommen-configuratie-ontwerp.md).
const STANDARD_TYPE_NAMES = [
  'Project', 'Capability', 'Operationele benefit', 'Sub-benefit',
  'Programmabaat', 'Strategische benefit', 'Strategisch doel', 'Missie',
];

export function isStandardColumns(columns: ColumnDef[]): boolean {
  const ordered = columns.slice().sort((a, b) => a.position - b.position);
  if (ordered.length !== STANDARD_TYPE_NAMES.length) return false;
  return ordered.every((c, i) => c.typeName === STANDARD_TYPE_NAMES[i]);
}

export async function getTenantDefaultColumns(tenantId: number | string): Promise<ColumnDef[]> {
  const result = await pool.query(
    `select ${COLUMN_SELECT_FIELDS} from columns
     where column_config_id = (select id from column_configs where scope = 'tenant_default' and tenant_id = $1)
     order by position`,
    [tenantId]
  );
  return result.rows;
}

// Validatie van een nieuwe kolommenlijst (PUT-body van routes/columnConfig.ts),
// gedeeld tussen de tenant-default- en doelenboom-variant. Geeft een lijst
// foutmeldingen terug (leeg = geldig).
export function validateColumnsInput(input: unknown): { errors: string[]; columns: Omit<ColumnDef, 'id'>[] } {
  const errors: string[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    return { errors: ['Minstens één kolom is verplicht.'], columns: [] };
  }
  const columns: Omit<ColumnDef, 'id'>[] = [];
  const seenTypeNames = new Set<string>();
  let projectRoleCount = 0;

  input.forEach((raw, idx) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const typeName = typeof c.typeName === 'string' ? c.typeName.trim() : '';
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    const subtitle = typeof c.subtitle === 'string' ? c.subtitle : '';
    const color = typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '';
    const isNarrow = c.isNarrow === true;
    const nodeFontSize = typeof c.nodeFontSize === 'number' && Number.isFinite(c.nodeFontSize) ? c.nodeFontSize : null;
    const isProjectRole = c.isProjectRole === true;
    const relationLabelToNext =
      typeof c.relationLabelToNext === 'string' && c.relationLabelToNext.trim() ? c.relationLabelToNext.trim() : null;

    if (!typeName) errors.push(`Kolom ${idx + 1}: type-naam is verplicht.`);
    if (!title) errors.push(`Kolom ${idx + 1}: titel is verplicht.`);
    if (!color) errors.push(`Kolom ${idx + 1}: kleur moet een geldige hex-waarde zijn (bv. #3E6FA6).`);
    if (typeName && seenTypeNames.has(typeName)) errors.push(`Type-naam "${typeName}" komt meer dan één keer voor.`);
    if (typeName) seenTypeNames.add(typeName);
    if (isProjectRole) projectRoleCount += 1;

    columns.push({ position: idx, typeName, title, subtitle, color, isNarrow, nodeFontSize, isProjectRole, relationLabelToNext });
  });

  if (projectRoleCount !== 1) {
    errors.push(
      `Precies één kolom moet de project-rol hebben (voor projectkaart/planning-items/tijdlijnenoverzicht) — nu zijn dat er ${projectRoleCount}.`
    );
  }
  // De laatste kolom heeft per definitie geen "volgende" kolom meer.
  if (columns.length) columns[columns.length - 1].relationLabelToNext = null;

  return { errors, columns };
}

// Vervangt de volledige kolommenlijst van een bestaande config (tenant-default
// of doelenboom) — eenvoudiger en minder foutgevoelig dan losse insert/update/
// delete-diffing, en past bij de "sla de hele lijst in één keer op"-UX van het
// beheerscherm (herordenen/toevoegen/verwijderen gebeurt allemaal client-side,
// pas bij opslaan naar de server). elementsUsingRemovedTypes controleert vooraf
// of dit geen wees-elementen zou opleveren.
export async function replaceColumns(
  client: PoolClient,
  columnConfigId: number,
  doelenboomIdForTypeCheck: number | string | null,
  columns: Omit<ColumnDef, 'id'>[]
): Promise<{ errors: string[] }> {
  if (doelenboomIdForTypeCheck != null) {
    const existingTypes = await client.query(
      `select distinct type from elements where doelenboom_id = $1`,
      [doelenboomIdForTypeCheck]
    );
    const newTypeNames = new Set(columns.map((c) => c.typeName));
    const removedTypesStillInUse: string[] = [];
    for (const row of existingTypes.rows) {
      if (!newTypeNames.has(row.type)) removedTypesStillInUse.push(row.type);
    }
    if (removedTypesStillInUse.length) {
      const counts = await client.query(
        `select type, count(*) from elements where doelenboom_id = $1 and type = any($2::text[]) group by type`,
        [doelenboomIdForTypeCheck, removedTypesStillInUse]
      );
      const detail = counts.rows.map((r) => `"${r.type}" (${r.count} element(en))`).join(', ');
      return {
        errors: [
          `Kan deze kolom(men) niet verwijderen/hernoemen, er bestaan nog elementen van dat type: ${detail}. ` +
            'Verplaats of verwijder die elementen eerst.',
        ],
      };
    }
  }

  await client.query('delete from columns where column_config_id = $1', [columnConfigId]);
  await insertColumns(client, columnConfigId, columns);
  return { errors: [] };
}
