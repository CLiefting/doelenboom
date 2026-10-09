-- Migratie: instelbare inactiviteitstermijn voor automatisch uitloggen (DOEL-97).
--
-- Tot nu toe stond de termijn vast op 15 minuten (IDLE_TIMEOUT_MINUTES in
-- api/src/auth.ts). Nu een kolom op app_settings, naast de parameters van de
-- inlogblokkade, zodat een sysadmin hem in de app kan aanpassen zonder herstart
-- of deploy. Standaard 15 minuten (ongewijzigd gedrag); grenzen 5 t/m 480
-- minuten, ook afgedwongen in de API (routes/appSettings.ts).
--
-- Daarnaast een nieuw event_type 'app_settings_updated' voor het auditlog
-- (detail: per gewijzigd veld de oude en nieuwe waarde, alleen getallen).
--
-- Draai dit VÓÓR het uitrollen van de nieuwe API-versie: die leest de kolom bij
-- elke aanvraag (requireAuth). Idempotent: veilig meerdere keren te draaien.
--
-- Gebruik (lokaal):
--   docker compose exec -T db psql -U "${POSTGRES_USER:-doelenboom}" \
--     -d "${POSTGRES_DB:-doelenboom}" -v ON_ERROR_STOP=1 < db/migrations/0050_app_settings_idle_timeout.sql
--
-- Gebruik (productie, op de VPS): zelfde commando met
-- "docker compose -f docker-compose.yml -f docker-compose.prod.yml".
begin;

alter table app_settings add column if not exists idle_timeout_minutes integer not null default 15;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_idle_timeout_minutes_check') then
    alter table app_settings add constraint app_settings_idle_timeout_minutes_check
      check (idle_timeout_minutes between 5 and 480);
  end if;

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
      'elements_bulk_deleted',
      'app_settings_updated'
    ));
end $$;

commit;
