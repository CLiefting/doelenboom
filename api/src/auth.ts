import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { previewOrCommitWipe } from './tenantWipe.js';
import { needsTermsAcceptance } from './legal.js';
import { getAppSettings } from './appSettings.js';
import { createMfaChallenge, verifyMfaChallenge, resendMfaChallenge } from './mfa.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

// Beide bekende, publiek-in-deze-repo-zichtbare dev-defaultwaarden: deze regel
// hierboven (als JWT_SECRET in het geheel niet gezet is) én
// docker-compose.yml's eigen `${JWT_SECRET:-dev-secret-verander-mij}` (als de
// env var wél via Compose binnenkomt, maar met die shell-default). Beide zijn
// even onveilig als productiegeheim: iedereen die deze repo leest kan er een
// geldig, zelfs sysadmin-, JWT mee vervalsen (zie requireAuth hierboven).
const KNOWN_DEV_JWT_SECRETS = new Set(['dev-secret-change-me', 'dev-secret-verander-mij']);

// CISO-aandachtspunt: vóór deze check kon een misconfiguratie (JWT_SECRET
// vergeten te zetten in productie, of per ongeluk de dev-.env meegekopieerd)
// volledig stilzwijgend doorlopen — de app start gewoon op, alleen met een
// publiek bekend ondertekeningsgeheim. In lokale dev (docker-compose.yml,
// geen NODE_ENV) blijft dit bewust een waarschuwing i.p.v. een crash, zodat
// de lokale stack met de ingebouwde dev-default gewoon blijft werken; alleen
// met NODE_ENV=production (zie docker-compose.prod.yml) weigert de app
// daadwerkelijk op te starten.
//
// Pure functie (secret/nodeEnv als parameters, geen directe process.env-
// lezing hier) zodat api/test/auth.test.ts dit met allerlei combinaties kan
// testen zonder een subprocess te hoeven starten — assertCurrentJwtSecretIsSafe()
// hieronder is de dunne, module-scope-lezende wrapper die createApp() in
// app.ts daadwerkelijk aanroept, 1x per opstart (dus ook vóór elke testrun,
// met NODE_ENV nooit op 'production').
export function assertJwtSecretIsSafe(secret: string, nodeEnv: string | undefined): void {
  if (!KNOWN_DEV_JWT_SECRETS.has(secret)) return;
  const message =
    'JWT_SECRET staat nog op een bekende dev-defaultwaarde — zet een eigen, willekeurig geheim ' +
    '(zie deploy/README.md §4: python3 -c "import secrets; print(secrets.token_urlsafe(32))") ' +
    'vóór dit in productie draait.';
  if (nodeEnv === 'production') {
    throw new Error(message);
  }
  console.warn(`WAARSCHUWING: ${message}`);
}

export function assertCurrentJwtSecretIsSafe(): void {
  assertJwtSecretIsSafe(JWT_SECRET, process.env.NODE_ENV);
}

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

  // Rate limiting / tijdelijke accountblokkade bij herhaalde mislukte
  // inlogpogingen (CISO-aandachtspunt) — drempel/duur zijn sysadmin-
  // instelbaar, app-breed (zie appSettings.ts/routes/appSettings.ts,
  // "Accountbeheer" in de frontend), geen hardgecodeerde constanten.
  // password_ok wordt als losse, berekende kolom meegenomen i.p.v. in de
  // where-clause (zoals voorheen), zodat we ook bij een FOUT wachtwoord de
  // rest van de rij (met name failed_login_count/locked_until) beschikbaar
  // hebben om de teller op te hogen — een niet-bestaand e-mailadres geeft
  // nog altijd domweg geen rij, exact zoals voorheen (geen aparte fout,
  // voorkomt dat we verklappen of een e-mailadres bestaat).
  const result = await pool.query(
    `select id, email, is_sysadmin, must_change_password, scheduled_deletion_at,
            failed_login_count, locked_until, mfa_enabled,
            (password_hash = crypt($2, password_hash)) as password_ok,
            exists(
              select 1 from tenant_users tu join tenants t on t.id = tu.tenant_id
              where tu.user_id = users.id and t.mfa_required
            ) as tenant_mfa_required
     from users
     where email = $1`,
    [email, password]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  }

  const settings = await getAppSettings();

  // Al geblokkeerd: geen wachtwoordcontrole meer nodig — ook een ondertussen
  // toevallig juist wachtwoord wordt pas ná het verstrijken van de blokkade
  // weer geaccepteerd. Eenvoudiger en voorspelbaarder dan een vroegtijdige
  // uitzondering, en voorkomt dat een aanvaller die tijdens de blokkade
  // alsnog raadt meteen binnenkomt.
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const minutesLeft = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000));
    return res.status(429).json({
      error: `Account tijdelijk geblokkeerd wegens te veel mislukte inlogpogingen. Probeer het over ongeveer ${minutesLeft} minuut/minuten opnieuw.`,
      reason: 'account_locked',
    });
  }

  if (!user.password_ok) {
    const newCount = user.failed_login_count + 1;
    if (newCount >= settings.maxFailedLoginAttempts) {
      // Teller resetten (niet laten doorlopen): de blokkade zelf is nu de
      // maatregel, en na afloop start een nieuwe telling vanaf 0.
      await pool.query(
        `update users
         set failed_login_count = 0, locked_until = now() + make_interval(mins => $2)
         where id = $1`,
        [user.id, settings.loginLockoutMinutes]
      );
      return res.status(429).json({
        error: `Te veel mislukte inlogpogingen. Account is ${settings.loginLockoutMinutes} minuten geblokkeerd.`,
        reason: 'account_locked',
      });
    }
    await pool.query('update users set failed_login_count = $2 where id = $1', [user.id, newCount]);
    return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  }

  // last_login_at is de enige gekozen basis voor "relevant gebruik" in de
  // accountretentiesweep (zie accountRetention.ts) — bij elke geslaagde login
  // bijgewerkt. Stond er al een geplande verwijdering/waarschuwing klaar
  // (scheduled_deletion_at/inactivity_warning_sent_at), dan annuleert deze
  // login die volledig en start de 12-maanden-klok opnieuw (§9 van de
  // opdracht) — vastgelegd als apart auditlog-event zodat zichtbaar blijft
  // wanneer/waardoor een geplande verwijdering is afgeblazen. Een geslaagde
  // login wist ook altijd een eventueel opgebouwde mislukte-pogingen-teller/
  // blokkade (failed_login_count/locked_until).
  await pool.query(
    `update users
     set last_login_at = now(), scheduled_deletion_at = null, inactivity_warning_sent_at = null,
         failed_login_count = 0, locked_until = null
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

  // MFA-poort (CISO-aandachtspunt, zie doelenboom_mfa_ontwerp.md in het
  // project en mfa.ts) — verplicht voor sysadmins (ongeacht mfa_enabled), voor
  // leden van een tenant met mfa_required aan (tenant_mfa_required hierboven,
  // zie db/init.sql tenants.mfa_required en routes/tenants.ts), en verder
  // optioneel (zelf aan/uit te zetten, zie mfa_enabled hierboven). Bewust
  // account-breed (niet sessie- of tenant-context-specifiek): heeft deze
  // gebruiker toegang tot meerdere tenants en is er ook maar één met
  // mfa_required aan, dan is MFA bij élke login verplicht, ongeacht welke
  // tenant/doelenboom hierna geopend wordt. Bewust GEEN sessie/token hier als
  // MFA vereist is: die worden pas aangemaakt in completeLogin() ná een
  // geslaagde /mfa/verify — vóór dat punt bestaat er dus geen enkel bruikbaar
  // token voor deze inlogpoging, anders dan bij mustChangePassword (dat al wél
  // meteen een geldig token geeft en alleen de frontend-UI blokkeert) zou een
  // kaal token vóór MFA de bedoelde bescherming juist omzeilbaar maken.
  const mfaRequired = user.is_sysadmin || user.mfa_enabled || user.tenant_mfa_required;
  if (mfaRequired) {
    // Expliciete try/catch (i.t.t. de meeste routes hier, die op de globale
    // unhandledRejection-vangnet in index.ts leunen): een falende
    // e-mailverzending (verkeerd wachtwoord, relay onbereikbaar, timeout) is
    // hier geen onvoorziene fout maar een reëel, te verwachten scenario — en
    // zonder deze catch bleef de hele /login-aanvraag onbeantwoord hangen
    // (de client zag "Bezig…" voor altijd) in plaats van een nette foutmelding
    // te krijgen. De net aangemaakte challenge-rij zelf hoeft niet opgeruimd
    // te worden: die verloopt vanzelf (CODE_TTL_MINUTES) en is zonder
    // ontvangen code toch onbruikbaar.
    let challenge;
    try {
      challenge = await createMfaChallenge(user.id, user.email);
    } catch (err) {
      console.error('Kon MFA-inlogcode niet versturen:', err);
      return res.status(502).json({
        error: 'Kon geen inlogcode versturen (e-mailserver niet bereikbaar). Probeer het later opnieuw.',
      });
    }
    return res.json({
      mfaRequired: true,
      challengeId: challenge.challengeId,
      expiresInSeconds: challenge.expiresInSeconds,
    });
  }

  res.json(await completeLogin(user.id));
});

// Rondt een inlogpoging daadwerkelijk af: maakt de sessies-rij en het JWT aan
// en bouwt de /me-achtige gebruikersrespons op. Hergebruikt door zowel de
// MFA-vrije tak hierboven als POST /mfa/verify hieronder (die roept dit pas
// aan ná een geslaagde codecontrole) — zo bestaat er precies één plek die
// ooit daadwerkelijk een sessie/token uitgeeft.
async function completeLogin(userId: number) {
  const userResult = await pool.query(
    'select id, email, is_sysadmin, must_change_password, mfa_enabled from users where id = $1',
    [userId]
  );
  const user = userResult.rows[0];

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
  const mfaRequiredTenants = user.is_sysadmin ? [] : await fetchMfaRequiredTenantNames(user.id);
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      isSysadmin: user.is_sysadmin,
      mustChangePassword: user.must_change_password,
      mfaEnabled: user.mfa_enabled,
      mfaRequiredTenants,
      termsAcceptanceRequired,
      tenantRoles,
    },
  };
}

// POST /api/auth/mfa/verify — tweede stap van de inlogflow zodra /login
// { mfaRequired: true, challengeId, ... } teruggaf. Geen requireAuth (er is
// immers nog geen sessie): de challengeId zelf (ondoorzichtig, willekeurig,
// zie mfa.ts) plus de gemailde code zijn hier de enige verificatie.
authRouter.post('/mfa/verify', async (req, res) => {
  const { challengeId, code } = req.body ?? {};
  if (!challengeId || !code) {
    return res.status(400).json({ error: 'challengeId en code zijn verplicht' });
  }

  const result = await verifyMfaChallenge(String(challengeId), String(code));
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: 'Ongeldige of verlopen aanmeldpoging. Log opnieuw in.',
      expired: 'Deze code is verlopen. Vraag een nieuwe code aan.',
      already_used: 'Deze aanmeldpoging is al afgerond of verlopen. Log opnieuw in.',
      too_many_attempts: 'Te veel foutieve pogingen. Vraag een nieuwe code aan of log opnieuw in.',
      wrong_code: 'Onjuiste code.',
    };
    const status = result.reason === 'too_many_attempts' ? 429 : result.reason === 'not_found' ? 400 : 401;
    return res.status(status).json({ error: messages[result.reason], reason: result.reason });
  }

  res.json(await completeLogin(result.userId));
});

// POST /api/auth/mfa/resend — vervangt de code IN dezelfde challenge (zie
// resendMfaChallenge in mfa.ts), zodat de frontend dezelfde challengeId
// blijft gebruiken. Ook hier geen requireAuth, om dezelfde reden als hierboven.
authRouter.post('/mfa/resend', async (req, res) => {
  const { challengeId } = req.body ?? {};
  if (!challengeId) {
    return res.status(400).json({ error: 'challengeId is verplicht' });
  }

  // Zelfde reden als bij /login hierboven: een falende e-mailverzending is
  // hier te verwachten, geen onvoorziene fout — zonder deze catch bleef ook
  // deze aanvraag onbeantwoord hangen i.p.v. een nette foutmelding te geven.
  let result: Awaited<ReturnType<typeof resendMfaChallenge>>;
  try {
    result = await resendMfaChallenge(String(challengeId));
  } catch (err) {
    console.error('Kon MFA-inlogcode niet opnieuw versturen:', err);
    return res.status(502).json({
      error: 'Kon geen nieuwe inlogcode versturen (e-mailserver niet bereikbaar). Probeer het later opnieuw.',
    });
  }
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: 'Ongeldige of verlopen aanmeldpoging. Log opnieuw in.',
      already_used: 'Deze aanmeldpoging is al afgerond of verlopen. Log opnieuw in.',
      cooldown: 'Wacht nog even voordat je een nieuwe code aanvraagt.',
      too_many_resends: 'Je hebt het maximaal aantal keer een nieuwe code opgevraagd. Log opnieuw in om het nogmaals te proberen.',
    };
    const status = result.reason === 'cooldown' || result.reason === 'too_many_resends' ? 429 : result.reason === 'not_found' ? 400 : 401;
    return res
      .status(status)
      .json({ error: messages[result.reason], reason: result.reason, retryAfterSeconds: result.retryAfterSeconds });
  }

  res.json({ expiresInSeconds: result.expiresInSeconds });
});

// Tenants waar deze gebruiker toegang toe heeft: expliciete tenant_users-
// lidmaatschappen, ÉN tenants met open toegang (tenants.open_access_role,
// zie rbac.ts getTenantRole) waar deze gebruiker geen eigen rij voor heeft —
// LEFT JOIN vanuit tenants (i.p.v. vanuit tenant_users) om ook die laatste
// mee te pakken. coalesce(tu.role, t.open_access_role): een expliciete rol
// wint altijd, open_access_role is puur de fallback.
// Namen van de tenant(s) waar deze gebruiker lid van is (tenant_users) én die
// mfa_required aan hebben staan — puur voor UI-uitleg (MySecurityPage.tsx: "MFA
// is verplicht via tenant X" i.p.v. alleen "verplicht"). Bepaalt zelf NIET of
// MFA vereist is bij login — dat gebeurt met de exists()-subquery in /login
// hierboven (die ook open_access_role-toegang zonder eigen tenant_users-rij
// bewust NEGEERT: mfa_required is een verplichting voor leden, geen
// eigenschap die via open toegang "meelift").
async function fetchMfaRequiredTenantNames(userId: number): Promise<string[]> {
  const result = await pool.query(
    `select t.name from tenants t
     join tenant_users tu on tu.tenant_id = t.id
     where tu.user_id = $1 and t.mfa_required
     order by t.name`,
    [userId]
  );
  return result.rows.map((r) => r.name as string);
}

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
  const mcp = await pool.query('select must_change_password, mfa_enabled from users where id = $1', [req.user!.id]);
  const termsAcceptanceRequired = await needsTermsAcceptance(req.user!.id);
  const mfaRequiredTenants = req.user!.isSysadmin ? [] : await fetchMfaRequiredTenantNames(req.user!.id);
  res.json({
    user: {
      ...req.user,
      mustChangePassword: mcp.rows[0]?.must_change_password ?? false,
      mfaEnabled: mcp.rows[0]?.mfa_enabled ?? false,
      mfaRequiredTenants,
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
  // mfaEnabled/mfaRequiredTenants horen hier ook bij (dit retourneert een
  // volledig User-object, zie types.ts) — zonder deze twee zou MySecurityPage
  // meteen na een wachtwoordwijziging op een onvolledige user kunnen crashen
  // als de gebruiker daar meteen daarna naartoe navigeert zonder tussentijdse
  // /me-herlaadbeurt.
  const mcp = await pool.query('select mfa_enabled from users where id = $1', [req.user!.id]);
  const mfaRequiredTenants = req.user!.isSysadmin ? [] : await fetchMfaRequiredTenantNames(req.user!.id);
  res.json({
    user: {
      ...req.user,
      mustChangePassword: false,
      mfaEnabled: mcp.rows[0]?.mfa_enabled ?? false,
      mfaRequiredTenants,
      termsAcceptanceRequired,
      tenantRoles,
    },
  });
});

// PUT /api/auth/mfa-enabled — zelfbediening: elke ingelogde gebruiker mag zijn/
// haar eigen optionele MFA aan/uit zetten (zie doelenboom_mfa_ontwerp.md §6).
// Sysadmins krijgen hier bewust een 400: hun MFA is verplicht (zie mfaRequired
// in /login hierboven) en dit ontwerp biedt daar expliciet geen eigen omweg
// voor — anders zou een gecompromitteerd sysadmin-account zichzelf de
// bescherming kunnen laten uitschakelen. Zelfde reden, zelfde 400, voor een
// lid van een tenant met mfa_required aan (zie fetchMfaRequiredTenantNames
// hierboven): ook dat is bedoeld als verplichting zonder individuele
// opt-out — anders zou de tenant-instelling in de praktijk vrijblijvend zijn.
authRouter.put('/mfa-enabled', requireAuth, async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    return res.status(400).json({ error: 'MFA is verplicht voor sysadmin-accounts en kan niet worden uitgezet.' });
  }
  const mfaRequiredTenants = await fetchMfaRequiredTenantNames(req.user!.id);
  if (mfaRequiredTenants.length > 0) {
    return res.status(400).json({
      error: `MFA is verplicht gesteld door tenant "${mfaRequiredTenants.join('", "')}" en kan niet worden uitgezet.`,
    });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is verplicht.' });
  }
  await pool.query('update users set mfa_enabled = $1 where id = $2', [b.enabled, req.user!.id]);
  res.json({ mfaEnabled: b.enabled });
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
