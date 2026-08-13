import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { authRouter } from './auth.js';
import { tenantsRouter } from './routes/tenants.js';
import { usersRouter } from './routes/users.js';
import { doelenbomenRouter } from './routes/doelenbomen.js';
import { treeRouter } from './routes/tree.js';
import { importsRouter } from './routes/imports.js';
import { exportsRouter } from './routes/exports.js';
import { elementsRouter } from './routes/elements.js';
import { tagsRouter } from './routes/tags.js';
import { orgUnitsRouter } from './routes/orgUnits.js';
import { edgesRouter } from './routes/edges.js';
import { sweepIdleTenants } from './tenantWipe.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);

app.get('/api/hello', (_req, res) => {
  res.json({ message: 'Hello, doelenboom! 👋' });
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'unreachable', error: (err as Error).message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/users', usersRouter);
// doelenbomenRouter definieert zelf '/doelenbomen', '/doelenbomen/:id' en
// '/tenants/:tenantId/doelenbomen' — vandaar mounten op '/api' i.p.v. '/api/doelenbomen'.
app.use('/api', doelenbomenRouter);
app.use('/api/doelenbomen', treeRouter);
app.use('/api', importsRouter);
app.use('/api', exportsRouter);
app.use('/api', elementsRouter);
app.use('/api', tagsRouter);
app.use('/api', orgUnitsRouter);
app.use('/api', edgesRouter);

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
