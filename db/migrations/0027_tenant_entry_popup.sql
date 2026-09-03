-- Popup-melding bij het openen van een doelenboom binnen een tenant, met
-- een keuze tussen OK (doorgaan) en Annuleren (niet doorgaan) — instelbaar
-- per tenant. Zie db/init.sql (tenants.entry_popup_enabled/entry_popup_message),
-- api/src/routes/tenants.ts (PUT /api/tenants/:id) en
-- web/src/components/TenantEntryNotice.tsx.
begin;
alter table tenants add column if not exists entry_popup_enabled boolean not null default false;
alter table tenants add column if not exists entry_popup_message text not null default '';
commit;
