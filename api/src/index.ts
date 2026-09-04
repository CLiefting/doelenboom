import { createApp } from './app.js';
import { sweepIdleTenants } from './tenantWipe.js';
import { sweepAccountRetention } from './accountRetention.js';
import { sweepDependencyHealthCheck } from './dependencyHealth.js';

// Laatste vangnet: een onafgevangen fout in een async route-handler (een
// await die afwijst zonder eigen try/catch) crasht in Node.js standaard het
// hele proces — en dus, in deze v1-opzet met één API-container zonder
// automatisch herstart bij zo'n crash (zie db/migrations/
// 0024_fix_excel_imports_status_check.sql voor het incident dat dit
// blootlegde: één upload met een db-constraint-mismatch legde de hele site
// voor alle tenants plat, tot een handmatige `docker compose restart api`),
// de hele applicatie voor iedereen tegelijk. Loggen i.p.v. laten crashen is
// hier bewust de keuze boven "fail fast en laat de procesmanager herstarten"
// (de gebruikelijke Node-aanbeveling) — er ís hier geen procesmanager die dat
// betrouwbaar doet (zie het incident). Dit is geen vervanging voor een eigen
// try/catch in een route die weet wat er kan misgaan (zie bv. routes/
// imports.ts) — alleen de achtervang voor wat daar toch doorheen glipt, zodat
// hooguit dát ene verzoek vastloopt/blijft hangen i.p.v. de héle site.
process.on('unhandledRejection', (reason) => {
  console.error('Onafgevangen promise-rejection (proces blijft draaien):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Onafgevangen fout (proces blijft draaien):', err);
});

const app = createApp();

const PORT = Number(process.env.PORT ?? 4000);

app.listen(PORT, () => {
  console.log(`doelenboom-api listening on port ${PORT}`);
});

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
