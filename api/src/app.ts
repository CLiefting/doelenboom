import express from 'express';
import cors from 'cors';
import { authRouter } from './auth.js';
import { tenantsRouter } from './routes/tenants.js';
import { usersRouter } from './routes/users.js';
import { doelenbomenRouter } from './routes/doelenbomen.js';
import { treeRouter } from './routes/tree.js';
import { importsRouter } from './routes/imports.js';
import { exportsRouter } from './routes/exports.js';
import { projectExcelRouter } from './routes/projectExcel.js';
import { elementsRouter } from './routes/elements.js';
import { tagsRouter } from './routes/tags.js';
import { orgUnitsRouter } from './routes/orgUnits.js';
import { edgesRouter } from './routes/edges.js';
import { productsRouter } from './routes/products.js';
import { activitiesRouter } from './routes/activities.js';
import { projectStatusRouter } from './routes/projectStatus.js';
import { columnConfigRouter } from './routes/columnConfig.js';
import { doelenboomTemplatesRouter } from './routes/doelenboomTemplates.js';
import { licensesRouter } from './routes/licenses.js';
import { dbstatRouter } from './routes/dbstat.js';
import { sessionsRouter } from './routes/sessions.js';
import { announcementRouter } from './routes/announcement.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { legalRouter } from './routes/legal.js';
import { pool } from './db.js';

// Bouwt de Express-app zonder 'm te starten (geen app.listen, geen idle-sweep-
// interval) — losgetrokken uit index.ts zodat de regressietest-suite (api/test/)
// dezelfde routes/middleware in-process kan mounten (via app.listen(0) in de
// tests zelf) zonder een losse server-poort of de achtergrond-sweep te hoeven
// starten/opruimen. index.ts blijft de enige plek die dit daadwerkelijk als
// draaiende service opstart.
export function createApp() {
  const app = express();
  // exposedHeaders: 'Content-Disposition' — zonder dit mag JS in de browser
  // (fetch/XHR) een cross-origin response-header wel ONTVANGEN, maar niet
  // via res.headers.get(...) UITLEZEN, tenzij de server 'm expliciet vrijgeeft
  // (CORS-safelisted headers zijn standaard alleen Cache-Control/Content-
  // Language/Content-Type/Expires/Last-Modified/Pragma). tree.html draait op
  // een ander poort/origin dan deze API (bv. localhost:5173 vs localhost:4000)
  // en leest Content-Disposition uit om de downloadnaam te bepalen (zowel de
  // hele-doelenboom-export in exports.ts als de project-Excel-export in
  // projectExcel.ts) — zonder deze regel valt dat altijd terug op de kale
  // fallbacknaam, ook al stuurt de server de juiste header wél mee.
  app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
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

  // announcementRouter vóór alle hieronder op de kale prefix '/api' gemounte
  // routers (doelenbomenRouter, importsRouter, ...): die roepen zelf
  // onvoorwaardelijk requireAuth aan (router.use(requireAuth), geen eigen
  // pad-restrictie), en Express matcht zo'n kaal-'/api'-gemounte router voor
  // ELK pad dat met '/api' begint — dus óók '/api/announcement' — vóórdat er
  // ook maar gekeken is of die router zelf een passende route heeft. Stond
  // announcementRouter ná die routers, dan zou de eerste van hen de
  // ongeauthenticeerde GET al met 401 afkappen, en announcementRouter's eigen
  // (bewust publieke) GET nooit bereikt worden.
  app.use('/api/announcement', announcementRouter);
  // subscriptionsRouter definieert zelf zowel publieke routes (aanvraag
  // indienen, tiers/aanbiedingen/prijs opvragen) als sysadmin-only
  // beheerroutes (elk met hun eigen requireAuth/requireSysadmin, zie dat
  // bestand) — vandaar hier vóór de kaal-'/api'-gemounte routers hieronder,
  // om dezelfde reden als announcementRouter hierboven.
  app.use('/api', subscriptionsRouter);
  // legalRouter: zelfde reden als announcementRouter/subscriptionsRouter
  // hierboven — GET /api/legal/:type is bewust ongeauthenticeerd, dus vóór de
  // kaal-'/api'-gemounte routers hieronder (zie legal.ts).
  app.use('/api', legalRouter);

  app.use('/api/auth', authRouter);
  app.use('/api/tenants', tenantsRouter);
  app.use('/api/users', usersRouter);
  // doelenbomenRouter definieert zelf '/doelenbomen', '/doelenbomen/:id' en
  // '/tenants/:tenantId/doelenbomen' — vandaar mounten op '/api' i.p.v. '/api/doelenbomen'.
  app.use('/api', doelenbomenRouter);
  app.use('/api/doelenbomen', treeRouter);
  app.use('/api', importsRouter);
  app.use('/api', exportsRouter);
  app.use('/api', projectExcelRouter);
  app.use('/api', elementsRouter);
  app.use('/api', tagsRouter);
  app.use('/api', orgUnitsRouter);
  app.use('/api', edgesRouter);
  app.use('/api', productsRouter);
  app.use('/api', activitiesRouter);
  app.use('/api', projectStatusRouter);
  app.use('/api', columnConfigRouter);
  app.use('/api', doelenboomTemplatesRouter);
  // Definieert zelf zowel '/tiers'/'/modules' als '/tenants/:tenantId/license/...'
  // — vandaar op '/api' gemount, net als doelenbomenRouter hierboven.
  app.use('/api', licensesRouter);
  app.use('/api/dbstat', dbstatRouter);
  app.use('/api/sessions', sessionsRouter);

  return app;
}
