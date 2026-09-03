import { Router } from 'express';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';

// GET /api/audit-log (+ /export) — sysadmin-only overzicht van het
// auditlogboek (zie db/init.sql audit_log). Bewust GEEN delete-route: dit
// logboek is append-only, ook voor een sysadmin (zie Charles' expliciete eis
// "alleen sysadmin kan de log inzien, maar niet verwijderen").
export const auditLogRouter = Router();
auditLogRouter.use(requireAuth, requireSysadmin);

const LIST_QUERY = `
  select
    a.id,
    a.event_type,
    a.created_at,
    a.role,
    a.detail,
    u.email as user_email,
    a.tenant_id,
    t.name as tenant_name,
    a.doelenboom_id,
    d.name as doelenboom_name
  from audit_log a
  left join users u on u.id = a.user_id
  left join tenants t on t.id = a.tenant_id
  left join doelenbomen d on d.id = a.doelenboom_id
  order by a.created_at desc
`;

// Tenant- en doelenboomnamen zijn NIET uniek (twee tenants of twee bomen
// kunnen best dezelfde naam hebben, zie het "twee tenants heten allebei
// Liefting"-verhaal) — het (id) erachter maakt in het logboek altijd
// ondubbelzinnig duidelijk over wélke tenant/boom het gaat, ook al zijn de
// namen toevallig gelijk of is een tenant/boom later hernoemd.
function withId(name: unknown, id: unknown): string | null {
  if (name === null || name === undefined) return null;
  return `${name} (${id})`;
}

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventType: row.event_type,
    createdAt: row.created_at,
    role: row.role,
    detail: row.detail,
    userEmail: row.user_email,
    tenantName: withId(row.tenant_name, row.tenant_id),
    doelenboomName: withId(row.doelenboom_name, row.doelenboom_id),
  };
}

// Geen limit: dit is een volledig audit-overzicht, zelfde conventie als
// GET /api/sessions hierboven.
auditLogRouter.get('/', async (_req, res) => {
  const result = await pool.query(LIST_QUERY);
  res.json(result.rows.map(mapRow));
});

// Excel-export rechtstreeks via exceljs in Node (Charles' expliciete keuze,
// i.p.v. via de excel-service — dat is een aparte microservice die tot nu toe
// exclusief voor doelenboom-exports/-imports gebruikt werd, geen generiek
// export-mechanisme). Één werkblad, kolomkoppen in het Nederlands, detail-jsonb
// als platte JSON-string (leesbaar, geen aparte kolommen per mogelijk
// detail-veld nodig).
auditLogRouter.get('/export', async (_req, res) => {
  const result = await pool.query(LIST_QUERY);
  const rows = result.rows.map(mapRow);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Auditlogboek');
  sheet.columns = [
    { header: 'Datum/tijd', key: 'createdAt', width: 22 },
    { header: 'Gebeurtenis', key: 'eventType', width: 22 },
    { header: 'Gebruiker', key: 'userEmail', width: 30 },
    { header: 'Tenant', key: 'tenantName', width: 24 },
    { header: 'Doelenboom', key: 'doelenboomName', width: 30 },
    { header: 'Rol', key: 'role', width: 14 },
    { header: 'Details', key: 'detail', width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    sheet.addRow({
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      eventType: row.eventType === 'doelenboom_view' ? 'Boom bekeken' : 'Tenant-instellingen gewijzigd',
      userEmail: row.userEmail ?? '(verwijderd account)',
      tenantName: row.tenantName ?? '(verwijderde tenant)',
      doelenboomName: row.doelenboomName ?? '',
      role: row.role ?? '',
      detail: row.detail && Object.keys(row.detail as Record<string, unknown>).length > 0 ? JSON.stringify(row.detail) : '',
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="auditlogboek.xlsx"');
  res.send(Buffer.from(buffer));
});
