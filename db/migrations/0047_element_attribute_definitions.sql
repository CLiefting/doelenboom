-- Migratie: kenmerkdefinities per kolomconfiguratie (DOEL-75, epic DOEL-61
-- "Module Controleregels"; ontwerp: doelenboom_kenmerken_ontwerp.md).
--
-- 1. column_configs.attributes — jsonb-array van kenmerkdefinities: eigen
--    velden die een tenant met de module 'controleregels' per elementtype
--    vastlegt (bv. {"id":"K01","label":"Laatst beoordeeld","kind":"date",
--    "subjectTypes":["Capability"],"required":false,"explanation":"",
--    "options":[]}). Op de kolomconfiguratie, om dezelfde redenen als
--    column_configs.rules (0044): een kenmerk verwijst naar typen uit meerdere
--    kolommen, hoort bij de configuratie van één doelenboom (of bij de
--    tenant-default, waarvandaan het bij een nieuwe boom wordt meegekopieerd)
--    en wordt nooit los gequeried. Het schema (id/label/kind/subjectTypes/
--    required/explanation/options) en alle validatie (whitelist van velden en
--    soorten, max. 30 kenmerken, id en soort vast na aanmaken, typen moeten
--    bestaan in de kolommen+aliassen van dezelfde config) zitten op
--    API-niveau in api/src/elementAttributes.ts, niet in de database.
--    Dit zijn alleen de DEFINITIES; de waarden per element volgen in DOEL-76.
--    Alleen metagegevens: geen inhoudelijke of gerubriceerde informatie.
-- 2. doelenboom_templates.attributes_snapshot — definities gaan mee in
--    sjablonen (opslaan/toepassen), net als rules_snapshot. Bestaande
--    sjablonen krijgen '[]'.
-- 3. audit_log: nieuw event_type 'attribute_definitions_updated' (detail
--    bevat alleen scope, aantal en kenmerk-id's — nooit labels, uitleg of
--    keuzelijstwaarden). Zelfde constraint-vervangpatroon als 0044/0046.
--
-- Bestaande kolomconfiguraties krijgen attributes = '[]' en gedragen zich
-- ongewijzigd. Idempotent (if not exists / constraint opnieuw opbouwen) en
-- exact gespiegeld in db/init.sql. Draai dit VÓÓR het uitrollen van de nieuwe
-- API-versie.
--
-- Gebruik:
--   set -euo pipefail
--   docker compose exec -T db psql -U doelenboom -d doelenboom -v ON_ERROR_STOP=1 < db/migrations/0047_element_attribute_definitions.sql
begin;

alter table column_configs add column if not exists attributes jsonb not null default '[]'::jsonb;
alter table doelenboom_templates add column if not exists attributes_snapshot jsonb not null default '[]'::jsonb;

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
      'attribute_definitions_updated'
    ));
end $$;

commit;
