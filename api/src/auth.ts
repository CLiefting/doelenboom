import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { previewOrCommitWipe } from './tenantWipe.js';
import { needsTermsAcceptance } from './legal.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

// 15-minuten-inactiviteit-beveiliging (zie POST /activity hieronder en
// web/src/useActivityPing.ts / web/public/tree.html's eigen kopie daarvan):
// een sessie waarvan de écht-activiteit langer dan dit aantal minuten
// geleden is, wordt hard geweigerd — geen glijdend venster, zie de
// toelichting bij de /activity-check verderop.
const IDLE_TIMEOUT_MINUTES = 15;

export type AuthedRequest = Request & {
  user?: { id: number; email: string; isSysadmin: boolean; sessionId: string };
};

// Async, want naast de JWT-handtekening wordt ook de sessions-rij zelf
// gecontroleerd: een geldige JWT alleen is niet genoeg zodra er is uitgelogd
// (ended_at, zie POST /logout) of de sessie te lang inactief is geweest
// (last_activity_at, zie IDLE_TIMEOUT_MINUTES hierboven) — anders zou een JWT
// tot z'n 12 uur-vervaldatum blijven werken ondanks een expliciete logout of
// een dichtgeklapte laptop.
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  let payload: { id: number; email: string; isSysadmin: boolean; sid: string };
  try {
    payload = jwt.verify(header.slice('Bearer '.length), JWT_SECRET) as typeof payload;
  } catch {
    return res.status(401).json({ error: 'Ongeldige of verlopen sessie' });
  }

  const sessionResult = await pool.query(
    `select ended_at, (last_activity_at < now() - interval '${IDLE_TIMEOUT_MINUTES} minutes') as idle
     from sessions where id = $1`,
    [payload.sid]
  );
  const session = sessionResult.rows[0];
  if (!session || session.ended_at !== null) {
    return res.status(401).json({ error: 'Sessie is beëindigd', reason: 'session_ended' });
  }
  if (session.idle) {
    return res.status(401).json({ error: 'Sessie is verlopen door inactiviteit', reason: 'idle_timeout' });
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
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
  }
  const result = await pool.query(
    `select id, email, is_sysadmin, must_change_password, scheduled_deletion_at
     from users
     where email = $1 and password_hash = crypt($2, password_hash)`,
    [email, password]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  }

  // last_login_at is de enige gekozen basis voor "relevant gebruik" in de
  // accountretentiesweep (zie accountRetention.ts) — bij elke geslaagde login
  // bijgewerkt. Stond er al een geplande verwijdering/waarschuwing klaar
  // (scheduled_deletion_at/inactivity_warning_sent_at), dan annuleert deze
  // login die volledig en start de 12-maanden-klok opnieuw (§9 van de
  // opdracht) — vastgelegd als apart auditlog-event zodat zichtbaar blijft
  // wanneer/waardoor een geplande verwijdering is afgeblazen.
  await pool.query(
    `update users
     set last_login_at = now(), scheduled_deletion_at = null, inactivity_warning_sent_at = null
     where id = $1`,
    [user.id]
  );
  if (user.scheduled_deletion_at) {
    await pool.query(
      `insert into account_retention_events (user_id, event_type, detail)
       values ($1, 'deletion_cancelled_by_login', '{}'::jsonb)`,
      [user.id]
    );
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
  const termsAcceptanceRequired = await needsTermsAcceptance(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      isSysadmin: user.is_sysadmin,
      mustChangePassword: user.must_change_password,
      termsAcceptanceRequired,
      tenantRoles,
    },
  });
});

// Tenants waar deze gebruiker toegang toe heeft: expliciete tenant_users-
// lidmaatschappen, ÉN tenants met open toegang (tenants.open_access_role,
// zie rbac.ts getTenantRole) waar deze gebruiker geen eigen rij voor heeft —
// LEFT JOIN vanuit tenants (i.p.v. vanuit tenant_users) om ook die laatste
// mee te pakken. coalesce(tu.role, t.open_access_role): een expliciete rol
// wint altijd, open_access_role is puur de fallback.
async function fetchTenantRoles(userId: number) {
  const result = await pool.query(
    `select t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name,
            coalesce(tu.role, t.open_access_role) as role
     from tenants t
     left join tenant_users tu on tu.tenant_id = t.id and tu.user_id = $1
     where tu.user_id is not null or t.open_access_role is not null
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
  const tenantRoles = req.user!.isSysadmin ? [] : await fetchTenantRoles(req.user!.id);
  const mcp = await pool.query('select must_change_password from users where id = $1', [req.user!.id]);
  const termsAcceptanceRequired = await needsTermsAcceptance(req.user!.id);
  res.json({
    user: {
      ...req.user,
      mustChangePassword: mcp.rows[0]?.must_change_password ?? false,
      termsAcceptanceRequired,
      tenantRoles,
    },
  });
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
  const tenantRoles = req.user!.isSysadmin ? [] : await fetchTenantRoles(req.user!.id);
  const termsAcceptanceRequired = await needsTermsAcceptance(req.user!.id);
  res.json({ user: { ...req.user, mustChangePassword: false, termsAcceptanceRequired, tenantRoles } });
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

// Échte-activiteit-ping (i.t.t. /heartbeat hierboven, dat blind elke minuut
// gaat ongeacht of er iemand meekijkt) — ververst last_activity_at, de basis
// van de IDLE_TIMEOUT_MINUTES-check in requireAuth hierboven. Zie
// web/src/useActivityPing.ts en web/public/tree.html's eigen kopie daarvan
// (muis/toetsenbord/scroll/touch, gethrottled tot 1x/minuut).
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
