-- Bewaartermijn na beëindiging van een tenant/abonnement (CISO-aandachtspunt
-- — vult de tot nu toe "nog te bepalen"-vraag "concrete bewaartermijn na
-- beëindiging van een organisatieomgeving" in, zie docs/
-- juridische-documenten-en-retentie.md en de openstaande-punten-lijst in de
-- gebruiksvoorwaarden zelf).
--
-- Beleid: in plaats van een tenant bij "Tenant verwijderen" meteen hard te
-- verwijderen (cascade, direct onherstelbaar), wordt de tenant nu eerst
-- "beëindigd" (terminated_at gezet, zie api/src/tenantRetention.ts
-- terminateTenant, aangeroepen vanuit routes/tenants.ts DELETE /:id). Vanaf
-- dat moment:
--   - is de tenant (met al zijn doelenbomen/inhoud) voor gewone leden
--     (tenant-admin/gebruiker/bezoeker) volledig onzichtbaar en ontoegankelijk
--     geworden, alsof hij niet meer bestaat (zie api/src/rbac.ts);
--   - blijft de inhoud, alleen-lezen, uitsluitend voor een sysadmin
--     raadpleegbaar (rbac.ts requireTenantRoleForDoelenboomParam — de enige
--     plek in het rolmodel waar een sysadmin bewust wél zonder eigen
--     tenant_users-koppeling mag lezen, nooit schrijven);
--   - wordt de tenant TENANT_RETENTION_MONTHS (12, zie tenantRetention.ts) na
--     terminated_at automatisch definitief verwijderd door de periodieke
--     sweep (sweepTenantRetention, aangeroepen vanuit index.ts) — cascade
--     (db/init.sql) ruimt tenant_users, doelenbomen en al hun inhoud dan
--     alsnog volledig op, exact zoals de oude, onmiddellijke DELETE dat deed.
--
-- tenant_retention_events is bewust een eigen, kleine tabel (net als
-- account_retention_events voor de vergelijkbare accountretentie), niet het
-- generieke audit_log: dat log is (zie db/init.sql-commentaar erboven)
-- bedoeld voor door mensen uitgevoerde acties binnen een tenant, terwijl
-- 'purged' hier juist volledig automatisch (door de sweep, geen actor)
-- gebeurt — en na afloop bestaat de tenant zelf niet meer om nog acties
-- "binnen" te loggen.
begin;

alter table tenants add column if not exists terminated_at timestamptz;
create index if not exists idx_tenants_terminated_at on tenants(terminated_at) where terminated_at is not null;

create table if not exists tenant_retention_events (
  id bigserial primary key,
  -- on delete set null: de definitieve verwijdering (cascade) van de tenant
  -- zelf mag dit logboek-record niet meetrekken (zelfde conventie als
  -- audit_log/account_retention_events hierboven).
  tenant_id bigint references tenants(id) on delete set null,
  event_type text not null check (event_type in ('terminated', 'purged')),
  -- Welke sysadmin de beëindiging heeft geïnitieerd — altijd null bij
  -- 'purged' (dat is de automatische sweep, geen menselijke actor).
  actor_user_id bigint references users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_tenant_retention_events_tenant on tenant_retention_events(tenant_id, created_at desc);

commit;
