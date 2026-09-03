import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin, requireTenantRoleForTenantParam } from '../rbac.js';
import { createTenantDefaultConfig } from '../columnConfig.js';
import { assertCanAddAdmin, computeDefaultLicenseEndDate, LicenseLimitError } from '../license.js';

export const tenantsRouter = Router();
tenantsRouter.use(requireAuth);

const TENANT_SELECT_FIELDS =
  'id, slug, name, wipe_on_empty, session_timeout_minutes, nightly_export_enabled, open_access_role, created_at';

// Licentie-einddatum als losse, expliciet met to_char geformatteerde kolom
// ("YYYY-MM-DD" of null) — bewust NIET in TENANT_SELECT_FIELDS hierboven,
// want die constante wordt elders (zie de niet-sysadmin-tak hieronder)
// naïef op ', ' gesplitst om een tabel-alias (t.) in te voegen; een
// to_char(...)-expressie bevat zelf een ', ' en zou die truc breken. Zelfde
// to_char-conventie als license.ts getTenantLicense (endDate) — voorkomt dat
// de pg-driver hier een DATE-kolom als JS Date-object teruggeeft.
const LICENSE_END_DATE_SELECT = `to_char(license_end_date, 'YYYY-MM-DD') as license_end_date`;

// Sysadmin ziet alle tenants; iedereen anders alleen de tenants waar hij/zij lid
// van is (nodig voor bv. "in welke tenant mag ik een doelenboom aanmaken" of het
// eigen ledenbeheer-scherm van een tenant-admin). license_end_date gaat mee
// zodat Tenantbeheer per tenant een kleurindicatie kan tonen (zie
// TenantManagementPage.tsx licenseBorderColor).
tenantsRouter.get('/', async (req: AuthedRequest, res) => {
  if (req.user!.isSysadmin) {
    const result = await pool.query(`select ${TENANT_SELECT_FIELDS}, ${LICENSE_END_DATE_SELECT} from tenants order by name`);
    return res.json(result.rows);
  }
  const result = await pool.query(
    `select t.${TENANT_SELECT_FIELDS.split(', ').join(', t.')}, tu.role as my_role,
            to_char(t.license_end_date, 'YYYY-MM-DD') as license_end_date
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
  const { slug, name, wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled } = req.body ?? {};
  if (!slug || !name) {
    return res.status(400).json({ error: 'slug en name zijn verplicht' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Default licentie-einddatum: einde van de aanmaakmaand + 12 maanden
    // (jaarlicentie, zie license.ts computeDefaultLicenseEndDate en
    // doelenboom_licentiemodel.md) — een sysadmin kan dit later altijd
    // verlengen/wijzigen/wissen via het licentiescherm in Tenantbeheer.
    const defaultLicenseEndDate = computeDefaultLicenseEndDate(new Date());
    const result = await client.query(
      `insert into tenants (slug, name, wipe_on_empty, session_timeout_minutes, nightly_export_enabled, license_end_date)
       values ($1, $2, $3, $4, $5, $6) returning ${TENANT_SELECT_FIELDS}, ${LICENSE_END_DATE_SELECT}`,
      [
        slug,
        name,
        !!wipeOnEmpty,
        Number.isFinite(sessionTimeoutMinutes) ? sessionTimeoutMinutes : 30,
        typeof nightlyExportEnabled === 'boolean' ? nightlyExportEnabled : true,
        defaultLicenseEndDate,
      ]
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

// PUT /api/tenants/:id — wipeOnEmpty/sessionTimeoutMinutes/openAccessRole
// aanpassen. Toegestaan voor sysadmins en tenant-admins van déze tenant (dat
// valt onder "wijzigen in tenant"). Slug/naam wijzigen kan hier bewust niet.
//
// openAccessRole is nullable (null = open toegang uit), dus coalesce() zoals
// bij wipeOnEmpty/sessionTimeoutMinutes hierboven volstaat niet — dat zou
// "expliciet uitzetten" (null meesturen) niet kunnen onderscheiden van "niet
// meegestuurd" (allebei worden null in JS/SQL). In plaats daarvan: alleen
// wijzigen als de key 'openAccessRole' ÜBERHAUPT in de request-body zit
// ('in b'), ongeacht of de waarde zelf null of een rol is.
tenantsRouter.put('/:id', requireTenantRoleForTenantParam('admin', 'id'), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const { wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled } = b;
  const hasOpenAccessRole = 'openAccessRole' in b;
  const openAccessRole = b.openAccessRole;
  if (
    typeof wipeOnEmpty !== 'boolean' &&
    sessionTimeoutMinutes === undefined &&
    typeof nightlyExportEnabled !== 'boolean' &&
    !hasOpenAccessRole
  ) {
    return res
      .status(400)
      .json({ error: 'Geef wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled en/of openAccessRole mee.' });
  }
  if (
    sessionTimeoutMinutes !== undefined &&
    (typeof sessionTimeoutMinutes !== 'number' || !Number.isFinite(sessionTimeoutMinutes) || sessionTimeoutMinutes <= 0)
  ) {
    return res.status(400).json({ error: 'sessionTimeoutMinutes moet een positief getal zijn.' });
  }
  if (
    hasOpenAccessRole &&
    openAccessRole !== null &&
    openAccessRole !== 'admin' &&
    openAccessRole !== 'gebruiker' &&
    openAccessRole !== 'bezoeker'
  ) {
    return res.status(400).json({ error: 'openAccessRole moet "admin", "gebruiker", "bezoeker" of null zijn.' });
  }
  const result = await pool.query(
    `update tenants set
       wipe_on_empty = coalesce($1, wipe_on_empty),
       session_timeout_minutes = coalesce($2, session_timeout_minutes),
       nightly_export_enabled = coalesce($3, nightly_export_enabled),
       open_access_role = case when $4 then $5 else open_access_role end
     where id = $6
     returning ${TENANT_SELECT_FIELDS}, ${LICENSE_END_DATE_SELECT}`,
    [
      typeof wipeOnEmpty === 'boolean' ? wipeOnEmpty : null,
      sessionTimeoutMinutes ?? null,
      typeof nightlyExportEnabled === 'boolean' ? nightlyExportEnabled : null,
      hasOpenAccessRole,
      openAccessRole ?? null,
      req.params.id,
    ]
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
  const role = b.role === 'admin' || b.role === 'gebruiker' || b.role === 'bezoeker' ? b.role : '';
  if (!email || !role) {
    return res.status(400).json({ error: 'E-mailadres en rol (admin/gebruiker/bezoeker) zijn verplicht.' });
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

  // Licentielimiet (zie license.ts/doelenboom_licentiemodel.md §5): alleen
  // relevant als deze gebruiker hierdoor NIEUW admin van deze tenant wordt —
  // een al-bestaande admin (bv. e-mailadres bestond al met role='admin') mag
  // altijd zonder limiet-check opnieuw als admin worden toegevoegd, dat is
  // geen extra admin.
  if (role === 'admin') {
    const alreadyAdmin = await pool.query(
      `select 1 from tenant_users where tenant_id = $1 and user_id = $2 and role = 'admin'`,
      [req.params.tenantId, userId]
    );
    if (alreadyAdmin.rows.length === 0) {
      try {
        await assertCanAddAdmin(req.params.tenantId);
      } catch (err) {
        if (err instanceof LicenseLimitError) return res.status(403).json({ error: err.message });
        throw err;
      }
    }
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
  if (role !== 'admin' && role !== 'gebruiker' && role !== 'bezoeker') {
    return res.status(400).json({ error: 'role moet "admin", "gebruiker" of "bezoeker" zijn.' });
  }

  if (role === 'admin') {
    const alreadyAdmin = await pool.query(
      `select 1 from tenant_users where tenant_id = $1 and user_id = $2 and role = 'admin'`,
      [req.params.tenantId, req.params.userId]
    );
    if (alreadyAdmin.rows.length === 0) {
      try {
        await assertCanAddAdmin(req.params.tenantId);
      } catch (err) {
        if (err instanceof LicenseLimitError) return res.status(403).json({ error: err.message });
        throw err;
      }
    }
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
