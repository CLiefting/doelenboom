// Importeert een bundel van doelenboomExport.ts in DEZE omgeving (DOEL-104).
// Aangeroepen door scripts/doelenboom-kopieer.sh op de DOEL-omgeving:
//
//   node dist/scripts/doelenboomImport.js --naar-tenant <naam> --naar-boom <naam> --admin <e-mail>
//        [--naar-tenant-slug <slug>] [--naar-boom-slug <slug>] [--overschrijven] [--dry-run]  < bundel.json
//
// Alles gebeurt in één transactie. Met --dry-run wordt de import volledig
// uitgevoerd (inclusief alle controles van de database) en daarna
// teruggedraaid: wat de proefrun meldt is dus precies wat de echte run doet.
import { pool } from '../db.js';
import { importBundle, validateBundleFile, TransferError, TRANSFER_LIMITS, TRANSFER_TABLES } from '../doelenboomTransfer.js';
import { countsLine, parseFlags, reportFailure } from './transferCli.js';

const P = '[doelenboom-import]';

async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    // OWASP A04: niet onbegrensd in het geheugen laden.
    if (size > maxBytes) throw new TransferError(`De bundel is groter dan ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { values, switches } = parseFlags(process.argv.slice(2), {
    values: ['--naar-tenant', '--naar-boom', '--naar-tenant-slug', '--naar-boom-slug', '--admin'],
    switches: ['--overschrijven', '--dry-run'],
  });
  const tenant = values['--naar-tenant'];
  const boom = values['--naar-boom'];
  const adminEmail = values['--admin'];
  if (!tenant || !boom || !adminEmail) {
    throw new TransferError('Gebruik: doelenboomImport --naar-tenant <naam> --naar-boom <naam> --admin <e-mail> [--overschrijven] [--dry-run] < bundel.json');
  }
  for (const key of ['--naar-tenant-slug', '--naar-boom-slug']) {
    const slug = values[key];
    if (slug !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      throw new TransferError(`${key} mag alleen kleine letters, cijfers en streepjes bevatten.`);
    }
  }
  const dryRun = switches.has('--dry-run');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readStdin(TRANSFER_LIMITS.bytes));
  } catch (err) {
    if (err instanceof TransferError) throw err;
    throw new TransferError('De bundel is geen geldige JSON (leeg of afgebroken bestand?).');
  }
  const file = validateBundleFile(parsed);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await importBundle(
      client, file,
      { tenant, tenantSlug: values['--naar-tenant-slug'], boom, boomSlug: values['--naar-boom-slug'] },
      { overwrite: switches.has('--overschrijven'), adminEmail }
    );
    await client.query(dryRun ? 'rollback' : 'commit');

    const say = (line: string) => console.log(`${P} ${line}`);
    const will = (done: string, plan: string) => (dryRun ? plan : done);
    say(dryRun ? 'PROEFRUN: alles is uitgevoerd en teruggedraaid; er is niets gewijzigd.' : 'Import vastgelegd.');
    say(`bron: tenant "${file.bundle.source.tenant.name}", doelenboom "${file.bundle.source.doelenboom.name}" (geëxporteerd ${file.bundle.exportedAt})`);
    say(result.tenant.created
      ? `tenant "${result.tenant.name}" (slug ${result.tenant.slug}): ${will('AANGEMAAKT', 'WORDT AANGEMAAKT')}, modules: ${result.tenant.modulesEnabled.join(', ') || 'geen'}`
      : `tenant "${result.tenant.name}" (slug ${result.tenant.slug}): bestaat al`);
    if (result.tenant.modulesMissing.length > 0) {
      say(result.tenant.created
        ? `LET OP: deze modules van de bron bestaan hier niet en zijn niet aangezet: ${result.tenant.modulesMissing.join(', ')}`
        : `LET OP: de bron heeft modules die deze tenant niet heeft (niet gewijzigd): ${result.tenant.modulesMissing.join(', ')}`);
    }
    say(result.admin.addedAsAdmin
      ? `${result.admin.email}: ${will('toegevoegd', 'wordt toegevoegd')} als admin van de tenant`
      : `${result.admin.email}: is al lid van de tenant (rol ${result.admin.existingRole}); niet gewijzigd`);
    if (result.doelenboom.created) {
      say(`doelenboom "${result.doelenboom.name}" (slug ${result.doelenboom.slug}): ${will('AANGEMAAKT', 'WORDT AANGEMAAKT')}`);
    } else {
      const removed = TRANSFER_TABLES.map((t) => `${t.table}=${result.doelenboom.removed[t.table] ?? 0}`).join(' ');
      say(`doelenboom "${result.doelenboom.name}" (slug ${result.doelenboom.slug}): bestaat al, inhoud ${will('VERVANGEN', 'WORDT VERVANGEN')}`);
      say(`${will('verwijderd', 'wordt verwijderd')}: ${removed}`);
    }
    say(countsLine(result.counts));
    say(`SHA256 ${file.sha256}`);
    say(dryRun ? 'PROEFRUN-OK' : 'IMPORT-OK');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => reportFailure(P, err))
  .finally(() => pool.end());
