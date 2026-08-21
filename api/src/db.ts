import pg from 'pg';

const { Pool, types } = pg;

// DATE-kolommen (products.verwachte_datum/werkelijke_datum, project_status.
// gerapporteerd_op) worden door pg standaard geparsed naar een JS Date-object
// op lokale middernacht van het proces waarin de API draait. Bij het
// terugsturen als JSON (JSON.stringify -> Date.toISOString()) wordt dat altijd
// naar UTC omgezet — in elke tijdzone vóór UTC (bv. Europe/Amsterdam) schuift
// een datum dan een dag terug (2026-12-01 wordt "2026-11-30T23:00:00.000Z").
// In de Docker-images (node:20-alpine/postgres:18-alpine, beide standaard UTC)
// is dit tot nu toe niet zichtbaar geworden, maar het is exact de kern van de
// datum-problemen die tree.html eerder dit project moest omzeilen
// (parseDateFlexible/toDateInputValue) — en zou gegarandeerd terugkomen zodra
// de API ooit op een niet-UTC machine draait (bv. rechtstreeks lokaal via
// `npm run dev` op een Nederlandse laptop, buiten Docker om). Simpelste,
// structurele fix: laat pg een date-kolom gewoon als de kale 'YYYY-MM-DD'-
// string teruggeven i.p.v. als Date-object — precies wat elke aanroeper
// (tree.ts, products.ts, projectStatus.ts, de frontend) toch al verwacht.
types.setTypeParser(types.builtins.DATE, (value) => value);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
