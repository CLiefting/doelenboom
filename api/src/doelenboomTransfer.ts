// Een doelenboom van de ene omgeving naar de andere kopiëren (DOEL-104):
// lokaal exporteren naar één bundel, op de doelomgeving in één transactie
// importeren. Aangeroepen door src/scripts/doelenboomExport.ts en
// doelenboomImport.ts, die op hun beurt door scripts/doelenboom-kopieer.sh
// worden gestart.
//
// Wat er WEL meegaat: de eigen kolomconfiguratie van de boom (kolommen,
// controleregels, kenmerkdefinities) en alle inhoud (elementen, relaties,
// tags, organisatieonderdelen en hun koppelingen, projectstatus, afwijkingen,
// kenmerkwaarden, producten, activiteiten en afhankelijkheden).
// Wat er NIET meegaat: gebruikers, rollen per boom, importhistorie,
// projecthistorie en het auditlog. Verwijzingen naar gebruikers (bijgewerkt
// door, aangemaakt door) worden leeggemaakt: de accounts van de bron bestaan
// op de doelomgeving niet, of zijn daar iemand anders.
//
// De rijen gaan als to_jsonb(rij) de bundel in en via jsonb_populate_record
// de doeltabel in. Postgres doet zo zelf de typeconversie (datums, numerieke
// waarden, jsonb), en een kolom die later aan een tabel wordt toegevoegd gaat
// vanzelf mee. Voorwaarde is dat bron en doel dezelfde migratiestand hebben;
// dat wordt bij het importeren gecontroleerd.
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { createTenantDefaultConfig } from './columnConfig.js';
import { computeDefaultLicenseEndDate, incrementLifetimeTreesCreated } from './license.js';

export const BUNDLE_FORMAT = 1;

// Bovengrenzen (OWASP A04): een bundel die hier overheen gaat wordt geweigerd
// vóórdat er iets in de database verandert.
export const TRANSFER_LIMITS = {
  bytes: 64 * 1024 * 1024,
  elements: 20_000,
  rowsPerTable: 200_000,
  nameLength: 200,
  slugLength: 80,
};

/** Fout met een melding die zo aan de beheerder getoond mag worden. */
export class TransferError extends Error {}

type Row = Record<string, unknown>;
type MapName = 'element' | 'tag' | 'org' | 'product' | 'activity';
type FkTarget = 'doelenboom' | 'config' | MapName;

interface TableSpec {
  table: string;
  /** Voorwaarde op alias t; $1 = id van de bron-doelenboom. */
  where: string;
  orderBy: string;
  /** Kolom -> waar de verwijzing naartoe moet op de doelomgeving. */
  fk: Record<string, FkTarget>;
  /** Oude id -> nieuwe id bijhouden onder deze naam (voor latere tabellen). */
  map?: MapName;
  /** Tabel zonder eigen id-kolom. */
  noId?: boolean;
}

const OF_BOOM = 't.doelenboom_id = $1';
const OF_ELEMENT = 't.element_id in (select id from elements where doelenboom_id = $1)';

// Volgorde = importvolgorde: een tabel staat ná de tabellen waar hij naar verwijst.
export const TRANSFER_TABLES: TableSpec[] = [
  {
    table: 'columns', orderBy: 't.position', fk: { column_config_id: 'config' },
    where: `t.column_config_id in (select id from column_configs where scope = 'doelenboom' and doelenboom_id = $1)`,
  },
  { table: 'elements', where: OF_BOOM, orderBy: 't.sort_order, t.id', fk: { doelenboom_id: 'doelenboom' }, map: 'element' },
  {
    table: 'edges', where: OF_BOOM, orderBy: 't.id',
    fk: { doelenboom_id: 'doelenboom', source_element_id: 'element', target_element_id: 'element' },
  },
  { table: 'tags', where: OF_BOOM, orderBy: 't.id', fk: { doelenboom_id: 'doelenboom' }, map: 'tag' },
  { table: 'org_units', where: OF_BOOM, orderBy: 't.id', fk: { doelenboom_id: 'doelenboom' }, map: 'org' },
  { table: 'element_tags', where: OF_ELEMENT, orderBy: 't.element_id, t.tag_id', fk: { element_id: 'element', tag_id: 'tag' }, noId: true },
  { table: 'ob_org_relations', where: OF_ELEMENT, orderBy: 't.id', fk: { element_id: 'element', org_unit_id: 'org' } },
  { table: 'project_status', where: OF_ELEMENT, orderBy: 't.element_id', fk: { element_id: 'element' }, noId: true },
  { table: 'control_rule_deviations', where: OF_BOOM, orderBy: 't.id', fk: { doelenboom_id: 'doelenboom', element_id: 'element' } },
  { table: 'element_attribute_values', where: OF_BOOM, orderBy: 't.id', fk: { doelenboom_id: 'doelenboom', element_id: 'element' } },
  { table: 'products', where: OF_ELEMENT, orderBy: 't.id', fk: { element_id: 'element' }, map: 'product' },
  {
    table: 'product_dependencies', orderBy: 't.id', fk: { predecessor_id: 'product', successor_id: 'product' },
    where: `t.predecessor_id in (select p.id from products p join elements e on e.id = p.element_id where e.doelenboom_id = $1)`,
  },
  { table: 'activities', where: OF_ELEMENT, orderBy: 't.id', fk: { element_id: 'element' }, map: 'activity' },
  {
    table: 'activity_dependencies', orderBy: 't.id', fk: { predecessor_id: 'activity', successor_id: 'activity' },
    where: `t.predecessor_id in (select a.id from activities a join elements e on e.id = a.element_id where e.doelenboom_id = $1)`,
  },
];

// Tabellen die wel aan een doelenboom of zijn inhoud hangen maar bewust NIET
// meegaan. test/doelenboomTransfer.test.ts controleert dat elke tabel die naar
// een doelenboom, element, product, activiteit, tag of organisatieonderdeel
// verwijst óf hierboven óf hier staat: een nieuwe tabel dwingt zo een keuze af.
export const TRANSFER_EXCLUDED_TABLES = [
  'column_configs', // de ene config-rij van de boom gaat apart mee (columnConfig in de bundel)
  'doelenboom_user_roles', // rollen van gebruikers van de bron
  'excel_imports', // importhistorie
  'project_history', // historie, verwijst naar gebruikers van de bron
  'audit_log',
  'program_selections', // persoonlijke selecties van gebruikers van de bron (DOEL-112)
];

const TABLE_NAMES = TRANSFER_TABLES.map((t) => t.table);
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// Kolommen van de doelenboom-rij zelf die meegaan naar een NIEUWE boom. Niet:
// read_only, wipe_on_empty en archived_at (operationele vlaggen, net als bij
// dupliceren in routes/doelenbomen.ts) en de sleutels/naam/slug.
const DOELENBOOM_SETTINGS = ['stale_after_days', 'nightly_export_enabled'];
// Kolommen van de config-rij die meegaan.
const CONFIG_COLUMNS = ['rules', 'attributes'];

export interface Bundle {
  format: number;
  exportedAt: string;
  schemaVersion: string;
  source: {
    tenant: { slug: string; name: string; modules: string[] };
    doelenboom: { slug: string; name: string; settings: Row };
  };
  columnConfig: Row | null;
  tables: Record<string, Row[]>;
}

export interface BundleFile {
  sha256: string;
  bundle: Bundle;
}

export function bundleChecksum(bundle: Bundle): string {
  return crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

export function bundleCounts(bundle: Bundle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of TABLE_NAMES) counts[name] = bundle.tables[name]?.length ?? 0;
  return counts;
}

/** 'OVpay @ NS' -> 'ovpay-ns'. Gooit als er niets bruikbaars overblijft. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TRANSFER_LIMITS.slugLength)
    .replace(/-+$/g, '');
  if (!slug) throw new TransferError(`Van de naam "${name}" is geen slug af te leiden; geef zelf een slug op.`);
  return slug;
}

const quote = (ident: string) => {
  if (!IDENT_RE.test(ident)) throw new TransferError(`Ongeldige kolom- of tabelnaam: ${ident}`);
  return `"${ident}"`;
};

async function schemaVersion(client: PoolClient): Promise<string> {
  const exists = await client.query(`select to_regclass('public.schema_migrations') is not null as ok`);
  if (!exists.rows[0].ok) return 'geen-boekhouding';
  const r = await client.query('select max(filename) as last, count(*)::int as n from schema_migrations');
  return `${r.rows[0].last ?? 'leeg'} (${r.rows[0].n})`;
}

interface TableMeta {
  columns: Set<string>;
  numeric: string[];
  /** Kolommen met een foreign key, met de tabel waar ze naar verwijzen. */
  references: Map<string, string>;
}

async function tableMeta(client: PoolClient, table: string): Promise<TableMeta> {
  const cols = await client.query(
    `select column_name, data_type from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table]
  );
  if (cols.rows.length === 0) throw new TransferError(`Tabel ${table} bestaat niet op deze omgeving.`);
  const fks = await client.query(
    `select a.attname as column_name, c.confrelid::regclass::text as target
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f' and c.conrelid = ('public.' || $1)::regclass`,
    [table]
  );
  return {
    columns: new Set(cols.rows.map((r) => r.column_name as string)),
    numeric: cols.rows.filter((r) => r.data_type === 'numeric').map((r) => r.column_name as string),
    references: new Map(fks.rows.map((r) => [r.column_name as string, r.target as string])),
  };
}

// Elke foreign key van een meegenomen tabel moet óf in de specificatie staan
// (dan wordt hij omgezet) óf naar users verwijzen (dan wordt hij leeggemaakt).
// Een onbekende verwijzing zou anders stil naar een verkeerde of niet-bestaande
// rij op de doelomgeving wijzen.
function assertReferencesCovered(spec: TableSpec, meta: TableMeta) {
  for (const [column, target] of meta.references) {
    if (target === 'users' || column in spec.fk) continue;
    throw new TransferError(
      `Tabel ${spec.table} heeft een verwijzing (${column} -> ${target}) die het kopieerscript niet kent. ` +
        'Werk TRANSFER_TABLES in api/src/doelenboomTransfer.ts bij.'
    );
  }
}

// ---- exporteren -----------------------------------------------------------

async function findOne(
  client: PoolClient, sql: string, params: unknown[], what: string, value: string
): Promise<Row> {
  const r = await client.query(sql, params);
  if (r.rows.length === 0) throw new TransferError(`${what} "${value}" niet gevonden.`);
  if (r.rows.length > 1) {
    const list = r.rows.map((x) => `${x.name} (slug ${x.slug})`).join(', ');
    throw new TransferError(`${what} "${value}" is niet eenduidig: ${list}. Geef de slug op.`);
  }
  return r.rows[0];
}

/** Leest één doelenboom (op slug of exacte naam) uit en bouwt de bundel. */
export async function exportBundle(client: PoolClient, sel: { tenant: string; boom: string }): Promise<BundleFile> {
  const tenant = await findOne(
    client, 'select id, slug, name from tenants where slug = $1 or name = $1', [sel.tenant], 'Tenant', sel.tenant
  );
  const boom = await findOne(
    client,
    'select id, slug, name, to_jsonb(d) as row from doelenbomen d where tenant_id = $1 and (slug = $2 or name = $2)',
    [tenant.id, sel.boom], `Doelenboom in tenant ${tenant.name}`, sel.boom
  );
  const modules = await client.query(
    `select m.key from tenant_modules tm join modules m on m.id = tm.module_id
     where tm.tenant_id = $1 and (tm.end_date is null or tm.end_date >= current_date)
     order by m.key`,
    [tenant.id]
  );

  const config = await client.query(
    `select to_jsonb(t) as row from column_configs t where t.scope = 'doelenboom' and t.doelenboom_id = $1`,
    [boom.id]
  );
  const configRow = config.rows[0]?.row as Row | undefined;

  const tables: Record<string, Row[]> = {};
  for (const spec of TRANSFER_TABLES) {
    const meta = await tableMeta(client, spec.table);
    assertReferencesCovered(spec, meta);
    // Numerieke kolommen als tekst: een JSON-getal verliest in JavaScript
    // precisie voorbij 15 cijfers; jsonb_populate_record leest de tekst weer exact in.
    const numericAsText = meta.numeric.length
      ? ` || jsonb_build_object(${meta.numeric.map((c) => `'${c}', t.${quote(c)}::text`).join(', ')})`
      : '';
    const r = await client.query(
      `select to_jsonb(t)${numericAsText} as row from ${quote(spec.table)} t where ${spec.where} order by ${spec.orderBy}`,
      [boom.id]
    );
    tables[spec.table] = r.rows.map((x) => x.row as Row);
  }

  const boomRow = boom.row as Row;
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    schemaVersion: await schemaVersion(client),
    source: {
      tenant: { slug: String(tenant.slug), name: String(tenant.name), modules: modules.rows.map((m) => m.key as string) },
      doelenboom: {
        slug: String(boom.slug), name: String(boom.name),
        settings: Object.fromEntries(DOELENBOOM_SETTINGS.filter((k) => k in boomRow).map((k) => [k, boomRow[k]])),
      },
    },
    columnConfig: configRow ? Object.fromEntries(CONFIG_COLUMNS.filter((k) => k in configRow).map((k) => [k, configRow[k]])) : null,
    tables,
  };
  return { sha256: bundleChecksum(bundle), bundle };
}

// ---- bundel controleren ---------------------------------------------------

const isPlainObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Controleert vorm, grenzen en controlesom van een ingelezen bundelbestand
 * (OWASP A03/A04/A08). Er wordt niets aangenomen over de herkomst: alles wat
 * straks als tabel- of kolomnaam wordt gebruikt, komt uit TRANSFER_TABLES of
 * wordt tegen de doeltabel gecontroleerd.
 */
export function validateBundleFile(raw: unknown): BundleFile {
  if (!isPlainObject(raw) || typeof raw.sha256 !== 'string' || !isPlainObject(raw.bundle)) {
    throw new TransferError('Dit is geen doelenboom-bundel (sha256 of bundle ontbreekt).');
  }
  const b = raw.bundle;
  if (b.format !== BUNDLE_FORMAT) {
    throw new TransferError(`Bundelformaat ${String(b.format)} wordt niet ondersteund (verwacht ${BUNDLE_FORMAT}).`);
  }
  if (typeof b.schemaVersion !== 'string' || typeof b.exportedAt !== 'string') {
    throw new TransferError('Bundel is onvolledig (schemaVersion of exportedAt ontbreekt).');
  }
  const source = b.source;
  if (
    !isPlainObject(source) || !isPlainObject(source.tenant) || !isPlainObject(source.doelenboom) ||
    !isName(source.tenant.slug, TRANSFER_LIMITS.slugLength) || !isName(source.tenant.name, TRANSFER_LIMITS.nameLength) ||
    !isName(source.doelenboom.slug, TRANSFER_LIMITS.slugLength) || !isName(source.doelenboom.name, TRANSFER_LIMITS.nameLength) ||
    !Array.isArray(source.tenant.modules) || !source.tenant.modules.every((m) => typeof m === 'string' && IDENT_RE.test(m.replace(/-/g, '_'))) ||
    !isPlainObject(source.doelenboom.settings)
  ) {
    throw new TransferError('Bundel is onvolledig of ongeldig (gegevens over de bron).');
  }
  if (b.columnConfig !== null && !isPlainObject(b.columnConfig)) {
    throw new TransferError('Bundel is ongeldig (kolomconfiguratie).');
  }
  for (const key of Object.keys(b.columnConfig ?? {})) {
    if (!CONFIG_COLUMNS.includes(key)) throw new TransferError(`Bundel is ongeldig (onbekend veld ${key.slice(0, 40)} in de kolomconfiguratie).`);
  }
  for (const key of Object.keys(source.doelenboom.settings)) {
    if (!DOELENBOOM_SETTINGS.includes(key)) throw new TransferError(`Bundel is ongeldig (onbekende instelling ${key.slice(0, 40)}).`);
  }
  if (!isPlainObject(b.tables)) throw new TransferError('Bundel is ongeldig (tabellen ontbreken).');
  for (const name of Object.keys(b.tables)) {
    if (!TABLE_NAMES.includes(name)) throw new TransferError(`Bundel bevat een onbekende tabel (${name.slice(0, 40)}).`);
  }
  for (const name of TABLE_NAMES) {
    const rows = b.tables[name];
    if (!Array.isArray(rows)) throw new TransferError(`Bundel is ongeldig (tabel ${name} ontbreekt).`);
    if (rows.length > TRANSFER_LIMITS.rowsPerTable) throw new TransferError(`Bundel is te groot (tabel ${name}: ${rows.length} rijen).`);
    for (const row of rows) {
      if (!isPlainObject(row)) throw new TransferError(`Bundel is ongeldig (tabel ${name} bevat iets anders dan rijen).`);
      for (const key of Object.keys(row)) {
        if (!IDENT_RE.test(key)) throw new TransferError(`Bundel is ongeldig (kolomnaam in tabel ${name}).`);
      }
    }
  }
  if ((b.tables.elements as unknown[]).length > TRANSFER_LIMITS.elements) {
    throw new TransferError(`Bundel is te groot (${(b.tables.elements as unknown[]).length} elementen; maximum ${TRANSFER_LIMITS.elements}).`);
  }
  const bundle = b as unknown as Bundle;
  if (bundleChecksum(bundle) !== raw.sha256) {
    throw new TransferError('De controlesom van de bundel klopt niet: het bestand is beschadigd of gewijzigd.');
  }
  return { sha256: raw.sha256, bundle };
}

// ---- importeren -----------------------------------------------------------

export interface ImportTarget {
  /** Naam of slug van de tenant op de doelomgeving. */
  tenant: string;
  tenantSlug?: string;
  /** Naam of slug van de doelenboom op de doelomgeving. */
  boom: string;
  boomSlug?: string;
}

export interface ImportOptions {
  overwrite: boolean;
  adminEmail: string;
}

export interface ImportResult {
  tenant: { id: number; slug: string; name: string; created: boolean; modulesEnabled: string[]; modulesMissing: string[] };
  doelenboom: { id: number; slug: string; name: string; created: boolean; overwritten: boolean; removed: Record<string, number> };
  admin: { email: string; addedAsAdmin: boolean; existingRole: string | null };
  counts: Record<string, number>;
}

async function countsFor(client: PoolClient, doelenboomId: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const spec of TRANSFER_TABLES) {
    const r = await client.query(`select count(*)::int as n from ${quote(spec.table)} t where ${spec.where}`, [doelenboomId]);
    counts[spec.table] = r.rows[0].n;
  }
  return counts;
}

/**
 * Zet een bundel in de database van DEZE omgeving. Draait binnen de
 * transactie van de aanroeper: gooit deze functie, dan moet de aanroeper
 * terugdraaien en is er niets veranderd. Een proefrun is dus: uitvoeren en
 * daarna altijd terugdraaien.
 */
export async function importBundle(
  client: PoolClient, file: BundleFile, target: ImportTarget, options: ImportOptions
): Promise<ImportResult> {
  const { bundle } = file;
  for (const [what, value, max] of [
    ['De tenant', target.tenant, TRANSFER_LIMITS.nameLength], ['De doelenboom', target.boom, TRANSFER_LIMITS.nameLength],
    ['De tenant-slug', target.tenantSlug ?? 'x', TRANSFER_LIMITS.slugLength], ['De doelenboom-slug', target.boomSlug ?? 'x', TRANSFER_LIMITS.slugLength],
  ] as const) {
    if (!isName(value, max)) throw new TransferError(`${what} op de doelomgeving is leeg of te lang.`);
  }

  const here = await schemaVersion(client);
  if (here !== bundle.schemaVersion) {
    throw new TransferError(
      `De databaseversie verschilt: de bundel komt van "${bundle.schemaVersion}", deze omgeving staat op "${here}". ` +
        'Breng beide omgevingen eerst op dezelfde versie (migraties) en exporteer opnieuw.'
    );
  }

  const admin = await client.query('select id from users where lower(email) = lower($1)', [options.adminEmail]);
  if (admin.rows.length === 0) {
    throw new TransferError(
      `Het account ${options.adminEmail} bestaat niet op deze omgeving. Maak het eerst aan; dit script maakt geen accounts.`
    );
  }
  const adminId = Number(admin.rows[0].id);

  // -- tenant: bestaande gebruiken (op naam of slug) of aanmaken
  const tenantSlugWanted = target.tenantSlug ?? null;
  const tenants = await client.query(
    'select id, slug, name, terminated_at from tenants where slug = $1 or name = $1 or slug = $2',
    [target.tenant, tenantSlugWanted]
  );
  if (tenants.rows.length > 1) {
    throw new TransferError(
      `Tenant "${target.tenant}" is op de doelomgeving niet eenduidig: ` +
        `${tenants.rows.map((t) => `${t.name} (slug ${t.slug})`).join(', ')}. Geef --naar-tenant-slug op.`
    );
  }
  let tenant: { id: number; slug: string; name: string };
  let tenantCreated = false;
  const modulesEnabled: string[] = [];
  let modulesMissing: string[] = [];
  if (tenants.rows.length === 1) {
    if (tenants.rows[0].terminated_at) throw new TransferError(`Tenant "${tenants.rows[0].name}" is beëindigd op de doelomgeving.`);
    tenant = { id: Number(tenants.rows[0].id), slug: tenants.rows[0].slug, name: tenants.rows[0].name };
    const active = await client.query(
      `select m.key from tenant_modules tm join modules m on m.id = tm.module_id
       where tm.tenant_id = $1 and (tm.end_date is null or tm.end_date >= current_date)`,
      [tenant.id]
    );
    const have = new Set(active.rows.map((r) => r.key as string));
    modulesMissing = bundle.source.tenant.modules.filter((m) => !have.has(m));
  } else {
    const slug = tenantSlugWanted ?? slugify(target.tenant);
    const created = await client.query(
      'insert into tenants (slug, name, license_end_date) values ($1, $2, $3) returning id, slug, name',
      [slug, target.tenant, computeDefaultLicenseEndDate(new Date())]
    );
    tenant = { id: Number(created.rows[0].id), slug: created.rows[0].slug, name: created.rows[0].name };
    tenantCreated = true;
    await createTenantDefaultConfig(client, tenant.id, tenant.name);
    for (const key of bundle.source.tenant.modules) {
      const mod = await client.query('select id from modules where key = $1', [key]);
      if (mod.rows.length === 0) {
        modulesMissing.push(key);
        continue;
      }
      await client.query('insert into tenant_modules (tenant_id, module_id) values ($1, $2) on conflict do nothing', [tenant.id, mod.rows[0].id]);
      modulesEnabled.push(key);
    }
  }

  // -- admin: toevoegen als hij nog geen lid is; een bestaande rol blijft staan
  const member = await client.query('select role from tenant_users where tenant_id = $1 and user_id = $2', [tenant.id, adminId]);
  const existingRole = (member.rows[0]?.role as string | undefined) ?? null;
  if (!existingRole) {
    await client.query(`insert into tenant_users (tenant_id, user_id, role) values ($1, $2, 'admin')`, [tenant.id, adminId]);
  }

  // -- doelenboom: bestaande (alleen met overwrite) of nieuw
  const boomSlugWanted = target.boomSlug ?? null;
  const bomen = await client.query(
    'select id, slug, name, archived_at from doelenbomen where tenant_id = $1 and (slug = $2 or name = $2 or slug = $3)',
    [tenant.id, target.boom, boomSlugWanted]
  );
  if (bomen.rows.length > 1) {
    throw new TransferError(
      `Doelenboom "${target.boom}" is in tenant ${tenant.name} niet eenduidig: ` +
        `${bomen.rows.map((d) => `${d.name} (slug ${d.slug})`).join(', ')}. Geef --naar-boom-slug op.`
    );
  }
  let boom: { id: number; slug: string; name: string };
  let boomCreated = false;
  let removed: Record<string, number> = {};
  if (bomen.rows.length === 1) {
    const existing = bomen.rows[0];
    if (!options.overwrite) {
      throw new TransferError(
        `Doelenboom "${existing.name}" (slug ${existing.slug}) bestaat al in tenant ${tenant.name}. ` +
          'Gebruik --overschrijven om de inhoud te vervangen.'
      );
    }
    if (existing.archived_at) throw new TransferError(`Doelenboom "${existing.name}" is gearchiveerd; haal hem eerst uit het archief.`);
    boom = { id: Number(existing.id), slug: existing.slug, name: existing.name };
    removed = await countsFor(client, boom.id);
    // Elementen nemen via cascade hun relaties, koppelingen, status,
    // afwijkingen, kenmerkwaarden, producten en activiteiten mee.
    await client.query('delete from elements where doelenboom_id = $1', [boom.id]);
    await client.query('delete from tags where doelenboom_id = $1', [boom.id]);
    await client.query('delete from org_units where doelenboom_id = $1', [boom.id]);
    await client.query(`delete from column_configs where scope = 'doelenboom' and doelenboom_id = $1`, [boom.id]);
  } else {
    const slug = boomSlugWanted ?? slugify(target.boom);
    const created = await client.query(
      `insert into doelenbomen (tenant_id, slug, name) values ($1, $2, $3) returning id, slug, name`,
      [tenant.id, slug, target.boom]
    );
    boom = { id: Number(created.rows[0].id), slug: created.rows[0].slug, name: created.rows[0].name };
    boomCreated = true;
    const settings = bundle.source.doelenboom.settings;
    if (Object.keys(settings).length > 0) {
      const meta = await tableMeta(client, 'doelenbomen');
      const cols = Object.keys(settings).filter((k) => meta.columns.has(k));
      if (cols.length > 0) {
        await client.query(
          `update doelenbomen d set (${cols.map(quote).join(', ')}) =
             (select ${cols.map((c) => `r.${quote(c)}`).join(', ')} from jsonb_populate_record(null::doelenbomen, $2::jsonb) r)
           where d.id = $1`,
          [boom.id, JSON.stringify(settings)]
        );
      }
    }
    // Net als bij dupliceren: geen tier-limiet (beheerdersactie), wel de teller.
    await incrementLifetimeTreesCreated(client, tenant.id);
  }

  // -- kolomconfiguratie van de boom
  const cfg = await client.query(
    `insert into column_configs (scope, tenant_id, doelenboom_id) values ('doelenboom', $1, $2) returning id`,
    [tenant.id, boom.id]
  );
  const configId = Number(cfg.rows[0].id);
  if (bundle.columnConfig) {
    const meta = await tableMeta(client, 'column_configs');
    const cols = Object.keys(bundle.columnConfig).filter((k) => meta.columns.has(k));
    if (cols.length > 0) {
      await client.query(
        `update column_configs c set (${cols.map(quote).join(', ')}) =
           (select ${cols.map((c) => `r.${quote(c)}`).join(', ')} from jsonb_populate_record(null::column_configs, $2::jsonb) r)
         where c.id = $1`,
        [configId, JSON.stringify(bundle.columnConfig)]
      );
    }
  }

  // -- inhoud, tabel voor tabel, met nieuwe id's
  const maps: Record<MapName, Map<string, number>> = {
    element: new Map(), tag: new Map(), org: new Map(), product: new Map(), activity: new Map(),
  };
  for (const spec of TRANSFER_TABLES) {
    const meta = await tableMeta(client, spec.table);
    assertReferencesCovered(spec, meta);
    const userColumns = [...meta.references].filter(([, t]) => t === 'users').map(([c]) => c);
    for (const source of bundle.tables[spec.table]) {
      const row: Row = { ...source };
      const oldId = row.id;
      delete row.id;
      for (const column of userColumns) row[column] = null;
      for (const [column, kind] of Object.entries(spec.fk)) {
        if (kind === 'doelenboom') row[column] = boom.id;
        else if (kind === 'config') row[column] = configId;
        else {
          const mapped = maps[kind].get(String(row[column]));
          if (mapped === undefined) {
            throw new TransferError(`Bundel is inconsistent: tabel ${spec.table} verwijst via ${column} naar een rij die niet in de bundel zit.`);
          }
          row[column] = mapped;
        }
      }
      const columns = Object.keys(row);
      for (const column of columns) {
        if (!meta.columns.has(column)) {
          throw new TransferError(`Bundel past niet op deze omgeving: tabel ${spec.table} heeft hier geen kolom ${column}.`);
        }
      }
      const list = columns.map(quote).join(', ');
      const inserted = await client.query(
        `insert into ${quote(spec.table)} (${list})
         select ${list} from jsonb_populate_record(null::${quote(spec.table)}, $1::jsonb)
         ${spec.noId ? '' : 'returning id'}`,
        [JSON.stringify(row)]
      );
      if (spec.map) {
        if (oldId === undefined || oldId === null) throw new TransferError(`Bundel is ongeldig: een rij in ${spec.table} heeft geen id.`);
        maps[spec.map].set(String(oldId), Number(inserted.rows[0].id));
      }
    }
  }

  // -- natellen: wat er nu staat moet precies de bundel zijn
  const expected = bundleCounts(bundle);
  const counts = await countsFor(client, boom.id);
  for (const name of TABLE_NAMES) {
    if (counts[name] !== expected[name]) {
      throw new TransferError(`Controle na het importeren faalt: tabel ${name} heeft ${counts[name]} rijen, de bundel ${expected[name]}.`);
    }
  }

  // -- auditregel (OWASP A09): wie, welke boom en aantallen; geen inhoud.
  // Bestaand type 'doelenboom_import_published', zodat er geen migratie nodig is.
  await client.query(
    `insert into audit_log (event_type, user_id, tenant_id, doelenboom_id, detail)
     values ('doelenboom_import_published', $1, $2, $3, $4)`,
    [
      adminId, tenant.id, boom.id,
      JSON.stringify({
        kind: 'omgeving-kopie',
        overwritten: !boomCreated,
        tenantCreated,
        sourceTenantSlug: bundle.source.tenant.slug,
        sourceDoelenboomSlug: bundle.source.doelenboom.slug,
        sha256: file.sha256.slice(0, 16),
        counts,
      }),
    ]
  );

  return {
    tenant: { ...tenant, created: tenantCreated, modulesEnabled, modulesMissing },
    doelenboom: { ...boom, created: boomCreated, overwritten: !boomCreated, removed },
    admin: { email: options.adminEmail, addedAsAdmin: !existingRole, existingRole },
    counts,
  };
}
