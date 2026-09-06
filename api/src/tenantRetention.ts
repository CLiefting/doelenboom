import { pool } from './db.js';

// Bewaartermijn na beëindiging van een tenant/abonnement — zie
// db/migrations/0032_tenant_retention.sql voor het volledige ontwerp en
// docs/juridische-documenten-en-retentie.md.
//
// Beleid: "Tenant beëindigen" (routes/tenants.ts DELETE /:id, voorheen een
// onmiddellijke harde delete) zet nu alleen tenants.terminated_at. Vanaf dat
// moment is de tenant voor gewone leden ontoegankelijk/onzichtbaar (zie
// rbac.ts) en voor een sysadmin alleen-lezen — tot TENANT_RETENTION_MONTHS
// later de periodieke sweep (sweepTenantRetention, aangeroepen vanuit
// index.ts) 'm definitief verwijdert. Bewust geen magic number in de sweep-
// query zelf: één centrale constante, zoals ACCOUNT_INACTIVITY_MONTHS in
// accountRetention.ts.
export const TENANT_RETENTION_MONTHS = 12;

async function logEvent(
  tenantId: number | null,
  eventType: 'terminated' | 'purged',
  actorUserId: number | null,
  detail: Record<string, unknown> = {}
) {
  await pool.query(
    `insert into tenant_retention_events (tenant_id, event_type, actor_user_id, detail) values ($1, $2, $3, $4::jsonb)`,
    [tenantId, eventType, actorUserId, JSON.stringify(detail)]
  );
}

// Aangeroepen vanuit routes/tenants.ts DELETE /:id (sysadmin-only). Idempotent
// in de zin dat een tenant die al beëindigd is op zijn oorspronkelijke
// terminated_at blijft staan (geen "opnieuw beëindigen", geen dubbele
// event-regel) — de where-clause zorgt daarvoor.
export async function terminateTenant(
  tenantId: number | string,
  actorUserId: number
): Promise<{ id: number; name: string } | null> {
  const result = await pool.query(
    `update tenants set terminated_at = now() where id = $1 and terminated_at is null returning id, name`,
    [tenantId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0] as { id: number; name: string };
  await logEvent(row.id, 'terminated', actorUserId, { name: row.name });
  return row;
}

// Periodieke sweep (elk uur, zie index.ts — zelfde grofmazige, dag-granulaire
// aanpak als accountRetention.ts's sweepAccountRetention). Verwijdert tenants
// die meer dan TENANT_RETENTION_MONTHS geleden beëindigd zijn definitief.
// Cascade (db/init.sql: tenant_users, doelenbomen en al hun inhoud) ruimt dan
// alsnog alles op, exact zoals de oude, onmiddellijke DELETE-route deed.
export async function sweepTenantRetention(): Promise<void> {
  const candidates = await pool.query(
    `select id, name from tenants
     where terminated_at is not null
       and terminated_at < now() - interval '${TENANT_RETENTION_MONTHS} months'`
  );

  for (const row of candidates.rows) {
    const tenantId = row.id as number;
    try {
      // Vóór de delete loggen (net als accountRetention.ts): na de delete zou
      // 'on delete set null' tenant_id in dit logboek toch al op null hebben
      // gezet — de naam leggen we hier expliciet vast als laatste context.
      await logEvent(tenantId, 'purged', null, { name: row.name });
      await pool.query('delete from tenants where id = $1', [tenantId]);
    } catch (err) {
      console.error(`Kon beëindigde tenant ${tenantId} niet definitief verwijderen:`, err);
    }
  }
}
