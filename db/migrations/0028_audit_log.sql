-- Generiek, uitbreidbaar auditlogboek (CISO-aandachtspunt: "wie heeft wat
-- gedaan, wanneer"). Zelfde event_type+detail-jsonb-opzet als
-- account_retention_events, i.p.v. een aparte tabel per gebeurtenis-soort,
-- zodat een toekomstig event_type er zonder schemawijziging bij kan. Op dit
-- moment twee soorten (zie api/src/auditLog.ts): 'doelenboom_view' (iemand
-- opent/ververst een boomweergave — role is dan de effectieve rol op dat
-- moment) en 'tenant_settings_changed' (een sysadmin of tenant-admin wijzigt
-- tenant-instellingen — detail bevat {"changes": {veld: {from, to}}}).
-- Bewust GEEN delete-route/-knop ooit voorzien: dit log is append-only, ook
-- voor een sysadmin (zie api/src/routes/auditLog.ts — alleen GET-routes).
-- on delete set null (i.p.v. cascade) op user/tenant/doelenboom: een
-- verwijderd account/tenant/boom mag het log van wat er ooit gebeurd is niet
-- met zich meetrekken.
begin;
create table if not exists audit_log (
  id bigserial primary key,
  event_type text not null check (event_type in ('doelenboom_view', 'tenant_settings_changed')),
  user_id bigint references users(id) on delete set null,
  tenant_id bigint references tenants(id) on delete set null,
  doelenboom_id bigint references doelenbomen(id) on delete set null,
  role text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_log_created on audit_log(created_at desc);
create index if not exists idx_audit_log_user on audit_log(user_id, created_at desc);
create index if not exists idx_audit_log_doelenboom on audit_log(doelenboom_id, created_at desc);
create index if not exists idx_audit_log_tenant on audit_log(tenant_id, created_at desc);
commit;
