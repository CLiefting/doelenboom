import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, AuthedRequest } from '../auth.js';
import { requireSysadmin } from '../rbac.js';
import { logAuditEvent } from '../auditLog.js';
import { getTenantLicense } from '../license.js';

// Klantbeheer — zie db/migrations/0033_customer_management.sql voor het
// datamodel-ontwerp. Bewust sysadmin-only (geen enkele route hier is ook
// bereikbaar voor een tenant-admin): dit is een commerciële/relationele laag
// bovenop een tenant, geen zelfbedieningsfunctie — zelfde toegangsmodel als
// licensesRouter (routes/licenses.ts).
export const customerManagementRouter = Router();
customerManagementRouter.use(requireAuth, requireSysadmin);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

async function tenantExists(tenantId: string): Promise<boolean> {
  const r = await pool.query('select 1 from tenants where id = $1', [tenantId]);
  return r.rows.length > 0;
}

// --- Contactpersonen ---

const CONTACT_SELECT_FIELDS =
  'id, tenant_id as "tenantId", name, email, phone, role, is_primary as "isPrimary", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

const CONTACT_ROLES = ['tenant_admin', 'ciso', 'overig'] as const;
type ContactRole = (typeof CONTACT_ROLES)[number];

function parseContactBody(b: Record<string, unknown>): {
  name: string;
  email: string;
  phone: string | null;
  role: ContactRole;
  isPrimary: boolean;
} | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const phone = typeof b.phone === 'string' && b.phone.trim() ? b.phone.trim() : null;
  const role = typeof b.role === 'string' && (CONTACT_ROLES as readonly string[]).includes(b.role) ? (b.role as ContactRole) : null;
  const isPrimary = b.isPrimary === true;

  if (!name) return { error: 'Naam is verplicht.' };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Een geldig e-mailadres is verplicht.' };
  if (!role) return { error: `role moet één van ${CONTACT_ROLES.join(', ')} zijn.` };
  return { name, email, phone, role, isPrimary };
}

// Alle contactpersonen van één tenant, gegroepeerd per rol/primair-status aan
// de kant van de frontend (deze route geeft gewoon de platte lijst terug,
// gesorteerd zodat het primaire contact en de tenant_admins vooraan staan).
customerManagementRouter.get('/tenants/:tenantId/contacts', async (req, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const result = await pool.query(
    `select ${CONTACT_SELECT_FIELDS} from tenant_contacts where tenant_id = $1
     order by is_primary desc, role, name`,
    [req.params.tenantId]
  );
  res.json(result.rows);
});

// De geschiedenis van wijzigingen (wie was wanneer primair contact, welke
// velden zijn gewijzigd) staat NIET in een eigen tabel maar in het generieke
// audit_log (event_type 'tenant_contact_changed', zie migratie 0033) — deze
// route is puur een leesbaar-gemaakte doorverwijzing naar de al bestaande
// filter op GET /api/audit-log, zodat de frontend niet zelf de
// tenantId/eventType-query-string hoeft samen te stellen.
customerManagementRouter.get('/tenants/:tenantId/contacts/history', async (req, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const result = await pool.query(
    `select a.id, a.created_at, a.detail, u.email as user_email
     from audit_log a
     left join users u on u.id = a.user_id
     where a.tenant_id = $1 and a.event_type = 'tenant_contact_changed'
     order by a.created_at desc`,
    [req.params.tenantId]
  );
  res.json(
    result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      userEmail: row.user_email,
      detail: row.detail,
    }))
  );
});

// Precies één primair contact per tenant (partial unique index, zie
// migratie 0033) — bij het (her)instellen van isPrimary=true wordt een
// eventueel bestaand primair contact binnen dezelfde transactie eerst
// teruggezet, zodat de index nooit botst en de "overdracht" in één
// logregel {from, to} te vangen is (de gevraagde primair-contact-
// geschiedenis).
customerManagementRouter.post('/tenants/:tenantId/contacts', async (req: AuthedRequest, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const parsed = parseContactBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });

  const client = await pool.connect();
  try {
    await client.query('begin');
    let previousPrimary: { id: number; name: string } | null = null;
    if (parsed.isPrimary) {
      const prev = await client.query(
        'select id, name from tenant_contacts where tenant_id = $1 and is_primary',
        [req.params.tenantId]
      );
      previousPrimary = prev.rows[0] ?? null;
      if (previousPrimary) {
        await client.query('update tenant_contacts set is_primary = false, updated_at = now() where id = $1', [
          previousPrimary.id,
        ]);
      }
    }
    const inserted = await client.query(
      `insert into tenant_contacts (tenant_id, name, email, phone, role, is_primary)
       values ($1,$2,$3,$4,$5,$6)
       returning ${CONTACT_SELECT_FIELDS}`,
      [req.params.tenantId, parsed.name, parsed.email, parsed.phone, parsed.role, parsed.isPrimary]
    );
    await client.query('commit');

    const contact = inserted.rows[0];
    await logAuditEvent({
      eventType: 'tenant_contact_changed',
      userId: req.user!.id,
      tenantId: req.params.tenantId,
      role: null,
      detail: {
        action: 'created',
        contact: { id: contact.id, name: contact.name, role: contact.role },
        ...(parsed.isPrimary
          ? { primaryTransfer: { from: previousPrimary ? { id: previousPrimary.id, name: previousPrimary.name } : null, to: { id: contact.id, name: contact.name } } }
          : {}),
      },
    });
    res.status(201).json(contact);
  } catch (err) {
    await client.query('rollback');
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'Er is al een primair contact voor deze tenant.' });
    }
    throw err;
  } finally {
    client.release();
  }
});

customerManagementRouter.put('/contacts/:id', async (req: AuthedRequest, res) => {
  const parsed = parseContactBody({
    name: req.body?.name,
    email: req.body?.email,
    phone: req.body?.phone,
    role: req.body?.role,
    isPrimary: req.body?.isPrimary,
  });
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(`select ${CONTACT_SELECT_FIELDS} from tenant_contacts where id = $1`, [
      req.params.id,
    ]);
    if (before.rows.length === 0) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Contactpersoon niet gevonden.' });
    }
    const beforeRow = before.rows[0] as Record<string, unknown>;
    const tenantId = beforeRow.tenantId as number;

    let previousPrimary: { id: number; name: string } | null = null;
    if (parsed.isPrimary && !beforeRow.isPrimary) {
      const prev = await client.query(
        'select id, name from tenant_contacts where tenant_id = $1 and is_primary and id != $2',
        [tenantId, req.params.id]
      );
      previousPrimary = prev.rows[0] ?? null;
      if (previousPrimary) {
        await client.query('update tenant_contacts set is_primary = false, updated_at = now() where id = $1', [
          previousPrimary.id,
        ]);
      }
    }

    const updated = await client.query(
      `update tenant_contacts set
         name = $1, email = $2, phone = $3, role = $4, is_primary = $5, updated_at = now()
       where id = $6
       returning ${CONTACT_SELECT_FIELDS}`,
      [parsed.name, parsed.email, parsed.phone, parsed.role, parsed.isPrimary, req.params.id]
    );
    await client.query('commit');
    const afterRow = updated.rows[0] as Record<string, unknown>;

    const changedFields = ['name', 'email', 'phone', 'role', 'isPrimary'] as const;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of changedFields) {
      if (beforeRow[field] !== afterRow[field]) changes[field] = { from: beforeRow[field], to: afterRow[field] };
    }
    if (Object.keys(changes).length > 0 || previousPrimary) {
      await logAuditEvent({
        eventType: 'tenant_contact_changed',
        userId: req.user!.id,
        tenantId,
        role: null,
        detail: {
          action: 'updated',
          contact: { id: afterRow.id, name: afterRow.name },
          changes,
          ...(previousPrimary
            ? { primaryTransfer: { from: { id: previousPrimary.id, name: previousPrimary.name }, to: { id: afterRow.id, name: afterRow.name } } }
            : {}),
        },
      });
    }
    res.json(afterRow);
  } catch (err) {
    await client.query('rollback');
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'Er is al een primair contact voor deze tenant.' });
    }
    throw err;
  } finally {
    client.release();
  }
});

customerManagementRouter.delete('/contacts/:id', async (req: AuthedRequest, res) => {
  const result = await pool.query(`delete from tenant_contacts where id = $1 returning ${CONTACT_SELECT_FIELDS}`, [
    req.params.id,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Contactpersoon niet gevonden.' });
  const deleted = result.rows[0] as Record<string, unknown>;
  await logAuditEvent({
    eventType: 'tenant_contact_changed',
    userId: req.user!.id,
    tenantId: deleted.tenantId as number,
    role: null,
    detail: { action: 'deleted', contact: { id: deleted.id, name: deleted.name, role: deleted.role, isPrimary: deleted.isPrimary } },
  });
  res.status(204).send();
});

// --- Klantgegevens (facturatie/bedrijfsgegevens, tags, contractreferentie) ---

const CUSTOMER_INFO_SELECT_FIELDS =
  `tenant_id as "tenantId", to_char(customer_since, 'YYYY-MM-DD') as "customerSince", ` +
  `kvk_number as "kvkNumber", vat_number as "vatNumber", billing_address as "billingAddress", tags, ` +
  `contract_reference as "contractReference", to_char(contract_date, 'YYYY-MM-DD') as "contractDate", ` +
  `contract_url as "contractUrl", updated_at as "updatedAt"`;

// Leeg-object met defaults i.p.v. 404: elke tenant "heeft" klantgegevens,
// alleen zijn ze mogelijk nog nooit ingevuld — de frontend hoeft dan geen
// apart "nog geen klantgegevens"-scherm te tonen, gewoon een leeg formulier.
function emptyCustomerInfo(tenantId: string) {
  return {
    tenantId: Number(tenantId),
    customerSince: null,
    kvkNumber: null,
    vatNumber: null,
    billingAddress: null,
    tags: [] as string[],
    contractReference: null,
    contractDate: null,
    contractUrl: null,
    updatedAt: null,
  };
}

customerManagementRouter.get('/tenants/:tenantId/customer-info', async (req, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const result = await pool.query(
    `select ${CUSTOMER_INFO_SELECT_FIELDS} from tenant_customer_info where tenant_id = $1`,
    [req.params.tenantId]
  );
  res.json(result.rows[0] ?? emptyCustomerInfo(req.params.tenantId));
});

function parseCustomerInfoBody(b: Record<string, unknown>): {
  customerSince: string | null;
  kvkNumber: string | null;
  vatNumber: string | null;
  billingAddress: string | null;
  tags: string[];
  contractReference: string | null;
  contractDate: string | null;
  contractUrl: string | null;
} | { error: string } {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const customerSince = b.customerSince === null || b.customerSince === undefined ? null : b.customerSince;
  const contractDate = b.contractDate === null || b.contractDate === undefined ? null : b.contractDate;
  if (customerSince !== null && (typeof customerSince !== 'string' || !dateRe.test(customerSince))) {
    return { error: 'customerSince moet "YYYY-MM-DD" of null zijn.' };
  }
  if (contractDate !== null && (typeof contractDate !== 'string' || !dateRe.test(contractDate))) {
    return { error: 'contractDate moet "YYYY-MM-DD" of null zijn.' };
  }
  const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()) : [];
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    customerSince,
    kvkNumber: str(b.kvkNumber),
    vatNumber: str(b.vatNumber),
    billingAddress: str(b.billingAddress),
    tags,
    contractReference: str(b.contractReference),
    contractDate,
    contractUrl: str(b.contractUrl),
  };
}

customerManagementRouter.put('/tenants/:tenantId/customer-info', async (req: AuthedRequest, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const parsed = parseCustomerInfoBody((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });

  const before = await pool.query(
    `select ${CUSTOMER_INFO_SELECT_FIELDS} from tenant_customer_info where tenant_id = $1`,
    [req.params.tenantId]
  );
  const beforeRow = (before.rows[0] as Record<string, unknown>) ?? emptyCustomerInfo(req.params.tenantId);

  const result = await pool.query(
    `insert into tenant_customer_info
       (tenant_id, customer_since, kvk_number, vat_number, billing_address, tags, contract_reference, contract_date, contract_url, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     on conflict (tenant_id) do update set
       customer_since = excluded.customer_since,
       kvk_number = excluded.kvk_number,
       vat_number = excluded.vat_number,
       billing_address = excluded.billing_address,
       tags = excluded.tags,
       contract_reference = excluded.contract_reference,
       contract_date = excluded.contract_date,
       contract_url = excluded.contract_url,
       updated_at = now()
     returning ${CUSTOMER_INFO_SELECT_FIELDS}`,
    [
      req.params.tenantId,
      parsed.customerSince,
      parsed.kvkNumber,
      parsed.vatNumber,
      parsed.billingAddress,
      parsed.tags,
      parsed.contractReference,
      parsed.contractDate,
      parsed.contractUrl,
    ]
  );
  const afterRow = result.rows[0] as Record<string, unknown>;

  const changedFields = [
    'customerSince', 'kvkNumber', 'vatNumber', 'billingAddress', 'contractReference', 'contractDate', 'contractUrl',
  ] as const;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of changedFields) {
    if (beforeRow[field] !== afterRow[field]) changes[field] = { from: beforeRow[field], to: afterRow[field] };
  }
  const beforeTags = ((beforeRow.tags as string[] | undefined) ?? []).join(',');
  const afterTags = ((afterRow.tags as string[] | undefined) ?? []).join(',');
  if (beforeTags !== afterTags) changes.tags = { from: beforeRow.tags ?? [], to: afterRow.tags ?? [] };

  if (Object.keys(changes).length > 0) {
    await logAuditEvent({
      eventType: 'tenant_customer_info_changed',
      userId: req.user!.id,
      tenantId: req.params.tenantId,
      role: null,
      detail: { changes },
    });
  }
  res.json(afterRow);
});

// --- Klantgezondheid: een compact, afgeleid overzicht bovenop bestaande
// gegevens (geen nieuwe opslag) — licentiestatus, gebruik t.o.v. tierlimieten,
// en de laatste bekende activiteit van leden van deze tenant. Puur
// signalerend (bv. "licentie loopt over 12 dagen af, geen activiteit in 40
// dagen") — geen aparte "gezondheidsscore"-opslag, altijd live herberekend. ---

type HealthStatus = 'gezond' | 'aandacht' | 'risico';

customerManagementRouter.get('/tenants/:tenantId/health', async (req, res) => {
  if (!(await tenantExists(req.params.tenantId))) return res.status(404).json({ error: 'Tenant niet gevonden.' });
  const tenantId = req.params.tenantId;

  const [tenantRow, license, lastActivity] = await Promise.all([
    pool.query(
      `select terminated_at, to_char(license_end_date, 'YYYY-MM-DD') as license_end_date,
              (license_end_date is not null and license_end_date < current_date) as expired
       from tenants where id = $1`,
      [tenantId]
    ),
    getTenantLicense(tenantId),
    // Laatste activiteit van een lid van deze tenant — via sessions.last_seen_at
    // (zelfde bron als routes/sessions.ts), niet users.last_login_at: dat is
    // platformbreed per account, dit moet specifiek "activiteit binnen déze
    // tenant" benaderen. Bij gebrek aan een per-tenant activiteitstabel is de
    // meest recente sessie van elk lid de dichtstbijzijnde benadering.
    pool.query(
      `select max(s.last_seen_at) as last_seen_at
       from sessions s
       join tenant_users tu on tu.user_id = s.user_id
       where tu.tenant_id = $1`,
      [tenantId]
    ),
  ]);

  const terminated = tenantRow.rows[0]?.terminated_at != null;
  const expired = tenantRow.rows[0]?.expired ?? false;
  const licenseEndDate = tenantRow.rows[0]?.license_end_date ?? null;
  const daysUntilLicenseEnd =
    licenseEndDate != null
      ? Math.ceil((new Date(`${licenseEndDate}T00:00:00Z`).getTime() - Date.now()) / (24 * 3600 * 1000))
      : null;
  const lastSeenAt = lastActivity.rows[0]?.last_seen_at ?? null;
  const daysSinceActivity = lastSeenAt != null ? Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / (24 * 3600 * 1000)) : null;

  const adminUsagePct = license?.tier ? license.usage.activeAdmins / license.tier.maxAdmins : null;
  const bomenUsagePct = license?.tier ? license.usage.activeBomen / license.tier.maxBomen : null;

  // Simpel stoplicht: beëindigd/verlopen of al lang geen activiteit meer =
  // risico; licentie loopt binnenkort af of gebruik zit dicht tegen de
  // tierlimiet = aandacht; anders gezond. Bewust een paar harde, in code
  // gedocumenteerde drempels i.p.v. instelbare configuratie — dit is een
  // signalering, geen contractuele afspraak (in tegenstelling tot de
  // bewaartermijnen elders, die wél expliciet als constante bovenaan een
  // bestand staan).
  let status: HealthStatus = 'gezond';
  const reasons: string[] = [];
  if (terminated) {
    status = 'risico';
    reasons.push('Tenant is beëindigd.');
  } else if (expired) {
    status = 'risico';
    reasons.push('Licentie is verlopen.');
  } else {
    if (daysSinceActivity !== null && daysSinceActivity > 60) {
      status = 'risico';
      reasons.push(`Geen activiteit in ${daysSinceActivity} dagen.`);
    } else if (daysSinceActivity !== null && daysSinceActivity > 30) {
      status = 'aandacht';
      reasons.push(`Geen activiteit in ${daysSinceActivity} dagen.`);
    }
    if (daysUntilLicenseEnd !== null && daysUntilLicenseEnd <= 30) {
      if (status !== 'risico') status = 'aandacht';
      reasons.push(`Licentie loopt over ${daysUntilLicenseEnd} dag(en) af.`);
    }
    if ((adminUsagePct !== null && adminUsagePct >= 0.9) || (bomenUsagePct !== null && bomenUsagePct >= 0.9)) {
      if (status !== 'risico') status = 'aandacht';
      reasons.push('Gebruik zit dicht tegen de tierlimiet aan.');
    }
  }
  if (status === 'gezond') reasons.push('Geen bijzonderheden.');

  res.json({
    status,
    reasons,
    terminated,
    licenseExpired: expired,
    licenseEndDate,
    daysUntilLicenseEnd,
    lastActivityAt: lastSeenAt,
    daysSinceActivity,
    usage: license
      ? { activeAdmins: license.usage.activeAdmins, maxAdmins: license.tier?.maxAdmins ?? null, activeBomen: license.usage.activeBomen, maxBomen: license.tier?.maxBomen ?? null }
      : null,
  });
});
