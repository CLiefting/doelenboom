// Zet de test-database (standaard "doelenboom_test") terug naar een schone
// lei op basis van db/init.sql — draait automatisch vóór `npm test` (zie de
// "pretest"-npm-script in package.json), zodat elke testrun met een
// gegarandeerd leeg, actueel schema begint en nooit per ongeluk tegen de
// lokale ontwikkel-database (met jouw eigen data) aanloopt.
//
// Verbindt eerst met de "onderhouds"-database (POSTGRES_ADMIN_URL, standaard
// de gewone lokale dev-db uit docker-compose.yml) om de test-database te
// kunnen droppen/aanmaken — dat kan niet vanuit een connectie mét die
// database zelf. Voert daarna db/init.sql letterlijk uit tegen de nieuwe,
// lege test-database (geen aparte kopie van het schema hier — één bron van
// waarheid).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const ADMIN_URL =
  process.env.POSTGRES_ADMIN_URL ?? 'postgres://doelenboom:doelenboom@localhost:5432/doelenboom';
const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'doelenboom_test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const initSqlPath = path.resolve(__dirname, '../../db/init.sql');

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // Actieve connecties op de test-db afkappen vóór het droppen — anders
    // faalt DROP DATABASE als een vorige testrun nog niet netjes is afgesloten.
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [TEST_DB_NAME]
    );
    await admin.query(`drop database if exists ${admin.escapeIdentifier(TEST_DB_NAME)}`);
    await admin.query(`create database ${admin.escapeIdentifier(TEST_DB_NAME)}`);
  } finally {
    await admin.end();
  }

  const testDbUrl = new URL(ADMIN_URL);
  testDbUrl.pathname = `/${TEST_DB_NAME}`;
  const testClient = new Client({ connectionString: testDbUrl.toString() });
  await testClient.connect();
  try {
    const initSql = readFileSync(initSqlPath, 'utf8');
    await testClient.query(initSql);
  } finally {
    await testClient.end();
  }

  console.log(`Test-database "${TEST_DB_NAME}" opnieuw opgezet vanuit ${initSqlPath}.`);
}

main().catch((err) => {
  console.error('Opzetten van test-database mislukt:', err);
  process.exit(1);
});
