// Regressietests voor DOEL-47 (SBOM van een nieuwe uitrol wordt direct
// ingelezen i.p.v. pas na de 24-uurswachttijd) en DOEL-70 (mail aan sysadmins
// bij nieuwe kwetsbaarheden). Anders dan systemSbom.test.ts draait dit de
// ECHTE controle (refreshDependencyHealth) tegen een fixture-SBOM in een
// tijdelijke map, met een nagebootst npm-registry/PyPI/OSV.dev (fetch-stub;
// verzoeken naar de eigen testserver gaan gewoon door).
// OWASP: A01 (alleen sysadmins ontvangen), A03 (geen tekst van buiten in de
// mail), A04 (één mail per ontvanger per controle, geen herhaling), A09
// (audit-event met alleen aantallen).
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool } from '../src/db.js';
import {
  RefreshCooldownError, getSummary, isBuildIngested, refreshDependencyHealth, sweepDependencyHealthCheck,
} from '../src/dependencyHealth.js';
import { VulnerabilityAlert, renderVulnerabilityAlertEmail, setSendVulnerabilityAlertEmailImpl } from '../src/email.js';
import { startTestServer, stopTestServer, closePool, req, unique, createSysadminUser, createUser, login } from './helpers.js';

const PREFIX = unique('sbomalert');
const PKG = (n: string) => `${PREFIX}-${n}`;

// Wat het nagebootste OSV.dev per pakket teruggeeft, en de details per id.
let osvByPackage: Record<string, string[]> = {};
const OSV_DETAILS: Record<string, unknown> = {
  'GHSA-aaaa-aaaa-0001': { database_specific: { severity: 'HIGH' }, summary: '<img src=x onerror=alert(1)> samenvatting uit OSV' },
  'GHSA-aaaa-aaaa-0002': { severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] },
  'GHSA-aaaa-aaaa-0003': { database_specific: { severity: 'LOW' } },
  'GHSA-aaaa-aaaa-0004': { database_specific: { severity: 'CRITICAL' } },
  'GHSA-aaaa-aaaa-0005': { database_specific: { severity: 'CRITICAL' } },
  'GHSA-aaaa-aaaa-0006': { database_specific: { severity: 'MODERATE' } },
};
const externalCalls: string[] = [];
const realFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://registry.npmjs.org/')) { externalCalls.push('npm'); return json({ 'dist-tags': { latest: '9.9.9' } }); }
    if (url.startsWith('https://pypi.org/')) { externalCalls.push('pypi'); return json({ info: { version: '9.9.9' } }); }
    if (url === 'https://api.osv.dev/v1/querybatch') {
      externalCalls.push('osv-batch');
      const body = JSON.parse(init.body) as { queries: { package: { name: string } }[] };
      return json({ results: body.queries.map((q) => ({ vulns: (osvByPackage[q.package.name] ?? []).map((id) => ({ id })) })) });
    }
    if (url.startsWith('https://api.osv.dev/v1/vulns/')) {
      externalCalls.push('osv-detail');
      const id = decodeURIComponent(url.slice('https://api.osv.dev/v1/vulns/'.length));
      return OSV_DETAILS[id] ? json(OSV_DETAILS[id]) : json({}, 404);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

describe('SBOM inlezen na uitrol (DOEL-47) en melding aan sysadmins (DOEL-70)', () => {
  let dir: string;
  let startedAt: Date;
  let sysadminToken: string;
  const sysadminEmails = [`${PREFIX}-sys1@test.local`, `${PREFIX}-sys2@test.local`];
  const userEmail = `${PREFIX}-gewoon@test.local`;
  const savedEnv = { SBOM_DIR: process.env.SBOM_DIR, BUILD_VERSION: process.env.BUILD_VERSION, APP_BASE_URL: process.env.APP_BASE_URL };
  let mails: { to: string; alert: VulnerabilityAlert }[] = [];
  let buildCounter = 0;

  // "Uitrol": een nieuwe SBOM op schijf met een eigen bouwversie.
  function deploy(): string {
    buildCounter += 1;
    const buildVersion = `${PREFIX}-v${buildCounter}`;
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      generatedAt: new Date(Date.UTC(2030, 0, 1, 0, buildCounter)).toISOString(),
      buildVersion, gitCommit: 'abc1234', cyclonedxSpecVersion: '1.6',
      sbomSerialNumber: `urn:uuid:00000000-0000-0000-0000-${String(buildCounter).padStart(12, '0')}`,
      components: ['api'],
    }));
    writeFileSync(path.join(dir, 'api.cdx.json'), JSON.stringify({
      components: ['rt-high', 'rt-unknown', 'rt-low', 'rt-clean', 'dev-crit'].map((n) => ({ name: PKG(n), version: '1.0.0' })),
    }));
    writeFileSync(path.join(dir, 'api.meta.json'), JSON.stringify({
      directNames: [PKG('rt-high'), PKG('dev-crit')],
      runtimeNames: ['rt-high', 'rt-unknown', 'rt-low', 'rt-clean'].map(PKG),
    }));
    return buildVersion;
  }
  const runCount = async () =>
    Number((await pool.query('select count(*) from dependency_check_runs where started_at >= $1', [startedAt])).rows[0].count);
  const clearRuns = () => pool.query('delete from dependency_check_runs where started_at >= $1 or error = $2', [startedAt, PREFIX]);
  const notified = async () =>
    (await pool.query(
      `select name, vulnerability_id, severity_level from dependency_vulnerability_notifications where name like $1 order by vulnerability_id`,
      [`${PREFIX}%`]
    )).rows.map((r) => `${r.name.slice(PREFIX.length + 1)}:${r.vulnerability_id.slice(-4)}:${r.severity_level}`);
  const allSysadmins = async () => (await pool.query('select email from users where is_sysadmin = true order by id')).rows.map((r) => r.email);

  before(async () => {
    await startTestServer();
    startedAt = new Date((await pool.query('select now() as n')).rows[0].n);
    for (const e of sysadminEmails) await createSysadminUser(e, 'wachtwoord123');
    await createUser(userEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmails[0], 'wachtwoord123');
    dir = mkdtempSync(path.join(tmpdir(), 'sbom-fixture-'));
    process.env.SBOM_DIR = dir;
    process.env.APP_BASE_URL = 'https://doelenboom.example.test/';
    installFetchStub();
    setSendVulnerabilityAlertEmailImpl(async (to, alert) => { mails.push({ to, alert }); return true; });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await clearRuns();
    await pool.query('delete from dependency_sbom_builds where build_version like $1', [`${PREFIX}%`]);
    await pool.query('delete from dependency_vulnerability_notifications where name like $1', [`${PREFIX}%`]);
    await pool.query(`delete from audit_log where event_type = 'dependency_vulnerability_alert_sent' and created_at >= $1`, [startedAt]);
    await pool.query('delete from users where email like $1', [`${PREFIX}%`]);
    await stopTestServer();
    await closePool();
  });

  beforeEach(() => { mails = []; osvByPackage = {}; });

  // --- DOEL-47 -----------------------------------------------------------------

  it('DOEL-47: een nieuwe SBOM op schijf wordt direct ingelezen, ook als de vorige controle minder dan 24 uur geleden was', async () => {
    // Vorige controle: een uur geleden geslaagd.
    await pool.query(
      `insert into dependency_check_runs (started_at, finished_at, status, error)
       values (now() - interval '1 hour', now() - interval '1 hour', 'success', $1)`,
      [PREFIX] // markering, zodat clearRuns() deze nagebootste "vorige controle" ook opruimt
    );
    const v1 = deploy();
    assert.equal(await isBuildIngested({ buildVersion: v1, generatedAt: new Date(Date.UTC(2030, 0, 1, 0, 1)).toISOString() }), false);
    const before = await runCount();

    await sweepDependencyHealthCheck();

    assert.equal(await runCount(), before + 1, 'controle is gedraaid ondanks de wachttijd');
    const summary = await getSummary();
    assert.equal(summary!.buildVersion, v1);
    assert.equal(summary!.totalComponents, 5);
    assert.equal(await isBuildIngested({ buildVersion: v1, generatedAt: summary!.generatedAt! }), true);
  });

  it('DOEL-47: daarna geldt de 24-uurswachttijd weer (geen controle per uur)', async () => {
    const before = await runCount();
    const calls = externalCalls.length;
    await sweepDependencyHealthCheck();
    await sweepDependencyHealthCheck();
    assert.equal(await runCount(), before);
    assert.equal(externalCalls.length, calls, 'geen verzoeken naar registries/OSV');
    await assert.rejects(refreshDependencyHealth({ triggeredByUserId: null, isManual: false }), RefreshCooldownError);
  });

  it('DOEL-47: een volgende uitrol wordt opnieuw direct ingelezen; de knop houdt zijn eigen korte wachttijd', async () => {
    const v2 = deploy();
    await sweepDependencyHealthCheck();
    assert.equal((await getSummary())!.buildVersion, v2);
    // Handmatig, direct erna, met wéér een nieuwe SBOM: de 60s-wachttijd van de knop blijft gelden.
    deploy();
    await assert.rejects(refreshDependencyHealth({ triggeredByUserId: null, isManual: true }), RefreshCooldownError);
    assert.equal((await getSummary())!.buildVersion, v2);
  });

  it('DOEL-47: een build-rij zonder componenten (inlezen halverwege mislukt) telt niet als ingelezen', async () => {
    const generatedAt = new Date(Date.UTC(2031, 0, 1)).toISOString();
    await pool.query(
      `insert into dependency_sbom_builds (build_version, cyclonedx_spec_version, generated_at) values ($1, '1.6', $2)`,
      [`${PREFIX}-leeg`, generatedAt]
    );
    assert.equal(await isBuildIngested({ buildVersion: `${PREFIX}-leeg`, generatedAt }), false);
    await pool.query('delete from dependency_sbom_builds where build_version = $1', [`${PREFIX}-leeg`]);
  });

  it('DOEL-47: de pagina meldt of de getoonde SBOM bij de draaiende versie hoort (zelfde bron als /api/version)', async () => {
    const shown = (await getSummary())!.buildVersion!;
    process.env.BUILD_VERSION = shown;
    let res = await req('GET', '/api/system/sbom/summary', { token: sysadminToken });
    const version = await req('GET', '/api/version');
    assert.equal(res.body.runningBuildVersion, version.body.version);
    assert.equal(res.body.buildVersion, version.body.version);
    assert.equal(res.body.sbomMatchesRunningVersion, true);

    process.env.BUILD_VERSION = `${PREFIX}-nieuwer`;
    res = await req('GET', '/api/system/sbom/summary', { token: sysadminToken });
    assert.equal(res.body.sbomMatchesRunningVersion, false);
    assert.equal(res.body.runningBuildVersion, `${PREFIX}-nieuwer`);
  });

  // --- DOEL-70 -----------------------------------------------------------------

  it('DOEL-70: nieuwe kwetsbaarheden (hoog/onbekend, alleen productie) → één mail per sysadmin, alleen aantallen', async () => {
    osvByPackage = {
      [PKG('rt-high')]: ['GHSA-aaaa-aaaa-0001'],
      [PKG('rt-unknown')]: ['GHSA-aaaa-aaaa-0002'],
      [PKG('rt-low')]: ['GHSA-aaaa-aaaa-0003', 'GHSA-aaaa-aaaa-0006'],
      [PKG('dev-crit')]: ['GHSA-aaaa-aaaa-0004'],
    };
    await clearRuns();
    deploy();
    await sweepDependencyHealthCheck();

    // A01: precies de sysadmins, ieder één keer; nooit de gewone gebruiker.
    const expected = await allSysadmins();
    assert.deepEqual(mails.map((m) => m.to).sort(), [...expected].sort());
    for (const e of sysadminEmails) assert.ok(mails.some((m) => m.to === e));
    assert.ok(!mails.some((m) => m.to === userEmail));

    // Alleen hoog + onbekend in productie: laag/gemiddeld en de kritieke in een ontwikkel-dependency tellen niet.
    assert.deepEqual(mails[0].alert.counts, { kritiek: 0, hoog: 1, onbekend: 1 });
    assert.equal(mails[0].alert.total, 2);
    assert.equal(mails[0].alert.link, 'https://doelenboom.example.test/system-info');
    assert.deepEqual(await notified(), ['rt-high:0001:hoog', 'rt-unknown:0002:onbekend']);
  });

  it('DOEL-70 (A03): de mail bevat geen pakketnamen, id\'s of tekst uit OSV — alleen getallen en de link', async () => {
    const { subject, text, html } = renderVulnerabilityAlertEmail({ counts: { kritiek: 0, hoog: 1, onbekend: 1 }, total: 2, link: 'https://doelenboom.example.test/system-info' });
    for (const part of [subject, text, html]) {
      assert.doesNotMatch(part, new RegExp(PREFIX));
      assert.doesNotMatch(part, /GHSA|CVE-|rt-high|onerror|samenvatting uit OSV|1\.0\.0/);
    }
    assert.match(subject, /2 nieuwe kwetsbaarheden/);
    assert.match(text, /Hoog: 1/);
    assert.match(text, /Ernst onbekend: 1/);
    assert.match(renderVulnerabilityAlertEmail({ counts: { kritiek: 1, hoog: 0, onbekend: 0 }, total: 1, link: 'x' }).subject, /1 nieuwe kwetsbaarheid /);
    // Defensief: ook een vreemde link of niet-numerieke waarde levert geen HTML/attribuut-injectie op.
    const evil = renderVulnerabilityAlertEmail({
      counts: { kritiek: '<b>9</b>' as unknown as number, hoog: 0, onbekend: 0 }, total: 1,
      link: 'https://x.test/"><script>alert(1)</script>',
    });
    assert.doesNotMatch(evil.html, /<script|<b>/);
    assert.match(evil.html, /href="https:\/\/x\.test\/&quot;&gt;&lt;script&gt;/);
    assert.match(evil.text, /Kritiek: 0/);
  });

  it('DOEL-70 (A09): audit-event met alleen aantallen, zonder pakketnaam, id of e-mailadres', async () => {
    const rows = await pool.query(
      `select user_id, detail from audit_log where event_type = 'dependency_vulnerability_alert_sent' and created_at >= $1 order by id`,
      [startedAt]
    );
    assert.equal(rows.rowCount, 1);
    const detail = rows.rows[0].detail;
    assert.equal(rows.rows[0].user_id, null);
    assert.equal(detail.newVulnerabilities, 2);
    assert.deepEqual(detail.counts, { kritiek: 0, hoog: 1, onbekend: 1 });
    assert.equal(detail.sent, detail.recipients);
    assert.deepEqual(Object.keys(detail).sort(), ['counts', 'newVulnerabilities', 'recipients', 'sent']);
    assert.doesNotMatch(JSON.stringify(detail), /@|GHSA|rt-high/);
  });

  it('DOEL-70 (A04): dezelfde kwetsbaarheden worden niet opnieuw gemeld — niet na 24 uur en niet na een nieuwe uitrol', async () => {
    osvByPackage = { [PKG('rt-high')]: ['GHSA-aaaa-aaaa-0001'], [PKG('rt-unknown')]: ['GHSA-aaaa-aaaa-0002'] };
    await clearRuns();
    await sweepDependencyHealthCheck(); // "volgende dag", zelfde versie
    deploy();
    await sweepDependencyHealthCheck(); // nieuwe uitrol, zelfde kwetsbaarheden
    assert.equal(mails.length, 0);
  });

  it('DOEL-70: een kwetsbaarheid die er later bij komt wordt wel gemeld, alleen de nieuwe', async () => {
    osvByPackage = { [PKG('rt-high')]: ['GHSA-aaaa-aaaa-0001', 'GHSA-aaaa-aaaa-0005'], [PKG('rt-unknown')]: ['GHSA-aaaa-aaaa-0002'] };
    await clearRuns();
    await sweepDependencyHealthCheck();
    assert.ok(mails.length >= 2);
    assert.deepEqual(mails[0].alert.counts, { kritiek: 1, hoog: 0, onbekend: 0 });
    assert.equal(mails[0].alert.total, 1);
    assert.ok((await notified()).includes('rt-high:0005:kritiek'));
  });

  it('DOEL-70: mislukt het mailen (of is er geen mailserver), dan blijft de bevinding staan en volgt een nieuwe poging; de controle zelf slaagt', async () => {
    await pool.query('delete from dependency_vulnerability_notifications where name like $1', [`${PREFIX}%`]);
    osvByPackage = { [PKG('rt-high')]: ['GHSA-aaaa-aaaa-0001'] };

    setSendVulnerabilityAlertEmailImpl(async () => { throw new Error('relay onbereikbaar'); });
    await clearRuns();
    await sweepDependencyHealthCheck();
    assert.deepEqual(await notified(), []);
    assert.equal((await pool.query(`select status from dependency_check_runs where started_at >= $1 order by id desc limit 1`, [startedAt])).rows[0].status, 'success');

    setSendVulnerabilityAlertEmailImpl(async () => false); // geen SMTP_HOST
    await clearRuns();
    await sweepDependencyHealthCheck();
    assert.deepEqual(await notified(), []);

    setSendVulnerabilityAlertEmailImpl(async (to, alert) => { mails.push({ to, alert }); return true; });
    await clearRuns();
    await sweepDependencyHealthCheck();
    assert.deepEqual(await notified(), ['rt-high:0001:hoog']);
    assert.ok(mails.length >= 2);
  });

  it('DOEL-70: de knop "Nu controleren" (handmatig) mailt niet', async () => {
    await pool.query('delete from dependency_vulnerability_notifications where name like $1', [`${PREFIX}%`]);
    osvByPackage = { [PKG('rt-high')]: ['GHSA-aaaa-aaaa-0001'] };
    await clearRuns();
    const res = await req('POST', '/api/system/sbom/refresh', { token: sysadminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(mails.length, 0);
    assert.deepEqual(await notified(), []);
  });

  it('DOEL-70: zonder nieuwe bevindingen geen mail en geen audit-event', async () => {
    const auditBefore = (await pool.query(`select count(*) from audit_log where event_type = 'dependency_vulnerability_alert_sent'`)).rows[0].count;
    osvByPackage = { [PKG('rt-low')]: ['GHSA-aaaa-aaaa-0003'], [PKG('dev-crit')]: ['GHSA-aaaa-aaaa-0004'] };
    await clearRuns();
    await sweepDependencyHealthCheck();
    assert.equal(mails.length, 0);
    assert.equal((await pool.query(`select count(*) from audit_log where event_type = 'dependency_vulnerability_alert_sent'`)).rows[0].count, auditBefore);
  });

  // --- DOEL-48 (teller voor directe productie-dependencies) -----------------------

  it('DOEL-48: de samenvatting telt updates voor directe productie-dependencies apart van het totaal', async () => {
    const s = (await getSummary())!;
    // Alle 5 fixture-componenten staan op 1.0.0 en de nagebootste registry meldt 9.9.9 (major).
    assert.equal(s.updatesAvailable, 5);
    assert.equal(s.majorUpdates, 5);
    // Direct én productie: alleen rt-high (dev-crit is direct maar ontwikkel; de rest is transitief).
    assert.deepEqual(s.directRuntimeUpdates, { patch: 0, minor: 0, major: 1 });
  });
});
