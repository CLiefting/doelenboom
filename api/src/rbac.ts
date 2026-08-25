import { Response, NextFunction } from 'express';
import { pool } from './db.js';
import { AuthedRequest } from './auth.js';
import { hasModule, isLicenseExpired } from './license.js';

// Rolmodel (zie db/init.sql voor de tabellen):
// - sysadmin (users.is_sysadmin): globaal, mag alles — incl. tenants en
//   gebruikers beheren. Geen tenant_users-rij nodig, geldt overal.
// - admin (tenant_users.role = 'admin'): mag lezen én wijzigen binnen die ene
//   tenant (elementen/relaties/tags/org-eenheden/imports, tenant-instellingen,
//   leden van die tenant) — mag geen tenants aanmaken en geen andere tenants
//   beheren.
// - gebruiker (tenant_users.role = 'gebruiker'): alleen lezen binnen die tenant.
export type TenantRole = 'admin' | 'gebruiker';

export async function getTenantRole(userId: number, tenantId: number | string): Promise<TenantRole | null> {
  const result = await pool.query(
    'select role from tenant_users where user_id = $1 and tenant_id = $2',
    [userId, tenantId]
  );
  return (result.rows[0]?.role as TenantRole | undefined) ?? null;
}

export async function tenantIdForDoelenboom(doelenboomId: number | string): Promise<number | null> {
  const result = await pool.query('select tenant_id from doelenbomen where id = $1', [doelenboomId]);
  return result.rows[0]?.tenant_id ?? null;
}

// Effectieve rol van een gebruiker op één specifieke doelenboom: de rol uit
// doelenboom_user_roles (indien aanwezig) overrult de tenant-brede rol uit
// tenant_users — in beide richtingen (kan zowel op- als afschalen). Geen
// tenant-lidmaatschap betekent geen toegang, ook niet met een override-rij
// (die kan niet bestaan zonder een geldige user_id, maar checkt hier expliciet
// nog de tenant-membership zodat een verwijderd tenant-lidmaatschap ook
// meteen de toegang intrekt, ongeacht een eventuele oude override-rij).
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
// deze gebruiker in die tenant opgezocht. minRole='gebruiker' betekent "moet lid
// zijn" (lezen mag), minRole='admin' betekent "moet tenant-admin zijn" (schrijven).
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
    if (minRole === 'admin' && role !== 'admin') {
      return res.status(403).json({ error: 'Alleen een tenant-admin mag dit wijzigen.' });
    }
    next();
  };
}

// Voor routes met :id = doelenboom-id (elements/tags/orgUnits/edges/imports/exports/
// tree, en de doelenboom-instellingen zelf). Gebruikt de EFFECTIEVE rol (tenant-rol,
// tenzij overruled voor déze doelenboom via doelenboom_user_roles) — dus een
// tenant-admin die op deze ene doelenboom is teruggezet naar 'gebruiker' verliest
// hier ook de rechten om 'm te hernoemen/verwijderen/op read-only te zetten.
export function requireTenantRoleForDoelenboomParam(minRole: TenantRole, paramName = 'id') {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user?.isSysadmin) return next();

    const doelenboomId = req.params[paramName];
    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    const role = await getEffectiveRoleForDoelenboom(req.user!.id, doelenboomId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (minRole === 'admin' && role !== 'admin') {
      return res.status(403).json({ error: 'Alleen een admin (tenant- of doelenboom-specifiek) mag dit wijzigen.' });
    }
    next();
  };
}

// Voor routes met :tenantId direct in de URL (tenants/:id, tenants/:tenantId/...).
export function requireTenantRoleForTenantParam(minRole: TenantRole, paramName = 'tenantId') {
  return requireTenantRole(minRole, (req) => Number(req.params[paramName]));
}

// Voor content-schrijfroutes binnen een doelenboom (elementen/relaties/tags/
// organisatieonderdelen/imports — niet de doelenboom-instellingen zelf, zie
// db/init.sql bij doelenbomen.read_only). Sysadmin mag altijd door. Voor
// iedereen anders geldt de EFFECTIEVE rol (tenant-rol, tenzij overruled voor
// déze doelenboom, zie doelenboom_user_roles) — die moet 'admin' zijn EN de
// doelenboom mag niet op read-only staan — zo blokkeert read-only iedereen
// behalve sysadmin, ook een admin die normaal wél zou mogen schrijven.
//
// resolveDoelenboomId: net als bij requireTenantRole hierboven, óf de naam van
// de route-param die direct het doelenboom-id bevat, óf een functie die 'm
// afleidt (bv. via een tussenliggend import-id, zie imports.ts).
export function requireWritableDoelenboom(
  resolveDoelenboomId: string | ((req: AuthedRequest) => Promise<number | string | null> | number | string | null)
) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const doelenboomId =
      typeof resolveDoelenboomId === 'string' ? req.params[resolveDoelenboomId] : await resolveDoelenboomId(req);
    if (doelenboomId == null) return res.status(404).json({ error: 'Niet gevonden.' });

    if (req.user?.isSysadmin) return next();

    const tenantId = await tenantIdForDoelenboom(doelenboomId);
    if (tenantId == null) return res.status(404).json({ error: 'Niet gevonden.' });
    const role = await getEffectiveRoleForDoelenboom(req.user!.id, doelenboomId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Alleen een admin (tenant- of doelenboom-specifiek) mag dit wijzigen.' });
    }

    const result = await pool.query('select read_only from doelenbomen where id = $1', [doelenboomId]);
    if (result.rows[0]?.read_only) {
      return res
        .status(403)
        .json({ error: 'Deze doelenboom staat op alleen-lezen; alleen een sysadmin kan wijzigingen aanbrengen.' });
    }

    // Licentie-einddatum (zie license.ts isLicenseExpired,
    // doelenboom_licentiemodel.md) — zelfde enforcement-plek als de
    // read_only-check hierboven: een verlopen licentie maakt de hele tenant
    // read-only voor iedereen behalve sysadmin, net als vandaag al geldt voor
    // een doelenboom die individueel op read-only staat.
    if (await isLicenseExpired(tenantId)) {
      return res.status(403).json({
        error: 'De licentie van deze tenant is verlopen; alleen een sysadmin kan nog wijzigingen aanbrengen.',
      });
    }
    next();
  };
}

// Middleware-factory voor module-gebonden functies (zie license.ts en
// doelenboom_licentiemodel.md §3) — bv. de "Projecten"-module op
// routes/products.ts en routes/projectStatus.ts. Sysadmin mag altijd door
// (zelfde conventie als de rest van dit bestand). Voor iedereen anders: leidt
// de tenant af uit de doelenboom (resolveDoelenboomId, zelfde vorm als bij
// requireWritableDoelenboom hierboven) en controleert of die module actief
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
    if (req.user?.isSysadmin) return next();

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
