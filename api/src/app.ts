import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter, assertCurrentJwtSecretIsSafe } from './auth.js';
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
import { auditLogRouter } from './routes/auditLog.js';
import { appSettingsRouter } from './routes/appSettings.js';
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
// CORS-allowlist (zie de origin-functie hieronder) — komma-gescheiden lijst
// met exact toegestane origins, via env var instelbaar zodat dit per
// omgeving kan verschillen zonder codewijziging (CISO-aandachtspunt: geen
// open '*'-CORS meer). Default dekt alleen lokale ontwikkeling (web draait
// op :5173, zie web/Dockerfile en package.json "dev"-script). In productie
// (docker-compose.prod.yml) doet de frontend sowieso same-origin verzoeken
// (VITE_API_URL='', nginx stuurt /api/ intern door, zie nginx.conf) — de
// browser stuurt dan al geen Origin-header mee die hier iets zou hoeven te
// matchen. Deze allowlist is dus vooral defense-in-depth: hij voorkomt dat
// een willekeurige andere website in iemands browser deze API rechtstreeks
// cross-origin kan bevragen, mocht de API-poort ooit toch bereikbaar zijn.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Bouwt de Express-app zonder 'm te starten (geen app.listen, geen idle-sweep-
// interval) — losgetrokken uit index.ts zodat de regressietest-suite (api/test/)
// dezelfde routes/middleware in-process kan mounten (via app.listen(0) in de
// tests zelf) zonder een losse server-poort of de achtergrond-sweep te hoeven
// starten/opruimen. index.ts blijft de enige plek die dit daadwerkelijk als
// draaiende service opstart.
export function createApp() {
  // Vroegst mogelijke check, vóór er ook maar iets anders opgezet wordt (zie
  // assertJwtSecretIsSafe in auth.ts) — een productie-opstart met een publiek
  // bekend JWT-geheim mag nooit ook maar één request kunnen beantwoorden.
  assertCurrentJwtSecretIsSafe();

  const app = express();
  // Beveiligingsheaders (CISO-aandachtspunt) — X-Content-Type-Options,
  // X-DNS-Prefetch-Control, Referrer-Policy, X-Frame-Options (SAMEORIGIN,
  // niet DENY: tree.html laadt zichzelf same-origin in een iframe, zie
  // web/src/pages/TreePage.tsx), HSTS (no-op over gewone HTTP, dus onschadelijk
  // in lokale dev) — allemaal standaard helmet()-instellingen. In productie
  // zet Traefik (code072-infra, zie docker-compose.prod.yml) grotendeels
  // dezelfde headers al op het hele domein (frontend + doorgestuurde /api/-
  // responses); dit hier is zowel een vangnet als de enige plek waar lokale
  // dev (geen Traefik ervoor) ze ook krijgt. Helmets default Content-Security-
  // Policy staat bewust NIET uit: deze API geeft alleen JSON terug (nooit
  // HTML), dus CSP-directives hebben hier geen praktisch effect maar ook geen
  // nadeel.
  app.use(helmet());
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
  app.use(cors({
    exposedHeaders: ['Content-Disposition'],
    // origin===undefined: geen Origin-header meegestuurd (server-naar-server-
    // verzoeken, curl/Postman, of gewoon deze test-suite via fetch() — zie
    // api/test/helpers.ts) — dat is geen cross-origin BROWSER-verzoek, dus
    // altijd toestaan; de allowlist hieronder is er specifiek voor verzoeken
    // die wél een Origin meesturen. Een origin die niet op de lijst staat
    // krijgt gewoon geen CORS-headers terug (callback(null, false)) i.p.v.
    // een foutstatus — de browser blokkeert het resultaat dan zelf aan de
    // cliëntkant; er is hier bewust geen centrale Express-foutafhandelaar
    // (zie index.ts/app.ts) die een callback(new Error(...)) netjes zou
    // afvangen.
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(null, false);
    },
  }));
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
  app.use('/api/audit-log', auditLogRouter);
  app.use('/api/app-settings', appSettingsRouter);

  return app;
}
