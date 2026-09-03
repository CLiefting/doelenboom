// Nachtelijke back-up: exporteert elke doelenboom als .xlsx naar schijf, met
// een oplopende bewaartermijn (dagelijks -> wekelijks -> maandelijks). Gepland
// via cron op de VPS (zie deploy/export-all-doelenbomen.sh en
// deploy/README.md, sectie "Nachtelijke Excel-backup"), niet als HTTP-route:
// dit script draait binnen de api-container (`node dist/scripts/
// exportAllDoelenbomen.js`) en hergebruikt daardoor gewoon dezelfde
// database-pool/fetchTree/excel-service-aanroep als de bestaande
// GET /:id/export-route (routes/exports.ts) — geen aparte auth/token nodig,
// en de export blijft gegarandeerd exact hetzelfde bestand als een gebruiker
// zelf handmatig zou downloaden.
//
// Bewaarbeleid per doelenboom (toegepast op de bestanden die na het schrijven
// van vannacht se export op schijf staan — dus idempotent, onafhankelijk van
// wat eerdere nachten precies bewaard hebben):
//   - jonger dan 30 dagen: alles bewaren (1 per nacht)
//   - 30 dagen tot 1 jaar oud: alleen zondagen bewaren (1 per week)
//   - 1 jaar of ouder: alleen de eerste zondag van de maand bewaren (1 per
//     maand), voor altijd
import { pool } from '../db.js';
import { fetchTree } from '../routes/tree.js';
import { isStandardColumns } from '../columnConfig.js';
import fs from 'node:fs';
import path from 'node:path';

const EXCEL_SERVICE_URL = process.env.EXCEL_SERVICE_URL ?? 'http://excel-service:8000';
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';

const sanitizeForFilename = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'onbekend';

// YYYY-MM-DD in lokale tijd van het proces (de container draait op UTC, en
// cron plant dit om 01:00 — zie deploy/README.md; dat valt in geen enkele
// Nederlandse tijdzone-situatie op een andere kalenderdag dan "vannacht").
function todayIso(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isFirstSundayOfMonth(d: Date): boolean {
  return d.getUTCDay() === 0 && d.getUTCDate() <= 7;
}

// Bepaalt of een backup-bestand met deze datum (t.o.v. "vandaag") bewaard
// moet blijven volgens het bewaarbeleid hierboven.
function shouldKeep(fileDateIso: string, todayIsoStr: string): boolean {
  const fileDate = parseIsoDateUtc(fileDateIso);
  const today = parseIsoDateUtc(todayIsoStr);
  const ageDays = Math.round((today.getTime() - fileDate.getTime()) / 86400000);
  if (ageDays < 30) return true;
  if (ageDays < 365) return fileDate.getUTCDay() === 0;
  return isFirstSundayOfMonth(fileDate);
}

async function exportOneDoelenboom(
  doelenboomId: number,
  tenantSlug: string,
  doelenboomSlug: string,
  todayIsoStr: string
): Promise<void> {
  const tree = await fetchTree(String(doelenboomId));
  if (!tree) {
    console.error(`[export-all] doelenboom ${doelenboomId} niet gevonden (overgeslagen)`);
    return;
  }

  // Zelfde regel als exports.ts: het "oud" formaat werkt alleen bij precies
  // de 8 standaardkolommen, anders "nieuw".
  const format = isStandardColumns(tree.columns) ? 'oud' : 'nieuw';
  const meta = {
    doelenboom: tree.doelenboom.name,
    tenant: tree.doelenboom.tenant.name,
    exportedAt: new Date().toISOString(),
    exportedBy: 'nachtelijke-backup',
  };
  const body = JSON.stringify({ tree, columns: tree.columns, meta });

  const upstream = await fetch(`${EXCEL_SERVICE_URL}/export?format=${format}&mode=data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new Error(`excel-service gaf ${upstream.status} terug: ${text}`);
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());

  const dir = path.join(BACKUP_DIR, sanitizeForFilename(tenantSlug), sanitizeForFilename(doelenboomSlug));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeForFilename(doelenboomSlug)}_${todayIsoStr}.xlsx`);
  fs.writeFileSync(filePath, buffer);
  console.log(`[export-all] geschreven: ${filePath} (${buffer.byteLength} bytes)`);

  pruneDirectory(dir, doelenboomSlug, todayIsoStr);
}

// Ruimt oudere backups in één doelenboom-map op volgens shouldKeep() hierboven.
// Bestandsnamen die niet aan het verwachte patroon voldoen (bv. een handmatig
// bijgezet bestand) worden met rust gelaten — puur op safe-side, dit script
// verwijdert alleen bestanden waarvan het overtuigd is dat het z'n eigen
// eerder geschreven backup is.
function pruneDirectory(dir: string, doelenboomSlug: string, todayIsoStr: string): void {
  const prefix = `${sanitizeForFilename(doelenboomSlug)}_`;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{4}-\\d{2}-\\d{2})\\.xlsx$`);
  for (const entry of fs.readdirSync(dir)) {
    const match = entry.match(pattern);
    if (!match) continue;
    const fileDateIso = match[1];
    if (!shouldKeep(fileDateIso, todayIsoStr)) {
      fs.unlinkSync(path.join(dir, entry));
      console.log(`[export-all] verwijderd (buiten bewaartermijn): ${path.join(dir, entry)}`);
    }
  }
}

async function main() {
  const todayIsoStr = todayIso();
  // nightly_export_enabled (zie db/init.sql / db/migrations/
  // 0025_nightly_export_toggle.sql): per doelenboom instelbaar (PUT
  // /api/doelenbomen/:id, "Doelenbomen" in Tenantbeheer), default true zodat
  // een doelenboom niet per ongeluk buiten de back-up valt. Uitgezette
  // doelenbomen worden bewust WEL opgehaald (i.p.v. al in de where-clause
  // uitgefilterd) zodat ze in de telling hieronder als "overgeslagen"
  // meetellen, niet stilzwijgend ontbreken.
  const result = await pool.query<{ id: number; slug: string; tenant_slug: string; nightly_export_enabled: boolean }>(
    `select d.id, d.slug, t.slug as tenant_slug, d.nightly_export_enabled
     from doelenbomen d join tenants t on t.id = d.tenant_id
     order by t.slug, d.slug`
  );
  console.log(`[export-all] start — ${result.rows.length} doelenbomen, datum ${todayIsoStr}`);

  let failures = 0;
  let skipped = 0;
  for (const row of result.rows) {
    if (!row.nightly_export_enabled) {
      skipped += 1;
      console.log(`[export-all] overgeslagen (nachtelijke back-up uitgezet): ${row.tenant_slug}/${row.slug}`);
      continue;
    }
    try {
      await exportOneDoelenboom(row.id, row.tenant_slug, row.slug, todayIsoStr);
    } catch (err) {
      failures += 1;
      console.error(`[export-all] FOUT bij doelenboom ${row.id} (${row.tenant_slug}/${row.slug}):`, err);
    }
  }

  const attempted = result.rows.length - skipped;
  console.log(
    `[export-all] klaar — ${attempted - failures}/${attempted} geslaagd` +
      (skipped > 0 ? ` (${skipped} overgeslagen door uitgezette back-up)` : '')
  );
  await pool.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[export-all] onverwachte fout:', err);
  process.exitCode = 1;
});
