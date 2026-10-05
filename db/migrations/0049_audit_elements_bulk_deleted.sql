-- Migratie: auditlog-gebeurtenis voor bulk-verwijderen van elementen (DOEL-82).
-- Nieuw event_type 'elements_bulk_deleted' (detail: { count, codes } — het
-- aantal en de codes van de verwijderde elementen, nooit namen of andere
-- vrije tekst).
--
-- Vervangt alleen de CHECK-constraint op audit_log.event_type (idempotent,
-- zelfde patroon als 0042/0047). Draai dit VÓÓR het uitrollen van de nieuwe
-- API-versie, anders faalt het wegschrijven van deze auditregel (het
-- verwijderen zelf gaat dan wel gewoon door — auditfouten worden gelogd,
-- niet doorgegeven).
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0049_audit_elements_bulk_deleted.sql
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
      'doelenboom_deleted', 'doelenboom_exported', 'doelenboom_import_published',
      'control_rules_updated',
      'control_rule_deviation_set', 'control_rule_deviation_removed',
      'dependency_vulnerability_alert_sent',
      'attribute_definitions_updated',
      'elements_bulk_deleted'
    ));
end $$;

commit;
