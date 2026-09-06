-- Klantbeheer (CRM-achtige laag bovenop tenants, sysadmin-only — een
-- commerciële/relationele aangelegenheid, geen tenant-zelfbediening, zelfde
-- toegangsmodel als licenties, zie routes/customerManagement.ts):
--
--  - tenant_contacts: contactpersonen per tenant, LOS van app-accounts
--    (tenant_users) — iemand kan hier staan zonder ooit in te loggen. role is
--    puur een label/type ('tenant_admin', 'ciso', 'overig'), geen wijziging
--    aan het bestaande rechtenmodel (admin/gebruiker/bezoeker blijft de
--    enige echte permissie-rolverdeling, zie rbac.ts). Precies één contact
--    per tenant mag is_primary zijn (partial unique index hieronder) — de
--    geschiedenis van wijzigingen (wie was wanneer primair contact, welke
--    velden zijn gewijzigd) wordt NIET in een aparte tabel bijgehouden maar
--    via het bestaande generieke audit_log (event_type
--    'tenant_contact_changed', zie auditLog.ts) — zelfde aanpak als
--    tenant_settings_changed, want dit zijn door mensen (sysadmins)
--    uitgevoerde acties, geen automatisch/systeemproces (vergelijk met
--    tenant_retention_events, dat wél een eigen tabel kreeg omdat 'purged'
--    daar juist actor-loos is).
--
--  - tenant_customer_info: 1-op-1 met tenants, de overige klantbeheervelden
--    die geen natuurlijke plek hebben in de bestaande tenants-tabel
--    (facturatie-/bedrijfsgegevens, segmentatie-tags, contractreferentie,
--    "klant sinds" — bewust een los, expliciet instelbaar veld i.p.v.
--    tenants.created_at te hergebruiken: de klantrelatie kan al vóór het
--    aanmaken van de tenant in het systeem zijn begonnen, of pas later echt
--    "klant" worden na een proefperiode).
--
--  - tenants.license_renewal_reminder_sent_at: zie
--    api/src/licenseRenewalReminder.ts — voorkomt dat de periodieke
--    verlengingsherinnering-sweep bij elke draai opnieuw logt voor dezelfde
--    aflopende licentie; wordt teruggezet naar null zodra de licentie-
--    einddatum zelf wijzigt (license.ts setTenantLicenseEndDate), zodat een
--    nieuwe/verlengde einddatum weer zijn eigen herinneringscyclus krijgt.
begin;

create table if not exists tenant_contacts (
  id bigserial primary key,
  tenant_id bigint not null references tenants(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  role text not null check (role in ('tenant_admin', 'ciso', 'overig')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Precies één primair contact per tenant (geen primair contact hebben mag
-- ook, vandaar geen "exact one"-constraint maar alleen "hoogstens één").
create unique index if not exists idx_tenant_contacts_one_primary
  on tenant_contacts(tenant_id) where is_primary;
create index if not exists idx_tenant_contacts_tenant on tenant_contacts(tenant_id, role);

create table if not exists tenant_customer_info (
  tenant_id bigint primary key references tenants(id) on delete cascade,
  customer_since date,
  kvk_number text,
  vat_number text,
  billing_address text,
  tags text[] not null default '{}',
  contract_reference text,
  contract_date date,
  contract_url text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_tenant_customer_info_tags on tenant_customer_info using gin(tags);

alter table tenants add column if not exists license_renewal_reminder_sent_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'audit_log_event_type_check') then
    alter table audit_log drop constraint audit_log_event_type_check;
  end if;
  alter table audit_log add constraint audit_log_event_type_check
    check (event_type in (
      'doelenboom_view', 'tenant_settings_changed', 'mfa_verified', 'mfa_failed',
      'tenant_contact_changed', 'tenant_customer_info_changed', 'tenant_subscription_changed'
    ));
end $$;

commit;
