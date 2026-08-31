// Legt een generieke momentopname van tenant "Demo" vast, gebruikt door
// resetDemoTenant.ts om de tenant elke nacht (of op elk gewenst moment)
// terug te zetten naar exact deze staat.
//
// HANDMATIG draaien, nooit via cron -- alleen wanneer je de "vaste" demo-
// inhoud bewust wilt bijwerken (bv. na het toevoegen van een nieuwe
// voorbeeldboom, of na het aanpassen van bestaande inhoud die je wilt laten
// blijven staan). Zie deploy/snapshot-demo-tenant.sh en deploy/README.md.
//
// Vervangt het oude, handgeschreven deploy/reset-demo.sql (dat alleen de
// inhoud van doelenboom 'gezond-ouder' kende, met per-element hardgecodeerde
// INSERT-statements): dit script is generiek voor de HELE tenant Demo, dus
// een later toegevoegde doelenboom (of een aangepaste bestaande) wordt
// vanzelf meegenomen bij de eerstvolgende keer dat dit script opnieuw
// gedraaid wordt -- er hoeft nooit meer met de hand SQL bijgeschreven te
// worden.
//
// Elke tabel wordt met `select *` vastgelegd (i.p.v. een hardgecodeerde
// kolomlijst), zodat een toekomstige schemawijziging (nieuwe kolom) hier
// vanzelf meegaat -- alleen het WELKE-TABELLEN/WELKE-RIJEN (de where-filters
// hieronder) is met de hand vastgelegd, en moet je bijwerken als er ooit een
// nieuwe tenant-Demo-gebonden tabel bijkomt (zie db/init.sql voor het
// volledige schema/foreign-key-overzicht).
//
// Bewust NIET meegenomen: users/tenant_users (inlog-accounts van de demo-
// gebruikers blijven altijd bestaan, ook na een reset) en tenant_modules
// (licentie-/abonnementsinstellingen, geen "boom-inhoud").
import { pool } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';

const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const SNAPSHOT_PATH = path.join(BACKUP_DIR, 'demo-tenant-snapshot.json');

// Volgorde is tegelijk de restore-volgorde in resetDemoTenant.ts (ouders
// vóór kinderen i.v.m. foreign keys) -- zie db/init.sql.
const TABLES: { table: string; select: string }[] = [
  {
    table: 'doelenbomen',
    select: `select d.* from doelenbomen d join tenants t on t.id = d.tenant_id where t.slug = 'demo'`,
  },
  {
    // Zowel scope='tenant_default' (tenant-brede standaardkolommen) als
    // scope='doelenboom' (eigen kolomconfiguratie per boom) -- beide hangen
    // rechtstreeks aan tenant_id.
    table: 'column_configs',
    select: `select cc.* from column_configs cc join tenants t on t.id = cc.tenant_id where t.slug = 'demo'`,
  },
  {
    table: 'columns',
    select: `select c.* from columns c
             join column_configs cc on cc.id = c.column_config_id
             join tenants t on t.id = cc.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'elements',
    select: `select e.* from elements e
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'edges',
    select: `select ed.* from edges ed
             join doelenbomen d on d.id = ed.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'tags',
    select: `select tg.* from tags tg
             join doelenbomen d on d.id = tg.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'org_units',
    select: `select o.* from org_units o
             join doelenbomen d on d.id = o.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'doelenboom_user_roles',
    select: `select r.* from doelenboom_user_roles r
             join doelenbomen d on d.id = r.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'excel_imports',
    select: `select x.* from excel_imports x
             join doelenbomen d on d.id = x.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'element_tags',
    select: `select et.* from element_tags et
             join elements e on e.id = et.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'ob_org_relations',
    select: `select r.* from ob_org_relations r
             join elements e on e.id = r.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'project_status',
    select: `select p.* from project_status p
             join elements e on e.id = p.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'project_history',
    select: `select h.* from project_history h
             join elements e on e.id = h.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'products',
    select: `select p.* from products p
             join elements e on e.id = p.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    // predecessor/successor horen per definitie bij hetzelfde project-element
    // (afgedwongen in de API, zie routes/products.ts), dus filteren op de
    // predecessor-kant volstaat.
    table: 'product_dependencies',
    select: `select pd.* from product_dependencies pd
             join products p on p.id = pd.predecessor_id
             join elements e on e.id = p.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'activities',
    select: `select a.* from activities a
             join elements e on e.id = a.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
  {
    table: 'activity_dependencies',
    select: `select ad.* from activity_dependencies ad
             join activities a on a.id = ad.predecessor_id
             join elements e on e.id = a.element_id
             join doelenbomen d on d.id = e.doelenboom_id
             join tenants t on t.id = d.tenant_id
             where t.slug = 'demo'`,
  },
];

async function main() {
  const tenantCheck = await pool.query(`select id from tenants where slug = 'demo'`);
  if (tenantCheck.rowCount === 0) {
    throw new Error(`Tenant 'demo' niet gevonden -- niets vastgelegd.`);
  }

  const tables: Record<string, Record<string, unknown>[]> = {};
  let totalRows = 0;
  for (const { table, select } of TABLES) {
    const result = await pool.query(select);
    tables[table] = result.rows;
    totalRows += result.rowCount ?? 0;
    console.log(`[snapshot-demo] ${table}: ${result.rowCount} rijen`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const payload = { createdAt: new Date().toISOString(), tables };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[snapshot-demo] weggeschreven naar ${SNAPSHOT_PATH} (${totalRows} rijen totaal)`);
  await pool.end();
}

main().catch((err) => {
  console.error('[snapshot-demo] onverwachte fout:', err);
  process.exitCode = 1;
});
