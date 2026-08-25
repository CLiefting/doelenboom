import express from 'express';
import cors from 'cors';
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
import { productsRouter } from './routes/products.js';
import { projectStatusRouter } from './routes/projectStatus.js';
import { columnConfigRouter } from './routes/columnConfig.js';
import { licensesRouter } from './routes/licenses.js';
import { dbstatRouter } from './routes/dbstat.js';
import { sessionsRouter } from './routes/sessions.js';
import { pool } from './db.js';

// Bouwt de Express-app zonder 'm te starten (geen app.listen, geen idle-sweep-
// interval) — losgetrokken uit index.ts zodat de regressietest-suite (api/test/)
// dezelfde routes/middleware in-process kan mounten (via app.listen(0) in de
// tests zelf) zonder een losse server-poort of de achtergrond-sweep te hoeven
// starten/opruimen. index.ts blijft de enige plek die dit daadwerkelijk als
// draaiende service opstart.
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

  // Bouwversie (git-hash + datum), gezet als Docker build-arg/env-var (zie
  // api/Dockerfile en docker-compose.yml) — puur informatief, gebruikt om een
  // versienummer in de footer van de app te tonen (web/src/App.tsx en
  // tree.html halen dit allebei bij deze ene bron op, in plaats van elk hun
  // eigen build-time injectie nodig te hebben).
  app.get('/api/version', (_req, res) => {
    res.json({ version: process.env.BUILD_VERSION || 'dev' });
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
  app.use('/api', productsRouter);
  app.use('/api', projectStatusRouter);
  app.use('/api', columnConfigRouter);
  // Definieert zelf zowel '/tiers'/'/modules' als '/tenants/:tenantId/license/...'
  // — vandaar op '/api' gemount, net als doelenbomenRouter hierboven.
  app.use('/api', licensesRouter);
  app.use('/api/dbstat', dbstatRouter);
  app.use('/api/sessions', sessionsRouter);

  return app;
}
