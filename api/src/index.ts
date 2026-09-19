import { createApp } from './app.js';
import { sweepIdleTenants } from './tenantWipe.js';
import { sweepAccountRetention } from './accountRetention.js';
import { sweepTenantRetention } from './tenantRetention.js';
import { sweepDependencyHealthCheck } from './dependencyHealth.js';
import { sweepLicenseRenewalReminders } from './licenseRenewalReminder.js';
import { runStartupChecks } from './startupChecks.js';

// Laatste vangnet (DOEL-22). Een fout in een route-handler komt sinds errors.ts
// (async-wrapper + globale foutafhandelaar) als 500 bij de client terecht en
// crasht het proces niet meer — daarvoor hoeft dit vangnet dus niet meer.
//
// uncaughtException: bewust NIET meer inslikken. Na een onafgevangen
// exception is de proces-staat onbetrouwbaar (Node raadt voortdraaien af);
// loggen en afsluiten met exit-code 1, waarna `restart: unless-stopped`
// (docker-compose.yml / docker-compose.prod.yml) de container direct
// herstart. De vorige onderbouwing ("er is geen procesmanager") klopte niet
// meer.
//
// unhandledRejection: alleen loggen. Dit zijn fire-and-forget-promises buiten
// een request om (bv. een verstuurde mail of sweep waarvan het falen de site
// niet mag platleggen); request-afhandeling zelf gaat via errors.ts.
process.on('unhandledRejection', (reason) => {
  console.error('Onafgevangen promise-rejection (proces blijft draaien):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Onafgevangen fout — proces wordt afgesloten en door Docker herstart:', err);
  process.exit(1);
});

const app = createApp();

const PORT = Number(process.env.PORT ?? 4000);

// DOEL-23: in productie niet starten zolang het standaard sysadmin-wachtwoord werkt.
await runStartupChecks();

const server = app.listen(PORT, () => {
  console.log(`doelenboom-api listening on port ${PORT}`);
});

// Server-timeouts (DOEL-22): zonder deze grenzen houdt één trage of
// halfopen client (slowloris) een socket onbeperkt vast. Waarden ruim boven
// de zwaarste legitieme actie (Excel-upload van max. 25 MB / export) maar
// eindig; via env aan te passen zonder codewijziging.
const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
server.headersTimeout = envMs('HEADERS_TIMEOUT_MS', 30_000);
server.requestTimeout = envMs('REQUEST_TIMEOUT_MS', 120_000);
server.timeout = envMs('SOCKET_TIMEOUT_MS', 180_000);
// Traefik/nginx hergebruiken verbindingen; Node's default (5 s) is korter dan
// hun idle-timeout, wat sporadische 502's geeft. Moet > headersTimeout blijven.
server.keepAliveTimeout = envMs('KEEPALIVE_TIMEOUT_MS', 65_000);

// Idle-sweep: vangt browsers die zonder uitloggen gesloten zijn. Draait als
// setInterval in dit ene API-proces — voor dit project (v1, één container, geen
// horizontale schaling) is dat voldoende; geen aparte scheduler/cron nodig. Kijkt
// per tenant naar diens eigen session_timeout_minutes (tenantWipe.ts).
const IDLE_SWEEP_INTERVAL_MS = 60_000;
setInterval(() => {
  sweepIdleTenants().catch((err) => {
    console.error('Idle-sweep (tenant wipe-check) mislukt:', err);
  });
}, IDLE_SWEEP_INTERVAL_MS);

// Accountretentie-sweep (waarschuwen + automatisch verwijderen van 12+ maanden
// inactieve accounts, zie accountRetention.ts) — een dag-granulaire
// beleidscontrole, geen realtime concern zoals de idle-sweep hierboven.
// Draait daarom op een veel grovere interval, maar via hetzelfde in-process
// setInterval-patroon: voor dit project (v1, één container, geen horizontale
// schaling) is dat voldoende, geen aparte scheduler/cron nodig (§12 van de
// opdracht). Idempotent (zie accountRetention.ts), dus veilig om vaker te
// draaien dan strikt nodig — 1x per uur is ruim genoeg voor een dag-granulair
// beleid en zorgt dat een gemiste run door een herstart snel wordt ingehaald.
const ACCOUNT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
setInterval(() => {
  sweepAccountRetention().catch((err) => {
    console.error('Accountretentie-sweep mislukt:', err);
  });
}, ACCOUNT_RETENTION_SWEEP_INTERVAL_MS);

// Tenantretentie-sweep (definitief verwijderen van tenants die meer dan
// TENANT_RETENTION_MONTHS geleden beëindigd zijn, zie tenantRetention.ts) —
// zelfde dag-granulaire beleidscontrole en interval als de accountretentie-
// sweep hierboven.
const TENANT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
setInterval(() => {
  sweepTenantRetention().catch((err) => {
    console.error('Tenantretentie-sweep mislukt:', err);
  });
}, TENANT_RETENTION_SWEEP_INTERVAL_MS);

// Dependency-health-sweep (SBOM/kwetsbaarheden-cache verversen, zie
// dependencyHealth.ts) — zelfde in-process setInterval-patroon als hierboven.
// sweepDependencyHealthCheck() bewaakt zelf de "hooguit 1x/24u"-regel via
// dependency_check_runs (niet via deze intervaltimer), dus een grovere
// controle-interval hier is puur om een gemiste/herstart-onderbroken run
// tijdig opnieuw te proberen — geen scherpe klok.
const DEPENDENCY_HEALTH_SWEEP_INTERVAL_MS = 60 * 60_000;
setInterval(() => {
  sweepDependencyHealthCheck().catch((err) => {
    console.error('Dependency-health-sweep mislukt:', err);
  });
}, DEPENDENCY_HEALTH_SWEEP_INTERVAL_MS);

// Verlengingsherinnering-sweep (Klantbeheer, zie licenseRenewalReminder.ts) —
// zelfde dag-granulaire beleidscontrole en interval als de accountretentie-/
// tenantretentie-sweeps hierboven.
const LICENSE_RENEWAL_REMINDER_SWEEP_INTERVAL_MS = 60 * 60_000;
setInterval(() => {
  sweepLicenseRenewalReminders().catch((err) => {
    console.error('Verlengingsherinnering-sweep mislukt:', err);
  });
}, LICENSE_RENEWAL_REMINDER_SWEEP_INTERVAL_MS);
