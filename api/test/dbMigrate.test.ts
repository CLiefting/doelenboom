// Regressietests voor DOEL-99: migraties maar één keer per database draaien.
//
// Aanleiding (9 oktober 2026): `doelenboom -local -rebuild` draaide elke keer
// álle db/migrations/*.sql opnieuw. Migratie 0033 legt de check-constraint
// audit_log_event_type_check opnieuw vast met de lijst van toen; een database
// met nieuwere auditregels (bv. login_success) weigert dat, en -rebuild brak af.
//
// Fix: scripts/db-migrate.sh houdt in schema_migrations bij wat gedraaid is en
// draait alleen de rest. Deze tests draaien dat script echt, met psql tegen een
// eigen, losse database (niet de gedeelde test-database).
//
// Vereist psql. Zonder psql worden de databasetests overgeslagen, behalve als
// REQUIRE_MIGRATE_TESTS=1 (CI, zie .github/workflows/ci.yml): dan falen ze.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'db-migrate.sh');
const migrationsDir = path.join(repo, 'db', 'migrations');
const initSql = readFileSync(path.join(repo, 'db', 'init.sql'), 'utf8');
const NAME_RE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

const ADMIN_URL = process.env.POSTGRES_ADMIN_URL ?? 'postgres://doelenboom:doelenboom@localhost:5432/doelenboom';
const DB_NAME = 'doelenboom_migrate_test';
const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB_NAME}`; return u.toString(); })();

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

describe('DOEL-99: migratiebestanden en init.sql', () => {
  it('elke migratie heeft een geldige naam (NNNN_naam.sql, alleen a-z, 0-9 en _)', () => {
    for (const f of migrationFiles) assert.match(f, NAME_RE, f);
  });

  it('migratienummers zijn uniek', () => {
    const nums = migrationFiles.map((f) => f.slice(0, 4));
    assert.equal(new Set(nums).size, nums.length, `dubbel nummer in ${nums.join(',')}`);
  });

  it('init.sql registreert precies alle migraties als "init" (anders draait een verse database ze nog eens)', () => {
    const block = initSql.match(/insert into schema_migrations \(filename, method\) values([\s\S]*?)on conflict do nothing;/);
    assert.ok(block, 'insert into schema_migrations ontbreekt in db/init.sql');
    const listed = [...block[1].matchAll(/\('([^']+)', 'init'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed, migrationFiles, 'voeg de nieuwe migratie toe aan de schema_migrations-lijst onderaan db/init.sql');
  });
});

function psqlAvailable(): string | null {
  if (spawnSync('sh', ['-c', 'command -v psql']).status !== 0) return 'psql ontbreekt';
  return null;
}
const missing = psqlAvailable();
const skip = missing && process.env.REQUIRE_MIGRATE_TESTS !== '1' ? `${missing} (zet REQUIRE_MIGRATE_TESTS=1 om dit te laten falen)` : false;

function migrate(args: string[], dir = migrationsDir) {
  const r = spawnSync('bash', [script, ...args], {
    cwd: repo,
    env: { ...process.env, DB_MIGRATE_PSQL: `psql ${dbUrl}`, DB_MIGRATIONS_DIR: dir },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function freshDbFromInit() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [DB_NAME]);
    await admin.query(`drop database if exists ${DB_NAME}`);
    await admin.query(`create database ${DB_NAME}`);
  } finally { await admin.end(); }
  await withDb((c) => c.query(initSql));
}

// Een bestaande database van vóór DOEL-99: volledig schema, géén boekhouding,
// en auditregels van types die 0033 nog niet kende.
async function legacyDbWithNewerAuditRows() {
  await freshDbFromInit();
  await withDb(async (c) => {
    await c.query('drop table schema_migrations');
    await c.query(`insert into audit_log (event_type) values ('login_success'), ('app_settings_updated')`);
  });
}

const registered = () => withDb(async (c) => (await c.query('select filename, method from schema_migrations order by filename')).rows as { filename: string; method: string }[]);

describe('DOEL-99: scripts/db-migrate.sh tegen een echte database', { skip }, () => {
  if (missing && !skip) {
    it('psql is beschikbaar', () => assert.fail(missing));
    return;
  }
  let tmp = '';
  before(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'db-migrate-')); });
  after(async () => {
    rmSync(tmp, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try { await admin.query(`drop database if exists ${DB_NAME}`); } finally { await admin.end(); }
  });

  it('reproductie: alle migraties opnieuw draaien (oude -rebuild) faalt op 0033 bij nieuwere auditregels', async () => {
    await legacyDbWithNewerAuditRows();
    let failedAt = '';
    for (const f of migrationFiles) {
      const r = spawnSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationsDir, f)], { encoding: 'utf8' });
      if (r.status !== 0) { failedAt = f; assert.match(r.stderr, /audit_log_event_type_check/); break; }
    }
    assert.equal(failedAt, '0033_customer_management.sql');
  });

  it('bestaande database zonder boekhouding: weigert met baseline-instructie en voert niets uit', async () => {
    await legacyDbWithNewerAuditRows();
    const r = migrate([]);
    assert.equal(r.status, 2, r.all);
    assert.match(r.err, /--baseline 0050/);
    const exists = await withDb(async (c) => (await c.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t);
    assert.equal(exists, null, 'er mag niets aangemaakt zijn');
  });

  it('baseline + toepassen: alleen de nieuwe migratie draait, zonder fout; daarna is er niets meer te doen', async () => {
    await legacyDbWithNewerAuditRows();
    const b = migrate(['--baseline', '0050']);
    assert.equal(b.status, 0, b.all);
    assert.match(b.out, /50 migratie\(s\) t\/m 0050_/);

    const dry = migrate(['--dry-run']);
    assert.equal(dry.status, 0, dry.all);
    assert.match(dry.out, /0051_schema_migrations\.sql/);
    assert.doesNotMatch(dry.out, /0033_/);

    const a = migrate([]);
    assert.equal(a.status, 0, a.all);
    assert.match(a.out, /1 nieuwe migratie\(s\) toepassen/);
    assert.doesNotMatch(a.out, /0033_/);

    const rows = await registered();
    assert.equal(rows.length, migrationFiles.length);
    assert.equal(rows.filter((x) => x.method === 'baseline').length, 50);
    assert.deepEqual(rows.filter((x) => x.method === 'run').map((x) => x.filename), ['0051_schema_migrations.sql']);

    const again = migrate([]);
    assert.equal(again.status, 0, again.all);
    assert.match(again.out, /geen nieuwe migraties/);
  });

  it('een tweede baseline wordt geweigerd', async () => {
    const r = migrate(['--baseline', '0050']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /al een migratieboekhouding/);
  });

  it('baseline met een onbekend of ongeldig nummer wordt geweigerd', async () => {
    await legacyDbWithNewerAuditRows();
    for (const n of ['9999', '50', "0050'; drop table users; --"]) {
      const r = migrate(['--baseline', n]);
      assert.equal(r.status, 1, `${n}: ${r.all}`);
    }
    const exists = await withDb(async (c) => (await c.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t);
    assert.equal(exists, null);
  });

  it('verse database uit init.sql: alles staat al geregistreerd, er draait niets', async () => {
    await freshDbFromInit();
    const r = migrate([]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /geen nieuwe migraties/);
    assert.ok((await registered()).every((x) => x.method === 'init'));
  });

  it('nieuwe migratie wordt toegepast en geregistreerd; een mislukte migratie wordt niet geregistreerd en stopt de rest', async () => {
    await freshDbFromInit();
    const dir = path.join(tmp, 'm1');
    cpSync(migrationsDir, dir, { recursive: true });
    writeFileSync(path.join(dir, '9001_test_ok.sql'), 'begin;\ncreate table doel99_ok (id int);\ncommit;\n');
    writeFileSync(path.join(dir, '9002_test_kapot.sql'), 'begin;\ncreate table doel99_half (id int);\nselect * from bestaat_niet;\ncommit;\n');
    writeFileSync(path.join(dir, '9003_test_later.sql'), 'begin;\ncreate table doel99_later (id int);\ncommit;\n');

    const r = migrate([], dir);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.err, /9002_test_kapot\.sql is mislukt/);
    const names = (await registered()).map((x) => x.filename);
    assert.ok(names.includes('9001_test_ok.sql'));
    assert.ok(!names.includes('9002_test_kapot.sql'));
    assert.ok(!names.includes('9003_test_later.sql'), 'na een fout mag niets meer draaien');
    const tables = await withDb(async (c) => (await c.query(`select to_regclass('doel99_ok') as ok, to_regclass('doel99_half') as half, to_regclass('doel99_later') as later`)).rows[0]);
    assert.equal(tables.ok, 'doel99_ok');
    assert.equal(tables.half, null, 'de mislukte migratie is teruggedraaid');
    assert.equal(tables.later, null);
  });

  it('A03: een bestandsnaam met SQL-tekens wordt geweigerd vóórdat er iets draait', async () => {
    await freshDbFromInit();
    const dir = path.join(tmp, 'm2');
    cpSync(migrationsDir, dir, { recursive: true });
    writeFileSync(path.join(dir, '9001_test_ok.sql'), 'begin;\ncreate table doel99_ok (id int);\ncommit;\n');
    writeFileSync(path.join(dir, "9002_x'),('y.sql"), 'select 1;\n');
    const r = migrate([], dir);
    assert.equal(r.status, 1, r.all);
    assert.match(r.err, /ongeldige bestandsnaam/);
    const ok = await withDb(async (c) => (await c.query(`select to_regclass('doel99_ok') as t`)).rows[0].t);
    assert.equal(ok, null, 'er mag niets uitgevoerd zijn');
  });

  it('--status toont openstaande migraties', async () => {
    await freshDbFromInit();
    const dir = path.join(tmp, 'm3');
    cpSync(migrationsDir, dir, { recursive: true });
    writeFileSync(path.join(dir, '9001_test_ok.sql'), 'select 1;\n');
    const r = migrate(['--status'], dir);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /openstaand: 1/);
    assert.match(r.out, /open: +9001_test_ok\.sql/);
  });
});
