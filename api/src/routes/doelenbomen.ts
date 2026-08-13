import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRole, requireTenantRoleForTenantParam, tenantIdForDoelenboom } from '../rbac.js';

// Let op: dit router wordt gemount op '/api' (niet '/api/doelenbomen'), zodat zowel
// '/api/doelenbomen' als '/api/tenants/:tenantId/doelenbomen' vanuit één bestand
// gedefinieerd kunnen worden zonder rare dubbele nesting in de URL's.
export const doelenbomenRouter = Router();
doelenbomenRouter.use(requireAuth);

// Alle doelenbomen die deze gebruiker mag zien — sysadmin ziet alles, anders
// alleen doelenbomen van tenants waar hij/zij lid van is (rol maakt niet uit,
// gebruiker mag ook lezen). Zonder deze filter zag elke ingelogde gebruiker
// vroeger alle tenants door elkaar in de picker.
doelenbomenRouter.get('/doelenbomen', async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    const result = await pool.query(
      `select d.id, d.slug, d.name, d.created_at, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
       from doelenbomen d
       join tenants t on t.id = d.tenant_id
       order by t.name, d.name`
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    `select d.id, d.slug, d.name, d.created_at, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
     from doelenbomen d
     join tenants t on t.id = d.tenant_id
     join tenant_users tu on tu.tenant_id = t.id
     where tu.user_id = $1
     order by t.name, d.name`,
    [req.user!.id]
  );
  res.json(result.rows);
});

doelenbomenRouter.get(
  '/doelenbomen/:id',
  requireTenantRole('gebruiker', (req) => tenantIdForDoelenboom(req.params.id)),
  async (req, res) => {
    const result = await pool.query(
      `select d.id, d.slug, d.name, d.created_at, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
       from doelenbomen d join tenants t on t.id = d.tenant_id
       where d.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(result.rows[0]);
  }
);

doelenbomenRouter.get(
  '/tenants/:tenantId/doelenbomen',
  requireTenantRoleForTenantParam('gebruiker', 'tenantId'),
  async (req, res) => {
    const result = await pool.query(
      'select id, slug, name, created_at from doelenbomen where tenant_id = $1 order by name',
      [req.params.tenantId]
    );
    res.json(result.rows);
  }
);

// Een nieuwe doelenboom binnen een tenant aanmaken is een tenant-wijziging —
// toegestaan voor sysadmins en tenant-admins van die tenant, niet voor gewone
// gebruikers.
doelenbomenRouter.post(
  '/tenants/:tenantId/doelenbomen',
  requireTenantRoleForTenantParam('admin', 'tenantId'),
  async (req, res) => {
    const { slug, name } = req.body ?? {};
    if (!slug || !name) {
      return res.status(400).json({ error: 'slug en name zijn verplicht' });
    }
    try {
      const result = await pool.query(
        'insert into doelenbomen (tenant_id, slug, name) values ($1, $2, $3) returning id, slug, name, created_at',
        [req.params.tenantId, slug, name]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(409).json({ error: 'Doelenboom met deze slug bestaat al binnen deze tenant', detail: (err as Error).message });
    }
  }
);
