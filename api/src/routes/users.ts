import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin } from '../rbac.js';

// Beheer van gebruikersaccounts zelf (aanmaken/wijzigen/verwijderen, sysadmin-vlag)
// — uitsluitend voor sysadmins. Het koppelen van een account aan een tenant (met
// rol admin/gebruiker) gebeurt via de tenant-members routes in tenants.ts, die
// ook door tenant-admins gebruikt mogen worden voor hún eigen tenant — dat is
// bewust hier niet gemengd, om de rechten-scoping simpel te houden.
export const usersRouter = Router();
usersRouter.use(requireAuth, requireSysadmin);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const USER_SELECT_FIELDS = 'id, email, is_sysadmin, must_change_password, created_at';

async function attachTenantRoles<T extends { id: number }>(users: T[]) {
  if (users.length === 0) return users.map((u) => ({ ...u, tenantRoles: [] }));
  const ids = users.map((u) => u.id);
  const result = await pool.query(
    `select tu.user_id, tu.tenant_id, t.slug as tenant_slug, t.name as tenant_name, tu.role
     from tenant_users tu join tenants t on t.id = tu.tenant_id
     where tu.user_id = any($1::bigint[])
     order by t.name`,
    [ids]
  );
  const byUser = new Map<number, unknown[]>();
  for (const row of result.rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push({
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      tenantName: row.tenant_name,
      role: row.role,
    });
    byUser.set(row.user_id, list);
  }
  return users.map((u) => ({ ...u, tenantRoles: byUser.get(u.id) ?? [] }));
}

usersRouter.get('/', async (_req, res) => {
  const result = await pool.query(`select ${USER_SELECT_FIELDS} from users order by email`);
  res.json(await attachTenantRoles(result.rows));
});

// POST /api/users — nieuw account. Wijst hier bewust nog geen tenant toe; dat
// gebeurt via POST /api/tenants/:tenantId/members (die kan ook meteen een nieuw
// account aanmaken als het e-mailadres nog niet bestaat). must_change_password
// staat standaard aan: de sysadmin die dit account aanmaakt kiest het
// (tijdelijke) wachtwoord, dus de nieuwe gebruiker moet het bij de eerste login
// door zijn/haar eigen wachtwoord vervangen — kan uitgezet met mustChangePassword: false.
usersRouter.post('/', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const isSysadmin = b.isSysadmin === true;
  const mustChangePassword = b.mustChangePassword !== false;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord zijn verplicht.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Wachtwoord moet minstens 8 tekens zijn.' });
  }
  try {
    const result = await pool.query(
      `insert into users (email, password_hash, is_sysadmin, must_change_password)
       values ($1, crypt($2, gen_salt('bf')), $3, $4)
       returning ${USER_SELECT_FIELDS}`,
      [email, password, isSysadmin, mustChangePassword]
    );
    res.status(201).json({ ...result.rows[0], tenantRoles: [] });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Er bestaat al een account met e-mailadres "${email}".` });
    }
    res.status(500).json({ error: 'Aanmaken van gebruiker mislukt', detail: (err as Error).message });
  }
});

// PUT /api/users/:id — e-mail/wachtwoord/sysadmin-vlag wijzigen. Alleen
// meegegeven velden worden aangepast. Wordt hier een nieuw wachtwoord gezet
// (= een sysadmin die reset namens de gebruiker), dan gaat must_change_password
// standaard aan — tenzij expliciet mustChangePassword: false wordt meegegeven.
usersRouter.put('/:id', async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const userId = req.params.id;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : undefined;
  const password = typeof b.password === 'string' && b.password ? b.password : undefined;
  const isSysadmin = typeof b.isSysadmin === 'boolean' ? b.isSysadmin : undefined;
  const mustChangePassword = password !== undefined ? b.mustChangePassword !== false : undefined;

  if (password !== undefined && password.length < 8) {
    return res.status(400).json({ error: 'Wachtwoord moet minstens 8 tekens zijn.' });
  }
  // Voorkom dat de laatste sysadmin zichzelf (of iemand anders) degradeert en
  // daarmee niemand meer overblijft die tenants/gebruikers kan beheren.
  if (isSysadmin === false) {
    const countResult = await pool.query(
      'select count(*)::int as n from users where is_sysadmin = true and id != $1',
      [userId]
    );
    if (countResult.rows[0].n === 0) {
      return res.status(400).json({ error: 'Er moet minstens één sysadmin overblijven.' });
    }
  }

  try {
    const result = await pool.query(
      `update users set
         email = coalesce($1, email),
         password_hash = case when $2::text is null then password_hash else crypt($2, gen_salt('bf')) end,
         is_sysadmin = coalesce($3, is_sysadmin),
         must_change_password = coalesce($4, must_change_password)
       where id = $5
       returning ${USER_SELECT_FIELDS}`,
      [email ?? null, password ?? null, isSysadmin ?? null, mustChangePassword ?? null, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
    res.json((await attachTenantRoles(result.rows))[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: `Er bestaat al een account met e-mailadres "${email}".` });
    }
    res.status(500).json({ error: 'Bijwerken van gebruiker mislukt', detail: (err as Error).message });
  }
});

// DELETE /api/users/:id — verwijdert het account volledig (cascade: sessions,
// tenant_users — zie db/init.sql). Zelfde "laatste sysadmin"-bescherming als bij PUT.
usersRouter.delete('/:id', async (req, res) => {
  const userId = req.params.id;
  const target = await pool.query('select is_sysadmin from users where id = $1', [userId]);
  if (target.rows.length === 0) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
  if (target.rows[0].is_sysadmin) {
    const countResult = await pool.query(
      'select count(*)::int as n from users where is_sysadmin = true and id != $1',
      [userId]
    );
    if (countResult.rows[0].n === 0) {
      return res.status(400).json({ error: 'Er moet minstens één sysadmin overblijven.' });
    }
  }
  await pool.query('delete from users where id = $1', [userId]);
  res.status(204).send();
});
