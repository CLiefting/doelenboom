import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireTenantRole, requireTenantRoleForDoelenboomParam, requireTenantRoleForTenantParam, tenantIdForDoelenboom } from '../rbac.js';

// Let op: dit router wordt gemount op '/api' (niet '/api/doelenbomen'), zodat zowel
// '/api/doelenbomen' als '/api/tenants/:tenantId/doelenbomen' vanuit één bestand
// gedefinieerd kunnen worden zonder rare dubbele nesting in de URL's.
export const doelenbomenRouter = Router();
doelenbomenRouter.use(requireAuth);

// Alle doelenbomen die deze gebruiker mag zien — sysadmin ziet alles, anders
// alleen doelenbomen van tenants waar hij/zij lid van is (rol maakt niet uit,
// gebruiker mag ook lezen). Zonder deze filter zag elke ingelogde gebruiker
// vroeger alle tenants door elkaar in de picker.
const DOELENBOOM_FIELDS = 'd.id, d.slug, d.name, d.read_only, d.wipe_on_empty, d.created_at';

doelenbomenRouter.get('/doelenbomen', async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    const result = await pool.query(
      `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
       from doelenbomen d
       join tenants t on t.id = d.tenant_id
       order by t.name, d.name`
    );
    return res.json(result.rows);
  }
  const result = await pool.query(
    `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
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
      `select ${DOELENBOOM_FIELDS}, t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name
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
      'select id, slug, name, read_only, wipe_on_empty, created_at from doelenbomen where tenant_id = $1 order by name',
      [req.params.tenantId]
    );
    res.json(result.rows);
  }
);

// Een nieuwe doelenboom binnen een tenant aanmaken is een tenant-wijziging —
// toegestaan voor sysadmins en tenant-admins van die tenant, niet voor gewone
// gebruikers. wipe_on_empty wordt geseed vanuit tenants.wipe_on_empty (de
// "standaardinstelling" van de tenant, zie db/init.sql) zodat je 'm niet elke
// keer opnieuw hoeft te zetten — na aanmaken is 't gewoon een eigen,
// onafhankelijk instelbare vlag op déze doelenboom.
doelenbomenRouter.post(
  '/tenants/:tenantId/doelenbomen',
  requireTenantRoleForTenantParam('admin', 'tenantId'),
  async (req, res) => {
    const { slug, name } = req.body ?? {};
    if (!slug || !name) {
      return res.status(400).json({ error: 'slug en name zijn verplicht' });
    }
    try {
      const tenantDefault = await pool.query('select wipe_on_empty from tenants where id = $1', [req.params.tenantId]);
      const defaultWipeOnEmpty = tenantDefault.rows[0]?.wipe_on_empty ?? false;
      const result = await pool.query(
        `insert into doelenbomen (tenant_id, slug, name, wipe_on_empty)
         values ($1, $2, $3, $4) returning id, slug, name, read_only, wipe_on_empty, created_at`,
        [req.params.tenantId, slug, name, defaultWipeOnEmpty]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(409).json({ error: 'Doelenboom met deze slug bestaat al binnen deze tenant', detail: (err as Error).message });
    }
  }
);

// PUT /api/doelenbomen/:id — { name?, slug?, readOnly?, wipeOnEmpty? }. Dit zijn
// instellingen van de doelenboom zelf (naam/slug/alleen-lezen/auto-leegmaken),
// geen "boom-inhoud" — daarom hier bewust requireTenantRoleForDoelenboomParam
// i.p.v. requireWritableDoelenboom: een tenant-admin mag de read-only-vlag
// altijd zelf weer uitzetten, ook als de doelenboom op dit moment read-only
// staat (anders zou een tenant-admin zichzelf kunnen buitensluiten zonder
// sysadmin erbij te hoeven halen).
doelenbomenRouter.put(
  '/doelenbomen/:id',
  requireTenantRoleForDoelenboomParam('admin', 'id'),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    const readOnly = typeof b.readOnly === 'boolean' ? b.readOnly : undefined;
    const wipeOnEmpty = typeof b.wipeOnEmpty === 'boolean' ? b.wipeOnEmpty : undefined;
    if (!name) return res.status(400).json({ error: 'Naam is verplicht.' });

    const current = await pool.query('select slug, read_only, wipe_on_empty from doelenbomen where id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Doelenboom niet gevonden.' });
    const newSlug = slug || current.rows[0].slug;
    const newReadOnly = readOnly === undefined ? current.rows[0].read_only : readOnly;
    const newWipeOnEmpty = wipeOnEmpty === undefined ? current.rows[0].wipe_on_empty : wipeOnEmpty;

    try {
      const result = await pool.query(
        `update doelenbomen set name = $1, slug = $2, read_only = $3, wipe_on_empty = $4
         where id = $5 returning id, slug, name, read_only, wipe_on_empty, created_at`,
        [name, newSlug, newReadOnly, newWipeOnEmpty, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(409).json({ error: 'Doelenboom met deze slug bestaat al binnen deze tenant', detail: (err as Error).message });
    }
  }
);

// DELETE /api/doelenbomen/:id — cascade (db/init.sql) ruimt elementen/relaties/
// tags/organisatieonderdelen/imports van deze doelenboom automatisch mee op.
// Zelfde toegang als hernoemen/read-only (tenant-beheer, niet "boom-inhoud").
doelenbomenRouter.delete(
  '/doelenbomen/:id',
  requireTenantRoleForDoelenboomParam('admin', 'id'),
  async (req, res) => {
    const result = await pool.query('delete from doelenbomen where id = $1 returning id', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Doelenboom niet gevonden.' });
    res.status(204).send();
  }
);
