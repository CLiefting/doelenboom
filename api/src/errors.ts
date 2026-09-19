import { createRequire } from 'node:module';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

// Foutafhandeling voor Express 4 (DOEL-22, analyse H3).
//
// Probleem: Express 4 vangt de rejection van een `async` route-handler of
// -middleware NIET af. Een DB-fout (bv. "invalid input syntax for type bigint"
// bij /api/doelenbomen/abc/tree) liet het request daardoor onbeantwoord
// hangen, en de rejection kwam alleen nog in het unhandledRejection-vangnet
// van index.ts terecht. Er was ook geen globale error-middleware, dus fouten
// die wél doorkwamen (bv. kapotte JSON-body) kregen de Express-standaard-
// HTML-respons, in niet-productie mét stacktrace.
//
// Oplossing in twee delen, zonder extra dependency:
//  1. installAsyncErrorSupport(): laat Express 4 een afgewezen promise van
//     een handler/middleware naar next(err) doorgeven (Express 5 doet dit
//     standaard — bij een upgrade kan dit hele patch-deel weg).
//  2. errorHandler: de globale error-middleware (als LAATSTE in createApp
//     mounten) die de fout server-side logt en de client een generiek
//     antwoord geeft — nooit err.message of een stacktrace.

const require = createRequire(import.meta.url);

let installed = false;

export function installAsyncErrorSupport(): void {
  if (installed) return;
  // Layer is Express-intern (express/lib/router/layer). Dat is precies wat
  // het bekende express-async-errors-pakket ook patcht; hier zelf gedaan om
  // geen onderhoudsloze dependency binnen te halen. Faalt luid (i.p.v. stil
  // niets te doen) als een Express-update de interne vorm wijzigt — de tests
  // in test/asyncErrors.test.ts vangen dat ook af.
  const Layer = require('express/lib/router/layer') as {
    prototype: { handle_request: (req: Request, res: Response, next: NextFunction) => void; handle: (...args: unknown[]) => unknown };
  };
  if (typeof Layer?.prototype?.handle_request !== 'function') {
    throw new Error('installAsyncErrorSupport: onverwachte Express-interne structuur (express/lib/router/layer)');
  }
  Layer.prototype.handle_request = function handleRequest(this: typeof Layer.prototype, req, res, next) {
    const fn = this.handle as (req: Request, res: Response, next: NextFunction) => unknown;
    // Error-handling middleware (4 parameters) wordt door Express zelf alleen
    // via handle_error aangeroepen — hier dus niets te doen (zelfde als origineel).
    if (fn.length > 3) return next();
    try {
      const result = fn(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
  installed = true;
}

type HttpishError = Error & { status?: number; statusCode?: number; type?: string; code?: string };

export const errorHandler: ErrorRequestHandler = (err: HttpishError, req, res, next) => {
  // Er is al (deels) geantwoord: geen tweede respons mogelijk. Express'
  // standaardafhandelaar sluit dan de verbinding netjes af.
  if (res.headersSent) return next(err);

  // 4xx uit middleware zoals body-parser (kapotte JSON = 400, te groot = 413)
  // en multer: de status blijft, de tekst is generiek — err.message van
  // body-parser bevat stukken van de invoer/interne parserdetails.
  // MulterError (upload te groot/onverwacht veld) heeft geen .status maar een
  // .code: LIMIT_FILE_SIZE is een 413, de rest een 400.
  const status = err.name === 'MulterError'
    ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : (err.status ?? err.statusCode);
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const error = status === 413 ? 'Het verzoek is te groot.' : 'Ongeldig verzoek.';
    return void res.status(status).json({ error });
  }

  // Postgres klasse 22 ("data exception", bv. 22P02 ongeldige integer,
  // 22003 waarde buiten bereik): komt van invoer die de client zelf stuurde
  // (id in het pad), geen serverfout.
  if (typeof err.code === 'string' && /^22[0-9A-Z]{3}$/.test(err.code)) {
    return void res.status(400).json({ error: 'Ongeldige invoer.' });
  }

  // Alles wat overblijft is onverwacht: volledig server-side loggen, de
  // client krijgt niets over de oorzaak te zien (OWASP A05/A09).
  console.error(`Onverwachte fout in ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Interne serverfout.' });
};
