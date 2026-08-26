import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { previewOrCommitWipe } from './tenantWipe.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

// Beveiliging: na dit aantal minuten zonder échte gebruikersactiviteit
// (muis/toetsenbord/scroll/touch — zie POST /activity hieronder en
// last_activity_at bij de sessions-tabel in db/init.sql) wordt een sessie
// hard afgekeurd door requireAuth, ongeacht de resterende geldigheid van de
// JWT zelf (die blijft los 12u geldig, zie /login). Bewust een vast, systeem-
// breed getal (niet per tenant instelbaar, in tegenstelling tot
// tenants.session_timeout_minutes — dat is een ANDER concept, zie de
// toelichting bij de sessions-tabel in db/init.sql).
const IDLE_TIMEOUT_MINUTES = 15;

export type AuthedRequest = Request & {
  user?: { id: number; email: string; isSysadmin: boolean; sessionId: string };
};

// Async (i.p.v. de eerdere pure JWT-check): naast de JWT-handtekening/
// -geldigheid wordt nu ook, met één lichte query op de sessions-tabel (op
// primary key, dus goedkoop), gecontroleerd of de sessie niet expliciet is
// beëindigd (ended_at) én niet langer dan IDLE_TIMEOUT_MINUTES geleden nog
// échte activiteit had (last_activity_at) — dit is de daadwerkelijke
// serverside handhaving van de 15-minuten-inactiviteit-beveiliging: zelfs een
// hergebruikte/gekopieerde JWT stopt na 15 minuten inactiviteit te werken,
// niet alleen de frontend-UI. reason in de foutrespons laat de frontend een
// gerichte melding tonen (zie web/src/api.ts) i.p.v. een generieke fout.
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet ingelogd', reason: 'not_logged_in' });
  }
  let payload: { id: number; email: string; isSysadmin: boolean; sid: string };
  try {
    payload = jwt.verify(header.slice('Bearer '.length), JWT_SECRET) as typeof payload;
  } catch {
    return res.status(401).json({ error: 'Ongeldige of verlopen sessie', reason: 'invalid_token' });
  }

  try {
    const result = await pool.query(
      `select ended_at, (last_activity_at > now() - make_interval(mins => $2::int)) as fresh
       from sessions where id = $1`,
      [payload.sid, IDLE_TIMEOUT_MINUTES]
    );
    const row = result.rows[0];
    if (!row || row.ended_at != null) {
      return res.status(401).json({ error: 'Deze sessie is beëindigd, log opnieuw in.', reason: 'session_ended' });
    }
    if (!row.fresh) {
      return res.status(401).json({
        error: `Automatisch uitgelogd wegens ${IDLE_TIMEOUT_MINUTES} minuten inactiviteit.`,
        reason: 'idle_timeout',
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Sessie kon niet gecontroleerd worden.', detail: (err as Error).message });
  }

  req.user = { id: payload.id, email: payload.email, isSysadmin: payload.isSysadmin, sessionId: payload.sid };
  next();
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
//
// fetchTenantRoles draait voor IEDEREEN, sysadmin incluis: sinds sysadmin geen
// automatische toegang meer heeft tot boom-inhoud (privacy, zie rbac.ts
// rolmodel-comment) kan een sysadmin best een eigen tenant_users-rij hebben
// (bv. zichzelf tijdelijk als admin gekoppeld om een klant te helpen) — de
// frontend moet die net als bij iedere andere gebruiker kunnen tonen.
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
  }
  const result = await pool.query(
    `select id, email, is_sysadmin, must_change_password
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
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      isSysadmin: user.is_sysadmin,
      mustChangePassword: user.must_change_password,
      tenantRoles,
    },
  });
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
    role: r.role as 'admin' | 'gebruiker' | 'bezoeker',
  }));
}

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const tenantRoles = await fetchTenantRoles(req.user!.id);
  const mcp = await pool.query('select must_change_password from users where id = $1', [req.user!.id]);
  res.json({ user: { ...req.user, mustChangePassword: mcp.rows[0]?.must_change_password ?? false, tenantRoles } });
});

// POST /api/auth/change-password — zelfbediening: elke ingelogde gebruiker mag
// zijn/haar eigen wachtwoord wijzigen (huidig wachtwoord verplicht ter
// verificatie). Zet ook must_change_password terug op false, zodat de
// afgedwongen wijzig-wachtwoord-flow (frontend, na een door een sysadmin gezet
// tijdelijk wachtwoord) hierna niet opnieuw verschijnt. Dit is de eerste en
// enige plek waar een gebruiker zelf zijn wachtwoord kan wijzigen — voorheen kon
// dat alleen rechtstreeks in de database (zie oudere versie van deze README).
authRouter.post('/change-password', requireAuth, async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const currentPassword = typeof b.currentPassword === 'string' ? b.currentPassword : '';
  const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Huidig en nieuw wachtwoord zijn verplicht.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Nieuw wachtwoord moet minstens 8 tekens zijn.' });
  }
  const check = await pool.query(
    'select 1 from users where id = $1 and password_hash = crypt($2, password_hash)',
    [req.user!.id, currentPassword]
  );
  if (check.rows.length === 0) {
    return res.status(401).json({ error: 'Huidig wachtwoord is onjuist.' });
  }
  await pool.query(
    `update users set password_hash = crypt($1, gen_salt('bf')), must_change_password = false where id = $2`,
    [newPassword, req.user!.id]
  );
  const tenantRoles = await fetchTenantRoles(req.user!.id);
  res.json({ user: { ...req.user, mustChangePassword: false, tenantRoles } });
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

// POST /api/auth/activity — bewust ANDERS dan /heartbeat hierboven: dit wordt
// alleen aangeroepen door de frontend bij échte gebruikersactiviteit (muis/
// toetsenbord/scroll/touch, zelf al gethrottled tot max 1x/minuut, zie
// App.tsx/tree.html), en werkt uitsluitend last_activity_at bij — de basis
// voor de 15-minuten-inactiviteit-check in requireAuth hierboven. Zou dit
// hetzelfde veld als /heartbeat bijwerken (dat een blinde timer is, "tab staat
// open", geen activiteit nodig), dan zou een openstaande maar volledig
// inactieve tab nooit worden uitgelogd — precies wat deze beveiliging moet
// voorkomen.
authRouter.post('/activity', requireAuth, async (req: AuthedRequest, res) => {
  await pool.query('update sessions set last_activity_at = now() where id = $1', [req.user!.sessionId]);
  res.status(204).send();
});

// GET /api/auth/logout-preview — pure preview (geen bijeffecten): welke tenants
// (met hun doelenbomen) zouden leeggemaakt worden als deze sessie nu uitlogt?
// De frontend gebruikt dit om, vóór het daadwerkelijke uitloggen, eerst een
// Excel-export aan te bieden en daarna een expliciete waarschuwing te tonen.
authRouter.get('/logout-preview', requireAuth, async (req: AuthedRequest, res) => {
  const candidates = await previewOrCommitWipe(req.user!.sessionId, false, {
    id: req.user!.id,
    isSysadmin: req.user!.isSysadmin,
  });
  res.json({ wouldWipe: candidates });
});

// POST /api/auth/logout — beëindigt de sessie en voert de wipe (indien van
// toepassing) daadwerkelijk uit. Dit is bewust pas de tweede stap vanuit de
// frontend: eerst logout-preview + bevestiging, dan pas dit endpoint.
authRouter.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  const wiped = await previewOrCommitWipe(req.user!.sessionId, true, {
    id: req.user!.id,
    isSysadmin: req.user!.isSysadmin,
  });
  res.json({ wiped });
});
