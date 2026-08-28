import { Response, NextFunction } from 'express';
import { pool } from './db.js';
import { AuthedRequest } from './auth.js';
import { hasModule, isLicenseExpired } from './license.js';

// Rolmodel (zie db/init.sql voor de tabellen):
// - sysadmin (users.is_sysadmin): platformbeheer — tenants aanmaken/verwijderen,
//   licenties/tiers, leden van een tenant (en hun rol) toevoegen/wijzigen/
//   verwijderen, accounts beheren. GEEN tenant_users-rij nodig voor dat alles.
//   Sysadmin mag echter NIET zomaar de boom-inhoud van een tenant zien of
//   wijzigen (elementen/relaties/tags/org-koppelingen/projectstatus/producten/
//   kolommen/imports/exports, en de tree-view zelf) — dat vereist, net als voor
//   iedereen, een echte koppeling aan die tenant/doelenboom via tenant_users
//   (evt. met een doelenboom_user_roles-override), zie requireWritableDoelenboom/
//   requireModule hieronder (géén sysadmin-bypass meer) en
//   requireTenantRoleForDoelenboomParam's allowSysadmin-optie (default false).
//   Dit is bewust zo vanwege privacy: een platformbeheerder hoeft niet in de
//   inhoud van een klant te kunnen kijken om de tenant te kunnen beheren. Twee
//   uitzonderingen blijven wél zonder koppeling toegankelijk (puur metadata,
//   geen inhoud): de doelenbomen-lijst (naam/slug/alleen-lezen-status, zie
//   routes/doelenbomen.ts GET /doelenbomen en GET /tenants/:id/doelenbomen) en
//   de doelenboom-"instellingen" zelf (naam/slug wijzigen, alleen-lezen aan/uit,
//   archiveren, verwijderen, en doelenboom_user_roles-overrides beheren — zie
//   de allowSysadmin:true-routes in routes/doelenbomen.ts).
// - admin (tenant_users.role = 'admin'): mag lezen én wijzigen binnen die ene
//   tenant — alle boom-inhoud (elementen/relaties/tags/org-eenheden/imports),
//   ÉN de "instellingen"-laag: kolomconfiguratie, doelenboom-instellingen
//   (naam/slug/alleen-lezen/archiveren), tenant-instellingen, leden van die
//   tenant. Mag geen tenants aanmaken en geen andere tenants beheren.
// - gebruiker (tenant_users.role = 'gebruiker'): mag lezen én de "losse
//   boom-inhoud" wijzigen binnen die tenant — elementen aanmaken/bewerken/
//   verwijderen, relaties tussen elementen, tags/organisatieonderdelen aan
//   een element koppelen (niet de tag/org-catalogus zelf beheren), en
//   projectstatus/producten. Mag NIET de kolomconfiguratie of overige
//   instellingen wijzigen, geen Excel importeren, en geen leden/tenants
//   beheren — dat blijft admin/sysadmin (zie requireWritableDoelenboom's
//   minRole-param hieronder voor de precieze knip per route).
// - bezoeker (tenant_users.role = 'bezoeker'): alleen lezen binnen die
//   tenant — geen enkele schrijfactie.
//
// Open toegang (tenants.open_access_role, zie db/init.sql): een tenant kan
// ingesteld worden om IEDER account met een login minstens een bepaalde rol
// te geven, ook zonder eigen tenant_users-rij (bedoeld voor bv. de
// Demo-tenant). getTenantRole hieronder regelt de fallback; een expliciete
// tenant_users-rol wint altijd. sysadmins tellen hierin gewoon mee als "elk
// account" — een tenant die dit aanzet kiest daar bewust voor, dat is geen
// impliciete uitzondering op de privacy-afspraak hierboven (die gaat over
// tenants die dit NIET hebben aangezet).
export type TenantRole = 'admin' | 'gebruiker' | 'bezoeker';

// Rangorde voor "minimaal deze rol nodig"-checks hieronder — hoger getal =
// meer rechten. sysadmin zit hier bewust buiten (die mag altijd door, los
// van deze rangorde, zie elke functie hieronder).
const ROLE_RANK: Record<TenantRole, number> = { bezoeker: 0, gebruiker: 1, admin: 2 };

function roleAtLeast(role: TenantRole, minRole: TenantRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// Effectieve tenant-rol van een gebruiker: de expliciete tenant_users-rol als
// die bestaat, anders — als de tenant "open toegang" heeft (tenants.
// open_access_role, zie db/init.sql) — die open-toegang-rol als ondergrens
// voor IEDER account, ook zonder eigen tenant_users-rij. Een expliciete rol
// wint dus altijd; open_access_role is puur een fallback voor wie geen eigen
// rij heeft (kan iemands eigen rol nooit verlagen). LEFT JOIN i.p.v. een
// simpele where-clause op tenant_users, zodat deze functie ook een rij
// teruggeeft (met tu.role = null) wanneer er geen lidmaatschap is maar de
// tenant wél bestaat — nodig om open_access_role als fallback te kunnen
// gebruiken.
export async function getTenantRole(userId: number, tenantId: number | string): Promise<TenantRole | null> {
  const result = await pool.query(
    `select tu.role, t.open_access_role
     from tenants t
     left join tenant_users tu on tu.tenant_id = t.id and tu.user_id = $1
     where t.id = $2`,
    [userId, tenantId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as { role: TenantRole | null; open_access_role: TenantRole | null };
  return row.role ?? row.open_access_role ?? null;
}

export async function tenantIdForDoelenboom(doelenboomId: number | string): Promise<number | null> {
  const result = await pool.query('select tenant_id from doelenbomen where id = $1', [doelenboomId]);
  return result.rows[0]?.tenant_id ?? null;
}

// Effectieve rol van een gebruiker op één specifieke doelenboom: de rol uit
// doelenboom_user_roles (indien aanwezig) overrult de tenant-brede rol uit
// getTenantRole hierboven — in beide richtingen (kan zowel op- als
// afschalen). getTenantRole regelt zelf al de open-toegang-fallback
// (tenants.open_access_role), dus "geen toegang" hier betekent: geen
// tenant_users-rij ÉN geen open-toegang voor deze tenant. Een override-rij in
// doelenboom_user_roles kan overigens sowieso alleen bestaan voor een echte
// tenant_users-lid (zie PUT /doelenbomen/:id/member-roles/:userId in
// routes/doelenbomen.ts, die dat expliciet afdwingt) — een open-toegang-
// gebruiker zonder eigen rij heeft dus altijd precies open_access_role, nooit
// een eigen override.
export async function getEffectiveRoleForDoelenboom(
  userId: number,
  doelenboomId: number | string
): Promise<TenantRole | null> {
  const tenantId = await tenantIdForDoelenboom(doelenboomId);
  if (tenantId == null) return null;
  const tenantRole = await getTenantRole(userId, tenantId);
  if (!tenantRole) return null;
  const override = await pool.query(
    'select role from doelenboom_user_roles where doelenboom_id = $1 and user_id = $2',
    [doelenboomId, userId]
  );
  return (override.rows[0]?.role as TenantRole | undefined) ?? tenantRole;
}

export function requireSysadmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSysadmin) {
    return res.status(403).json({ error: 'Deze actie is alleen voor sysadmins.' });
  }
  next();
}

// Middleware-factory: sysadmin mag altijd door. Anders wordt via resolveTenantId
// (dat de tenant afleidt uit bv. req.params.id / req.params.tenantId) de rol van
// deze gebruiker in die tenant opgezocht, en vergeleken tegen minRole via de
// rangorde hierboven (ROLE_RANK) — minRole='bezoeker' betekent "moet lid zijn"
// (lezen mag, elke rol volstaat), minRole='gebruiker' betekent "moet gebruiker
// of admin zijn", minRole='admin' betekent "moet tenant-admin zijn" (schrijven).
export function requireTenantRole(
  minRole: TenantRole,
  resolveTenantId: (req: AuthedRequest) => Promise<number | null> | number | null
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user?.isSysadmin) return next();

    const tenantId = await resolveTenantId(req);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const role = await getTenantRole(req.user!.id, tenantId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (!roleAtLeast(role, minRole)) {
      return res.status(403).json({ error: `Deze actie vereist minimaal de rol "${minRole}" binnen deze tenant.` });
    }
    next();
  };
}

// Voor routes met :id = doelenboom-id (elements/tags/orgUnits/edges/imports/exports/
// tree, en de doelenboom-instellingen zelf). Gebruikt de EFFECTIEVE rol (tenant-rol,
// tenzij overruled voor déze doelenboom via doelenboom_user_roles) — dus een
// tenant-admin die op deze ene doelenboom is teruggezet naar 'gebruiker' verliest
// hier ook de rechten om 'm te hernoemen/verwijderen/op read-only te zetten.
//
// opts.allowSysadmin (default false): sysadmin mag hier NIET automatisch door —
// zie het rolmodel hierboven (privacy: geen inhoud zonder koppeling). Alleen de
// paar routes die écht "instellingen"/toegangsbeheer zijn i.p.v. boom-inhoud
// (doelenboom hernoemen/archiveren/verwijderen, doelenboom_user_roles-overrides
// — zie routes/doelenbomen.ts) zetten dit expliciet op true.
export function requireTenantRoleForDoelenboomParam(
  minRole: TenantRole,
  paramName = 'id',
  opts: { allowSysadmin?: boolean } = {}
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (opts.allowSysadmin && req.user?.isSysadmin) return next();

    const doelenboomId = req.params[paramName];
    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const role = await getEffectiveRoleForDoelenboom(req.user!.id, doelenboomId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (!roleAtLeast(role, minRole)) {
      return res.status(403).json({ error: `Deze actie vereist minimaal de rol "${minRole}" (tenant- of doelenboom-specifiek).` });
    }
    next();
  };
}

// Voor routes met :tenantId direct in de URL (tenants/:id, tenants/:tenantId/...).
export function requireTenantRoleForTenantParam(minRole: TenantRole, paramName = 'tenantId') {
  return requireTenantRole(minRole, (req) => Number(req.params[paramName]));
}

// Voor schrijfroutes binnen een doelenboom (boom-inhoud — zie het rolmodel
// hierboven: hier geldt bewust GEEN sysadmin-bypass, ook een sysadmin heeft een
// echte koppeling aan de tenant nodig). Voor iedereen — sysadmin incluis — geldt
// de EFFECTIEVE rol (tenant-rol, tenzij overruled voor déze doelenboom, zie
// doelenboom_user_roles) — die moet minstens minRole zijn (rangorde, zie
// ROLE_RANK hierboven) EN de doelenboom mag niet op read-only staan. Een
// doelenboom weer van read-only af halen kan alleen via de "instellingen"-route
// (routes/doelenbomen.ts PUT /doelenbomen/:id, die bewust
// requireTenantRoleForDoelenboomParam gebruikt i.p.v. deze functie) door een
// tenant-admin (of een sysadmin die zichzelf daar expliciet voor toegang geeft).
//
// minRole (default 'admin'): de meeste schrijfroutes zijn nog steeds
// admin-only — de "instellingen"-laag (kolomconfiguratie, doelenboom
// hernoemen/read-only/archiveren, Excel-import, tag-/org-catalogus zelf
// beheren). Voor de "losse boom-inhoud" (elementen, relaties, tags/org-
// koppelingen ÓP een element, projectstatus/producten — zie routes/elements.ts,
// edges.ts, tags.ts, orgUnits.ts, products.ts, projectStatus.ts) geven die
// routes hier expliciet minRole='gebruiker' mee, zodat ook de rol 'gebruiker'
// (niet alleen 'admin') erdoorheen mag — de read-only/licentie-check hieronder
// blijft in beide gevallen gelden.
//
// resolveDoelenboomId: net als bij requireTenantRole hierboven, óf de naam van
// de route-param die direct het doelenboom-id bevat, óf een functie die 'm
// afleidt (bv. via een tussenliggend import-id, zie imports.ts).
export function requireWritableDoelenboom(
  resolveDoelenboomId: string | ((req: AuthedRequest) => Promise<number | string | null> | number | string | null),
  minRole: TenantRole = 'admin'
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const doelenboomId =
      typeof resolveDoelenboomId === 'string' ? req.params[resolveDoelenboomId] : await resolveDoelenboomId(req);
    if (doelenboomId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });
    const role = await getEffectiveRoleForDoelenboom(req.user!.id, doelenboomId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (!roleAtLeast(role, minRole)) {
      return res.status(403).json({
        error:
          minRole === 'admin'
            ? 'Alleen een admin (tenant- of doelenboom-specifiek) mag dit wijzigen.'
            : 'Alleen een admin of gebruiker (tenant- of doelenboom-specifiek) mag dit wijzigen.',
      });
    }

    const result = await pool.query('select read_only from doelenbomen where id = $1', [doelenboomId]);
    if (result.rows[0]?.read_only) {
      return res.status(403).json({
        error: 'Deze doelenboom staat op alleen-lezen; een tenant-admin kan dit uitzetten via de doelenboom-instellingen.',
      });
    }

    // Licentie-einddatum (zie license.ts isLicenseExpired,
    // doelenboom_licentiemodel.md) — zelfde enforcement-plek als de
    // read_only-check hierboven: een verlopen licentie maakt de hele tenant
    // read-only voor iedereen, ongeacht rol.
    if (await isLicenseExpired(tenantId)) {
      return res.status(403).json({
        error: 'De licentie van deze tenant is verlopen; neem contact op om te verlengen.',
      });
    }
    next();
  };
}

// Middleware-factory voor module-gebonden functies (zie license.ts en
// doelenboom_licentiemodel.md §3) — bv. de "Projecten"-module op
// routes/products.ts en routes/projectStatus.ts. Geen sysadmin-bypass (zelfde
// conventie als requireWritableDoelenboom hierboven — dit gate't boom-inhoud).
// Leidt de tenant af uit de doelenboom (resolveDoelenboomId, zelfde vorm als
// bij requireWritableDoelenboom hierboven) en controleert of die module actief
// is. Bewust een eigen, aparte check (niet gecombineerd met
// requireWritableDoelenboom) zodat routes beide onafhankelijk kunnen
// combineren: eerst "mag deze gebruiker hier schrijven", dan "heeft de
// licentie deze module" — een duidelijker foutmelding per situatie dan één
// gecombineerde check zou geven.
export function requireModule(
  moduleKey: string,
  resolveDoelenboomId: string | ((req: AuthedRequest) => Promise<number | string | null> | number | string | null)
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const doelenboomId =
      typeof resolveDoelenboomId === 'string' ? req.params[resolveDoelenboomId] : await resolveDoelenboomId(req);
    if (doelenboomId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const active = await hasModule(tenantId, moduleKey);
    if (!active) {
      return res.status(403).json({
        error: `Deze functie vereist de module "${moduleKey}", die niet actief is voor de licentie van deze tenant.`,
      });
    }
    next();
  };
}
