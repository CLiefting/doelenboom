import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, closePool, req, rawReq, unique, createSysadminUser, createUser, login,
} from './helpers.js';
import { pool } from '../src/db.js';

// Softwarecomponenten/SBOM-API (sysadmin-only, /api/system/sbom/*, zie
// api/src/routes/systemSbom.ts + api/src/dependencyHealth.ts). SBOM_DIR wijst
// in de testomgeving bewust naar een niet-bestaand pad (zie de "test"-npm-
// script in package.json) — dat maakt het bestandsgebaseerde deel
// (loadCurrentSbomBuild/refresh) deterministisch getest zonder een echte SBOM
// op schijf en zonder netwerkaanroepen naar npm/PyPI/OSV.dev (die zijn hier
// niet betrouwbaar/snel genoeg voor een testrun, zie ook de opmerking in
// dependencyHealth.ts over §22 "lees-kant raakt nooit het netwerk"). De
// lees-kant (summary/components/vulnerabilities) wordt hieronder rechtstreeks
// via SQL-fixtures getest — die raakt sowieso nooit SBOM_DIR of het netwerk.
const PREFIX = unique('sysinfo-sbom');

describe('systemSbom (Softwarecomponenten/SBOM, sysadmin-only)', () => {
  let sysadminToken: string;
  let gebruikerToken: string;
  let buildId: number;

  let sysadminUserId: number;

  before(async () => {
    await startTestServer();
    const sysadminEmail = `${PREFIX}-sysadmin@test.local`;
    sysadminUserId = await createSysadminUser(sysadminEmail, 'wachtwoord123');
    sysadminToken = await login(sysadminEmail, 'wachtwoord123');

    const gebruikerEmail = `${PREFIX}-gebruiker@test.local`;
    await createUser(gebruikerEmail, 'wachtwoord123');
    gebruikerToken = await login(gebruikerEmail, 'wachtwoord123');
  });

  after(async () => {
    // dependency_check_runs is een systeembrede tabel zonder eigen
    // prefix/tenant-scoping (er is er maar één SBOM/build per omgeving) —
    // expliciet opruimen op triggered_by_user_id (i.p.v. te vertrouwen op de
    // 'on delete set null' van de FK hieronder) zodat een latere testrun in
    // dezelfde (niet-verse) database nooit een cooldown van déze run erft.
    await pool.query('delete from dependency_check_runs where triggered_by_user_id = $1', [sysadminUserId]);
    // Cascade (on delete cascade, zie db/init.sql) ruimt components/
    // vulnerabilities automatisch mee op zodra de build-rij verdwijnt.
    await pool.query('delete from dependency_sbom_builds where build_version = $1', [PREFIX]);
    await pool.query('delete from users where email like $1', [`${PREFIX}%`]);
    await stopTestServer();
    await closePool();
  });

  it('alle vijf endpoints zijn sysadmin-only', async () => {
    assert.equal((await req('GET', '/api/system/sbom/summary', { token: gebruikerToken })).status, 403);
    assert.equal((await req('GET', '/api/system/sbom/components', { token: gebruikerToken })).status, 403);
    assert.equal((await req('GET', '/api/system/sbom/vulnerabilities', { token: gebruikerToken })).status, 403);
    assert.equal((await req('POST', '/api/system/sbom/refresh', { token: gebruikerToken })).status, 403);
    assert.equal((await rawReq('GET', '/api/system/sbom/download', { token: gebruikerToken })).status, 403);

    // Zonder token: 401 (requireAuth), niet 403.
    assert.equal((await req('GET', '/api/system/sbom/summary')).status, 401);
  });

  it('GET /summary geeft available:false zolang er nog geen SBOM-build in de database staat', async () => {
    const res = await req('GET', '/api/system/sbom/summary', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
  });

  it('POST /refresh geeft 409 als er geen SBOM op schijf staat (SBOM_DIR leeg in de testomgeving)', async () => {
    const res = await req('POST', '/api/system/sbom/refresh', { token: sysadminToken });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /geen sbom/i);
  });

  it('een tweede POST /refresh kort daarna wordt geweigerd door de cooldown (§9: rate limiting op de knop)', async () => {
    const res = await req('POST', '/api/system/sbom/refresh', { token: sysadminToken });
    assert.equal(res.status, 429);
    assert.ok(typeof res.body.retryAfterSeconds === 'number' && res.body.retryAfterSeconds > 0);
  });

  it('GET /download geeft 404 zolang er geen gecombineerde SBOM op schijf staat', async () => {
    const res = await rawReq('GET', '/api/system/sbom/download', { token: sysadminToken });
    assert.equal(res.status, 404);
  });

  it('richt een SBOM-build met componenten/kwetsbaarheden rechtstreeks in de database in (fixture voor de lees-kant hieronder)', async () => {
    const build = await pool.query(
      `insert into dependency_sbom_builds (build_version, git_commit, cyclonedx_spec_version, sbom_serial_number, generated_at)
       values ($1, 'abc1234', '1.6', 'urn:uuid:11111111-1111-1111-1111-111111111111', now())
       returning id`,
      [PREFIX]
    );
    buildId = build.rows[0].id;

    type ComponentSeed = {
      applicationComponent: 'api' | 'web' | 'excel-service';
      applicationPart: 'frontend' | 'backend';
      ecosystem: 'npm' | 'pypi';
      name: string;
      version: string;
      dependencyType: 'direct' | 'transitive';
      scope: 'runtime' | 'development';
      license: string | null;
      latestVersion: string | null;
      updateCategory: 'actueel' | 'patch' | 'minor' | 'major' | 'onbekend';
    };
    const components: ComponentSeed[] = [
      { applicationComponent: 'api', applicationPart: 'backend', ecosystem: 'npm', name: 'express', version: '4.19.0', dependencyType: 'direct', scope: 'runtime', license: 'MIT', latestVersion: '4.19.0', updateCategory: 'actueel' },
      { applicationComponent: 'api', applicationPart: 'backend', ecosystem: 'npm', name: 'lodash', version: '4.17.20', dependencyType: 'transitive', scope: 'runtime', license: 'MIT', latestVersion: '4.17.21', updateCategory: 'patch' },
      { applicationComponent: 'web', applicationPart: 'frontend', ecosystem: 'npm', name: 'react', version: '18.2.0', dependencyType: 'direct', scope: 'runtime', license: 'MIT', latestVersion: '18.3.0', updateCategory: 'minor' },
      { applicationComponent: 'web', applicationPart: 'frontend', ecosystem: 'npm', name: 'vite', version: '4.0.0', dependencyType: 'direct', scope: 'development', license: 'MIT', latestVersion: '6.0.0', updateCategory: 'major' },
      { applicationComponent: 'excel-service', applicationPart: 'backend', ecosystem: 'pypi', name: 'fastapi', version: '0.100.0', dependencyType: 'direct', scope: 'runtime', license: 'MIT', latestVersion: null, updateCategory: 'onbekend' },
    ];

    const idByName = new Map<string, number>();
    for (const c of components) {
      const inserted = await pool.query(
        `insert into dependency_components
           (build_id, application_component, application_part, ecosystem, name, version, purl, dependency_type, scope, license, latest_version, update_category, version_checked_at)
         values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11, now())
         returning id`,
        [buildId, c.applicationComponent, c.applicationPart, c.ecosystem, c.name, c.version, c.dependencyType, c.scope, c.license, c.latestVersion, c.updateCategory]
      );
      idByName.set(c.name, inserted.rows[0].id);
    }

    // Eén woord-ernst (kritiek, GHSA-achtig), één alléén-CVSS-vector (moet
    // 'onbekend' classificeren, zie classifySeverityLevel), verdeeld over twee
    // componenten zodat vulnerableComponents/criticalVulnerabilities in de
    // summary-telling ook echt iets onderscheidends te tellen hebben.
    await pool.query(
      `insert into dependency_vulnerabilities (component_id, vulnerability_id, cve, severity, summary, fixed_version, source)
       values
         ($1, 'GHSA-aaaa-bbbb-cccc', 'CVE-2021-23337', 'CRITICAL', 'Command injection in lodash template', '4.17.21', 'osv.dev'),
         ($1, 'GHSA-dddd-eeee-ffff', null, 'HIGH', 'Prototype pollution', '4.17.19', 'osv.dev'),
         ($2, 'GHSA-gggg-hhhh-iiii', null, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'Onduidelijke ernst, alleen CVSS-vector bekend', null, 'osv.dev')`,
      [idByName.get('lodash'), idByName.get('react')]
    );
  });

  it('GET /summary telt componenten/updates/kwetsbaarheden correct voor de laatst gegenereerde build', async () => {
    const res = await req('GET', '/api/system/sbom/summary', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.buildVersion, PREFIX);
    assert.equal(res.body.sbomSerialNumber, 'urn:uuid:11111111-1111-1111-1111-111111111111');
    assert.equal(res.body.totalComponents, 5);
    assert.equal(res.body.directDependencies, 4);
    assert.equal(res.body.transitiveDependencies, 1);
    assert.equal(res.body.updatesAvailable, 3); // patch + minor + major
    assert.equal(res.body.majorUpdates, 1);
    assert.equal(res.body.vulnerableComponents, 2); // lodash + react
    // lodash heeft 1 kritieke (CRITICAL) + 1 hoge (HIGH); react's enige
    // kwetsbaarheid heeft alleen een CVSS-vector -> classificeert als
    // 'onbekend', telt dus terecht niet mee als kritiek.
    assert.equal(res.body.criticalVulnerabilities, 1);
  });

  it('GET /components zonder filters geeft alle 5 componenten, met kwetsbaarhedentelling per rij', async () => {
    const res = await req('GET', '/api/system/sbom/components', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.items.length, 5);
    const lodash = res.body.items.find((c: any) => c.name === 'lodash');
    assert.equal(lodash.vulnerabilityCount, 2);
    assert.equal(lodash.updateCategory, 'patch');
    const fastapi = res.body.items.find((c: any) => c.name === 'fastapi');
    assert.equal(fastapi.ecosystem, 'pypi');
    assert.equal(fastapi.vulnerabilityCount, 0);
  });

  it('GET /components filtert op applicationComponent/ecosystem/dependencyType/scope/updateCategory', async () => {
    const onlyWeb = await req('GET', '/api/system/sbom/components?applicationComponent=web', { token: sysadminToken });
    assert.equal(onlyWeb.body.total, 2);
    assert.ok(onlyWeb.body.items.every((c: any) => c.applicationComponent === 'web'));

    const onlyPypi = await req('GET', '/api/system/sbom/components?ecosystem=pypi', { token: sysadminToken });
    assert.equal(onlyPypi.body.total, 1);
    assert.equal(onlyPypi.body.items[0].name, 'fastapi');

    const onlyTransitive = await req('GET', '/api/system/sbom/components?dependencyType=transitive', { token: sysadminToken });
    assert.equal(onlyTransitive.body.total, 1);
    assert.equal(onlyTransitive.body.items[0].name, 'lodash');

    const onlyDev = await req('GET', '/api/system/sbom/components?scope=development', { token: sysadminToken });
    assert.equal(onlyDev.body.total, 1);
    assert.equal(onlyDev.body.items[0].name, 'vite');

    const onlyMajor = await req('GET', '/api/system/sbom/components?updateCategory=major', { token: sysadminToken });
    assert.equal(onlyMajor.body.total, 1);
    assert.equal(onlyMajor.body.items[0].name, 'vite');

    // Een onbekende/ongeldige enum-waarde wordt genegeerd (whitelist in
    // routes/systemSbom.ts) i.p.v. een 400 of stilzwijgend verkeerd filter.
    const invalidIgnored = await req('GET', '/api/system/sbom/components?updateCategory=onzin', { token: sysadminToken });
    assert.equal(invalidIgnored.body.total, 5);
  });

  it('GET /components zoekt op (deel van) de naam', async () => {
    const res = await req('GET', '/api/system/sbom/components?search=eact', { token: sysadminToken });
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].name, 'react');
  });

  it('GET /components sorteert en pagineert', async () => {
    const asc = await req('GET', '/api/system/sbom/components?sortBy=name&sortDir=asc', { token: sysadminToken });
    assert.deepEqual(asc.body.items.map((c: any) => c.name), ['express', 'fastapi', 'lodash', 'react', 'vite']);

    const desc = await req('GET', '/api/system/sbom/components?sortBy=name&sortDir=desc', { token: sysadminToken });
    assert.deepEqual(desc.body.items.map((c: any) => c.name), ['vite', 'react', 'lodash', 'fastapi', 'express']);

    const page1 = await req('GET', '/api/system/sbom/components?sortBy=name&sortDir=asc&limit=2&offset=0', { token: sysadminToken });
    assert.equal(page1.body.total, 5);
    assert.deepEqual(page1.body.items.map((c: any) => c.name), ['express', 'fastapi']);

    const page2 = await req('GET', '/api/system/sbom/components?sortBy=name&sortDir=asc&limit=2&offset=2', { token: sysadminToken });
    assert.deepEqual(page2.body.items.map((c: any) => c.name), ['lodash', 'react']);
  });

  it('GET /vulnerabilities geeft alle drie de kwetsbaarheden met afgeleid severityLevel', async () => {
    const res = await req('GET', '/api/system/sbom/vulnerabilities', { token: sysadminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    const cvssOnly = res.body.items.find((v: any) => v.vulnerabilityId === 'GHSA-gggg-hhhh-iiii');
    assert.equal(cvssOnly.severityLevel, 'onbekend');
    assert.match(cvssOnly.severity, /^CVSS:/);
    const critical = res.body.items.find((v: any) => v.vulnerabilityId === 'GHSA-aaaa-bbbb-cccc');
    assert.equal(critical.severityLevel, 'kritiek');
    assert.equal(critical.cve, 'CVE-2021-23337');
    assert.equal(critical.fixedVersion, '4.17.21');
  });

  it('GET /vulnerabilities filtert op applicationComponent/severityLevel en zoekt op component/CVE/ID', async () => {
    const onlyApi = await req('GET', '/api/system/sbom/vulnerabilities?applicationComponent=api', { token: sysadminToken });
    assert.equal(onlyApi.body.total, 2); // beide lodash-kwetsbaarheden

    const onlyKritiek = await req('GET', '/api/system/sbom/vulnerabilities?severityLevel=kritiek', { token: sysadminToken });
    assert.equal(onlyKritiek.body.total, 1);
    assert.equal(onlyKritiek.body.items[0].vulnerabilityId, 'GHSA-aaaa-bbbb-cccc');

    const byCve = await req('GET', '/api/system/sbom/vulnerabilities?search=2021-23337', { token: sysadminToken });
    assert.equal(byCve.body.total, 1);

    const byComponentName = await req('GET', '/api/system/sbom/vulnerabilities?search=react', { token: sysadminToken });
    assert.equal(byComponentName.body.total, 1);
    assert.equal(byComponentName.body.items[0].vulnerabilityId, 'GHSA-gggg-hhhh-iiii');
  });
});
