// Gedeelde hulpjes voor doelenboomExport.ts en doelenboomImport.ts (DOEL-104).
import { TRANSFER_TABLES, TransferError } from '../doelenboomTransfer.js';

export interface FlagSpec {
  /** Opties met een waarde, bv. '--tenant'. */
  values: string[];
  /** Schakelaars zonder waarde, bv. '--dry-run'. */
  switches: string[];
}

/** Leest '--naam waarde' en '--schakelaar'; onbekende of dubbele opties zijn een fout. */
export function parseFlags(argv: string[], spec: FlagSpec): { values: Record<string, string>; switches: Set<string> } {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (spec.switches.includes(arg)) {
      switches.add(arg);
    } else if (spec.values.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new TransferError(`Optie ${arg} mist een waarde.`);
      if (arg in values) throw new TransferError(`Optie ${arg} is twee keer opgegeven.`);
      values[arg] = value;
      i += 1;
    } else {
      throw new TransferError(`Onbekende optie: ${arg.slice(0, 60)}`);
    }
  }
  return { values, switches };
}

/** Eén regel met de aantallen per tabel, in vaste volgorde: het kopieerscript vergelijkt bron en doel hierop. */
export function countsLine(counts: Record<string, number>): string {
  return `TELLING ${TRANSFER_TABLES.map((t) => `${t.table}=${counts[t.table] ?? 0}`).join(' ')}`;
}

/** Meldt een fout zonder stacktrace of databasedetails (OWASP A09/A05) en zet de exitcode. */
export function reportFailure(prefix: string, err: unknown) {
  if (err instanceof TransferError) {
    console.error(`${prefix} FOUT: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const e = err as { code?: string; constraint?: string; message?: string };
  const hint = e?.code ? ` (databasecode ${e.code}${e.constraint ? `, ${e.constraint}` : ''})` : '';
  console.error(`${prefix} FOUT: onverwachte fout${hint}. Er is niets gewijzigd.`);
  if (process.env.DOELENBOOM_KOPIEER_DEBUG === '1') console.error(err);
  process.exitCode = 1;
}
