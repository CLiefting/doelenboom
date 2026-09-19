import type { NextFunction, Request, Response } from 'express';

// Eenvoudige in-memory rate limiter (DOEL-20, analyse H1) — vaste vensters per
// sleutel (standaard het client-IP). Bewust zonder extra dependency: dit
// project draait als één API-container (zie index.ts: sweeps zijn ook
// in-process), dus gedeelde opslag (Redis) is niet nodig. Bij een herstart
// van de API worden de tellers gewoon weer nul — acceptabel voor het
// afremmen van misbruik.
//
// Het client-IP komt uit req.ip; achter Traefik + nginx is dat alleen het
// echte client-IP als `trust proxy` juist staat (env TRUST_PROXY_HOPS, zie
// app.ts). Staat dat te laag dan delen alle bezoekers één teller; te hoog dan
// kan een client zijn IP spoofen via X-Forwarded-For.

type Bucket = { count: number; resetAt: number };

export type RateLimiterOptions = {
  // Functies i.p.v. getallen zodat env-waarden per request gelezen worden
  // (tests kunnen ze aanpassen zonder de app opnieuw op te bouwen).
  windowMs: () => number;
  max: () => number;
  // Standaard: req.ip. Geef bv. () => 'global' voor één teller voor iedereen.
  key?: (req: Request) => string;
  message: string;
};

export function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();

  // Opruimen zodat de map niet onbeperkt groeit bij veel verschillende IP's.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, 60_000);
  sweep.unref();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = opts.key ? opts.key(req) : req.ip ?? 'onbekend';
    const max = opts.max();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs() };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return void res.status(429).json({ error: opts.message });
    }
    next();
  };
  // Alleen voor tests.
  middleware.reset = () => buckets.clear();
  return middleware;
}

export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}
