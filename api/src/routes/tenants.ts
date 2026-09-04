import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin, requireTenantRoleForTenantParam } from '../rbac.js';
import { createTenantDefaultConfig } from '../columnConfig.js';
import { assertCanAddAdmin, computeDefaultLicenseEndDate, LicenseLimitError } from '../license.js';
import { logAuditEvent } from '../auditLog.js';

export const tenantsRouter = Router();
tenantsRouter.use(requireAuth);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const TENANT_SELECT_FIELDS =
  'id, slug, name, wipe_on_empty, session_timeout_minutes, nightly_export_enabled, open_access_role, ' +
  'entry_popup_enabled, entry_popup_message, mfa_required, created_at';

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
  const { slug, name, wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled, mfaRequired } = req.body ?? {};
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
      `insert into tenants (slug, name, wipe_on_empty, session_timeout_minutes, nightly_export_enabled, mfa_required, license_end_date)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${TENANT_SELECT_FIELDS}, ${LICENSE_END_DATE_SELECT}`,
      [
        slug,
        name,
        !!wipeOnEmpty,
        Number.isFinite(sessionTimeoutMinutes) ? sessionTimeoutMinutes : 30,
        typeof nightlyExportEnabled === 'boolean' ? nightlyExportEnabled : true,
        !!mfaRequired,
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

// PUT /api/tenants/:id — wipeOnEmpty/sessionTimeoutMinutes/nightlyExportEnabled/
// mfaRequired/openAccessRole/entryPopupEnabled/entryPopupMessage/name/slug
// aanpassen. De eerste groep is toegestaan voor sysadmins én tenant-admins van
// déze tenant (dat valt onder "wijzigen in tenant"). name/slug zijn bewust
// sysadmin-only (zie de check hieronder) — een hernoeming raakt hoe een tenant
// voor de HELE app (picker, andere sysadmins, back-up-bestandspaden die de
// slug gebruiken) herkenbaar is, geen zelfbedieningsactie voor een
// individuele tenant-admin.
//
// mfaRequired: simpel boolean, geen tri-state zoals openAccessRole hieronder
// nodig (er is geen "niet gezet"-betekenis te onderscheiden — uit is uit) dus
// coalesce() volstaat, zelfde patroon als wipeOnEmpty/nightlyExportEnabled.
// Zie api/src/auth.ts (mfaRequired-berekening bij /login) voor het effect:
// verplicht voor ALLE leden van deze tenant, zonder eigen opt-out.
//
// openAccessRole is nullable (null = open toegang uit), dus coalesce() zoals
// bij wipeOnEmpty/sessionTimeoutMinutes hierboven volstaat niet — dat zou
// "expliciet uitzetten" (null meesturen) niet kunnen onderscheiden van "niet
// meegestuurd" (allebei worden null in JS/SQL). In plaats daarvan: alleen
// wijzigen als de key 'openAccessRole' ÜBERHAUPT in de request-body zit
// ('in b'), ongeacht of de waarde zelf null of een rol is.
tenantsRouter.put('/:id', requireTenantRoleForTenantParam('admin', 'id'), async (req: AuthedRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const { wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled } = b;
  const hasMfaRequired = typeof b.mfaRequired === 'boolean';
  const mfaRequired = b.mfaRequired as boolean | undefined;
  const hasOpenAccessRole = 'openAccessRole' in b;
  const openAccessRole = b.openAccessRole;
  const hasEntryPopupEnabled = typeof b.entryPopupEnabled === 'boolean';
  const entryPopupEnabled = b.entryPopupEnabled as boolean | undefined;
  const hasEntryPopupMessage = typeof b.entryPopupMessage === 'string';
  const entryPopupMessage = hasEntryPopupMessage ? (b.entryPopupMessage as string).trim() : undefined;
  const hasName = typeof b.name === 'string';
  const name = hasName ? (b.name as string).trim() : undefined;
  const hasSlug = typeof b.slug === 'string';
  const slug = hasSlug ? (b.slug as string).trim() : undefined;

  if ((hasName || hasSlug) && !req.user!.isSysadmin) {
    return res.status(403).json({ error: 'Alleen een sysadmin mag de naam of slug van een tenant wijzigen.' });
  }
  if (
    typeof wipeOnEmpty !== 'boolean' &&
    sessionTimeoutMinutes === undefined &&
    typeof nightlyExportEnabled !== 'boolean' &&
    !hasMfaRequired &&
    !hasOpenAccessRole &&
    !hasEntryPopupEnabled &&
    !hasEntryPopupMessage &&
    !hasName &&
    !hasSlug
  ) {
    return res.status(400).json({
      error:
        'Geef wipeOnEmpty, sessionTimeoutMinutes, nightlyExportEnabled, mfaRequired, openAccessRole, ' +
        'entryPopupEnabled, entryPopupMessage, name en/of slug mee.',
    });
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
  // De popup-tekst wordt bewust altijd sámen met entryPopupEnabled verwacht
  // (zo verstuurt TenantSettingsForm het ook, net als de andere velden hier)
  // — dat voorkomt dat 'ie aan komt te staan met een lege tekst zonder een
  // aparte, extra select nodig te hebben om de al-opgeslagen tekst erbij te
  // betrekken. Zelfde boolean+tekst-validatiepatroon als announcement.ts.
  if (entryPopupEnabled === true && !entryPopupMessage) {
    return res.status(400).json({ error: 'Bij een actieve popup-melding is een tekst (entryPopupMessage) verplicht.' });
  }
  if (hasName && !name) {
    return res.status(400).json({ error: 'name mag niet leeg zijn.' });
  }
  if (hasSlug && !slug) {
    return res.status(400).json({ error: 'slug mag niet leeg zijn.' });
  }

  // Vóór-toestand ophalen voor de auditlog-diff hieronder (zie db/init.sql
  // audit_log, event_type 'tenant_settings_changed') — vóór de eigenlijke
  // update, zodat we straks per gewijzigd veld {from, to} kunnen loggen i.p.v.
  // alleen "iets is gewijzigd". Dubbele 404-check (hier én na de update) is
  // bewust: de tenant kan in theorie tussen deze select en de update
  // verwijderd zijn.
  const before = await pool.query(`select ${TENANT_SELECT_FIELDS} from tenants where id = $1`, [req.params.id]);
  if (before.rows.length === 0) return res.status(404).json({ error: 'Tenant niet gevonden' });
  const beforeRow = before.rows[0] as Record<string, unknown>;

  try {
    const result = await pool.query(
      `update tenants set
         wipe_on_empty = coalesce($1, wipe_on_empty),
         session_timeout_minutes = coalesce($2, session_timeout_minutes),
         nightly_export_enabled = coalesce($3, nightly_export_enabled),
         open_access_role = case when $4 then $5 else open_access_role end,
         entry_popup_enabled = coalesce($6, entry_popup_enabled),
         entry_popup_message = coalesce($7, entry_popup_message),
         name = coalesce($8, name),
         slug = coalesce($9, slug),
         mfa_required = coalesce($10, mfa_required)
       where id = $11
       returning ${TENANT_SELECT_FIELDS}, ${LICENSE_END_DATE_SELECT}`,
      [
        typeof wipeOnEmpty === 'boolean' ? wipeOnEmpty : null,
        sessionTimeoutMinutes ?? null,
        typeof nightlyExportEnabled === 'boolean' ? nightlyExportEnabled : null,
        hasOpenAccessRole,
        openAccessRole ?? null,
        hasEntryPopupEnabled ? entryPopupEnabled : null,
        hasEntryPopupMessage ? entryPopupMessage : null,
        name ?? null,
        slug ?? null,
        hasMfaRequired ? mfaRequired : null,
        req.params.id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant niet gevonden' });
    const afterRow = result.rows[0] as Record<string, unknown>;

    // Alleen loggen wat er echt veranderd is — een PUT die (per ongeluk of
    // expres) dezelfde waarden terugstuurt levert geen logregel op.
    const changedFields = [
      'wipe_on_empty',
      'session_timeout_minutes',
      'nightly_export_enabled',
      'open_access_role',
      'entry_popup_enabled',
      'entry_popup_message',
      'name',
      'slug',
      'mfa_required',
    ] as const;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of changedFields) {
      if (beforeRow[field] !== afterRow[field]) {
        changes[field] = { from: beforeRow[field], to: afterRow[field] };
      }
    }
    if (Object.keys(changes).length > 0) {
      await logAuditEvent({
        eventType: 'tenant_settings_changed',
        userId: req.user!.id,
        tenantId: req.params.id,
        role: null,
        detail: { changes },
      });
    }

    res.json(afterRow);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'Er bestaat al een tenant met deze slug.' });
    }
    throw err;
  }
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
