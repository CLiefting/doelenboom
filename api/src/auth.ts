import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { previewOrCommitWipe } from './tenantWipe.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

export type AuthedRequest = Request & {
  user?: { id: number; email: string; isSysadmin: boolean; sessionId: string };
};

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), JWT_SECRET) as {
      id: number;
      email: string;
      isSysadmin: boolean;
      sid: string;
    };
    req.user = { id: payload.id, email: payload.email, isSysadmin: payload.isSysadmin, sessionId: payload.sid };
    next();
  } catch {
    return res.status(401).json({ error: 'Ongeldige of verlopen sessie' });
  }
}

export const authRouter = Router();

// Wachtwoord-hash is opgeslagen via pgcrypto (crypt/gen_salt), dus verificatie
// gebeurt met dezelfde crypt()-functie in de database in plaats van een aparte
// JS-hashlib.
//
// Bij elke login komt er een sessions-rij bij (zie db/init.sql) — nodig om bij te
// houden of een browser nog "open" is (heartbeat) en, bij uitloggen, of dit de
// laatste actieve gebruiker van een tenant was (zie tenantWipe.ts).
//
// De JWT bevat bewust alleen id/email/isSysadmin/sid — geen tenant-rollen, want
// die kunnen tussentijds wijzigen (bv. een sysadmin degradeert een tenant-admin
// naar gebruiker) zonder dat de gebruiker opnieuw hoeft in te loggen. Tenant-
// rollen worden dus altijd live opgezocht (zie rbac.ts). /me geeft ze wel mee als
// gemakslijstje voor de frontend-UI (welke tenants zie ik, welke rol heb ik erin).
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
  }
  const result = await pool.query(
    `select id, email, is_sysadmin
     from users
     where email = $1 and password_hash = crypt($2, password_hash)`,
    [email, password]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  }

  const sessionResult = await pool.query(
    'insert into sessions (user_id) values ($1) returning id',
    [user.id]
  );
  const sessionId = sessionResult.rows[0].id as string;

  const token = jwt.sign(
    { id: user.id, email: user.email, isSysadmin: user.is_sysadmin, sid: sessionId },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  const tenantRoles = await fetchTenantRoles(user.id);
  res.json({ token, user: { id: user.id, email: user.email, isSysadmin: user.is_sysadmin, tenantRoles } });
});

async function fetchTenantRoles(userId: number) {
  const result = await pool.query(
    `select tu.tenant_id, t.slug as tenant_slug, t.name as tenant_name, tu.role
     from tenant_users tu join tenants t on t.id = tu.tenant_id
     where tu.user_id = $1
     order by t.name`,
    [userId]
  );
  return result.rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantSlug: r.tenant_slug,
    tenantName: r.tenant_name,
    role: r.role as 'admin' | 'gebruiker',
  }));
}

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const tenantRoles = req.user!.isSysadmin ? [] : await fetchTenantRoles(req.user!.id);
  res.json({ user: { ...req.user, tenantRoles } });
});

// Heartbeat: zolang de tab open is stuurt de frontend dit elke minuut (zie
// App.tsx). Werkt ook een sessie "bij" die door de idle-sweep (tenantWipe.ts,
// aangeroepen vanuit index.ts) als voorbij-de-timeout is gepasseerd — de sessie
// zelf wordt nooit hard "uitgelogd" door de sweep (die kijkt live naar
// last_seen_at), dus dit is vooral defensief.
authRouter.post('/heartbeat', requireAuth, async (req: AuthedRequest, res) => {
  await pool.query('update sessions set last_seen_at = now() where id = $1', [req.user!.sessionId]);
  res.status(204).send();
});

// GET /api/auth/logout-preview — pure preview (geen bijeffecten): welke tenants
// (met hun doelenbomen) zouden leeggemaakt worden als deze sessie nu uitlogt?
// De frontend gebruikt dit om, vóór het daadwerkelijke uitloggen, eerst een
// Excel-export aan te bieden en daarna een expliciete waarschuwing te tonen.
authRouter.get('/logout-preview', requireAuth, async (req: AuthedRequest, res) => {
  const candidates = await previewOrCommitWipe(req.user!.sessionId, false);
  res.json({ wouldWipe: candidates });
});

// POST /api/auth/logout — beëindigt de sessie en voert de wipe (indien van
// toepassing) daadwerkelijk uit. Dit is bewust pas de tweede stap vanuit de
// frontend: eerst logout-preview + bevestiging, dan pas dit endpoint.
authRouter.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  const wiped = await previewOrCommitWipe(req.user!.sessionId, true);
  res.json({ wiped });
});
