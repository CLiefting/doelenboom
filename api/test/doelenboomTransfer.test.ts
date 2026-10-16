// DOEL-104: een doelenboom van de ene omgeving naar de andere kopiëren.
// Test de kern (src/doelenboomTransfer.ts) tegen een echte database: bron en
// doel zijn hier twee tenants in dezelfde testdatabase, wat voor de logica
// (nieuwe id's, verwijzingen omzetten, niets buiten de doelboom aanraken)
// gelijkwaardig is aan twee omgevingen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { closePool, cleanupByPrefix, createUser, unique } from './helpers.js';
import {
  exportBundle, importBundle, validateBundleFile, bundleChecksum, slugify, TransferError,
  TRANSFER_TABLES, TRANSFER_EXCLUDED_TABLES, TRANSFER_LIMITS, type BundleFile,
} from '../src/doelenboomTransfer.js';

const PREFIX = unique('xfer');
const ADMIN = `${PREFIX}-admin@example.test`;
const OTHER = `${PREFIX}-ander@example.test`;
let adminId = 0;
let otherId = 0;
let source: { tenantId: number; boomId: number; tenantSlug: string; boomSlug: string };

async function q(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows;
}

// Voert fn uit in een transactie; commit bij succes, rollback bij een fout.
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Zet een volledige bronboom neer: elke tabel uit TRANSFER_TABLES krijgt rijen.
async function seedSource(slug: string) {
  const [tenant] = await q(`insert into tenants (slug, name) values ($1, $1) returning id`, [slug]);
  await q(
    `insert into tenant_modules (tenant_id, module_id) select $1, id from modules where key in ('projecten', 'controleregels')`,
    [tenant.id]
  );
  const [boom] = await q(
    `insert into doelenbomen (tenant_id, slug, name, stale_after_days, nightly_export_enabled)
     values ($1, 'bron-boom', 'Bron @ Boom', 45, false) returning id`,
    [tenant.id]
  );
  const [cfg] = await q(
    `insert into column_configs (scope, tenant_id, doelenboom_id, rules, attributes)
     values ('doelenboom', $1, $2, $3, $4) returning id`,
    [tenant.id, boom.id, JSON.stringify([{ id: 'regel-1', naam: 'Elke B heeft een A' }]), JSON.stringify([{ id: 'budget', label: 'Budget' }])]
  );
  await q(
    `insert into columns (column_config_id, position, type_name, title, color) values
       ($1, 1, 'A', 'Ambitie', '#112233'), ($1, 2, 'B', 'Baten', '#445566'), ($1, 3, 'P', 'Projecten', '#778899')`,
    [cfg.id]
  );
  const els = await q(
    `insert into elements (doelenboom_id, code, type, name, description, sort_order) values
       ($1, 'A1', 'A', 'Ambitie één', 'Tekst met ''quote'' en <b>html</b>', 1),
       ($1, 'B1', 'B', 'Baat één', '', 2),
       ($1, 'P1', 'P', 'Project één', '', 3),
       ($1, 'P2', 'P', 'Project twee', '', 4)
     returning id, code`,
    [boom.id]
  );
  const el = Object.fromEntries(els.map((e) => [e.code, e.id]));
  await q(
    `insert into edges (doelenboom_id, source_element_id, target_element_id, weight, toelichting) values
       ($1, $2, $3, 'primair', 'a-b'), ($1, $3, $4, 'ondersteunend', ''), ($1, $3, $5, null, '')`,
    [boom.id, el.A1, el.B1, el.P1, el.P2]
  );
  const tags = await q(`insert into tags (doelenboom_id, code, name) values ($1, 'T1', 'Tag één'), ($1, 'T2', 'Tag twee') returning id`, [boom.id]);
  const orgs = await q(`insert into org_units (doelenboom_id, code, name) values ($1, 'O1', 'Afdeling') returning id`, [boom.id]);
  await q(`insert into element_tags (element_id, tag_id, toelichting) values ($1, $2, 'x'), ($3, $4, '')`, [el.A1, tags[0].id, el.P1, tags[1].id]);
  await q(`insert into ob_org_relations (element_id, org_unit_id, relatietype) values ($1, $2, 'Primair')`, [el.B1, orgs[0].id]);
  await q(
    `insert into project_status (element_id, projectstatus, rag, toelichting, gerapporteerd_op, updated_by)
     values ($1, 'Actief', 'Oranje', 'loopt', '2026-09-30', $2)`,
    [el.P1, otherId]
  );
  await q(
    `insert into control_rule_deviations (doelenboom_id, element_id, rule_id, motivatie, created_by, updated_by)
     values ($1, $2, 'regel-1', 'bewust', $3, $3)`,
    [boom.id, el.B1, otherId]
  );
  await q(
    `insert into element_attribute_values (doelenboom_id, element_id, attribute_id, value_number, updated_by)
     values ($1, $2, 'budget', 123456789012345.678901, $3)`,
    [boom.id, el.P1, otherId]
  );
  await q(`insert into element_attribute_values (doelenboom_id, element_id, attribute_id, value_date) values ($1, $2, 'start', '2026-12-01')`, [boom.id, el.P2]);
  const prods = await q(
    `insert into products (element_id, code, name, type, pct_gereed, verwachte_datum, business_value) values
       ($1, 'PR1', 'Product één', 'deliverable', 40, '2026-11-15', 12.5),
       ($1, 'PR2', 'Mijlpaal', 'mijlpaal', 0, null, null)
     returning id`,
    [el.P1]
  );
  await q(`insert into product_dependencies (predecessor_id, successor_id, type) values ($1, $2, 'FS')`, [prods[0].id, prods[1].id]);
  const acts = await q(
    `insert into activities (element_id, name, start_date, end_date) values
       ($1, 'Voorbereiden', '2026-10-01', '2026-10-15'), ($1, 'Uitvoeren', '2026-10-16', '2026-11-30')
     returning id`,
    [el.P1]
  );
  await q(`insert into activity_dependencies (predecessor_id, successor_id, type, lag_days) values ($1, $2, 'FS', 2)`, [acts[0].id, acts[1].id]);
  // Hoort NIET mee te gaan:
  await q(`insert into doelenboom_user_roles (doelenboom_id, user_id, role) values ($1, $2, 'editor')`, [boom.id, otherId]);
  return { tenantId: Number(tenant.id), boomId: Number(boom.id), tenantSlug: slug, boomSlug: 'bron-boom' };
}

// Inhoud van een boom zonder id's, zodat bron en kopie vergelijkbaar zijn.
async function fingerprint(boomId: number) {
  const one = async (sql: string) => (await q(sql, [boomId])).map((r) => JSON.stringify(r));
  return {
    config: await one(`select rules, attributes from column_configs where scope = 'doelenboom' and doelenboom_id = $1`),
    columns: await one(
      `select c.position, c.type_name, c.title, c.color from columns c join column_configs cc on cc.id = c.column_config_id
       where cc.doelenboom_id = $1 order by c.position`),
    elements: await one(`select code, type, name, description, sort_order, created_at from elements where doelenboom_id = $1 order by code`),
    edges: await one(
      `select s.code as van, t.code as naar, e.weight, e.toelichting from edges e
       join elements s on s.id = e.source_element_id join elements t on t.id = e.target_element_id
       where e.doelenboom_id = $1 order by 1, 2`),
    tags: await one(`select code, name from tags where doelenboom_id = $1 order by code`),
    orgs: await one(`select code, name from org_units where doelenboom_id = $1 order by code`),
    elementTags: await one(
      `select e.code as el, t.code as tag, et.toelichting from element_tags et join elements e on e.id = et.element_id
       join tags t on t.id = et.tag_id where e.doelenboom_id = $1 order by 1, 2`),
    orgRelations: await one(
      `select e.code as el, o.code as org, r.relatietype, r.status from ob_org_relations r join elements e on e.id = r.element_id
       join org_units o on o.id = r.org_unit_id where e.doelenboom_id = $1 order by 1, 2`),
    status: await one(
      `select e.code, p.projectstatus, p.rag, p.toelichting, p.gerapporteerd_op from project_status p
       join elements e on e.id = p.element_id where e.doelenboom_id = $1 order by 1`),
    deviations: await one(
      `select e.code, d.rule_id, d.motivatie from control_rule_deviations d join elements e on e.id = d.element_id
       where d.doelenboom_id = $1 order by 1`),
    values: await one(
      `select e.code, v.attribute_id, v.value_text, v.value_number::text as value_number, v.value_date, v.value_bool
       from element_attribute_values v join elements e on e.id = v.element_id where v.doelenboom_id = $1 order by 1, 2`),
    products: await one(
      `select e.code as el, p.code, p.name, p.type, p.pct_gereed, p.verwachte_datum, p.business_value::text as bv
       from products p join elements e on e.id = p.element_id where e.doelenboom_id = $1 order by 2`),
    productDeps: await one(
      `select a.code as van, b.code as naar, d.type from product_dependencies d join products a on a.id = d.predecessor_id
       join products b on b.id = d.successor_id join elements e on e.id = a.element_id where e.doelenboom_id = $1`),
    activities: await one(
      `select e.code as el, a.name, a.start_date, a.end_date from activities a join elements e on e.id = a.element_id
       where e.doelenboom_id = $1 order by 2`),
    activityDeps: await one(
      `select a.name as van, b.name as naar, d.type, d.lag_days from activity_dependencies d join activities a on a.id = d.predecessor_id
       join activities b on b.id = d.successor_id join elements e on e.id = a.element_id where e.doelenboom_id = $1`),
  };
}

const clone = (file: BundleFile): BundleFile => JSON.parse(JSON.stringify(file));
const reseal = (file: BundleFile): BundleFile => ({ sha256: bundleChecksum(file.bundle), bundle: file.bundle });
const exportSource = () => inTx((c) => exportBundle(c, { tenant: source.tenantSlug, boom: source.boomSlug }));
const opts = { overwrite: false, adminEmail: ADMIN };

before(async () => {
  adminId = Number(await createUser(ADMIN));
  otherId = Number(await createUser(OTHER));
  source = await seedSource(`${PREFIX}-bron`);
});

after(async () => {
  await cleanupByPrefix(PREFIX);
  await closePool();
});

test('slugify: naam naar slug', () => {
  assert.equal(slugify('OVpay @ NS'), 'ovpay-ns');
  assert.equal(slugify('  Café Zürich  '), 'cafe-zurich');
  assert.throws(() => slugify('@@@'), TransferError);
});

test('export: elke tabel zit in de bundel, met controlesom en bronmodules', async () => {
  const file = await exportSource();
  assert.equal(file.sha256, bundleChecksum(file.bundle));
  for (const spec of TRANSFER_TABLES) {
    assert.ok(file.bundle.tables[spec.table].length > 0, `tabel ${spec.table} is leeg in de testbundel: de test dekt hem dan niet`);
  }
  assert.deepEqual(file.bundle.source.tenant.modules, ['controleregels', 'projecten']);
  assert.deepEqual(file.bundle.source.doelenboom.settings, { stale_after_days: 45, nightly_export_enabled: false });
  // Geen gebruikersgegevens in de bundel (OWASP A02/A01): geen e-mailadressen, geen hashes.
  const text = JSON.stringify(file);
  assert.ok(!text.includes(OTHER) && !text.includes('password'), 'bundel bevat accountgegevens');
});

test('export: op naam of slug; onbekend geeft een duidelijke fout', async () => {
  const byName = await inTx((c) => exportBundle(c, { tenant: source.tenantSlug, boom: 'Bron @ Boom' }));
  assert.equal(byName.bundle.source.doelenboom.slug, 'bron-boom');
  await assert.rejects(inTx((c) => exportBundle(c, { tenant: source.tenantSlug, boom: 'bestaat-niet' })), /niet gevonden/);
  await assert.rejects(inTx((c) => exportBundle(c, { tenant: `${PREFIX}-nergens`, boom: 'x' })), /Tenant .* niet gevonden/);
});

test('import in een nieuwe tenant en nieuwe boom: inhoud gelijk, admin toegewezen, modules mee', async () => {
  const file = validateBundleFile(JSON.parse(JSON.stringify(await exportSource())));
  const target = { tenant: `${PREFIX} Doel Één`, tenantSlug: `${PREFIX}-doel1`, boom: 'OVpay' };
  const result = await inTx((c) => importBundle(c, file, target, opts));

  assert.equal(result.tenant.created, true);
  assert.equal(result.tenant.slug, `${PREFIX}-doel1`);
  assert.equal(result.doelenboom.created, true);
  assert.equal(result.doelenboom.slug, 'ovpay');
  assert.deepEqual(result.tenant.modulesEnabled.sort(), ['controleregels', 'projecten']);
  assert.deepEqual(result.admin, { email: ADMIN, addedAsAdmin: true, existingRole: null });

  assert.deepEqual(await fingerprint(result.doelenboom.id), await fingerprint(source.boomId));

  const [member] = await q('select role from tenant_users where tenant_id = $1 and user_id = $2', [result.tenant.id, adminId]);
  assert.equal(member.role, 'admin');
  const [boom] = await q('select stale_after_days, nightly_export_enabled, read_only from doelenbomen where id = $1', [result.doelenboom.id]);
  assert.deepEqual(boom, { stale_after_days: 45, nightly_export_enabled: false, read_only: false });
  const [t] = await q(
    `select lifetime_trees_created, license_end_date is not null as licensed,
            (select count(*)::int from column_configs where tenant_id = t.id and scope = 'tenant_default') as defaults
     from tenants t where id = $1`, [result.tenant.id]);
  assert.deepEqual(t, { lifetime_trees_created: 1, licensed: true, defaults: 1 });

  // Verwijzingen naar gebruikers van de bron zijn leeggemaakt (A01).
  const [users] = await q(
    `select (select count(*)::int from project_status p join elements e on e.id = p.element_id where e.doelenboom_id = $1 and p.updated_by is not null)
          + (select count(*)::int from control_rule_deviations where doelenboom_id = $1 and (created_by is not null or updated_by is not null))
          + (select count(*)::int from element_attribute_values where doelenboom_id = $1 and updated_by is not null)
          + (select count(*)::int from doelenboom_user_roles where doelenboom_id = $1) as n`, [result.doelenboom.id]);
  assert.equal(users.n, 0);

  // Auditregel (A09): bestaand type, met kenmerk en aantallen, zonder inhoud.
  const [audit] = await q(`select event_type, user_id, detail from audit_log where doelenboom_id = $1`, [result.doelenboom.id]);
  assert.equal(audit.event_type, 'doelenboom_import_published');
  assert.equal(Number(audit.user_id), adminId);
  assert.equal(audit.detail.kind, 'omgeving-kopie');
  assert.equal(audit.detail.counts.elements, 4);
  assert.ok(!JSON.stringify(audit.detail).includes('Ambitie één'));

  // De bron is ongemoeid.
  assert.equal((await q('select count(*)::int as n from elements where doelenboom_id = $1', [source.boomId]))[0].n, 4);
});

test('bestaande boom: geweigerd zonder overschrijven, vervangen mét; andere bomen blijven staan', async () => {
  const file = await exportSource();
  const tenantSlug = `${PREFIX}-doel2`;
  const target = { tenant: tenantSlug, boom: 'Kopie' };
  const first = await inTx((c) => importBundle(c, file, target, opts));
  // Tweede boom in dezelfde doeltenant + lokale wijziging in de eerste.
  const second = await inTx((c) => importBundle(c, file, { tenant: tenantSlug, boom: 'Buurboom' }, opts));
  assert.equal(second.tenant.created, false);
  assert.deepEqual(second.admin, { email: ADMIN, addedAsAdmin: false, existingRole: 'admin' });
  await q(`insert into elements (doelenboom_id, code, type, name) values ($1, 'X9', 'A', 'Alleen op het doel')`, [first.doelenboom.id]);
  await q(`update doelenbomen set read_only = true where id = $1`, [first.doelenboom.id]);

  await assert.rejects(inTx((c) => importBundle(c, file, target, opts)), /bestaat al .*--overschrijven/s);
  assert.equal((await q(`select count(*)::int as n from elements where doelenboom_id = $1`, [first.doelenboom.id]))[0].n, 5, 'weigeren mag niets wijzigen');

  const again = await inTx((c) => importBundle(c, file, target, { ...opts, overwrite: true }));
  assert.equal(again.doelenboom.id, first.doelenboom.id, 'zelfde boom, niet een nieuwe');
  assert.equal(again.doelenboom.overwritten, true);
  assert.equal(again.doelenboom.removed.elements, 5);
  assert.deepEqual(await fingerprint(first.doelenboom.id), await fingerprint(source.boomId));
  assert.deepEqual(await fingerprint(second.doelenboom.id), await fingerprint(source.boomId), 'buurboom is geraakt');
  // Operationele vlaggen van de bestaande boom blijven zoals ze op het doel stonden.
  assert.equal((await q('select read_only from doelenbomen where id = $1', [first.doelenboom.id]))[0].read_only, true);
  assert.equal((await q('select lifetime_trees_created as n from tenants where id = $1', [first.tenant.id]))[0].n, 2);
});

test('bestaande rol van de beheerder in de doeltenant blijft staan', async () => {
  const slug = `${PREFIX}-doel3`;
  const [t] = await q(`insert into tenants (slug, name) values ($1, $1) returning id`, [slug]);
  await q(`insert into column_configs (scope, tenant_id) values ('tenant_default', $1)`, [t.id]);
  await q(`insert into tenant_users (tenant_id, user_id, role) values ($1, $2, 'bezoeker')`, [t.id, adminId]);
  const result = await inTx(async (c) => importBundle(c, await exportSource(), { tenant: slug, boom: 'Kopie' }, opts));
  assert.deepEqual(result.admin, { email: ADMIN, addedAsAdmin: false, existingRole: 'bezoeker' });
  assert.deepEqual(result.tenant.modulesMissing, ['controleregels', 'projecten'], 'ontbrekende modules worden gemeld, niet stil aangezet');
  assert.equal((await q('select count(*)::int as n from tenant_modules where tenant_id = $1', [t.id]))[0].n, 0);
});

test('proefrun = uitvoeren en terugdraaien: er blijft niets achter', async () => {
  const file = await exportSource();
  const slug = `${PREFIX}-proef`;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await importBundle(client, file, { tenant: slug, boom: 'Kopie' }, opts);
    assert.equal(result.counts.elements, 4);
    await client.query('rollback');
  } finally {
    client.release();
  }
  assert.equal((await q('select count(*)::int as n from tenants where slug = $1', [slug]))[0].n, 0);
});

test('weigeringen: onbekend account, beëindigde tenant, gearchiveerde boom, andere databaseversie', async () => {
  const file = await exportSource();
  await assert.rejects(
    inTx((c) => importBundle(c, file, { tenant: `${PREFIX}-w1`, boom: 'K' }, { overwrite: false, adminEmail: `${PREFIX}-wie@example.test` })),
    /bestaat niet op deze omgeving/
  );
  assert.equal((await q('select count(*)::int as n from tenants where slug = $1', [`${PREFIX}-w1`]))[0].n, 0);

  await q(`insert into tenants (slug, name, terminated_at) values ($1, $1, now())`, [`${PREFIX}-w2`]);
  await assert.rejects(inTx((c) => importBundle(c, file, { tenant: `${PREFIX}-w2`, boom: 'K' }, opts)), /beëindigd/);

  const made = await inTx((c) => importBundle(c, file, { tenant: `${PREFIX}-w3`, boom: 'K' }, opts));
  await q('update doelenbomen set archived_at = now() where id = $1', [made.doelenboom.id]);
  await assert.rejects(inTx((c) => importBundle(c, file, { tenant: `${PREFIX}-w3`, boom: 'K' }, { ...opts, overwrite: true })), /gearchiveerd/);

  const other = clone(file);
  other.bundle.schemaVersion = '0001_iets_anders.sql (1)';
  await assert.rejects(inTx((c) => importBundle(c, reseal(other), { tenant: `${PREFIX}-w4`, boom: 'K' }, opts)), /databaseversie verschilt/);
});

test('A08 integriteit: gewijzigde bundel wordt geweigerd op de controlesom', async () => {
  const file = clone(await exportSource());
  file.bundle.tables.elements[0].name = 'Stiekem aangepast';
  assert.throws(() => validateBundleFile(file), /controlesom/);
  assert.throws(() => validateBundleFile({ nope: true }), /geen doelenboom-bundel/);
  assert.throws(() => validateBundleFile(reseal({ ...file, bundle: { ...file.bundle, format: 99 } })), /Bundelformaat 99/);
});

test('A03 injectie: tabel- en kolomnamen uit de bundel worden nooit als SQL gebruikt', async () => {
  const base = await exportSource();

  const table = clone(base);
  (table.bundle.tables as Record<string, unknown>)['users'] = [{ email: 'x@example.test', is_sysadmin: true }];
  assert.throws(() => validateBundleFile(reseal(table)), /onbekende tabel/);

  const badColumn = clone(base);
  badColumn.bundle.tables.elements[0]['name"; drop table elements; --'] = 'x';
  assert.throws(() => validateBundleFile(reseal(badColumn)), /kolomnaam/);

  // Geldige naam, maar geen kolom van de doeltabel: geweigerd bij het importeren.
  const unknown = clone(base);
  unknown.bundle.tables.elements[0].is_sysadmin = true;
  const sealed = validateBundleFile(reseal(unknown));
  await assert.rejects(inTx((c) => importBundle(c, sealed, { tenant: `${PREFIX}-inj1`, boom: 'K' }, opts)), /geen kolom is_sysadmin/);
  assert.equal((await q('select count(*)::int as n from tenants where slug = $1', [`${PREFIX}-inj1`]))[0].n, 0, 'mislukte import laat niets achter');

  // Waarden gaan als parameter mee: SQL in een naam blijft tekst.
  const value = clone(base);
  value.bundle.tables.elements[0].name = `x'); delete from users; --`;
  const r = await inTx((c) => importBundle(c, validateBundleFile(reseal(value)), { tenant: `${PREFIX}-inj2`, boom: 'K' }, opts));
  assert.equal((await q(`select count(*)::int as n from elements where doelenboom_id = $1 and name like '%delete from users%'`, [r.doelenboom.id]))[0].n, 1);
  assert.ok((await q('select count(*)::int as n from users'))[0].n >= 2);

  const settings = clone(base);
  (settings.bundle.source.doelenboom.settings as Record<string, unknown>).tenant_id = 1;
  assert.throws(() => validateBundleFile(reseal(settings)), /onbekende instelling/);
  const cfg = clone(base);
  (cfg.bundle.columnConfig as Record<string, unknown>).tenant_id = 1;
  assert.throws(() => validateBundleFile(reseal(cfg)), /kolomconfiguratie/);
});

test('A01 toegang: een bundel kan niet naar een andere boom of naar andermans rijen wijzen', async () => {
  const base = await exportSource();
  // Vreemde doelenboom_id en gebruikers-id in de bundel worden genegeerd: alles
  // landt in de doelboom, en gebruikersverwijzingen worden leeg.
  const forged = clone(base);
  for (const row of forged.bundle.tables.elements) row.doelenboom_id = source.boomId;
  for (const row of forged.bundle.tables.control_rule_deviations) row.created_by = adminId;
  const before = (await q('select count(*)::int as n from elements where doelenboom_id = $1', [source.boomId]))[0].n;
  const r = await inTx((c) => importBundle(c, validateBundleFile(reseal(forged)), { tenant: `${PREFIX}-acl1`, boom: 'K' }, opts));
  assert.equal((await q('select count(*)::int as n from elements where doelenboom_id = $1', [source.boomId]))[0].n, before);
  assert.equal((await q('select count(*)::int as n from elements where doelenboom_id = $1', [r.doelenboom.id]))[0].n, 4);
  assert.equal((await q('select created_by from control_rule_deviations where doelenboom_id = $1', [r.doelenboom.id]))[0].created_by, null);

  // Relatie naar een element dat niet in de bundel zit (bv. een bestaand id op het doel).
  const dangling = clone(base);
  dangling.bundle.tables.edges[0].target_element_id = 1;
  await assert.rejects(
    inTx((c) => importBundle(c, validateBundleFile(reseal(dangling)), { tenant: `${PREFIX}-acl2`, boom: 'K' }, opts)),
    /niet in de bundel/
  );
});

test('A04 grenzen: te grote bundel en te lange namen worden geweigerd', async () => {
  const base = await exportSource();
  const big = clone(base);
  big.bundle.tables.elements = Array.from({ length: TRANSFER_LIMITS.elements + 1 }, () => ({ code: 'x' }));
  assert.throws(() => validateBundleFile(reseal(big)), /te groot/);
  await assert.rejects(inTx((c) => importBundle(c, base, { tenant: 'x'.repeat(TRANSFER_LIMITS.nameLength + 1), boom: 'K' }, opts)), /leeg of te lang/);
  await assert.rejects(inTx((c) => importBundle(c, base, { tenant: `${PREFIX}-g`, boom: '  ' }, opts)), /leeg of te lang/);
});

test('schemadekking: elke tabel die aan een boom of zijn inhoud hangt is meegenomen of bewust uitgesloten', async () => {
  const roots = ['doelenbomen', 'elements', 'products', 'activities', 'tags', 'org_units', 'column_configs', 'columns', 'edges'];
  const rows = await q(
    `select distinct c.conrelid::regclass::text as tabel from pg_constraint c
     where c.contype = 'f' and c.confrelid::regclass::text = any ($1)`, [roots]);
  const known = new Set([...TRANSFER_TABLES.map((t) => t.table), ...TRANSFER_EXCLUDED_TABLES]);
  const missing = rows.map((r) => r.tabel as string).filter((t) => !known.has(t));
  assert.deepEqual(missing, [], `Nieuwe tabel(len) ${missing.join(', ')}: neem ze op in TRANSFER_TABLES of TRANSFER_EXCLUDED_TABLES (api/src/doelenboomTransfer.ts)`);
});
