import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import { createRateLimiter, envInt } from '../rateLimit.js';
import { sendVulnerabilityOverviewEmail } from '../email.js';
import { logAuditEvent } from '../auditLog.js';
import {
  getSummary,
  getComponents,
  getVulnerabilities,
  getSbomDownloadInfo,
  getVulnerabilityOverview,
  refreshDependencyHealth,
  RefreshCooldownError,
  NoSbomError,
  type ApplicationComponentKey,
  type Ecosystem,
  type DependencyType,
  type Scope,
  type UpdateCategory,
  type SeverityLevel,
  type DependencyComponentFilters,
} from '../dependencyHealth.js';

// GET/POST /api/system/sbom/* — sysadmin-only Softwarecomponenten-pagina (zie
// doelenboom_sbom_ontwerp.md in het project). Zelfde autorisatiepatroon als
// routes/dbstat.ts/auditLog.ts: requireAuth + requireSysadmin, geen apart
// permissiesysteem (§8/§16 van de opdracht: hergebruik de bestaande
// architectuur, geen nieuwe autorisatielaag naast requireSysadmin).
export const systemSbomRouter = Router();
systemSbomRouter.use(requireAuth, requireSysadmin);

const APPLICATION_COMPONENTS: ApplicationComponentKey[] = ['api', 'web', 'excel-service'];
const ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi'];
const DEPENDENCY_TYPES: DependencyType[] = ['direct', 'transitive'];
const SCOPES: Scope[] = ['runtime', 'development'];
const UPDATE_CATEGORIES: UpdateCategory[] = ['actueel', 'patch', 'minor', 'major', 'onbekend'];
const SEVERITY_LEVELS: SeverityLevel[] = ['kritiek', 'hoog', 'gemiddeld', 'laag', 'onbekend'];
const COMPONENT_SORT_FIELDS: NonNullable<DependencyComponentFilters['sortBy']>[] = [
  'name',
  'applicationComponent',
  'updateCategory',
  'version',
];

function singleQueryParam(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return undefined;
}

// Query-parameters komen rechtstreeks van de sysadmin-gebruiker via de UI
// (filters/zoekveld/paginering) — niet van een externe bron — maar worden
// hier toch tegen een whitelist gevalideerd i.p.v. ongezien doorgegeven aan
// dependencyHealth.ts, zodat een onverwachte/verkeerde waarde een duidelijke
// 400 geeft in plaats van stilzwijgend genegeerd of verkeerd geïnterpreteerd
// te worden.
function pickEnum<T extends string>(value: unknown, allowed: T[]): T | undefined {
  const raw = singleQueryParam(value);
  if (raw === undefined) return undefined;
  return (allowed as string[]).includes(raw) ? (raw as T) : undefined;
}

function pickPositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = singleQueryParam(value);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

systemSbomRouter.get('/summary', async (_req, res) => {
  const summary = await getSummary();
  if (!summary) {
    res.json({ available: false });
    return;
  }
  res.json({ available: true, ...summary });
});

systemSbomRouter.get('/components', async (req, res) => {
  const filters: DependencyComponentFilters = {
    applicationComponent: pickEnum(req.query.applicationComponent, APPLICATION_COMPONENTS),
    ecosystem: pickEnum(req.query.ecosystem, ECOSYSTEMS),
    dependencyType: pickEnum(req.query.dependencyType, DEPENDENCY_TYPES),
    scope: pickEnum(req.query.scope, SCOPES),
    updateCategory: pickEnum(req.query.updateCategory, UPDATE_CATEGORIES),
    search: singleQueryParam(req.query.search)?.slice(0, 200),
    sortBy: pickEnum(req.query.sortBy, COMPONENT_SORT_FIELDS),
    sortDir: pickEnum(req.query.sortDir, ['asc', 'desc'] as const),
    limit: pickPositiveInt(req.query.limit, 50, 500),
    offset: pickPositiveInt(req.query.offset, 0, 1_000_000),
  };
  const result = await getComponents(filters);
  res.json(result);
});

systemSbomRouter.get('/vulnerabilities', async (req, res) => {
  const result = await getVulnerabilities({
    applicationComponent: pickEnum(req.query.applicationComponent, APPLICATION_COMPONENTS),
    severityLevel: pickEnum(req.query.severityLevel, SEVERITY_LEVELS),
    search: singleQueryParam(req.query.search)?.slice(0, 200),
    limit: pickPositiveInt(req.query.limit, 50, 500),
    offset: pickPositiveInt(req.query.offset, 0, 1_000_000),
  });
  res.json(result);
});

// POST i.p.v. GET: dit heeft een neveneffect (schrijft naar
// dependency_check_runs/dependency_components en doet externe aanroepen),
// dus geen cachebare/idempotente GET (zelfde conventie als elders in deze
// API, bv. POST /api/imports).
systemSbomRouter.post('/refresh', async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  try {
    const result = await refreshDependencyHealth({ triggeredByUserId: userId, isManual: true });
    console.log('Handmatige dependency-health-controle uitgevoerd:', {
      userId,
      status: result.status,
      componentsChecked: result.componentsChecked,
      vulnerabilitiesFound: result.vulnerabilitiesFound,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof RefreshCooldownError) {
      res.status(429).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
      return;
    }
    if (err instanceof NoSbomError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Downloadknop: het gecombineerde CycloneDX-document van de laatst
// gegenereerde SBOM (zie sbom-postprocess.mjs), met een veilige bestandsnaam
// (zie getSbomDownloadInfo — buildVersion is geschoond tot alleen
// [A-Za-z0-9._-]) en een expliciete Content-Type i.p.v. Express' eigen
// gok-op-extensie.
// DOEL-128: knop "Overzicht mailen" — de volledige stand van alle
// kwetsbaarheden (alle ernstniveaus, ook al eerder gemelde) naar de sysadmin
// die erom vraagt, en alleen naar die. Raakt de "één keer melden"-boekhouding
// van de dagelijkse melding (DOEL-70) niet. A01: router vereist sysadmin.
// A04: hooguit VULN_OVERVIEW_MAIL_MAX (standaard 5) per uur per gebruiker.
// A09: auditlog met alleen aantallen. Zonder APP_BASE_URL (lokale dev-stack)
// geen mail (DOEL-127).
export const vulnerabilityOverviewMailRateLimit = createRateLimiter({
  windowMs: () => 60 * 60_000,
  max: () => envInt('VULN_OVERVIEW_MAIL_MAX', 5),
  key: (req) => `user:${(req as AuthedRequest).user?.id ?? 'onbekend'}`,
  message: 'Je hebt het overzicht het afgelopen uur al vaak laten mailen. Probeer het later opnieuw.',
});

systemSbomRouter.post('/mail-overzicht', vulnerabilityOverviewMailRateLimit, async (req: AuthedRequest, res) => {
  const user = req.user!;
  const baseUrl = (process.env.APP_BASE_URL ?? '').trim();
  if (!baseUrl) {
    res.status(409).json({ error: 'Mailen is in deze omgeving niet ingesteld (APP_BASE_URL ontbreekt).' });
    return;
  }
  const overview = await getVulnerabilityOverview();
  if (!overview) {
    res.status(409).json({ error: 'Er is nog geen SBOM ingelezen; er valt nog niets te melden.' });
    return;
  }
  const link = `${baseUrl.replace(/\/+$/, '')}/system-info`;
  const sent = await sendVulnerabilityOverviewEmail(user.email, { ...overview, link });
  if (!sent) {
    res.status(503).json({ error: 'Er is geen mailserver ingesteld; het overzicht is niet verstuurd.' });
    return;
  }
  await logAuditEvent({
    eventType: 'dependency_vulnerability_overview_sent',
    userId: user.id,
    // Alleen aantallen: geen adres, pakketnamen of kwetsbaarheid-id's.
    detail: { runtime: overview.runtime, development: overview.development, total: overview.total },
  });
  res.json({ sent: true, runtime: overview.runtime, development: overview.development, total: overview.total });
});

systemSbomRouter.get('/download', (_req, res) => {
  const info = getSbomDownloadInfo();
  if (!info) {
    res.status(404).json({ error: 'Geen SBOM beschikbaar — draai eerst een build (scripts/generate-sbom.sh).' });
    return;
  }
  res.setHeader('Content-Type', 'application/vnd.cyclonedx+json');
  res.setHeader('Content-Disposition', `attachment; filename="${info.fileName}"`);
  res.sendFile(info.filePath);
});
