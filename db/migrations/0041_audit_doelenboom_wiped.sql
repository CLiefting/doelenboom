-- Migratie: auditlog-gebeurtenis 'doelenboom_wiped' (DOEL-28, analyse M5).
-- Het automatisch leegmaken van een doelenboom (wipe_on_empty: bij uitloggen
-- van de laatste gebruiker of door de minutensweep) liet tot nu toe geen enkel
-- spoor na. Nu komt er per echte wipe een regel in audit_log (user_id is null
-- bij de sweep; detail: {trigger, deleted: {elements, tags, orgUnits, imports}}).
--
-- Vervangt alleen de CHECK-constraint op audit_log.event_type door dezelfde
-- lijst + het nieuwe type (idempotent, zelfde patroon als 0033). Draai dit
-- VÓÓR het uitrollen van de nieuwe API-versie, anders faalt het schrijven van
-- die auditregel (de wipe zelf gaat dan wel door).
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0041_audit_doelenboom_wiped.sql
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
      'doelenboom_wiped'
    ));
end $$;

commit;
