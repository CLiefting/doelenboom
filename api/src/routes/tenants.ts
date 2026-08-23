import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin, requireTenantRoleForTenantParam } from '../rbac.js';
import { createTenantDefaultConfig } from '../columnConfig.js';

export const tenantsRouter = Router();
tenantsRouter.use(requireAuth);

const TENANT_SELECT_FIELDS = 'id, slug, name, wipe_on_empty, session_timeout_minutes, created_at';

// Sysadmin ziet alle tenants; iedereen anders alleen de tenants waar hij/zij lid
// van is (nodig voor bv. "in welke tenant mag ik een doelenboom aanmaken" of het
// eigen ledenbeheer-scherm van een tenant-admin).
tenantsRouter.get('/', async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    const result = await pool.query(`select ${TENANT_SELECT_FIELDS} from tenants order by name`);
    return res.json(result.rows);
  }
  const result = await pool.query(
    `select t.${TENANT_SELECT_FIELDS.split(', ').join(', t.')}, tu.role as my_role
     from tenants t join tenant_users tu on tu.tenant_id = t.id
     where tu.user_id = $1
     order by t.name`,
    [req.user!.id]
  );
  res.json(result.rows);
});

// Alleen sysadmins mogen nieuwe tenants aanmaken. Krijgt meteen een eigen
// tenant-default kolomconfiguratie (de standaardkolommen, zie
// columnConfig.ts) — het sjabloon waarmee elke nieuwe doelenboom binnen deze
// tenant straks start.
tenantsRouter.post('/', requireSysadmin, async (req, res) => {
  const { slug, name, wipeOnEmpty, sessionTimeoutMinutes } = req.body ?? {};
  if (!slug || !name) {
    return res.status(400).json({ error: 'slug en name zijn verplicht' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `insert into tenants (slug, name, wipe_on_empty, session_timeout_minutes)
       values ($1, $2, $3, $4) returning ${TENANT_SELECT_FIELDS}`,
      [slug, name, !!wipeOnEmpty, Number.isFinite(sessionTimeoutMinutes) ? sessionTimeoutMinutes : 30]
    );
    await createTenantDefaultConfig(client, result.rows[0].id, result.rows[0].name);
    await client.query('commit');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('rollback');
    res.status(409).json({ error: 'Tenant met deze slug bestaat al', detail: (err as Error).message });
  } finally {
    client.release();
  }
});

// PUT /api/tenants/:id — wipeOnEmpty/sessionTimeoutMinutes aanpassen. Toegestaan
// voor sysadmins en tenant-admins van déze tenant (dat valt onder "wijzigen in
// tenant"). Slug/naam wijzigen kan hier bewust niet.
tenantsRouter.put('/:id', requireTenantRoleForTenantParam('admin', 'id'), async (req, res) => {
  const { wipeOnEmpty, sessionTimeoutMinutes } = req.body ?? {};
  if (typeof wipeOnEmpty !== 'boolean' && sessionTimeoutMinutes === undefined) {
    return res.status(400).json({ error: 'Geef wipeOnEmpty en/of sessionTimeoutMinutes mee.' });
  }
  if (sessionTimeoutMinutes !== undefined && (!Number.isFinite(sessionTimeoutMinutes) || sessionTimeoutMinutes <= 0)) {
    return res.status(400).json({ error: 'sessionTimeoutMinutes moet een positief getal zijn.' });
  }
  const result = await pool.query(
    `update tenants set
       wipe_on_empty = coalesce($1, wipe_on_empty),
       session_timeout_minutes = coalesce($2, session_timeout_minutes)
     where id = $3
     returning ${TENANT_SELECT_FIELDS}`,
    [typeof wipeOnEmpty === 'boolean' ? wipeOnEmpty : null, sessionTimeoutMinutes ?? null, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant niet gevonden' });
  res.json(result.rows[0]);
});

// DELETE /api/tenants/:id — sysadmin-only. Cascade (db/init.sql) ruimt
// tenant_users, doelenbomen en al hun inhoud (elementen/relaties/tags/
// organisatieonderdelen/imports) van deze tenant automatisch mee op. Bewust
// géén requireTenantRoleForTenantParam hier: een tenant-admin mag zijn eigen
// tenant niet kunnen wegvagen, alleen een sysadmin.
tenantsRouter.delete('/:id', requireSysadmin, async (req, res) => {
  const result = await pool.query('delete from tenants where id = $1 returning id', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  res.status(204).send();
});

// --- Leden van een tenant (user management binnen de tenant) ---
// Toegestaan voor sysadmins en tenant-admins van déze tenant. Los van
// api/src/routes/users.ts (dat is accountbeheer zelf, sysadmin-only) — dit hier
// is puur "wie heeft welke rol in deze tenant".

tenantsRouter.get('/:tenantId/members', requireTenantRoleForTenantParam('admin', 'tenantId'), async (req, res) => {
  const result = await pool.query(
    `select u.id as user_id, u.email, tu.role
     from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = $1
     order by u.email`,
    [req.params.tenantId]
  );
  res.json(result.rows);
});

// POST /api/tenants/:tenantId/members — { email, password?, role }. Als er nog
// geen account met dit e-mailadres bestaat wordt het aangemaakt (dan is password
// verplicht, en krijgt het account nooit is_sysadmin=true via deze route — dat
// kan alleen via /api/users, sysadmin-only). Bestaat het account al, dan wordt
// alleen de rol in déze tenant gezet/overschreven (upsert).
tenantsRouter.post('/:tenantId/members', requireTenantRoleForTenantParam('admin', 'tenantId'), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const role = b.role === 'admin' || b.role === 'gebruiker' ? b.role : '';
  if (!email || !role) {
    return res.status(400).json({ error: 'E-mailadres en rol (admin/gebruiker) zijn verplicht.' });
  }

  const existing = await pool.query('select id from users where email = $1', [email]);
  let userId: number;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
  } else {
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Nieuw account: wachtwoord (min. 8 tekens) is verplicht.' });
    }
    const created = await pool.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ($1, crypt($2, gen_salt('bf')), false, true) returning id`,
      [email, password]
    );
    userId = created.rows[0].id;
  }

  await pool.query(
    `insert into tenant_users (tenant_id, user_id, role) values ($1, $2, $3)
     on conflict (tenant_id, user_id) do update set role = excluded.role`,
    [req.params.tenantId, userId, role]
  );
  res.status(201).json({ userId, email, role });
});

tenantsRouter.put('/:tenantId/members/:userId', requireTenantRoleForTenantParam('admin', 'tenantId'), async (req, res) => {
  const role = (req.body ?? {}).role;
  if (role !== 'admin' && role !== 'gebruiker') {
    return res.status(400).json({ error: 'role moet "admin" of "gebruiker" zijn.' });
  }
  const result = await pool.query(
    `update tenant_users set role = $1 where tenant_id = $2 and user_id = $3 returning id`,
    [role, req.params.tenantId, req.params.userId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Lidmaatschap niet gevonden.' });
  res.json({ userId: Number(req.params.userId), role });
});

tenantsRouter.delete('/:tenantId/members/:userId', requireTenantRoleForTenantParam('admin', 'tenantId'), async (req, res) => {
  const result = await pool.query(
    'delete from tenant_users where tenant_id = $1 and user_id = $2 returning id',
    [req.params.tenantId, req.params.userId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Lidmaatschap niet gevonden.' });
  res.status(204).send();
});
