// Nachtelijke reset van tenant "Demo": zet ALLES in deze tenant terug naar de
// momentopname die snapshotDemoTenant.ts heeft vastgelegd -- inclusief een
// eventuele doelenboom die een demo-bezoeker die dag zelf heeft aangemaakt
// (die verdwijnt dan ook weer, precies zoals bedoeld: de tenant Demo is elke
// ochtend weer exact hetzelfde uitgangspunt). Andere tenants (zoals kmar)
// worden niet aangeraakt.
//
// Gepland via cron op de VPS (zie deploy/reset-demo.sh en deploy/README.md,
// sectie "Nachtelijke reset van tenant Demo") -- draait binnen de al-
// lopende api-container, geen herstart nodig, zelfde patroon als
// exportAllDoelenbomen.ts. Mag ook altijd handmatig gedraaid worden, ook
// overdag: idempotent, eindigt altijd exact in de snapshot-staat, ongeacht
// wat er op dat moment in de tenant staat.
//
// Vervangt het oude, aan doelenboom 'gezond-ouder' gebonden reset-demo.sql
// (met per-element hardgecodeerde INSERT-statements) -- dit werkt nu
// generiek voor de hele tenant, ongeacht hoeveel/welke doelenbomen erin
// zitten. Zie snapshotDemoTenant.ts voor hoe/wanneer de momentopname zelf
// wordt vastgelegd (nooit door dit script -- dit script leest 'm alleen).
import { pool } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';

// Zelfde BACKUP_DIR/bestandsnaam als snapshotDemoTenant.ts -- bewust hier
// gedupliceerd i.p.v. geïmporteerd: dat andere script voert bij het inladen
// zelf meteen main() uit (het is een zelfstandig te draaien script, geen
// module), dus importeren ervan zou het per ongeluk laten meedraaien.
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const SNAPSHOT_PATH = path.join(BACKUP_DIR, 'demo-tenant-snapshot.json');

// Restore-volgorde: ouders vóór kinderen (foreign keys) -- zelfde volgorde
// als de vastlegging in snapshotDemoTenant.ts, zie db/init.sql voor het
// schema.
const RESTORE_ORDER = [
  'doelenbomen',
  'column_configs',
  'columns',
  'elements',
  'edges',
  'tags',
  'org_units',
  'doelenboom_user_roles',
  'excel_imports',
  'element_tags',
  'ob_org_relations',
  'project_status',
  'project_history',
  'products',
  'product_dependencies',
  'activities',
  'activity_dependencies',
];

type Row = Record<string, unknown>;
type Snapshot = { createdAt: string; tables: Record<string, Row[]> };

async function insertRow(client: import('pg').PoolClient, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const columnList = columns.map((c) => `"${c}"`).join(', ');
  await client.query(`insert into ${table} (${columnList}) values (${placeholders})`, values);
}

async function main() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Geen momentopname gevonden op ${SNAPSHOT_PATH} -- draai eerst scripts/snapshotDemoTenant.ts (zie deploy/snapshot-demo-tenant.sh).`
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  console.log(`[reset-demo] momentopname van ${snapshot.createdAt} wordt toegepast`);

  const client = await pool.connect();
  try {
    await client.query('begin');

    const tenantRes = await client.query<{ id: number }>(`select id from tenants where slug = 'demo'`);
    if (tenantRes.rowCount === 0) throw new Error(`Tenant 'demo' niet gevonden.`);
    const tenantId = tenantRes.rows[0].id;

    // Verwijdert -- via ON DELETE CASCADE (zie db/init.sql) -- in één klap
    // ook alle elementen/relaties/tags/organisatieonderdelen/project-info/
    // eigen kolomconfiguraties van elke doelenboom in deze tenant, dus die
    // onderliggende tabellen hoeven hier niet apart geleegd te worden. De
    // tenant-brede standaardkolomconfiguratie (column_configs met
    // scope='tenant_default') hangt rechtstreeks aan de tenant, niet aan een
    // doelenboom, en cascadet dus NIET mee -- expliciet apart verwijderen.
    await client.query(`delete from doelenbomen where tenant_id = $1`, [tenantId]);
    await client.query(`delete from column_configs where tenant_id = $1`, [tenantId]);

    let totalRows = 0;
    for (const table of RESTORE_ORDER) {
      const rows = snapshot.tables[table] ?? [];
      for (const row of rows) {
        await insertRow(client, table, row);
      }
      totalRows += rows.length;
      console.log(`[reset-demo] ${table}: ${rows.length} rijen hersteld`);
    }

    await client.query('commit');
    console.log(`[reset-demo] klaar -- ${totalRows} rijen hersteld, tenant Demo staat weer op de momentopname van ${snapshot.createdAt}.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[reset-demo] onverwachte fout:', err);
  process.exitCode = 1;
});
