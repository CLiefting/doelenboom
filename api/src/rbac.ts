import { Response, NextFunction } from 'express';
import { pool } from './db.js';
import { AuthedRequest } from './auth.js';

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

// Voor routes met :id = doelenboom-id (elements/tags/orgUnits/edges/imports/exports/tree).
export function requireTenantRoleForDoelenboomParam(minRole: TenantRole, paramName = 'id') {
  return requireTenantRole(minRole, async (req) => tenantIdForDoelenboom(req.params[paramName]));
}

// Voor routes met :tenantId direct in de URL (tenants/:id, tenants/:tenantId/...).
export function requireTenantRoleForTenantParam(minRole: TenantRole, paramName = 'tenantId') {
  return requireTenantRole(minRole, (req) => Number(req.params[paramName]));
}

// Voor content-schrijfroutes binnen een doelenboom (elementen/relaties/tags/
// organisatieonderdelen/imports — niet de doelenboom-instellingen zelf, zie
// db/init.sql bij doelenbomen.read_only). Sysadmin mag altijd door. Een
// tenant-admin moet zowel tenant-admin zijn ALS de doelenboom mag niet op
// read-only staan — zo blokkeert read-only iedereen behalve sysadmin, ook een
// tenant-admin die normaal wél zou mogen schrijven.
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
    const role = await getTenantRole(req.user!.id, tenantId);
    if (!role) return res.status(403).json({ error: 'Geen toegang tot deze tenant.' });
    if (role !== 'admin') return res.status(403).json({ error: 'Alleen een tenant-admin mag dit wijzigen.' });

    const result = await pool.query('select read_only from doelenbomen where id = $1', [doelenboomId]);
    if (result.rows[0]?.read_only) {
      return res
        .status(403)
        .json({ error: 'Deze doelenboom staat op alleen-lezen; alleen een sysadmin kan wijzigingen aanbrengen.' });
    }
    next();
  };
}
