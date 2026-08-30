import { createApp } from './app.js';
import { sweepIdleTenants } from './tenantWipe.js';
import { sweepAccountRetention } from './accountRetention.js';

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
