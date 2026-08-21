import { createApp } from './app.js';
import { sweepIdleTenants } from './tenantWipe.js';

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
