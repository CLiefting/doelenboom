import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { requireSysadmin } from '../rbac.js';

// GET /api/dbstat — puur diagnostisch overzicht: per tenant welke doelenbomen
// er zijn en hoeveel elementen/relaties/tags/organisatieonderdelen/imports
// daarin zitten. Gebouwd om te kunnen controleren of het automatisch leegmaken
// van een tenant (tenantWipe.ts) écht werkt — vandaar sysadmin-only (dit toont
// counts over alle tenants heen, niet gescoped per tenant-admin).
export const dbstatRouter = Router();
dbstatRouter.use(requireAuth, requireSysadmin);

dbstatRouter.get('/', async (_req, res) => {
  const result = await pool.query(`
    select
      t.id as tenant_id, t.slug as tenant_slug, t.name as tenant_name,
      t.wipe_on_empty, t.session_timeout_minutes,
      d.id as doelenboom_id, d.slug as doelenboom_slug, d.name as doelenboom_name,
      (select count(*) from elements e where e.doelenboom_id = d.id) as element_count,
      (select count(*) from edges e2 where e2.doelenboom_id = d.id) as edge_count,
      (select count(*) from tags tg where tg.doelenboom_id = d.id) as tag_count,
      (select count(*) from org_units ou where ou.doelenboom_id = d.id) as org_unit_count,
      (select count(*) from excel_imports ei where ei.doelenboom_id = d.id) as import_count
    from tenants t
    left join doelenbomen d on d.tenant_id = t.id
    order by t.name, d.name
  `);

  const byTenant = new Map<number, {
    id: number; slug: string; name: string;
    wipeOnEmpty: boolean; sessionTimeoutMinutes: number;
    doelenbomen: Array<{
      id: number; slug: string; name: string;
      elementCount: number; edgeCount: number; tagCount: number; orgUnitCount: number; importCount: number;
    }>;
  }>();

  for (const row of result.rows) {
    if (!byTenant.has(row.tenant_id)) {
      byTenant.set(row.tenant_id, {
        id: row.tenant_id,
        slug: row.tenant_slug,
        name: row.tenant_name,
        wipeOnEmpty: row.wipe_on_empty,
        sessionTimeoutMinutes: row.session_timeout_minutes,
        doelenbomen: [],
      });
    }
    if (row.doelenboom_id != null) {
      byTenant.get(row.tenant_id)!.doelenbomen.push({
        id: row.doelenboom_id,
        slug: row.doelenboom_slug,
        name: row.doelenboom_name,
        elementCount: Number(row.element_count),
        edgeCount: Number(row.edge_count),
        tagCount: Number(row.tag_count),
        orgUnitCount: Number(row.org_unit_count),
        importCount: Number(row.import_count),
      });
    }
  }

  res.json([...byTenant.values()]);
});
