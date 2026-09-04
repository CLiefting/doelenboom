import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';

// Software Bill of Materials / dependency-health (CISO-aandachtspunt, zie
// doelenboom_sbom_ontwerp.md in het project en db/init.sql voor het
// datamodel). Leest de door scripts/generate-sbom.sh gegenereerde
// CycloneDX-SBOM's + hun .meta.json-zusjes (direct/runtime-namen) van schijf,
// normaliseert de componenten, zoekt nieuwste versies + kwetsbaarheden op
// (npm-registry/PyPI/OSV.dev) en cachet dat in Postgres — zie
// refreshDependencyHealth() onderaan. De lees-kant (getSummary/
// getComponents/getVulnerabilities, gebruikt door routes/systemSbom.ts) raakt
// NOOIT het netwerk, alleen de database — zie §22 van de opdracht.

// Standaard "/app/sbom" (zie docker-compose.yml: ./sbom:/app/sbom:ro) — lokaal
// zonder Docker (bv. `npm run dev` in api/) valt dit terug op de repo-root se
// eigen sbom/-map, zodat SBOM_DIR niet apart gezet hoeft te worden voor lokaal
// draaien met dat script al eens uitgevoerd.
const SBOM_DIR = process.env.SBOM_DIR || path.resolve(process.cwd(), '..', 'sbom');

export type ApplicationComponentKey = 'api' | 'web' | 'excel-service';
export type Ecosystem = 'npm' | 'pypi';
export type DependencyType = 'direct' | 'transitive';
export type Scope = 'runtime' | 'development';
export type UpdateCategory = 'actueel' | 'patch' | 'minor' | 'major' | 'onbekend';

type SbomMeta = {
  generatedAt: string;
  buildVersion: string;
  gitCommit: string | null;
  cyclonedxSpecVersion: string;
  sbomSerialNumber: string | null;
  components: ApplicationComponentKey[];
};

type CdxLicense = { license?: { id?: string; name?: string } };
type CdxComponent = {
  name: string;
  group?: string;
  version: string;
  purl?: string;
  licenses?: CdxLicense[];
  properties?: { name: string; value: string }[];
};
type CdxDocument = { specVersion?: string; components?: CdxComponent[] };
type ComponentMeta = { directNames: string[]; runtimeNames: string[] };

export type NormalizedComponent = {
  applicationComponent: ApplicationComponentKey;
  applicationPart: 'frontend' | 'backend';
  ecosystem: Ecosystem;
  name: string;
  version: string;
  purl: string | null;
  dependencyType: DependencyType;
  scope: Scope;
  license: string | null;
};

const APPLICATION_PART: Record<ApplicationComponentKey, 'frontend' | 'backend'> = {
  api: 'backend',
  web: 'frontend',
  'excel-service': 'backend',
};
const ECOSYSTEM: Record<ApplicationComponentKey, Ecosystem> = {
  api: 'npm',
  web: 'npm',
  'excel-service': 'pypi',
};

function normalizePyName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

// npm-componentnaam zoals die ook in package.json/de .meta.json-directNames
// voorkomt: "@scope/naam" voor scoped packages, anders gewoon "naam".
function npmComponentKey(c: CdxComponent): string {
  return c.group ? `${c.group}/${c.name}` : c.name;
}

function licenseFromComponent(c: CdxComponent): string | null {
  const first = c.licenses?.[0]?.license;
  if (!first) return null;
  return first.id ?? first.name ?? null;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    console.error(`SBOM-bestand ${filePath} kon niet gelezen worden (corrupt/ongeldig JSON):`, err);
    return null;
  }
}

export type LoadedSbomBuild = {
  meta: SbomMeta;
  components: NormalizedComponent[];
};

// Leest en normaliseert de huidige SBOM-set van schijf. Retourneert null als
// er (nog) geen SBOM is gegenereerd — dat is een verwachte, geen fatale,
// toestand (zie §19 van de opdracht: een falende/ontbrekende SBOM mag de rest
// van Doelenboom niet verstoren), de aanroepers tonen dan "geen SBOM
// beschikbaar" resp. slaan de refresh over.
export function loadCurrentSbomBuild(): LoadedSbomBuild | null {
  const meta = readJsonFile<SbomMeta>(path.join(SBOM_DIR, 'meta.json'));
  if (!meta) return null;

  const components: NormalizedComponent[] = [];
  for (const key of meta.components) {
    const doc = readJsonFile<CdxDocument>(path.join(SBOM_DIR, `${key}.cdx.json`));
    const compMeta = readJsonFile<ComponentMeta>(path.join(SBOM_DIR, `${key}.meta.json`));
    if (!doc || !compMeta) continue;
    const directNames = new Set(compMeta.directNames);
    const runtimeNames = new Set(compMeta.runtimeNames);
    const ecosystem = ECOSYSTEM[key];

    for (const c of doc.components ?? []) {
      // Matchsleutel voor de directNames/runtimeNames-sets uit .meta.json:
      // voor npm de "@scope/naam"-vorm (zoals package.json 'm ook gebruikt),
      // voor Python de PEP 503-genormaliseerde naam (zoals
      // scripts/sbom_python_scope.py die ook produceert) — zie
      // scripts/sbom-postprocess.mjs voor waar deze sets vandaan komen.
      const matchKey = ecosystem === 'npm' ? npmComponentKey(c) : normalizePyName(c.name);
      components.push({
        applicationComponent: key,
        applicationPart: APPLICATION_PART[key],
        ecosystem,
        name: c.name,
        version: c.version,
        purl: c.purl ?? null,
        dependencyType: directNames.has(matchKey) ? 'direct' : 'transitive',
        scope: runtimeNames.has(matchKey) ? 'runtime' : 'development',
        license: licenseFromComponent(c),
      });
    }
  }
  return { meta, components };
}

// --- Semver-classificatie (§7 van de opdracht) ---------------------------

type ParsedVersion = { major: number; minor: number; patch: number; prerelease: string | null };
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.-]+))?$/;

function parseSemver(v: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

// >0 als a > b, <0 als a < b, 0 als gelijk — prerelease-precedentie is bewust
// vereenvoudigd (een prerelease telt als "vóór" de gewone release) omdat het
// hier alleen gaat om "is er een nieuwere release", niet om volledige
// semver-precedentie zoals bij dependency-resolutie.
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
  return 0;
}

// Exported voor unit-tests (zie api/test/dependencyHealth.test.ts). Niet-
// standaard/onherkenbare versienotaties geven bewust 'onbekend' i.p.v. een
// giswerk-conclusie (§7: "de applicatie mag bij twijfel geen verkeerde
// conclusie presenteren").
export function classifySemverUpdate(current: string, latest: string): UpdateCategory {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return 'onbekend';
  const cmp = compareVersions(l, c);
  if (cmp <= 0) return 'actueel';
  if (l.major !== c.major) return 'major';
  if (l.minor !== c.minor) return 'minor';
  return 'patch';
}

// --- Registry-lookups (nieuwste versie) -----------------------------------

const FETCH_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLatestNpmVersion(name: string): Promise<string | null> {
  try {
    // npm-registry-conventie voor scoped packages: alleen de segmenten los
    // percent-encoden, de "/" ertussen NIET (anders 404).
    const urlPath = name.startsWith('@')
      ? name.split('/').map(encodeURIComponent).join('/')
      : encodeURIComponent(name);
    const res = await fetchWithTimeout(`https://registry.npmjs.org/${urlPath}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    return typeof latest === 'string' ? latest : null;
  } catch {
    return null;
  }
}

export async function fetchLatestPypiVersion(name: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: { version?: string } };
    return typeof data.info?.version === 'string' ? data.info!.version! : null;
  } catch {
    return null;
  }
}

// Kleine concurrency-begrensde map i.p.v. alles tegelijk (zou de registry
// kunnen laten rate-limiten) of alles na elkaar (te traag bij 300+ unieke
// packages) — zie §22 van de opdracht.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- OSV.dev kwetsbaarheden-check ------------------------------------------

const OSV_QUERYBATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
const OSV_BATCH_SIZE = 300;

type OsvQuery = { ecosystem: Ecosystem; name: string; version: string };

// name -> OSV-ecosysteemnaam (zie https://ossf.github.io/osv-schema/#ecosystem)
const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI' };

async function queryOsvIds(queries: OsvQuery[]): Promise<Map<number, string[]>> {
  // key = index in `queries` -> gevonden vulnerability-id's.
  const idsByIndex = new Map<number, string[]>();
  for (let i = 0; i < queries.length; i += OSV_BATCH_SIZE) {
    const chunk = queries.slice(i, i + OSV_BATCH_SIZE);
    try {
      const res = await fetchWithTimeout(OSV_QUERYBATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: OSV_ECOSYSTEM[q.ecosystem] }, version: q.version })),
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
      (data.results ?? []).forEach((r, idx) => {
        const ids = (r.vulns ?? []).map((v) => v.id).filter(Boolean);
        if (ids.length > 0) idsByIndex.set(i + idx, ids);
      });
    } catch (err) {
      // Eén mislukte batch (OSV.dev onbereikbaar/timeout) mag de rest van de
      // refresh niet blokkeren — zie §19 van de opdracht.
      console.error('OSV.dev querybatch mislukt (batch overgeslagen):', err);
    }
  }
  return idsByIndex;
}

export type OsvVulnDetail = {
  id: string;
  cve: string | null;
  severity: string | null;
  summary: string | null;
  // Ruwe OSV-payload bewaard (i.p.v. hier al een fixedVersion te bepalen):
  // welke versie een fix bevat hangt af van WELK getroffen component het
  // betreft (raw.affected[] kan meerdere packages/ranges noemen), en één
  // vulnerability-detail wordt hier gedeeld over alle componenten die 'm
  // treffen (gededupliceerd op vulnerability-id, zie refreshVulnerabilities).
  raw: any;
};

function extractCve(aliases: string[] | undefined): string | null {
  return aliases?.find((a) => /^CVE-\d{4}-\d+$/.test(a)) ?? null;
}

// OSV geeft severity op twee, niet altijd allebei aanwezige manieren: een
// CVSS-vectorstring (severity[].score — GEEN kaal getal, dat vergt een eigen
// CVSS-rekenmodule om te herleiden tot laag/gemiddeld/hoog/kritiek, wat voor
// dit doel onnodig risicovol giswerk zou zijn) en/of een woord
// (database_specific.severity, bv. "CRITICAL"/"HIGH" — vaak aanwezig bij
// GHSA-advisories). We bewaren bij voorkeur het woord (leesbaar, en meteen
// classificeerbaar via classifySeverityLevel hieronder); is er alleen een
// CVSS-vector, dan bewaren we die als informatieve tekst maar classificeert
// classifySeverityLevel 'm als 'onbekend' i.p.v. te gokken (§7/§19).
function extractSeverity(raw: any): string | null {
  const dbSpecific = raw?.database_specific?.severity;
  if (typeof dbSpecific === 'string') return dbSpecific;
  const cvss = raw?.severity?.[0]?.score;
  return typeof cvss === 'string' ? cvss : null;
}

export type SeverityLevel = 'kritiek' | 'hoog' | 'gemiddeld' | 'laag' | 'onbekend';

// Exported voor unit-tests. Alleen de expliciete OSV-woorden classificeren
// (case-insensitive) — een CVSS-vectorstring of iets onherkenbaars geeft
// bewust 'onbekend', zie extractSeverity hierboven.
export function classifySeverityLevel(severity: string | null): SeverityLevel {
  if (!severity) return 'onbekend';
  const s = severity.trim().toUpperCase();
  if (s === 'CRITICAL') return 'kritiek';
  if (s === 'HIGH') return 'hoog';
  if (s === 'MODERATE' || s === 'MEDIUM') return 'gemiddeld';
  if (s === 'LOW') return 'laag';
  return 'onbekend';
}

function extractFixedVersion(raw: any, ecosystem: Ecosystem, packageName: string): string | null {
  for (const affected of raw?.affected ?? []) {
    const pkgName = affected?.package?.name;
    if (pkgName && normalizeForCompare(pkgName, ecosystem) !== normalizeForCompare(packageName, ecosystem)) continue;
    for (const range of affected?.ranges ?? []) {
      const fixEvent = range?.events?.find((e: any) => typeof e?.fixed === 'string');
      if (fixEvent) return fixEvent.fixed;
    }
  }
  return null;
}

function normalizeForCompare(name: string, ecosystem: Ecosystem): string {
  return ecosystem === 'pypi' ? normalizePyName(name) : name;
}

async function fetchOsvVulnDetail(id: string): Promise<OsvVulnDetail | null> {
  try {
    const res = await fetchWithTimeout(`${OSV_VULN_URL}${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const raw = await res.json();
    return {
      id,
      cve: extractCve(raw.aliases),
      severity: extractSeverity(raw),
      summary: typeof raw.summary === 'string' ? raw.summary : (typeof raw.details === 'string' ? raw.details.slice(0, 500) : null),
      raw,
    };
  } catch (err) {
    console.error(`OSV.dev-detail voor ${id} kon niet opgehaald worden:`, err);
    return null;
  }
}

// --- Refresh-orkestratie ----------------------------------------------------

export class NoSbomError extends Error {
  constructor() {
    super('Geen SBOM gevonden — draai eerst scripts/generate-sbom.sh (zie doelenboom_sbom_ontwerp.md).');
    this.name = 'NoSbomError';
  }
}

async function ensureBuildRow(meta: SbomMeta): Promise<number> {
  const existing = await pool.query(
    `select id from dependency_sbom_builds where build_version = $1 and generated_at = $2`,
    [meta.buildVersion, meta.generatedAt]
  );
  if (existing.rows.length > 0) return existing.rows[0].id as number;
  const inserted = await pool.query(
    `insert into dependency_sbom_builds (build_version, git_commit, cyclonedx_spec_version, sbom_serial_number, generated_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [meta.buildVersion, meta.gitCommit, meta.cyclonedxSpecVersion, meta.sbomSerialNumber, meta.generatedAt]
  );
  return inserted.rows[0].id as number;
}

type ComponentRowKey = string; // `${applicationComponent}|${name}|${version}`
function componentRowKey(c: { applicationComponent: string; name: string; version: string }): ComponentRowKey {
  return `${c.applicationComponent}|${c.name}|${c.version}`;
}

async function upsertComponents(buildId: number, components: NormalizedComponent[]): Promise<Map<ComponentRowKey, number>> {
  const idByKey = new Map<ComponentRowKey, number>();
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const c of components) {
      const result = await client.query(
        `insert into dependency_components
           (build_id, application_component, application_part, ecosystem, name, version, purl, dependency_type, scope, license)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (build_id, application_component, name, version) do update set
           purl = excluded.purl, dependency_type = excluded.dependency_type,
           scope = excluded.scope, license = excluded.license
         returning id`,
        [
          buildId, c.applicationComponent, c.applicationPart, c.ecosystem, c.name, c.version,
          c.purl, c.dependencyType, c.scope, c.license,
        ]
      );
      idByKey.set(componentRowKey(c), result.rows[0].id as number);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return idByKey;
}

async function refreshLatestVersions(components: NormalizedComponent[], idByKey: Map<ComponentRowKey, number>): Promise<void> {
  // Dedupliceren per (ecosystem,name): meerdere applicatiedelen kunnen
  // dezelfde package gebruiken (bv. @types/node in zowel api als web) — dat
  // hoeft maar 1x bij de registry nagevraagd te worden.
  const unique = new Map<string, { ecosystem: Ecosystem; name: string }>();
  for (const c of components) unique.set(`${c.ecosystem}:${c.name}`, { ecosystem: c.ecosystem, name: c.name });
  const uniqueList = [...unique.values()];

  const latestByKey = new Map<string, string | null>();
  const CONCURRENCY = 12;
  const fetched = await mapWithConcurrency(uniqueList, CONCURRENCY, async (u) => {
    const latest = u.ecosystem === 'npm' ? await fetchLatestNpmVersion(u.name) : await fetchLatestPypiVersion(u.name);
    return { key: `${u.ecosystem}:${u.name}`, latest };
  });
  for (const f of fetched) latestByKey.set(f.key, f.latest);

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const c of components) {
      const id = idByKey.get(componentRowKey(c));
      if (!id) continue;
      const latest = latestByKey.get(`${c.ecosystem}:${c.name}`) ?? null;
      const category: UpdateCategory = latest ? classifySemverUpdate(c.version, latest) : 'onbekend';
      await client.query(
        `update dependency_components
         set latest_version = $1, update_category = $2, version_checked_at = now()
         where id = $3`,
        [latest, category, id]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function refreshVulnerabilities(components: NormalizedComponent[], idByKey: Map<ComponentRowKey, number>): Promise<number> {
  const queries: OsvQuery[] = components.map((c) => ({ ecosystem: c.ecosystem, name: c.name, version: c.version }));
  const idsByIndex = await queryOsvIds(queries);

  const uniqueVulnIds = new Set<string>();
  for (const ids of idsByIndex.values()) for (const id of ids) uniqueVulnIds.add(id);

  const detailById = new Map<string, OsvVulnDetail>();
  const CONCURRENCY = 8;
  const details = await mapWithConcurrency([...uniqueVulnIds], CONCURRENCY, fetchOsvVulnDetail);
  for (const d of details) if (d) detailById.set(d.id, d);

  const checkedComponentIds = [...idByKey.values()];
  let vulnerabilitiesFound = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (checkedComponentIds.length > 0) {
      // Eerst opschonen voor alle componenten die we net (opnieuw) gecheckt
      // hebben — voorkomt dat een niet-meer-gevonden (bv. inmiddels
      // ingetrokken) advisory blijft hangen.
      await client.query(
        `delete from dependency_vulnerabilities where component_id = any($1::bigint[])`,
        [checkedComponentIds]
      );
    }
    for (let i = 0; i < components.length; i += 1) {
      const ids = idsByIndex.get(i);
      if (!ids || ids.length === 0) continue;
      const componentId = idByKey.get(componentRowKey(components[i]));
      if (!componentId) continue;
      const component = components[i];
      for (const vulnId of ids) {
        const detail = detailById.get(vulnId);
        vulnerabilitiesFound += 1;
        await client.query(
          `insert into dependency_vulnerabilities
             (component_id, vulnerability_id, cve, severity, summary, fixed_version, source)
           values ($1,$2,$3,$4,$5,$6,'osv.dev')
           on conflict (component_id, vulnerability_id) do update set
             cve = excluded.cve, severity = excluded.severity, summary = excluded.summary,
             fixed_version = excluded.fixed_version, checked_at = now()`,
          [
            componentId,
            vulnId,
            detail?.cve ?? null,
            detail?.severity ?? null,
            detail?.summary ?? null,
            detail ? extractFixedVersion(detail.raw, component.ecosystem, component.name) : null,
          ]
        );
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return vulnerabilitiesFound;
}

export type RefreshResult = {
  status: 'success' | 'partial' | 'failed';
  componentsChecked: number;
  vulnerabilitiesFound: number;
  error?: string;
};

const MIN_MANUAL_REFRESH_INTERVAL_MS = 60_000;
const AUTOMATIC_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

export async function getLastCheckRun(): Promise<{ startedAt: string; finishedAt: string | null; status: string } | null> {
  const result = await pool.query(
    `select started_at, finished_at, status from dependency_check_runs order by started_at desc limit 1`
  );
  if (result.rows.length === 0) return null;
  return {
    startedAt: result.rows[0].started_at,
    finishedAt: result.rows[0].finished_at,
    status: result.rows[0].status,
  };
}

// POST /api/system/sbom/refresh (routes/systemSbom.ts) roept dit aan met
// isManual=true — een korte cooldown (i.p.v. de volle 24 uur van de
// automatische sweep) voorkomt dat de knop per ongeluk/moedwillig
// achter-elkaar de registries/OSV.dev bestookt (§9 van de opdracht: "rate
// limiting toepassen waar relevant"), zonder een bevoegde beheerder die één
// keer per minuut wil verversen echt in de weg te zitten.
export async function refreshDependencyHealth(opts: { triggeredByUserId: number | null; isManual: boolean }): Promise<RefreshResult> {
  const last = await pool.query(
    `select finished_at, status from dependency_check_runs where status <> 'running' order by started_at desc limit 1`
  );
  if (last.rows.length > 0 && last.rows[0].finished_at) {
    const elapsed = Date.now() - new Date(last.rows[0].finished_at).getTime();
    const minInterval = opts.isManual ? MIN_MANUAL_REFRESH_INTERVAL_MS : AUTOMATIC_REFRESH_INTERVAL_MS;
    if (elapsed < minInterval) {
      const retryAfterSeconds = Math.ceil((minInterval - elapsed) / 1000);
      throw new RefreshCooldownError(retryAfterSeconds);
    }
  }

  const runInsert = await pool.query(
    `insert into dependency_check_runs (triggered_by_user_id) values ($1) returning id`,
    [opts.triggeredByUserId]
  );
  const runId = runInsert.rows[0].id as number;

  try {
    const build = loadCurrentSbomBuild();
    if (!build) throw new NoSbomError();

    const buildId = await ensureBuildRow(build.meta);
    const idByKey = await upsertComponents(buildId, build.components);
    await refreshLatestVersions(build.components, idByKey);
    const vulnerabilitiesFound = await refreshVulnerabilities(build.components, idByKey);

    await pool.query(
      `update dependency_check_runs
       set finished_at = now(), status = 'success', components_checked = $2, vulnerabilities_found = $3
       where id = $1`,
      [runId, build.components.length, vulnerabilitiesFound]
    );
    return { status: 'success', componentsChecked: build.components.length, vulnerabilitiesFound };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `update dependency_check_runs set finished_at = now(), status = 'failed', error = $2 where id = $1`,
      [runId, message]
    );
    if (err instanceof NoSbomError) throw err;
    console.error('Dependency-health-controle mislukt:', err);
    return { status: 'failed', componentsChecked: 0, vulnerabilitiesFound: 0, error: message };
  }
}

export class RefreshCooldownError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Wacht nog ${retryAfterSeconds} seconden voordat je opnieuw controleert.`);
    this.name = 'RefreshCooldownError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Automatische sweep (zelfde in-process setInterval-patroon als
// tenantWipe.ts/accountRetention.ts, zie index.ts) — draait hooguit 1x/24u
// (bewaakt via dependency_check_runs, niet via de intervaltimer zelf, zodat
// een herstart de 24-uursklok niet ongewild reset).
export async function sweepDependencyHealthCheck(): Promise<void> {
  const build = loadCurrentSbomBuild();
  if (!build) return; // geen SBOM gegenereerd — niets te controleren, geen foutmelding nodig
  try {
    await refreshDependencyHealth({ triggeredByUserId: null, isManual: false });
  } catch (err) {
    if (err instanceof RefreshCooldownError) return; // nog geen 24u om, verwacht gedrag
    console.error('Automatische dependency-health-sweep mislukt:', err);
  }
}

// --- Lees-kant (routes/systemSbom.ts) ---------------------------------------
// Alles hieronder raakt uitsluitend Postgres — nooit npm/PyPI/OSV.dev (§22 van
// de opdracht: de browser/request-cyclus mag nooit rechtstreeks of indirect op
// een externe registry wachten). De laatste build ("actuele SBOM") is steeds
// de rij met de hoogste generated_at in dependency_sbom_builds.

export type DependencyHealthSummary = {
  buildVersion: string | null;
  gitCommit: string | null;
  generatedAt: string | null;
  cyclonedxSpecVersion: string | null;
  sbomSerialNumber: string | null;
  lastCheckedAt: string | null;
  totalComponents: number;
  directDependencies: number;
  transitiveDependencies: number;
  updatesAvailable: number;
  majorUpdates: number;
  vulnerableComponents: number;
  criticalVulnerabilities: number;
};

async function latestBuildId(): Promise<number | null> {
  const result = await pool.query(
    `select id from dependency_sbom_builds order by generated_at desc limit 1`
  );
  return result.rows.length > 0 ? (result.rows[0].id as number) : null;
}

export async function getSummary(): Promise<DependencyHealthSummary | null> {
  const buildResult = await pool.query(
    `select id, build_version, git_commit, cyclonedx_spec_version, sbom_serial_number, generated_at
     from dependency_sbom_builds order by generated_at desc limit 1`
  );
  if (buildResult.rows.length === 0) return null;
  const build = buildResult.rows[0];

  const countsResult = await pool.query(
    `select
       count(*) as total,
       count(*) filter (where dependency_type = 'direct') as direct,
       count(*) filter (where dependency_type = 'transitive') as transitive,
       count(*) filter (where update_category in ('patch', 'minor', 'major')) as updates_available,
       count(*) filter (where update_category = 'major') as major_updates
     from dependency_components where build_id = $1`,
    [build.id]
  );
  const counts = countsResult.rows[0];

  const vulnComponentsResult = await pool.query(
    `select count(distinct v.component_id) as count
     from dependency_vulnerabilities v join dependency_components c on c.id = v.component_id
     where c.build_id = $1`,
    [build.id]
  );

  // Kritiek wordt via classifySeverityLevel bepaald (niet in SQL "= 'CRITICAL'"
  // gedupliceerd) zodat deze telling altijd in lijn blijft met wat de
  // kwetsbaarhedenlijst zelf als "kritiek" toont — het aantal rijen is klein
  // genoeg (per component enkele kwetsbaarheden) om in de API-laag te
  // classificeren i.p.v. in SQL te herhalen.
  const severityResult = await pool.query(
    `select v.severity from dependency_vulnerabilities v join dependency_components c on c.id = v.component_id
     where c.build_id = $1`,
    [build.id]
  );
  const criticalVulnerabilities = severityResult.rows.filter(
    (r: { severity: string | null }) => classifySeverityLevel(r.severity) === 'kritiek'
  ).length;

  const lastCheckResult = await pool.query(
    `select finished_at from dependency_check_runs where status in ('success', 'partial') order by finished_at desc limit 1`
  );

  return {
    buildVersion: build.build_version,
    gitCommit: build.git_commit,
    generatedAt: build.generated_at,
    cyclonedxSpecVersion: build.cyclonedx_spec_version,
    sbomSerialNumber: build.sbom_serial_number,
    lastCheckedAt: lastCheckResult.rows[0]?.finished_at ?? null,
    totalComponents: Number(counts.total),
    directDependencies: Number(counts.direct),
    transitiveDependencies: Number(counts.transitive),
    updatesAvailable: Number(counts.updates_available),
    majorUpdates: Number(counts.major_updates),
    vulnerableComponents: Number(vulnComponentsResult.rows[0].count),
    criticalVulnerabilities,
  };
}

export type DependencyComponentRow = {
  id: number;
  applicationComponent: ApplicationComponentKey;
  applicationPart: 'frontend' | 'backend';
  ecosystem: Ecosystem;
  name: string;
  version: string;
  purl: string | null;
  dependencyType: DependencyType;
  scope: Scope;
  license: string | null;
  latestVersion: string | null;
  updateCategory: UpdateCategory;
  versionCheckedAt: string | null;
  vulnerabilityCount: number;
};

export type DependencyComponentFilters = {
  applicationComponent?: ApplicationComponentKey;
  ecosystem?: Ecosystem;
  dependencyType?: DependencyType;
  scope?: Scope;
  updateCategory?: UpdateCategory;
  search?: string;
  sortBy?: 'name' | 'applicationComponent' | 'updateCategory' | 'version';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

// Whitelist i.p.v. de kolomnaam rechtstreeks uit de request over te nemen —
// een onbekende sortBy-waarde valt terug op 'c.name' in plaats van een
// SQL-fout of (erger) een injectiemogelijkheid.
const COMPONENT_SORT_COLUMNS: Record<NonNullable<DependencyComponentFilters['sortBy']>, string> = {
  name: 'c.name',
  applicationComponent: 'c.application_component',
  updateCategory: 'c.update_category',
  version: 'c.version',
};

export async function getComponents(
  filters: DependencyComponentFilters = {}
): Promise<{ items: DependencyComponentRow[]; total: number }> {
  const buildId = await latestBuildId();
  if (buildId === null) return { items: [], total: 0 };

  const conditions: string[] = ['c.build_id = $1'];
  const params: unknown[] = [buildId];
  if (filters.applicationComponent) {
    params.push(filters.applicationComponent);
    conditions.push(`c.application_component = $${params.length}`);
  }
  if (filters.ecosystem) {
    params.push(filters.ecosystem);
    conditions.push(`c.ecosystem = $${params.length}`);
  }
  if (filters.dependencyType) {
    params.push(filters.dependencyType);
    conditions.push(`c.dependency_type = $${params.length}`);
  }
  if (filters.scope) {
    params.push(filters.scope);
    conditions.push(`c.scope = $${params.length}`);
  }
  if (filters.updateCategory) {
    params.push(filters.updateCategory);
    conditions.push(`c.update_category = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    conditions.push(`lower(c.name) like $${params.length}`);
  }
  const where = conditions.join(' and ');

  const countResult = await pool.query(`select count(*) from dependency_components c where ${where}`, params);
  const total = Number(countResult.rows[0].count);

  const sortColumn = COMPONENT_SORT_COLUMNS[filters.sortBy ?? 'name'] ?? 'c.name';
  const sortDir = filters.sortDir === 'desc' ? 'desc' : 'asc';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);

  const result = await pool.query(
    `select c.id, c.application_component, c.application_part, c.ecosystem, c.name, c.version, c.purl,
            c.dependency_type, c.scope, c.license, c.latest_version, c.update_category, c.version_checked_at,
            coalesce(vc.vuln_count, 0) as vulnerability_count
     from dependency_components c
     left join (
       select component_id, count(*) as vuln_count from dependency_vulnerabilities group by component_id
     ) vc on vc.component_id = c.id
     where ${where}
     order by ${sortColumn} ${sortDir}, c.name asc
     limit $${params.length - 1} offset $${params.length}`,
    params
  );

  const items: DependencyComponentRow[] = result.rows.map((r) => ({
    id: r.id,
    applicationComponent: r.application_component,
    applicationPart: r.application_part,
    ecosystem: r.ecosystem,
    name: r.name,
    version: r.version,
    purl: r.purl,
    dependencyType: r.dependency_type,
    scope: r.scope,
    license: r.license,
    latestVersion: r.latest_version,
    updateCategory: r.update_category,
    versionCheckedAt: r.version_checked_at,
    vulnerabilityCount: Number(r.vulnerability_count),
  }));

  return { items, total };
}

export type DependencyVulnerabilityRow = {
  id: number;
  componentId: number;
  applicationComponent: ApplicationComponentKey;
  componentName: string;
  componentVersion: string;
  vulnerabilityId: string;
  cve: string | null;
  severity: string | null;
  severityLevel: SeverityLevel;
  summary: string | null;
  fixedVersion: string | null;
  source: string;
  checkedAt: string;
};

export type DependencyVulnerabilityFilters = {
  applicationComponent?: ApplicationComponentKey;
  severityLevel?: SeverityLevel;
  search?: string;
  limit?: number;
  offset?: number;
};

// severityLevel wordt pas ná ophalen geclassificeerd (classifySeverityLevel
// leest zowel het CVSS-vectorveld als het OSV-woord, zie extractSeverity
// hierboven) — dat is niet 1-op-1 in SQL uit te drukken zonder de classificatie
// te dupliceren, en het aantal kwetsbaarheden per build blijft klein genoeg
// (enkele tientallen/honderden rijen, nooit per-rij een externe aanroep) om
// filteren/pagineren in de API-laag te doen i.p.v. in de query zelf.
export async function getVulnerabilities(
  filters: DependencyVulnerabilityFilters = {}
): Promise<{ items: DependencyVulnerabilityRow[]; total: number }> {
  const buildId = await latestBuildId();
  if (buildId === null) return { items: [], total: 0 };

  const conditions: string[] = ['c.build_id = $1'];
  const params: unknown[] = [buildId];
  if (filters.applicationComponent) {
    params.push(filters.applicationComponent);
    conditions.push(`c.application_component = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    conditions.push(
      `(lower(c.name) like $${params.length} or lower(v.vulnerability_id) like $${params.length} or lower(coalesce(v.cve, '')) like $${params.length})`
    );
  }

  const result = await pool.query(
    `select v.id, v.component_id, c.application_component, c.name as component_name, c.version as component_version,
            v.vulnerability_id, v.cve, v.severity, v.summary, v.fixed_version, v.source, v.checked_at
     from dependency_vulnerabilities v
     join dependency_components c on c.id = v.component_id
     where ${conditions.join(' and ')}
     order by v.checked_at desc`,
    params
  );

  let items: DependencyVulnerabilityRow[] = result.rows.map((r) => ({
    id: r.id,
    componentId: r.component_id,
    applicationComponent: r.application_component,
    componentName: r.component_name,
    componentVersion: r.component_version,
    vulnerabilityId: r.vulnerability_id,
    cve: r.cve,
    severity: r.severity,
    severityLevel: classifySeverityLevel(r.severity),
    summary: r.summary,
    fixedVersion: r.fixed_version,
    source: r.source,
    checkedAt: r.checked_at,
  }));

  if (filters.severityLevel) {
    items = items.filter((i) => i.severityLevel === filters.severityLevel);
  }

  const total = items.length;
  const offset = Math.max(filters.offset ?? 0, 0);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  return { items: items.slice(offset, offset + limit), total };
}

// Voor GET /api/system/sbom/download — het gecombineerde CycloneDX-document
// (alle drie de Doelenboom-onderdelen samen, zie sbom-postprocess.mjs) met
// een veilige, deterministische bestandsnaam (geen paden/tekens uit
// buildVersion overnemen die als headerinjectie/pad-traversal misbruikt
// zouden kunnen worden — vandaar de whitelist-regex).
export function getSbomDownloadInfo(): { filePath: string; fileName: string } | null {
  const filePath = path.join(SBOM_DIR, 'combined.cdx.json');
  if (!existsSync(filePath)) return null;
  const meta = readJsonFile<SbomMeta>(path.join(SBOM_DIR, 'meta.json'));
  const versionPart = (meta?.buildVersion || 'onbekend').replace(/[^A-Za-z0-9._-]+/g, '-');
  return { filePath, fileName: `doelenboom-sbom-${versionPart}.cdx.json` };
}
