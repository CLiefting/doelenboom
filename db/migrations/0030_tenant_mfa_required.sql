-- Tenant-breed verplichte MFA (CISO-aandachtspunt, zie doelenboom_mfa_
-- ontwerp.md en db/init.sql tenants.mfa_required). Zie api/src/routes/
-- tenants.ts (PUT /api/tenants/:id) en api/src/auth.ts (mfaRequired).
begin;
alter table tenants add column if not exists mfa_required boolean not null default false;
commit;
