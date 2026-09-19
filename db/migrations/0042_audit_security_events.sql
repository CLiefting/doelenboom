-- Migratie: extra auditlog-gebeurtenissen (DOEL-29, analyse M6).
-- Tot nu toe werden alleen MFA, tenantinstellingen, klantbeheer, boomweergave
-- en (sinds 0041) wipes gelogd. Nieuw: login_success, login_failed,
-- account_locked, password_changed, password_reset, user_created,
-- user_updated, user_deleted, tenant_member_changed, doelenboom_deleted,
-- doelenboom_exported, doelenboom_import_published.
--
-- Vervangt alleen de CHECK-constraint op audit_log.event_type (idempotent,
-- zelfde patroon als 0033/0041). Draai dit VÓÓR het uitrollen van de nieuwe
-- API-versie, anders faalt het wegschrijven van deze auditregels (de acties
-- zelf gaan dan wel gewoon door — auditfouten worden gelogd, niet doorgegeven).
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0042_audit_security_events.sql
begin;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'audit_log_event_type_check') then
    alter table audit_log drop constraint audit_log_event_type_check;
  end if;
  alter table audit_log add constraint audit_log_event_type_check
    check (event_type in (
      'doelenboom_view', 'tenant_settings_changed', 'mfa_verified', 'mfa_failed',
      'tenant_contact_changed', 'tenant_customer_info_changed', 'tenant_subscription_changed',
      'doelenboom_wiped',
      'login_success', 'login_failed', 'account_locked', 'password_changed', 'password_reset',
      'user_created', 'user_updated', 'user_deleted', 'tenant_member_changed',
      'doelenboom_deleted', 'doelenboom_exported', 'doelenboom_import_published'
    ));
end $$;

commit;
