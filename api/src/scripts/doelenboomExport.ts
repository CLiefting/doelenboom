// Exporteert één doelenboom als bundel (DOEL-104). Aangeroepen door
// scripts/doelenboom-kopieer.sh op de BRON-omgeving:
//
//   node dist/scripts/doelenboomExport.js --tenant <naam|slug> --boom <naam|slug>
//
// De bundel (één regel JSON) gaat naar de standaarduitvoer; meldingen, de
// controlesom en de aantallen gaan naar de foutuitvoer, zodat de bundel
// schoon blijft. Leest alleen: er wordt niets in de database gewijzigd.
import { pool } from '../db.js';
import { exportBundle, bundleCounts, TransferError } from '../doelenboomTransfer.js';
import { countsLine, parseFlags, reportFailure } from './transferCli.js';

const P = '[doelenboom-export]';

async function main() {
  const { values } = parseFlags(process.argv.slice(2), { values: ['--tenant', '--boom'], switches: [] });
  const tenant = values['--tenant'];
  const boom = values['--boom'];
  if (!tenant || !boom) throw new TransferError('Gebruik: doelenboomExport --tenant <naam|slug> --boom <naam|slug>');

  const client = await pool.connect();
  let file;
  try {
    // Eén momentopname: alle tabellen worden op hetzelfde tijdstip gelezen.
    await client.query('begin transaction isolation level repeatable read read only');
    file = await exportBundle(client, { tenant, boom });
    await client.query('rollback');
  } finally {
    client.release();
  }
  const { source } = file.bundle;
  console.error(`${P} bron: tenant "${source.tenant.name}" (slug ${source.tenant.slug}), doelenboom "${source.doelenboom.name}" (slug ${source.doelenboom.slug})`);
  console.error(`${P} databaseversie: ${file.bundle.schemaVersion}`);
  console.error(`${P} ${countsLine(bundleCounts(file.bundle))}`);
  console.error(`${P} SHA256 ${file.sha256}`);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(file)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

main()
  .catch((err) => reportFailure(P, err))
  .finally(() => pool.end());
